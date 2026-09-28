import type { AutoApprove, FileAccess, FileChange } from '@shared/types'
import type { LspManager } from './lsp'
import { buildWorkspaceTools, confine, describeWorkspaceTools, WORKSPACE_TOOL_NAMES, type ApprovalService, type CheckpointStore } from './workspace'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { UsageService } from '../core/usage'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Type, type Static, type TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { BuiltinToolInfo, RagHit, RagMode, WebResult } from '@shared/types'
import { formatHitsForModel, type RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'

export interface ToolDetails {
  durationMs?: number
  references?: RagHit[]
  changes?: FileChange[]
  subagent?: JsonValue
  [key: string]: JsonValue | RagHit[] | FileChange[] | undefined
}

export interface ToolDeps {
  rag: RagService
  skills: SkillService
  web: WebService
  custom: CustomToolService
  usage?: UsageService
  approvals?: ApprovalService
  checkpoints?: CheckpointStore
  lsp?: LspManager
}

export interface ToolScope {
  collectionIds: string[]
  knowledgeEnabled?: boolean
  skillsEnabled: boolean
  webEnabled?: boolean
  customTools?: boolean
  workspace: string | null
  /** Default read-only. Write access needs a session to ask for approvals. */
  fileAccess?: FileAccess
  shell?: boolean
  sessionId?: string
  autoApprove?: () => AutoApprove
  onAlways?: (scope: 'edits' | 'all') => void
  /** Offer the `task` tool (top-level chat agents only). */
  subagents?: boolean
  /** 0 for the chat agent, 1 inside a subagent. */
  depth?: number
  /** Language-server tools and post-edit type checks (default on). */
  codeIntel?: boolean
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
  if (ctx.scope.knowledgeEnabled === false) return []
  const all = ctx.deps.rag.listCollections()
  return ctx.scope.collectionIds.length ? all.filter((c) => ctx.scope.collectionIds.includes(c.id)) : all
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
    name: 'todo_write',
    label: 'Todo list',
    group: 'planning',
    availability: 'Chats (not headless flow agents)',
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: 'The task, as a short imperative sentence' }),
          status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])
        }),
        { description: 'The complete, updated list — it replaces the previous one' }
      )
    }),
    description: () =>
      'Plan and track multi-step work with a todo list the user can see. Write the full list each time (it replaces the previous one). Mark exactly one item in_progress while working on it and mark items completed as soon as they are done. Use for tasks with 3 or more steps; skip for simple questions.',
    when: (ctx) => !!ctx.scope.sessionId && !ctx.scope.depth,
    async run(p) {
      const todos = (p.todos ?? []).filter((t) => t && typeof t.content === 'string' && t.content.trim())
      const done = todos.filter((t) => t.status === 'completed').length
      const current = todos.find((t) => t.status === 'in_progress')
      return {
        text: todos.length ? `Todo list updated: ${done}/${todos.length} completed.${current ? ` In progress: ${current.content}` : ''}` : 'Todo list cleared.',
        details: { todos: todos.map((t) => ({ content: t.content.trim(), status: t.status })) }
      }
    }
  }),
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
    name: 'grep',
    label: 'Search files',
    group: 'workspace',
    availability: 'Chats with a workspace folder',
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), maxResults: Type.Optional(Type.Number()) }),
    description: () => 'Regex search (case-insensitive) across text files in the workspace, or in one file when path is a file. Returns path:line: text.',
    when: (ctx) => !!ctx.scope.workspace,
    async run(p, ctx, signal) {
      const re = new RegExp(p.pattern, 'i')
      const max = p.maxResults ?? 80
      const hits: string[] = []
      const base = await realpath(ctx.scope.workspace!)
      const root = await confine(ctx.scope.workspace!, p.path || '.')
      const searchFile = async (full: string) => {
        if ((await stat(full)).size > 1_000_000) return
        const text = await readFile(full, 'utf8').catch(() => '')
        if (text.includes('\u0000')) return
        text.split('\n').forEach((line, i) => {
          if (hits.length < max && re.test(line)) hits.push(`${relative(base, full).split(sep).join('/')}:${i + 1}: ${line.trim().slice(0, 200)}`)
        })
      }
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (hits.length >= max || signal?.aborted) return
          if (['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target'].includes(e.name)) continue
          const full = join(dir, e.name)
          if (e.isDirectory()) await walk(full)
          else if (e.isFile()) await searchFile(full)
        }
      }
      if ((await stat(root)).isFile()) await searchFile(root)
      else await walk(root)
      return { text: hits.join('\n') || 'No matches.' }
    }
  })
]

export const BUILTIN_NAMES = [...BUILTINS.map((b) => b.name), ...WORKSPACE_TOOL_NAMES, 'task']

export function describeBuiltins(): BuiltinToolInfo[] {
  return BUILTINS.map((b) => ({
    name: b.name,
    label: b.label,
    description: b.description(null),
    group: b.group,
    availability: b.availability,
    schema: JSON.parse(JSON.stringify(b.parameters))
  }))
    .concat(describeWorkspaceTools())
    .concat({
      name: 'task',
      label: 'Subagent',
      description: 'Delegate a self-contained job to a subagent with its own fresh context: a read-only scout for exploring and researching, or a worker that can also edit files (edits still need approval). Several can run in parallel; each returns a concise report.',
      group: 'planning',
      availability: 'Chats with subagents on',
      schema: { type: 'object', required: ['description', 'prompt'], properties: { description: { type: 'string' }, prompt: { type: 'string' }, role: { type: 'string', enum: ['scout', 'worker'] } } }
    })
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
  if (scope.workspace) {
    const writable = scope.fileAccess === 'write' && !!scope.sessionId
    tools.push(
      ...buildWorkspaceTools({
        root: scope.workspace,
        sessionId: scope.sessionId ?? null,
        access: writable ? 'write' : 'read',
        shell: !!scope.shell && !!scope.sessionId,
        approvals: deps.approvals ?? null,
        checkpoints: deps.checkpoints ?? null,
        autoApprove: scope.autoApprove ?? (() => 'none'),
        onAlways: scope.onAlways,
        lsp: scope.codeIntel !== false ? (deps.lsp ?? null) : null
      })
    )
  }
  if (scope.customTools !== false) for (const t of deps.custom.list()) if (t.enabled) tools.push(deps.custom.toAgentTool(t))
  const usage = deps.usage
  return usage ? tools.map((t) => withUsage(t, BUILTIN_NAMES.includes(t.name) ? 'builtin' : 'custom', usage)) : tools
}

/** Record every call of a tool (and skills loaded through skill_use) in the usage log. */
function withUsage<T extends AgentTool<any, ToolDetails>>(tool: T, kind: string, usage: UsageService): T {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const started = Date.now()
      try {
        const res = await tool.execute(id, params, signal, onUpdate)
        usage.tool(tool.name, kind, Date.now() - started, true)
        if (tool.name === 'skill_use' && params && typeof (params as { name?: unknown }).name === 'string' && !(params as { file?: unknown }).file) {
          usage.skill((params as { name: string }).name, 'tool')
        }
        return res
      } catch (err) {
        usage.tool(tool.name, kind, Date.now() - started, false)
        throw err
      }
    }
  }
}
