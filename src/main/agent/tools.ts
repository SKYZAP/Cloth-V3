import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { Type, type Static, type TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { BuiltinToolInfo, RagHit, RagMode, WebResult } from '@shared/types'
import { formatHitsForModel, type RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'

export interface ToolDetails {
  durationMs?: number
  references?: RagHit[]
  [key: string]: unknown
}

export interface ToolDeps {
  rag: RagService
  skills: SkillService
  web: WebService
  custom: CustomToolService
}

export interface ToolScope {
  collectionIds: string[]
  skillsEnabled: boolean
  webEnabled?: boolean
  customTools?: boolean
  workspace: string | null
}

interface Ctx {
  deps: ToolDeps
  scope: ToolScope
}

/** Declarative built-in tool: listed read-only on the Tools page, instantiated per chat by scope. */
interface BuiltinSpec<P extends TSchema = TSchema> {
  name: string
  label: string
  group: BuiltinToolInfo['group']
  availability: string
  parameters: P
  description(ctx: Ctx | null): string
  when(ctx: Ctx): boolean
  run(params: Static<P>, ctx: Ctx, signal?: AbortSignal): Promise<{ text: string; details?: ToolDetails }>
}

const spec = <P extends TSchema>(s: BuiltinSpec<P>): BuiltinSpec => s as unknown as BuiltinSpec

function scopedCollections(ctx: Ctx) {
  const all = ctx.deps.rag.listCollections()
  return ctx.scope.collectionIds.length ? all.filter((c) => ctx.scope.collectionIds.includes(c.id)) : all
}

function workspacePath(ctx: Ctx, p: string | undefined): { base: string; full: string } {
  const base = resolve(ctx.scope.workspace!)
  const full = resolve(base, p || '.')
  if (full !== base && !full.startsWith(base + sep)) throw new Error('Path is outside the workspace')
  return { base, full }
}

export function webToHits(results: WebResult[]): RagHit[] {
  return results.map((r, i) => ({
    chunkId: r.url,
    docId: r.url,
    collectionId: 'web',
    title: r.title,
    source: r.url,
    sourceType: 'url',
    headingPath: r.engine ? `web · ${r.engine}` : 'web',
    text: r.snippet,
    score: 1 - i / Math.max(results.length, 1),
    bm25Rank: null,
    vectorRank: null
  }))
}

export const BUILTINS: BuiltinSpec[] = [
  spec({
    name: 'rag_search',
    label: 'Knowledge search',
    group: 'knowledge',
    availability: 'Chats whose knowledge scope includes at least one collection',
    parameters: Type.Object({
      query: Type.String({ description: 'Focused search query' }),
      collections: Type.Optional(Type.Array(Type.String(), { description: 'Collection names to restrict to' })),
      k: Type.Optional(Type.Number({ description: 'Number of results (default 6)' })),
      mode: Type.Optional(Type.Union([Type.Literal('hybrid'), Type.Literal('keyword'), Type.Literal('vector')]))
    }),
    description: (ctx) =>
      `Search the local knowledge base (hybrid BM25 + vector).${ctx ? ` Collections: ${scopedCollections(ctx).map((c) => c.name).join(', ')}.` : ''} Call it several times with different phrasings when the first results are thin. Cite results as [n].`,
    when: (ctx) => scopedCollections(ctx).length > 0,
    async run(p, ctx) {
      const allowed = scopedCollections(ctx).map((c) => c.id)
      const requested = p.collections?.length ? p.collections.map((n) => ctx.deps.rag.findCollection(n)?.id).filter((id): id is string => !!id && allowed.includes(id)) : allowed
      const res = await ctx.deps.rag.search({ query: p.query, collectionIds: requested.length ? requested : allowed, k: p.k ?? 6, mode: (p.mode ?? 'hybrid') as RagMode })
      const notes = res.notes.length ? `\n\nNotes: ${res.notes.join('; ')}` : ''
      return { text: formatHitsForModel(res.hits) + notes, details: { references: res.hits } }
    }
  }),
  spec({
    name: 'web_search',
    label: 'Web search',
    group: 'web',
    availability: 'Chats with web access on; engine chosen in Settings (SearXNG or Obscura)',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      k: Type.Optional(Type.Number({ description: 'Number of results (default from Settings)' }))
    }),
    description: () => 'Search the public web. Returns titles, URLs and snippets; follow up with web_fetch to read a page. Cite results as [n].',
    when: (ctx) => !!ctx.scope.webEnabled,
    async run(p, ctx, signal) {
      const res = await ctx.deps.web.search(p.query, { k: p.k, signal })
      const text = res.results.length
        ? res.results.map((r, i) => `[${i + 1}] ${r.title}\nurl: ${r.url}\n${r.snippet}`).join('\n\n')
        : 'No results.'
      return { text: `${text}\n\n(engine: ${res.engine}, ${res.tookMs}ms)`, details: { references: webToHits(res.results), engine: res.engine } }
    }
  }),
  spec({
    name: 'web_fetch',
    label: 'Fetch web page',
    group: 'web',
    availability: 'Chats with web access on',
    parameters: Type.Object({ url: Type.String({ description: 'http(s) URL to read' }) }),
    description: () => 'Fetch a web page and return its main content as Markdown.',
    when: (ctx) => !!ctx.scope.webEnabled,
    async run(p, ctx, signal) {
      const page = await ctx.deps.web.fetchPage(p.url, signal)
      return { text: `# ${page.title}\nsource: ${p.url}\n\n${page.markdown}`, details: { url: p.url, via: page.via } }
    }
  }),
  spec({
    name: 'skill_list',
    label: 'List skills',
    group: 'skills',
    availability: 'Chats with skills on',
    parameters: Type.Object({}),
    description: () => 'List the skills available in the Cloth skill hub.',
    when: (ctx) => ctx.scope.skillsEnabled,
    async run(_p, ctx) {
      const skills = await ctx.deps.skills.list()
      return { text: skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') || 'No skills installed.' }
    }
  }),
  spec({
    name: 'skill_use',
    label: 'Load skill',
    group: 'skills',
    availability: 'Chats with skills on',
    parameters: Type.Object({
      name: Type.String(),
      file: Type.Optional(Type.String({ description: 'Relative path of a bundled file to read instead of SKILL.md' }))
    }),
    description: () => 'Load the full instructions of a skill by name (and optionally one of its bundled files). Load a skill before doing a task it covers.',
    when: (ctx) => ctx.scope.skillsEnabled,
    async run(p, ctx) {
      if (p.file) return { text: await ctx.deps.skills.readFile(p.name, p.file), details: { skill: p.name, file: p.file } }
      const s = await ctx.deps.skills.get(p.name)
      const extra = s.files.filter((f) => f !== 'SKILL.md' && f !== 'evals.json')
      return {
        text: `# Skill: ${s.name}\n${s.description}\n\n${s.body}${extra.length ? `\n\nBundled files (read with skill_use + file): ${extra.join(', ')}` : ''}`,
        details: { skill: s.name }
      }
    }
  }),
  spec({
    name: 'list_dir',
    label: 'List directory',
    group: 'workspace',
    availability: 'Chats with a workspace folder (read-only)',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    description: (ctx) => `List files in the workspace${ctx?.scope.workspace ? ` (${ctx.scope.workspace})` : ''}. Paths are relative to the workspace root.`,
    when: (ctx) => !!ctx.scope.workspace,
    async run(p, ctx) {
      const { full } = workspacePath(ctx, p.path)
      const entries = await readdir(full, { withFileTypes: true })
      const lines = entries
        .filter((e) => !['node_modules', '.git'].includes(e.name))
        .slice(0, 400)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      return { text: lines.join('\n') || '(empty)' }
    }
  }),
  spec({
    name: 'read_file',
    label: 'Read file',
    group: 'workspace',
    availability: 'Chats with a workspace folder (read-only)',
    parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
    description: () => 'Read a text file from the workspace. Use offset/limit (lines) for large files.',
    when: (ctx) => !!ctx.scope.workspace,
    async run(p, ctx) {
      const { full } = workspacePath(ctx, p.path)
      if ((await stat(full)).size > 5_000_000) throw new Error('File too large')
      const lines = (await readFile(full, 'utf8')).split('\n')
      const start = Math.max(0, (p.offset ?? 1) - 1)
      const slice = lines.slice(start, start + (p.limit ?? 400))
      const more = start + slice.length < lines.length ? `\n… (${lines.length} lines total)` : ''
      return { text: slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n') + more, details: { path: p.path } }
    }
  }),
  spec({
    name: 'grep',
    label: 'Search files',
    group: 'workspace',
    availability: 'Chats with a workspace folder (read-only)',
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), maxResults: Type.Optional(Type.Number()) }),
    description: () => 'Regex search across text files in the workspace. Returns path:line: text.',
    when: (ctx) => !!ctx.scope.workspace,
    async run(p, ctx, signal) {
      const re = new RegExp(p.pattern, 'i')
      const max = p.maxResults ?? 80
      const hits: string[] = []
      const { base, full: root } = workspacePath(ctx, p.path)
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (hits.length >= max || signal?.aborted) return
          if (['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target'].includes(e.name)) continue
          const full = join(dir, e.name)
          if (e.isDirectory()) await walk(full)
          else {
            if ((await stat(full)).size > 1_000_000) continue
            const text = await readFile(full, 'utf8').catch(() => '')
            if (text.includes('\u0000')) continue
            text.split('\n').forEach((line, i) => {
              if (hits.length < max && re.test(line)) hits.push(`${relative(base, full)}:${i + 1}: ${line.trim().slice(0, 200)}`)
            })
          }
        }
      }
      await walk(root)
      return { text: hits.join('\n') || 'No matches.' }
    }
  })
]

export const BUILTIN_NAMES = BUILTINS.map((b) => b.name)

export function describeBuiltins(): BuiltinToolInfo[] {
  return BUILTINS.map((b) => ({
    name: b.name,
    label: b.label,
    description: b.description(null),
    group: b.group,
    availability: b.availability,
    schema: JSON.parse(JSON.stringify(b.parameters))
  }))
}

function instantiate(b: BuiltinSpec, ctx: Ctx): AgentTool<TSchema, ToolDetails> {
  return {
    name: b.name,
    label: b.label,
    description: b.description(ctx),
    parameters: b.parameters,
    async execute(_id, params, signal): Promise<AgentToolResult<ToolDetails>> {
      const started = performance.now()
      const out = await b.run(params, ctx, signal)
      return { content: [{ type: 'text', text: out.text }], details: { ...(out.details ?? {}), durationMs: Math.round(performance.now() - started) } }
    }
  }
}

export function buildTools(deps: ToolDeps, scope: ToolScope): AgentTool<any, ToolDetails>[] {
  const ctx: Ctx = { deps, scope }
  const tools: AgentTool<any, ToolDetails>[] = BUILTINS.filter((b) => b.when(ctx)).map((b) => instantiate(b, ctx))
  if (scope.customTools !== false) for (const t of deps.custom.list()) if (t.enabled) tools.push(deps.custom.toAgentTool(t))
  return tools
}
