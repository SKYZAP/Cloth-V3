import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { RegistryPreview, RegistrySkill, SkillSource } from '@shared/types'
import type { Ctx } from '../core/context'
import { parseSkillMd, slugify, type SkillService } from './skills'

/**
 * Client for the skills.sh registry, using the same public endpoints as the official `skills` CLI:
 *   GET /api/search?q=…&limit=…            → { skills: [{ id, source, skillId, name, installs }] }
 *   GET /api/download/{owner}/{repo}/{id}  → { files: [{ path, contents }], hash }
 */
export const SKILLS_REGISTRY = 'https://skills.sh'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const SOURCE_FILE = '.cloth-source.json'

interface DownloadResponse {
  files?: { path: string; contents: string | null }[]
  hash?: string | null
}

export class SkillRegistry {
  private cache = new Map<string, { at: number; data: DownloadResponse }>()

  constructor(
    private ctx: Ctx,
    private skills: SkillService,
    private base = process.env.CLOTH_SKILLS_REGISTRY || SKILLS_REGISTRY
  ) {}

  async search(query: string, limit = 30): Promise<RegistrySkill[]> {
    const q = query.trim()
    if (q.length < 2) return []
    const url = new URL('/api/search', this.base)
    url.searchParams.set('q', q)
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)))
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`skills.sh search failed (HTTP ${res.status})`)
    const body = (await res.json()) as { skills?: { id: string; source?: string; skillId?: string; name: string; installs?: number }[] }
    const installed = await this.installedSources()
    return (body.skills ?? [])
      .filter((s) => typeof s.id === 'string' && s.id.split('/').length >= 3)
      .map((s) => ({
        id: s.id,
        source: s.source ?? s.id.split('/').slice(0, 2).join('/'),
        skillId: s.skillId ?? s.id.split('/').pop()!,
        name: s.name,
        installs: s.installs ?? 0,
        url: `${SKILLS_REGISTRY}/${s.id}`,
        installedAs: installed.get(s.id) ?? null
      }))
  }

  async preview(id: string): Promise<RegistryPreview> {
    const data = await this.download(id)
    const files = (data.files ?? []).filter((f) => f.contents !== null)
    const skillMd = files.find((f) => f.path === 'SKILL.md')
    if (!skillMd?.contents) throw new Error('This registry entry has no SKILL.md snapshot yet — open it on skills.sh instead')
    const { frontmatter, body } = parseSkillMd(skillMd.contents)
    const installed = await this.installedSources()
    return {
      id,
      name: String(frontmatter.name ?? id.split('/').pop()),
      description: String(frontmatter.description ?? ''),
      body,
      files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.contents ?? '') })),
      hash: data.hash ?? null,
      url: `${SKILLS_REGISTRY}/${id}`,
      installedAs: installed.get(id) ?? null
    }
  }

  /** Download a registry skill into the hub. Returns the local skill name. */
  async install(id: string, opts: { overwrite?: boolean } = {}): Promise<string> {
    const data = await this.download(id, true)
    const files = (data.files ?? []).filter((f): f is { path: string; contents: string } => f.contents !== null)
    const skillMd = files.find((f) => f.path === 'SKILL.md')
    if (!skillMd) throw new Error('Registry entry has no SKILL.md')
    const { frontmatter } = parseSkillMd(skillMd.contents)
    const name = slugify(String(frontmatter.name ?? id.split('/').pop()))
    if (!name) throw new Error('Could not derive a skill name')

    const installed = await this.installedSources()
    const existingName = installed.get(id)
    const dir = join(this.ctx.skillsDir, name)
    if (existsSync(dir) && existingName !== name && !opts.overwrite) {
      throw new Error(`A different skill named "${name}" already exists in the hub — rename it first, or install with overwrite`)
    }

    let total = 0
    for (const f of files) {
      total += Buffer.byteLength(f.contents)
      if (Buffer.byteLength(f.contents) > MAX_FILE_BYTES) throw new Error(`${f.path} is larger than 2 MB`)
    }
    if (total > MAX_TOTAL_BYTES) throw new Error('Skill is larger than 20 MB')

    // Write to a staging folder first so a failed download never leaves a half-updated skill.
    const staging = join(this.ctx.dataDir, 'skills-staging', `${name}-${Date.now()}`)
    await mkdir(staging, { recursive: true })
    try {
      for (const f of files) {
        const target = resolve(staging, f.path)
        if (!target.startsWith(staging + sep) || f.path.includes('\0')) throw new Error(`Refusing unsafe path in registry skill: ${f.path}`)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, f.contents)
      }
      const source: SkillSource = { registry: 'skills.sh', id, hash: data.hash ?? null, installedAt: Date.now(), url: `${SKILLS_REGISTRY}/${id}` }
      await writeFile(join(staging, SOURCE_FILE), JSON.stringify(source, null, 2))
      // Keep locally authored eval cases across updates.
      if (existsSync(join(dir, 'evals.json')) && !files.some((f) => f.path === 'evals.json')) {
        await writeFile(join(staging, 'evals.json'), await readFile(join(dir, 'evals.json')))
      }
      await rm(dir, { recursive: true, force: true })
      await mkdir(this.ctx.skillsDir, { recursive: true })
      await rename(staging, dir)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    this.ctx.log('skills', `installed ${id} from skills.sh as ${name}`)
    return name
  }

  /** For hub skills installed from the registry: is a newer snapshot available? */
  async checkUpdate(name: string): Promise<{ updateAvailable: boolean; current: string | null; latest: string | null }> {
    const skill = await this.skills.get(name)
    if (!skill.source) throw new Error(`${name} was not installed from skills.sh`)
    const data = await this.download(skill.source.id, true)
    const latest = data.hash ?? null
    return { updateAvailable: !!latest && latest !== skill.source.hash, current: skill.source.hash, latest }
  }

  private async download(id: string, fresh = false): Promise<DownloadResponse> {
    const parts = id.split('/')
    if (parts.length < 3 || parts.some((p) => !p || p === '..')) throw new Error(`Invalid registry id "${id}"`)
    const cached = this.cache.get(id)
    if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.data
    const [owner, repo, ...rest] = parts
    const url = `${this.base}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(rest.join('/'))}`
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } })
    if (res.status === 404) throw new Error('skills.sh has no downloadable snapshot for this skill yet')
    if (!res.ok) throw new Error(`skills.sh download failed (HTTP ${res.status})`)
    const data = (await res.json()) as DownloadResponse
    this.cache.set(id, { at: Date.now(), data })
    return data
  }

  /** registry id → local skill name, for skills installed from skills.sh. */
  private async installedSources(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const s of await this.skills.list()) if (s.source) out.set(s.source.id, s.name)
    return out
  }
}
