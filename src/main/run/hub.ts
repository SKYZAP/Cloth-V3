import type { Hardware, HubFileGroup, HubFiles, HubFit, HubModel } from '@shared/types'
import { reasoningKind } from './gguf'
import { USER_AGENT, type Fetch } from './download'

export const HF_BASE = 'https://huggingface.co'
const GB = 1024 ** 3

interface ApiModel {
  id: string
  author?: string
  downloads?: number
  likes?: number
  gated?: boolean | string
  gguf?: { total?: number; architecture?: string; context_length?: number; chat_template?: string }
}

/** GGUF models on Hugging Face matching a query, most downloaded first. */
export async function searchHub(query: string, fetch: Fetch, base = HF_BASE): Promise<HubModel[]> {
  const q = query.trim()
  const params = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: '24' })
  // With no query, the popular list: chat models only (GGUF repos also hold speech, image and embedding models).
  if (q) params.set('search', q)
  else params.set('pipeline_tag', 'text-generation')
  for (const e of ['gguf', 'downloads', 'likes', 'gated']) params.append('expand[]', e)
  const res = await fetch(`${base}/api/models?${params}`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Hugging Face search failed (HTTP ${res.status})`)
  return ((await res.json()) as ApiModel[]).map(toHubModel)
}

export function toHubModel(m: ApiModel): HubModel {
  const [author, ...rest] = m.id.split('/')
  return {
    id: m.id,
    author: m.author ?? author,
    name: prettyName(rest.join('/') || m.id),
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    gated: !!m.gated && m.gated !== 'false',
    params: paramsOf(m.id, m.gguf?.total ?? null),
    architecture: m.gguf?.architecture ?? null,
    contextLength: m.gguf?.context_length ?? null,
    reasoning: reasoningKind(m.gguf?.chat_template)
  }
}

/**
 * Parameter count: Hugging Face's figure from the GGUF, unless the name says it's far bigger (repos that
 * only hold a draft or MTP head report that head's size).
 */
export function paramsOf(id: string, total: number | null): number | null {
  const m = /(?:^|[-_ /])(\d+(?:\.\d+)?)B(?=[-_ ]|$)/i.exec(id.split('/').pop() ?? id)
  const named = m ? Number(m[1]) * 1e9 : null
  if (named && (!total || total < named * 0.5)) return named
  return total
}

/** "Qwen3-8B-GGUF" → "Qwen3 8B". */
export function prettyName(repoName: string): string {
  return repoName.replace(/[-_]?GGUF$/i, '').replace(/[-_]+/g, ' ').trim()
}

/** A GGUF file's quantization from its name: Q4_K_M, IQ4_XS, BF16, UD-Q4_K_XL… (null when unknown). */
export function quantOf(path: string): string | null {
  const name = path.split('/').pop() ?? path
  const m = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_K)?(?:_[A-Z0-9]+)?|BF16|F16|F32|MXFP4(?:_MOE)?|TQ\d_\d|PQ\d_\d))(?=[-_.](?:\d{5}-of-\d{5}\.)?gguf$|\.gguf$|-\d{5}-of-)/i.exec(name)
  if (m) return m[1].toUpperCase()
  // A quant folder: "Q4_K_M/model-00001-of-00002.gguf".
  const dir = path.split('/').slice(-2, -1)[0]
  return dir && /^(?:UD-)?(?:I?Q\d|BF16|F16)/i.test(dir) ? dir.toUpperCase() : null
}

/** Memory a model needs with an 8K context: the weights, plus a context cache and working buffers. */
export function needBytes(fileBytes: number, params: number | null): number {
  // About 1 GB of cache and buffers at 8K for a 8B model, growing gently with size.
  const extra = 0.6 * GB + (params ? Math.min(params / 8e9, 6) * 0.5 * GB : fileBytes * 0.08)
  return fileBytes + extra
}

/** Where a model of this size runs: all on the GPU, partly in system memory, or not at all. */
export function fitOf(need: number, hw: Pick<Hardware, 'gpus' | 'ramMiB'>): HubFit {
  const vram = (hw.gpus[0]?.totalMiB ?? 0) * 1024 * 1024
  const ram = hw.ramMiB * 1024 * 1024
  if (vram && need <= vram * 0.95) return 'gpu'
  // A Mac's GPU shares the system memory: there's no slower pool to spill into.
  if (hw.gpus[0]?.vendor === 'apple') return 'too-big'
  // Spilling over: what doesn't fit on the GPU comes from system memory, leaving room for the OS.
  if (need <= vram + ram * 0.6) return 'ram'
  return 'too-big'
}

/** Quality order for picking a recommendation (higher is better). */
const QUALITY = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q4_K_M', 'Q4_K_S', 'IQ4_XS', 'IQ4_NL', 'Q3_K_M', 'Q3_K_L', 'IQ3_M', 'Q2_K']

/** A repo's GGUF files grouped by quantization (shards together), with fit and one recommendation. */
export function groupFiles(repo: string, entries: { path: string; size: number }[], hw: Pick<Hardware, 'gpus' | 'ramMiB'>, params: number | null): HubFiles {
  const ggufs = entries.filter((e) => /\.gguf$/i.test(e.path))
  const projectors = ggufs.filter((e) => /mmproj/i.test(e.path))
  const byQuant = new Map<string, { path: string; size: number }[]>()
  for (const e of ggufs) {
    if (/mmproj/i.test(e.path)) continue
    const q = quantOf(e.path)
    if (!q) continue
    byQuant.set(q, [...(byQuant.get(q) ?? []), e])
  }
  const vram = (hw.gpus[0]?.totalMiB ?? 0) * 1024 * 1024
  const groups: HubFileGroup[] = [...byQuant.entries()].map(([quant, files]) => {
    files.sort((a, b) => a.path.localeCompare(b.path))
    const size = files.reduce((n, f) => n + f.size, 0)
    const need = needBytes(size, params)
    return { quant, files, size, fit: fitOf(need, hw), needGB: Math.round((need / GB) * 10) / 10, recommended: false }
  })
  groups.sort((a, b) => a.size - b.size)
  // The best quality that leaves a quarter of the GPU for a longer context; else the best that fits at all.
  const rank = (q: string) => {
    const i = QUALITY.indexOf(q.replace(/^UD-/, '').replace(/_XL$/, '_M'))
    return i === -1 ? 99 : i
  }
  const pick =
    [...groups].filter((g) => vram && g.needGB * GB <= vram * 0.75 && rank(g.quant) < 99).sort((a, b) => rank(a.quant) - rank(b.quant))[0] ??
    [...groups].filter((g) => g.fit !== 'too-big' && rank(g.quant) < 99).sort((a, b) => rank(a.quant) - rank(b.quant))[0]
  if (pick) pick.recommended = true
  return { repo, groups, projectors }
}

/** A repo's files with their sizes. */
export async function listRepoFiles(repo: string, fetch: Fetch, base = HF_BASE): Promise<{ path: string; size: number }[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`“${repo}” isn't a Hugging Face model id`)
  const res = await fetch(`${base}/api/models/${repo}/tree/main?recursive=true`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) })
  if (res.status === 401 || res.status === 403) throw new Error(`${repo} needs you to accept its licence on Hugging Face; gated models aren't supported yet`)
  if (!res.ok) throw new Error(`Couldn't list ${repo}'s files (HTTP ${res.status})`)
  const items = (await res.json()) as { type?: string; path: string; size?: number; lfs?: { size?: number } }[]
  return items.filter((i) => i.type !== 'directory').map((i) => ({ path: i.path, size: i.lfs?.size ?? i.size ?? 0 }))
}
