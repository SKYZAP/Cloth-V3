import type { AutoApprove, FileAccess, FileChange } from '@shared/types'
import type { LspManager } from './lsp'
import { buildWorkspaceTools, confine, describeWorkspaceTools, WORKSPACE_TOOL_NAMES, type ApprovalService, type CheckpointStore, type WorkspaceOptions } from './workspace'
import type { JsonValue } from '@earendil-works/pi-ai'
import type { UsageService } from '../core/usage'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Type, type Static, type TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { BuiltinToolInfo, RagHit, RagMode, ToolWhere, WebResult } from '@shared/types'
import { formatHitsForModel, type RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'
import { createSkill, createTool, indexKnowledge, RAG_INDEX_DESCRIPTION, SKILL_CREATE_DESCRIPTION, TOOL_CREATE_DESCRIPTION } from './hub'

export interface ToolDetails {
  durationMs?: number
  references?: RagHit[]
  changes?: FileChange[]
  subagent?: JsonValue
  image?: JsonValue
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
  /** Offer generate_image (chat agents, when an image model is configured). */
  images?: boolean
  /** Only these custom tools (by name); null/undefined = every enabled one. */
  toolNames?: string[] | null
  /** Only these skills (by name); null/undefined = all. */
  skillNames?: string[] | null
  /** Skills left out of the list and skill_use (a chat's Off skills). */
  skillsOff?: string[]
  /** Skills whose instructions are in the system prompt (a chat's Always skills). */
  skillsAlways?: string[]
  /** Tools switched off by name. */
  disabledTools?: string[]
  /** Only these tools, by name (an automation's exact list); null/undefined = no such limit. */
  onlyTools?: string[] | null
  /** The saved agent this agent is (it doesn't delegate to itself). */
  agentId?: string | null
  /** A file was written in the workspace by a custom tool (absolute path). */
  onFile?: (abs: string) => void
  /** External MCP servers (by id) whose tools this agent gets. */
  mcpServers?: string[]
  /** The workspace is a container copy: commands run there with bash. */
  container?: { image: string; folder: string | null; exec: NonNullable<WorkspaceOptions['shellExec']> }
}

/** Skills an agent with this scope may see and load. */
export function allowedSkill(scope: ToolScope, name: string): boolean {
  return (!scope.skillNames || scope.skillNames.includes(name)) && !scope.skillsOff?.includes(name)
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
  run(params: Static<P>, ctx: Ctx, signal: AbortSignal | undefined, toolCallId: string): Promise<{ text: string; details?: ToolDetails }>
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
    name: 'ask_user',
    label: 'Ask the user',
    group: 'planning',
    availability: 'Chats (not flows or subagents)',
    parameters: Type.Object({
      question: Type.String({ description: 'The question, self-contained and specific' }),
      options: Type.Optional(Type.Array(Type.String(), { description: 'Suggested answers to pick from (2-6 short options). Leave out for a free-text answer.' })),
      multiple: Type.Optional(Type.Boolean({ description: 'Allow picking several options (default false)' })),
      allowOther: Type.Optional(Type.Boolean({ description: 'Also accept a typed answer besides the options (default true)' }))
    }),
    description: () =>
      'Ask the user a question and wait for the answer. Use it when you need a decision, a preference or missing information that you cannot find out yourself, instead of guessing — e.g. choosing between approaches or confirming scope. Offer options when the likely answers are known. Ask one focused question at a time; do not ask for things you can look up.',
    when: (ctx) => !!ctx.scope.sessionId && !ctx.scope.depth && !!ctx.deps.approvals,
    async run(p, ctx, signal, toolCallId) {
      const options = [...new Set((p.options ?? []).map((o) => String(o).trim()).filter(Boolean))].slice(0, 8)
      const answer = await ctx.deps.approvals!.ask(
        { sessionId: ctx.scope.sessionId!, toolCallId, question: p.question.trim(), options, multiple: !!p.multiple && options.length > 1, allowOther: p.allowOther !== false || !options.length },
        signal
      )
      return answer === null
        ? { text: 'The user skipped this question. Continue with your best judgement and say which assumption you made.', details: { answer: null } }
        : { text: `The user answered: ${answer}`, details: { answer } }
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
    name: 'rag_index',
    label: 'Index knowledge',
    group: 'knowledge',
    availability: 'Chats with knowledge on (not flows or subagents; local paths only inside the workspace)',
    parameters: Type.Object({
      collection: Type.String({ description: 'Collection name, as the user gave it' }),
      create: Type.Optional(Type.Boolean({ description: 'Create the collection if it does not exist (default true)' })),
      description: Type.Optional(Type.String({ description: 'Description for a new collection' })),
      title: Type.Optional(Type.String({ description: 'Title for text' })),
      text: Type.Optional(Type.String({ description: 'Markdown or plain text to index' })),
      urls: Type.Optional(Type.Array(Type.String(), { description: 'Web pages to fetch and index' })),
      crawl: Type.Optional(Type.Boolean({ description: 'Follow links on the same site from each URL' })),
      maxPages: Type.Optional(Type.Number({ description: 'Page limit when crawling (default 25)' })),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Workspace files or folders to index' }))
    }),
    description: () => RAG_INDEX_DESCRIPTION,
    when: (ctx) => ctx.scope.knowledgeEnabled !== false && !!ctx.scope.sessionId && !ctx.scope.depth,
    async run(p, ctx) {
      const root = ctx.scope.workspace
      const text = await indexKnowledge(ctx.deps.rag, p, { resolvePath: root ? (x) => confine(root, x) : undefined })
      return { text, details: { collection: p.collection } }
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
      const skills = (await ctx.deps.skills.list()).filter((s) => allowedSkill(ctx.scope, s.name))
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
      if (!allowedSkill(ctx.scope, p.name)) throw new Error(`The skill "${p.name}" is not available here`)
      if (p.file) return { text: await ctx.deps.skills.readFile(p.name, p.file), details: { skill: p.name, file: p.file } }
      const s = await ctx.deps.skills.get(p.name)
      const extra = s.files.filter((f) => f !== 'SKILL.md' && f !== 'evals.json')
      return {
        text: `# Skill: ${s.name}\n${s.description}\n\n${ctx.deps.skills.instructions(s)}${extra.length ? `\n\nBundled files (read with skill_use + file): ${extra.join(', ')}` : ''}`,
        details: { skill: s.name }
      }
    }
  }),
  spec({
    name: 'skill_create',
    label: 'Create skill',
    group: 'skills',
    availability: 'Chats with skills on (not flows or subagents)',
    parameters: Type.Object({
      name: Type.String({ description: 'kebab-case name' }),
      description: Type.String({ description: 'What the skill does and when to use it' }),
      instructions: Type.String({ description: 'The SKILL.md body in Markdown' }),
      files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String() }), { description: 'Supporting files by relative path' }))
    }),
    description: () => SKILL_CREATE_DESCRIPTION,
    when: (ctx) => ctx.scope.skillsEnabled && !!ctx.scope.sessionId && !ctx.scope.depth,
    async run(p, ctx) {
      return { text: await createSkill(ctx.deps.skills, p), details: { skill: p.name } }
    }
  }),
  spec({
    name: 'tool_create',
    label: 'Create tool',
    group: 'tools',
    availability: 'Chats with custom tools on (not flows or subagents)',
    parameters: Type.Object({
      name: Type.String({ description: 'snake_case tool name' }),
      description: Type.String({ description: 'What the tool does and when to call it' }),
      kind: Type.Union([Type.Literal('http'), Type.Literal('javascript'), Type.Literal('command'), Type.Literal('prompt')]),
      params: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            type: Type.Optional(Type.Union([Type.Literal('string'), Type.Literal('number'), Type.Literal('boolean'), Type.Literal('json')])),
            description: Type.Optional(Type.String()),
            required: Type.Optional(Type.Boolean())
          })
        )
      ),
      config: Type.Record(Type.String(), Type.Any(), { description: 'Kind-specific settings (see the tool description)' }),
      replace: Type.Optional(Type.Boolean({ description: 'Update a tool you created earlier with this name' }))
    }),
    description: () => TOOL_CREATE_DESCRIPTION,
    when: (ctx) => ctx.scope.customTools !== false && !!ctx.scope.sessionId && !ctx.scope.depth,
    async run(p, ctx) {
      const { tool, text } = createTool(ctx.deps.custom, p, 'chat')
      return { text, details: { toolId: tool.id, enabled: tool.enabled } }
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

export const BUILTIN_NAMES = [...BUILTINS.map((b) => b.name), ...WORKSPACE_TOOL_NAMES, 'task', 'generate_image']

const W = (chats: boolean, subagents: boolean, flows: boolean, apps: boolean): ToolWhere => ({ chats, subagents, flows, apps })
/**
 * Where each built-in can be called. Follows each tool's `when`: subagents run at depth 1 in their chat's
 * session; flow Agent steps have no session, no shell, no code intelligence and no subagents; apps get
 * what Cloth's MCP server shares (MCP_SHARED_TOOLS).
 */
const WHERE: Record<string, ToolWhere> = {
  todo_write: W(true, false, false, false),
  ask_user: W(true, false, false, false),
  rag_search: W(true, true, true, true),
  rag_index: W(true, false, false, true),
  web_search: W(true, true, true, true),
  web_fetch: W(true, true, true, false),
  skill_list: W(true, true, true, true),
  skill_use: W(true, true, true, true),
  skill_create: W(true, false, false, true),
  tool_create: W(true, false, false, true),
  read: W(true, true, true, false),
  ls: W(true, true, true, false),
  find: W(true, true, true, false),
  grep: W(true, true, true, false),
  ast_grep: W(true, true, true, false),
  ast_edit: W(true, true, true, false),
  write: W(true, true, true, false),
  edit: W(true, true, true, false),
  lsp: W(true, true, false, false),
  bash: W(true, true, false, false),
  powershell: W(true, true, false, false),
  task: W(true, false, false, false)
}

export function describeBuiltins(): BuiltinToolInfo[] {
  return BUILTINS.map((b) => ({
    name: b.name,
    label: b.label,
    description: b.description(null),
    group: b.group,
    availability: b.availability,
    where: WHERE[b.name] ?? W(true, false, false, false),
    schema: JSON.parse(JSON.stringify(b.parameters))
  }))
    .concat(describeWorkspaceTools().map((t) => ({ ...t, where: WHERE[t.name] ?? W(true, true, true, false) })))
    .concat({
      name: 'task',
      label: 'Subagent',
      description: 'Delegate a self-contained job to a subagent with its own fresh context: a read-only scout for exploring and researching, or a worker that can also edit files (edits still need approval). Several can run in parallel; each returns a concise report.',
      group: 'planning',
      availability: 'Chats with subagents on',
      where: WHERE.task,
      schema: { type: 'object', required: ['description', 'prompt'], properties: { description: { type: 'string' }, prompt: { type: 'string' }, role: { type: 'string', enum: ['scout', 'worker'] } } }
    })
}

function instantiate(b: BuiltinSpec, ctx: Ctx): AgentTool<TSchema, ToolDetails> {
  return {
    name: b.name,
    label: b.label,
    description: b.description(ctx),
    parameters: b.parameters,
    async execute(id, params, signal): Promise<AgentToolResult<ToolDetails>> {
      const started = performance.now()
      const out = await b.run(params, ctx, signal, id)
      return { content: [{ type: 'text', text: out.text }], details: { ...(out.details ?? {}), durationMs: Math.round(performance.now() - started) } }
    }
  }
}

export function buildTools(deps: ToolDeps, scope: ToolScope): AgentTool<any, ToolDetails>[] {
  const ctx: Ctx = { deps, scope }
  const tools: AgentTool<any, ToolDetails>[] = BUILTINS.filter((b) => b.when(ctx)).map((b) => instantiate(b, ctx))
  // Writes need someone to approve them (a chat), or a policy that approves them up front (flows).
  const autoEdits = !!scope.autoApprove && scope.autoApprove() !== 'none'
  if (scope.workspace) {
    const writable = scope.fileAccess === 'write' && (!!scope.sessionId || autoEdits)
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
        lsp: scope.codeIntel !== false ? (deps.lsp ?? null) : null,
        shellExec: scope.container?.exec
      })
    )
  }
  if (scope.customTools !== false) {
    // Custom code may only write where file edits are already allowed without asking.
    const env = scope.workspace ? { workspace: { root: scope.workspace, writable: scope.fileAccess === 'write' && autoEdits, onWrite: scope.onFile } } : {}
    for (const t of deps.custom.list()) if (t.enabled && (!scope.toolNames || scope.toolNames.includes(t.name))) tools.push(deps.custom.toAgentTool(t, env))
  }
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
