import { basename } from 'node:path'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { ContainerSettings, GeneratedImage, ImageSize } from '@shared/types'
import { contextIsGuess } from '@shared/types'
import type { Agent as SavedAgent, AgentSetup, ApprovalDecision, ChatAttachment, ChatEvent, ChatSession, ChatSetup, ContextSlice, ContextSliceKey, ContextUsage, FileChange, ModelRef, PendingApproval, PendingQuestion, SubagentRun, SubagentSettings, ThinkingLevel, ToolTrace, UiAttachment, UiBlock, UiMessage } from '@shared/types'
import type { ProjectService } from './projects'
import { ROLE_BUILTINS, type AgentService } from './agents'
import type { McpClientService } from '../mcp/client'
import { attachmentContent, FILE_OPEN, parseFileBlock } from './attachments'
import type { ContainerService } from './containers'
import type { ApprovalService, CheckpointStore } from './workspace'
import type { LspManager } from './lsp'
import type { ImageService } from '../images'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import { DEFAULT_SUBAGENTS, type SettingsService } from '../core/settings'
import type { RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'
import { allowedSkill, buildTools, type ToolDetails, type ToolScope } from './tools'
import { runAsCall } from './workspace'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { budget, estimateHistory, findCut, splitSummary, summarize, SUMMARY_OPEN, withSummary } from './compaction'
import type { UsageService } from '../core/usage'

const SUBAGENT_INSTRUCTIONS = (role: 'scout' | 'worker') =>
  [
    'You are a subagent: another agent delegated this job to you. Work autonomously — you cannot ask the user or the other agent questions.',
    role === 'scout'
      ? 'You are a read-only scout: investigate with the tools you have and do not attempt to change anything.'
      : 'You are a worker: make the changes the job asks for, keeping them minimal. Each edit may be reviewed by the user.',
    'When done, reply with a concise report — it is all the other agent will see. Include concrete findings: file paths with line numbers, names, facts, and what you changed. No preamble.'
  ].join('\n')

const SLICE_LABELS: Record<ContextSliceKey, string> = {
  system: 'System prompt',
  tools: 'Tool definitions',
  skills: 'Invoked skills',
  summary: 'Summary',
  user: 'Your messages',
  assistant: 'Replies & thinking',
  toolResults: 'Tool calls & results'
}

const TITLE_SYSTEM = `You name chat conversations for a sidebar. Reply with the title only: 2 to 6 words that say specifically what the conversation is about — the project, task, file or question — in sentence case. No quotes, no trailing punctuation, no emoji, and never generic words like "Chat", "Help", "Question" or "Conversation".`

/** A model's reply turned into a sidebar title (or '' when it gave nothing usable). */
export function cleanTitle(raw: string): string {
  const line =
    raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  let t = line
    .replace(/[*_`#]+/g, '')
    .replace(/^(title|chat title)\s*[:\-–]\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .trim()
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '')
  return t
}

const SKILL_OPEN = '<skill-invocation name="'
const SKILL_CLOSE = '</skill-invocation>'

type SessionConfig = Omit<ChatSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>

interface SessionRow {
  id: string
  title: string
  config: string
  messages: string
  archive?: string
  preview?: string | null
  created_at: number
  updated_at: number
}

const DEFAULT_CONFIG: SessionConfig = {
  model: null,
  systemPrompt: '',
  collectionIds: [],
  knowledgeEnabled: true,
  skillsEnabled: true,
  webEnabled: false,
  customTools: true,
  workspace: null,
  fileAccess: 'read',
  shell: false,
  autoApprove: 'none',
  subagents: true,
  codeIntel: true,
  imagesEnabled: true,
  thinking: 'off',
  projectId: null,
  container: null,
  mcpServers: null,
  disabledTools: [],
  skillsOff: [],
  skillsAlways: [],
  agentId: null
}

/** The capability switches a chat copies from an agent when it is set up from one. */
const SETUP_KEYS: (keyof AgentSetup)[] = ['skillsEnabled', 'skillsOff', 'skillsAlways', 'webEnabled', 'customTools', 'subagents', 'codeIntel', 'imagesEnabled', 'knowledgeEnabled', 'collectionIds', 'mcpServers', 'disabledTools', 'fileAccess', 'shell', 'autoApprove']

/** An agent's switches as a tool scope (its folder access capped at what the caller has). */
export function agentScope(agent: AgentSetup, base: ToolScope): ToolScope {
  const write = agent.fileAccess === 'write' && base.fileAccess === 'write'
  return {
    ...base,
    skillsEnabled: agent.skillsEnabled,
    skillsOff: agent.skillsOff,
    skillsAlways: agent.skillsAlways,
    webEnabled: agent.webEnabled,
    customTools: agent.customTools,
    codeIntel: agent.codeIntel,
    images: agent.imagesEnabled,
    knowledgeEnabled: agent.knowledgeEnabled,
    collectionIds: agent.collectionIds,
    disabledTools: agent.disabledTools,
    fileAccess: write ? 'write' : 'read',
    shell: !!base.shell && agent.shell
  }
}

export interface AgentRunOptions {
  model: ModelRef
  prompt: string
  systemPrompt?: string
  scope: ToolScope
  thinking?: ThinkingLevel
  history?: AgentMessage[]
  signal?: AbortSignal
  maxTurns?: number
  onEvent?: (turn: UiMessage) => void
}

/** Built-in tools the Tools page can run on their own: they only read. */
export const TRYABLE = ['web_search', 'web_fetch', 'rag_search', 'skill_list', 'read', 'ls', 'find', 'grep', 'ast_grep']
const FOLDER_TOOLS = ['read', 'ls', 'find', 'grep', 'ast_grep']

export class AgentRuntime {
  constructor(
    readonly providers: ProviderService,
    private rag: RagService,
    private skills: SkillService,
    private web: WebService,
    private custom: CustomToolService,
    private ws: { approvals?: ApprovalService; checkpoints?: CheckpointStore; lsp?: LspManager; images?: ImageService; settings?: SettingsService; mcp?: McpClientService; agents?: AgentService } = {}
  ) {}

  get mcpClients(): McpClientService | undefined {
    return this.ws.mcp
  }

  /** Saved agents other agents may hand work to by name. */
  private delegates(self?: string | null): SavedAgent[] {
    return (this.ws.agents?.list() ?? []).filter((a) => (!a.builtin || !ROLE_BUILTINS.includes(a.builtin)) && a.id !== self)
  }

  private subagentSettings(): SubagentSettings {
    return this.ws.settings?.get().subagents ?? DEFAULT_SUBAGENTS
  }

  // Subagents running now across every chat, and the tasks waiting for a slot.
  private activeSubagents = 0
  private subagentQueue: (() => void)[] = []

  private async subagentSlot(signal: AbortSignal | undefined, onWait: () => void): Promise<() => void> {
    const limit = Math.max(1, this.subagentSettings().maxParallel)
    if (this.activeSubagents >= limit) {
      onWait()
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', cancel)
          resolve()
        }
        const cancel = () => {
          this.subagentQueue = this.subagentQueue.filter((f) => f !== go)
          reject(new Error('Cancelled'))
        }
        signal?.addEventListener('abort', cancel, { once: true })
        this.subagentQueue.push(go)
      })
    }
    this.activeSubagents++
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeSubagents--
      this.subagentQueue.shift()?.()
    }
  }

  async systemPrompt(scope: ToolScope, extra: string): Promise<string> {
    const lines = [
      'You are Cloth, a local developer assistant running inside an offline developer hub.',
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
      'Be precise and concise. Use Markdown. Prefer showing code over describing it.'
    ]
    const collections = scope.knowledgeEnabled === false ? [] : this.rag.listCollections().filter((c) => !scope.collectionIds.length || scope.collectionIds.includes(c.id))
    if (collections.length) {
      lines.push(
        '',
        '## Knowledge base',
        'Use `rag_search` whenever the question may be answered by the local knowledge base. Search iteratively: refine queries if results are weak. Ground claims in results and cite them inline as [n] using the numbers from the most recent search. If the knowledge base has nothing relevant, say so.',
        ...collections.map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''} (${c.docCount} docs)`)
      )
    }
    const installed = scope.skillsEnabled || scope.skillsAlways?.length ? await this.skills.list().catch(() => []) : []
    if (scope.skillsEnabled) {
      const skills = installed.filter((s) => allowedSkill(scope, s.name) && !scope.skillsAlways?.includes(s.name))
      if (skills.length) {
        lines.push('', '## Skills', 'Load a skill with `skill_use` before doing a task it covers.', ...skills.map((s) => `- ${s.name}: ${s.description}`))
      }
    }
    for (const s of installed.filter((x) => scope.skillsAlways?.includes(x.name))) {
      lines.push('', `## Skill: ${s.name} (always on)`, 'Follow this skill whenever it applies.', '', this.skills.instructions(s))
    }
    if (scope.webEnabled) {
      lines.push('', '## Web', 'You can search the public web with `web_search` and read pages with `web_fetch`. Prefer the local knowledge base for project-specific questions; use the web for current or external information, and cite web results as [n].')
    }
    if (scope.subagents && !scope.depth) {
      lines.push(
        '',
        '## Subagents',
        'Use `task` to hand a self-contained job to a subagent with its own fresh context — e.g. exploring a large codebase, researching a question across many files or pages, or independent investigations you can run in parallel (call `task` several times in one turn). role "scout" is read-only; role "worker" can also edit files. Give the subagent everything it needs in the prompt: it cannot see this conversation. It returns a concise report; relay what matters. Do simple lookups yourself.'
      )
      const named = this.delegates(scope.agentId)
      if (named.length) lines.push('These saved agents can take a job (pass its name as `agent`) when the job matches their purpose:', ...named.map((a) => `- ${a.name}: ${a.purpose || 'no purpose given'}`))
    }
    const external = this.ws.mcp?.tools(scope) ?? []
    if (external.length) {
      const servers = [...new Set(external.map((t) => t.name.split('__')[1]))]
      lines.push('', '## External tools', `Tools from these MCP servers are available (named mcp__<server>__<tool>): ${servers.join(', ')}.${servers.includes('playwright') ? ' With Playwright you can open pages in a real browser, interact with them and take screenshots — use it to check UI you build (open the page, look at the screenshot or snapshot, fix what is off).' : ''}`)
    }
    if (this.imagesAvailable(scope)) lines.push('', '## Images', 'You can create images with `generate_image` when the user asks for a picture, illustration, logo, mockup or similar. The image appears inline for the user.')
    if (scope.sessionId && !scope.depth) {
      lines.push('', '## Planning', 'For tasks with three or more steps, keep a todo list with `todo_write`: write the plan first, mark one item in_progress while you work on it, and mark items completed as you finish them. Skip it for simple questions.')
      if (this.ws.approvals) lines.push('When you need a decision, a preference or information only the user has before you can continue, ask with the `ask_user` tool (offer options when you can) instead of guessing or ending your reply with questions — the user answers in the chat and you carry on with the answer. Ask one question per call; call it again for the next one. Do not ask about things you can find out yourself.')
    }
    if (scope.workspace) {
      // The same rules the tools are built with (buildTools): outside a chat, changes and commands need approval up front, an allowlist or a container.
      const unattended = !scope.sessionId
      const autoEdits = !!scope.autoApprove && scope.autoApprove() !== 'none'
      const writable = scope.fileAccess === 'write' && (!!scope.sessionId || autoEdits)
      const shell = scope.shell && (scope.sessionId || scope.commandAllow?.length || scope.container) ? (scope.container || process.platform !== 'win32' ? 'bash' : 'powershell') : null
      lines.push(
        '',
        '## Workspace',
        scope.container
          ? `You work in an isolated copy of ${scope.container.folder ? `the user's folder ${scope.container.folder}` : 'an empty workspace'}, inside a Linux container (image ${scope.container.image}) where it is mounted at /workspace. Tool paths are relative to the workspace root: write "src/app.ts", never an absolute path. Your file changes stay in the copy until the user reviews them and applies them to their folder, so work freely — but say what you changed when you finish. Dependencies (node_modules, .venv) are not copied: install them in the container when you need them.`
          : `The workspace root is ${scope.workspace}. Tool paths are relative to that root: write "src/app.ts", never "${basename(scope.workspace)}/src/app.ts" or an absolute path. Nothing outside the workspace is accessible.`,
        'Explore with ls, find (glob) and grep, and read files with read before changing or quoting them. For code structure (calls, definitions, usages) prefer ast_grep: patterns are code with $NAME / $$$ARGS placeholders, e.g. `fetch($URL, $$$REST)`.',
        writable
          ? unattended
            ? 'You can change files: use ast_edit for mechanical refactors across many places, edit for targeted changes to existing files (exact text replacement) and write for new files or full rewrites. Nobody is watching this run, so changes are made without asking: keep them minimal and focused on the task, and say what you changed when you finish.'
            : 'You can change files: use ast_edit for mechanical refactors across many places (renames, API migrations), edit for targeted changes to existing files (exact text replacement) and write for new files or full rewrites. The user reviews each change as a diff and may decline it — if a change is declined, do not retry it; ask what they would like instead. Keep changes minimal and focused on the request.'
          : 'Access is read-only: you cannot create or modify files. If the user asks for changes, show them as code instead.',
        ...(scope.codeIntel !== false ? ['Use `lsp` for TypeScript/JavaScript/Python code intelligence: go to definition, find references, hover types, outline symbols, and check diagnostics. After you change such files, type errors are reported in the tool result — fix them before finishing.'] : []),
        ...(shell
          ? [
              scope.container
                ? `You can run commands with bash in the container (working directory /workspace). It is Linux: use its package manager or language tools to install what you need. ${unattended ? 'Nobody is watching this run, so commands run without asking.' : 'Unless the user auto-approves commands, they approve each one, so explain why a command is needed.'}`
                : scope.commandAllow?.length
                  ? `You can run only these commands with ${shell} (working directory = the workspace), each on its own and with any arguments: ${scope.commandAllow.map((c) => `\`${c}\``).join(', ')}. Anything else, or chaining commands with ; && | or redirects, is refused.`
                  : `You can run commands with ${shell} (working directory = the workspace). The user approves each command, so prefer read-only commands and explain why a command is needed.`,
              ...(scope.container
                ? [
                    'Commands are stopped after 5 minutes unless you pass a larger timeout. Never run servers or other long-running processes in the foreground: start them in the background with output to a log file, listening on 0.0.0.0 (e.g. `nohup npm run dev -- --host 0.0.0.0 > /tmp/dev.log 2>&1 &`), then check they respond (e.g. with curl) and tell the user the port. Cloth opens container servers on the user’s PC automatically.'
                  ]
                : scope.commandAllow?.length
                  ? []
                  : [
                      `Commands are stopped after 5 minutes unless you pass a larger timeout. Never run servers or other long-running processes in the foreground: start them in the background with output to a log file (e.g. ${shell === 'bash' ? '`nohup npm run dev > /tmp/dev.log 2>&1 &`' : "`Start-Process npm -ArgumentList 'run','dev' -RedirectStandardOutput dev.log`"}), then check they respond (e.g. with curl) and tell the user the port.`
                    ])
            ]
          : [])
      )
    }
    if (extra.trim()) lines.push('', '## Instructions', extra.trim())
    return lines.join('\n')
  }

  /**
   * Run one built-in tool outside any chat, for the Tools page's Try it. Only tools that read are
   * offered: nobody is there to approve a change or a command.
   */
  async tryTool(name: string, args: Record<string, unknown>, folder: string | null): Promise<string> {
    if (!TRYABLE.includes(name)) throw new Error(`${name} changes things or needs a chat, so it can't be tried here`)
    const scope: ToolScope = { collectionIds: [], knowledgeEnabled: true, skillsEnabled: false, webEnabled: true, customTools: false, workspace: folder, fileAccess: 'read', shell: false, codeIntel: false, subagents: false }
    const tool = this.toolset({ model: { providerId: '', modelId: '' }, scope }).find((t) => t.name === name)
    if (!tool) throw new Error(folder || !FOLDER_TOOLS.includes(name) ? `${name} isn't available` : 'Pick a folder for this tool to look in')
    const out = await tool.execute(`try_${Date.now()}`, args)
    return out.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n')
  }

  /** The tools an agent with this scope gets, without the ones switched off by name. */
  private toolset(parent: Omit<AgentRunOptions, 'prompt'>, usage = false): AgentTool<any, ToolDetails>[] {
    const scope = parent.scope
    const off = new Set(scope.disabledTools ?? [])
    const only = scope.onlyTools ? new Set(scope.onlyTools) : null
    return [
      ...buildTools({ rag: this.rag, skills: this.skills, web: this.web, custom: this.custom, ...(usage ? { usage: this.providers.usage } : {}), ...this.ws }, scope),
      ...(scope.subagents && !scope.depth ? [this.taskTool(parent)] : []),
      ...(this.imagesAvailable(scope) ? [this.imageTool()] : []),
      ...(this.ws.mcp?.tools(scope) ?? [])
    ].filter((t) => !off.has(t.name) && (!only || only.has(t.name)))
  }

  /** The tool declarations an agent with this scope is given, as the model sees them. */
  toolDefinitions(scope: ToolScope): string {
    const tools = this.toolset({ model: { providerId: '', modelId: '' }, scope })
    return JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })))
  }

  /**
   * Everything a chat's setup could add to a request, item by item: every tool it could have with its
   * folder settings (switched on or not), its skills, and the knowledge section.
   */
  async setup(scope: ToolScope, servers: string[]): Promise<ChatSetup> {
    const est = (s: string) => Math.ceil(s.length / 4)
    const model = { providerId: '', modelId: '' }
    const live = new Set(this.toolset({ model, scope }).map((t) => t.name))
    const full: ToolScope = { ...scope, webEnabled: true, customTools: true, subagents: true, images: true, skillsEnabled: true, knowledgeEnabled: true, codeIntel: true, disabledTools: [], skillsOff: [], mcpServers: servers }
    const tools = this.toolset({ model, scope: full }).map((t) => ({
      name: t.name,
      description: t.description,
      tokens: est(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })),
      on: live.has(t.name)
    }))
    const skills = (await this.skills.list().catch(() => []))
      .filter((s) => !scope.skillNames || scope.skillNames.includes(s.name))
      .map((s) => ({
        name: s.name,
        description: s.description,
        mode: (scope.skillsOff?.includes(s.name) ? 'off' : scope.skillsAlways?.includes(s.name) ? 'always' : 'auto') as ChatSetup['skills'][number]['mode'],
        listedTokens: est(`- ${s.name}: ${s.description}\n`),
        fullTokens: est(this.skills.instructions(s))
      }))
    const collections = scope.knowledgeEnabled === false ? [] : this.rag.listCollections().filter((c) => !scope.collectionIds.length || scope.collectionIds.includes(c.id))
    const knowledgeTokens = collections.length ? est('## Knowledge base\nUse `rag_search` whenever the question may be answered by the local knowledge base. Search iteratively: refine queries if results are weak. Ground claims in results and cite them inline as [n] using the numbers from the most recent search. If the knowledge base has nothing relevant, say so.') + collections.reduce((n, c) => n + est(`- ${c.name}${c.description ? ` — ${c.description}` : ''} (${c.docCount} docs)\n`), 0) : 0
    return { tools, skills, knowledgeTokens }
  }

  createAgent(opts: Omit<AgentRunOptions, 'prompt'> & { systemPrompt: string }): Agent {
    const { model } = this.providers.resolve(opts.model)
    const agent = new Agent({
      initialState: {
        systemPrompt: opts.systemPrompt,
        model,
        thinkingLevel: model.reasoning ? (opts.thinking ?? 'off') : 'off',
        tools: this.toolset(opts, true),
        messages: opts.history ?? []
      },
      streamFn: streamSimple,
      getApiKey: async (providerId) => this.providers.apiKey(providerId) || 'cloth-local',
      toolExecution: 'parallel'
    })
    this.providers.usage.track(agent)
    return agent
  }

private imagesAvailable(scope: ToolScope): boolean {
    return !!scope.images && !scope.depth && !!scope.sessionId && !!this.ws.images?.defaultModel()
  }

  /** generate_image: create an image with the configured image model; the UI shows it inline. */
  private imageTool(): AgentTool<any, ToolDetails> {
    const images = this.ws.images!
    return {
      name: 'generate_image',
      label: 'Generate image',
      description:
        'Create an image from a text description with the image model configured in Cloth. The user sees the image inline in the chat, so do not repeat a link. Write a rich prompt: subject, composition, style, lighting, colours, and any text that must appear.',
      parameters: Type.Object({
        prompt: Type.String({ description: 'Detailed description of the image' }),
        size: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('1024x1024'), Type.Literal('1536x1024'), Type.Literal('1024x1536')], { description: 'square, landscape or portrait (default auto)' }))
      }),
      execute: async (_id, params, signal, onUpdate) => {
        const p = params as { prompt: string; size?: ImageSize }
        const model = images.defaultModel()
        const base: GeneratedImage = { status: 'generating', prompt: p.prompt, size: p.size ?? 'auto', model: model?.modelId, startedAt: Date.now() }
        onUpdate?.({ content: [{ type: 'text', text: 'Generating…' }], details: { image: base } as unknown as ToolDetails })
        const img = await images.generate({ prompt: p.prompt, size: p.size, signal })
        const image: GeneratedImage = { id: img.id, status: 'complete', prompt: img.prompt, revisedPrompt: img.revisedPrompt, size: img.size, width: img.width, height: img.height, model: img.model, startedAt: base.startedAt }
        const dims = img.width && img.height ? `${img.width}×${img.height} ` : ''
        return {
          content: [{ type: 'text', text: `Generated a ${dims}image with ${img.model}; it is shown to the user.${img.revisedPrompt ? ` The model revised the prompt to: ${img.revisedPrompt}` : ''}` }],
          details: { image } as unknown as ToolDetails
        }
      }
    }
  }

  /** The `task` tool: run a subagent with a fresh context and a scoped toolset. */
  private taskTool(parent: Omit<AgentRunOptions, 'prompt'>): AgentTool<any, ToolDetails> {
    return {
      name: 'task',
      label: 'Subagent',
      description: this.subagentSettings().allowWorkers
        ? 'Run a subagent on a self-contained job with its own fresh context and return its report. role "scout" (default) can read and search but not change anything; role "worker" can also edit files in the workspace. The subagent cannot see this conversation — put everything it needs in prompt.'
        : 'Run a read-only subagent on a self-contained job with its own fresh context and return its report. It can read and search but not change anything. The subagent cannot see this conversation — put everything it needs in prompt.',
      parameters: Type.Object({
        description: Type.String({ description: 'Short label for the job (3–6 words), shown to the user' }),
        prompt: Type.String({ description: 'Complete instructions: goal, relevant context, and what to report back' }),
        role: Type.Optional(Type.Union([Type.Literal('scout'), Type.Literal('worker')])),
        ...(this.delegates(parent.scope.agentId).length ? { agent: Type.Optional(Type.String({ description: `A saved agent to run instead of a plain scout or worker: ${this.delegates(parent.scope.agentId).map((a) => a.name).join(', ')}` })) } : {})
      }),
      execute: async (id, params, signal, onUpdate) => {
        const p = params as { description: string; prompt: string; role?: 'scout' | 'worker'; agent?: string }
        const cfg = this.subagentSettings()
        const named = p.agent ? this.ws.agents?.byName(p.agent) : null
        if (p.agent && !named) throw new Error(`There is no agent called "${p.agent}". Use role scout or worker instead.`)
        const wantsWrite = named ? named.fileAccess === 'write' : p.role === 'worker'
        const role: SubagentRun['role'] = wantsWrite && cfg.allowWorkers && parent.scope.fileAccess === 'write' ? 'worker' : 'scout'
        const builtin = this.ws.agents?.builtin(role)
        let scope: ToolScope = { ...parent.scope, depth: 1, subagents: false, ...(role === 'scout' ? { fileAccess: 'read' as const, shell: false } : {}) }
        if (named) {
          scope = { ...agentScope(named, scope), depth: 1, subagents: false }
          if (named.mcpServers && this.ws.mcp) {
            scope.mcpServers = this.ws.mcp.chatServers(named.mcpServers)
            await this.ws.mcp.ensure(scope.mcpServers)
          }
        }
        const usable = (m: ModelRef | null | undefined): m is ModelRef => !!m && this.providers.list().some((pr) => pr.id === m.providerId && pr.enabled)
        // The agent's own model, then the subagent model, unless its provider is gone or switched off.
        const own = named?.model ?? builtin?.model
        const model = usable(own) ? own : usable(cfg.model) ? cfg.model : parent.model
        const base = { role, ...(named ? { agent: named.name } : {}), description: p.description || named?.name || 'Subagent', model: model.modelId }
        const release = await this.subagentSlot(signal, () =>
          onUpdate?.({ content: [{ type: 'text', text: 'Queued…' }], details: { subagent: { ...base, blocks: [], running: true } } as unknown as ToolDetails })
        )
        const started = Date.now()
        const { result, changes } = await runAsCall(id, 'task', signal, () =>
          this.run({
            model,
            prompt: p.prompt,
            systemPrompt: [SUBAGENT_INSTRUCTIONS(role), named ? `You are the "${named.name}" agent. ${named.purpose}` : '', (named ?? builtin)?.instructions.trim() ?? cfg.instructions.trim()].filter(Boolean).join('\n\n'),
            scope,
            thinking: (named ?? builtin)?.thinking ?? (cfg.thinking === 'inherit' ? parent.thinking : cfg.thinking),
            signal,
            maxTurns: Math.max(1, cfg.maxTurns),
            onEvent: (turn) =>
              onUpdate?.({ content: [{ type: 'text', text: 'Working…' }], details: { subagent: { ...base, blocks: turn.blocks, running: true } } as unknown as ToolDetails })
          })
        )
          .catch((err) => {
            this.providers.usage.tool('task', 'builtin', Date.now() - started, false)
            const who = named ?? builtin
            if (who) this.providers.usage.agentRun(who.id, role, Date.now() - started, false)
            throw err
          })
          .finally(release)
        this.providers.usage.tool('task', 'builtin', Date.now() - started, true)
        const who = named ?? builtin
        if (who) this.providers.usage.agentRun(who.id, role, Date.now() - started, true)
        return {
          content: [{ type: 'text', text: result.text || '(the subagent finished without a report)' }],
          details: { subagent: { ...base, blocks: result.turn.blocks, running: false, usage: result.turn.usage }, ...(changes.length ? { changes } : {}) } as unknown as ToolDetails
        }
      }
    }
  }

  /** Headless agent run (workflows, MCP). Returns the final assistant text and the turn trace. */
  async run(opts: AgentRunOptions): Promise<{ text: string; turn: UiMessage; messages: AgentMessage[] }> {
    const systemPrompt = await this.systemPrompt(opts.scope, opts.systemPrompt ?? '')
    const agent = this.createAgent({ ...opts, systemPrompt })
    const startIndex = agent.state.messages.length
    let turns = 0
    const maxTurns = opts.maxTurns ?? 12
    agent.subscribe((e) => {
      if (e.type === 'turn_end' && ++turns >= maxTurns) agent.abort()
      if (opts.onEvent && (e.type === 'message_end' || e.type === 'tool_execution_start' || e.type === 'tool_execution_end')) {
        const turn = toUiMessages(agent.state.messages.slice(startIndex), agent.state.pendingToolCalls).at(-1)
        if (turn?.role === 'assistant') opts.onEvent(turn)
      }
    })
    opts.signal?.addEventListener('abort', () => agent.abort(), { once: true })
    await agent.prompt(opts.prompt)
    const messages = agent.state.messages
    const turn = toUiMessages(messages.slice(startIndex)).filter((m) => m.role === 'assistant').at(-1)
    if (!turn) throw new Error(agent.state.errorMessage || 'Agent produced no response')
    if (turn.error) throw new Error(turn.error)
    const text = turn.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim()
    return { text, turn, messages }
  }
}

export class ChatService {
  private active = new Map<string, Agent>()
  private compacting = new Set<string>()
  /** Summary to reattach when the message carrying it was rewound away. */
  private carry = new Map<string, string>()

  constructor(
    private ctx: Ctx,
    private runtime: AgentRuntime,
    private settings: SettingsService,
    private skills: SkillService,
    private usage?: UsageService,
    private approvals?: ApprovalService,
    private checkpoints?: CheckpointStore,
    private projects?: ProjectService,
    private containers?: ContainerService,
    private agents?: AgentService
  ) {}

  list(): ChatSession[] {
    const rows = this.ctx.db.prepare('SELECT id, title, config, preview, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[]
    // Chats from before previews existed get theirs worked out once.
    const fill = this.ctx.db.prepare('UPDATE sessions SET preview = ? WHERE id = ?')
    for (const r of rows) {
      if (r.preview !== null && r.preview !== undefined) continue
      r.preview = previewOf(this.rawMessages(r.id))
      fill.run(r.preview, r.id)
    }
    return rows.map(toSession)
  }

  get(id: string): ChatSession {
    return toSession(this.row(id))
  }

  create(config: Partial<SessionConfig> = {}, id = newId('ses_')): ChatSession {
    const now = Date.now()
    const s = this.settings.get()
    // A chat started in a project begins with the project's folder and settings.
    const fromProject = config.projectId && this.projects ? this.projects.chatConfig(config.projectId) : {}
    const full: SessionConfig = { ...DEFAULT_CONFIG, model: s.defaultModel, subagents: s.subagents.enabledByDefault, ...fromProject, ...config }
    if (!full.model) full.model = s.defaultModel
    this.ctx.db.prepare('INSERT INTO sessions (id, title, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, 'New chat', JSON.stringify(full), now, now)
    return this.get(id)
  }

  update(id: string, patch: Partial<SessionConfig> & { title?: string }): ChatSession {
    const cur = this.get(id)
    const { title, ...config } = patch
    const next: SessionConfig = {
      model: cur.model,
      systemPrompt: cur.systemPrompt,
      collectionIds: cur.collectionIds,
      knowledgeEnabled: cur.knowledgeEnabled,
      skillsEnabled: cur.skillsEnabled,
      webEnabled: cur.webEnabled,
      customTools: cur.customTools,
      workspace: cur.workspace,
      fileAccess: cur.fileAccess,
      shell: cur.shell,
      autoApprove: cur.autoApprove,
      subagents: cur.subagents,
      codeIntel: cur.codeIntel,
      imagesEnabled: cur.imagesEnabled,
      thinking: cur.thinking,
      titleSource: cur.titleSource,
      titleTurns: cur.titleTurns,
      projectId: cur.projectId,
      container: cur.container,
      mcpServers: cur.mcpServers,
      disabledTools: cur.disabledTools,
      skillsOff: cur.skillsOff,
      skillsAlways: cur.skillsAlways,
      agentId: cur.agentId,
      ...config
    }
    // A title set without saying where it came from was typed by the user: AI titles leave it alone.
    if (title !== undefined && config.titleSource === undefined) next.titleSource = 'user'
    this.ctx.db.prepare('UPDATE sessions SET title = ?, config = ?, updated_at = ? WHERE id = ?').run(title ?? cur.title, JSON.stringify(next), Date.now(), id)
    return this.get(id)
  }

  remove(id: string): void {
    this.abort(id)
    this.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    void this.checkpoints?.removeSession(id)
    void this.containers?.remove(id).catch(() => undefined)
  }

  pendingApprovals(id: string): PendingApproval[] {
    return this.approvals?.list(id) ?? []
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    if (!this.approvals) throw new Error('Approvals are not available')
    this.approvals.resolve(approvalId, decision)
  }

  pendingQuestions(id: string): PendingQuestion[] {
    return this.approvals?.listQuestions(id) ?? []
  }

  answerQuestion(questionId: string, answer: string | null): void {
    if (!this.approvals) throw new Error('Questions are not available')
    this.approvals.answer(questionId, answer)
  }

  /** Restore the files one tool call changed, and mark its changes as undone in the history. */
  async undoChange(id: string, toolCallId: string, force = false): Promise<UiMessage[]> {
    if (!this.checkpoints) throw new Error('Checkpoints are not available')
    if (this.active.has(id)) throw new Error('Wait for the agent to finish before undoing')
    await this.checkpoints.undo(id, toolCallId, force)
    const raw = this.rawMessages(id)
    for (const m of raw) {
      if (m.role !== 'toolResult' || m.toolCallId !== toolCallId) continue
      const details = (m.details ?? {}) as { changes?: FileChange[] }
      if (details.changes) details.changes = details.changes.map((c) => ({ ...c, undone: true }))
    }
    this.saveMessages(id, raw)
    return this.messages(id)
  }

  messages(id: string): UiMessage[] {
    const archived = toUiMessages(this.archive(id)).map((m) => ({ ...m, archived: true }))
    return [...archived, ...toUiMessages(this.rawMessages(id))]
  }

  /** How full the model's context is, and where auto-summarising kicks in. */
  async contextUsage(id: string): Promise<ContextUsage> {
    const session = this.get(id)
    // Keep the model's limit current (throttled; offline providers keep what they had).
    if (session.model) await this.runtime.providers.refreshModel(session.model).catch(() => undefined)
    const window = session.model ? this.contextWindow(session.model) : null
    const raw = this.rawMessages(id)
    const scope = this.scope(id)
    const est = (s: string) => Math.ceil(s.length / 4)
    const parts: Record<ContextSliceKey, number> = { system: 0, tools: 0, skills: 0, summary: 0, user: 0, assistant: 0, toolResults: 0 }
    parts.system = est(await this.runtime.systemPrompt(scope, await this.instructions(session)))
    parts.tools = est(this.runtime.toolDefinitions(scope))
    for (const m of raw) {
      if (m.role === 'user') {
        for (const c of typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content) {
          if (c.type !== 'text') parts.user += 1200 // images: rough per-image cost
          else if (c.text.startsWith(SUMMARY_OPEN)) parts.summary += est(c.text)
          else if (c.text.startsWith(SKILL_OPEN)) parts.skills += est(c.text)
          else parts.user += est(c.text)
        }
      } else if (m.role === 'assistant') {
        for (const c of m.content) {
          if (c.type === 'text') parts.assistant += est(c.text)
          else if (c.type === 'thinking') parts.assistant += est(c.thinking)
          else if (c.type === 'toolCall') parts.toolResults += est(JSON.stringify(c.arguments ?? {})) + 8
        }
      } else if (m.role === 'toolResult') {
        for (const c of m.content) parts.toolResults += c.type === 'text' ? est(c.text) : 1200
      }
    }
    const estimated = Object.values(parts).reduce((a, b) => a + b, 0)
    // Prefer the provider's reported count (pi keeps the system prompt in the history); scale the split to it.
    const reported = raw.some((m) => m.role !== 'system') ? estimateHistory(raw, this.ctx.kv.get<number>('compactedAt:' + id, 0)) : 0
    const tokens = Math.max(reported, 0) || estimated
    const scale = estimated ? tokens / estimated : 1
    const breakdown: ContextSlice[] = (Object.keys(SLICE_LABELS) as ContextSliceKey[])
      .map((key) => ({ key, label: SLICE_LABELS[key], tokens: Math.round(parts[key] * scale) }))
      .filter((s) => s.tokens > 0)
    return { tokens, window, estimated: session.model ? this.contextEstimated(session.model) : false, threshold: window ? budget(window).threshold : null, breakdown, cost: this.usage?.costFor('chat', id) ?? 0 }
  }

  /**
   * Summarise older turns into a checkpoint carried by the first kept user message. The
   * summarised turns move to the archive (still shown in the UI, no longer sent to the model).
   */
  async compact(id: string, opts: { instructions?: string; signal?: AbortSignal } = {}): Promise<UiMessage[]> {
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('Wait for the agent to finish first')
    const session = this.get(id)
    if (!session.model) throw new Error('Pick a model for this chat first')
    const raw = this.rawMessages(id)
    const window = this.contextWindow(session.model)
    const cut = findCut(raw, budget(window).keep)
    if (cut === null) throw new Error('Not enough conversation to summarise yet')
    this.compacting.add(id)
    this.ctx.emit('chat', { sessionId: id, type: 'compacting' })
    try {
      // pi keeps the system prompt as a message at the head of the history: it stays, it isn't summarised.
      const system = raw.slice(0, cut).filter((m) => m.role === 'system')
      const older = raw.slice(0, cut).filter((m) => m.role !== 'system')
      // Fold an earlier summary (on the first user message) into the new one rather than re-summarising it.
      let previous: string | null = null
      const firstUser = older.findIndex((m) => m.role === 'user')
      if (firstUser >= 0) {
        const split = splitSummary(older[firstUser] as UserMessage)
        previous = split.summary
        older[firstUser] = split.message
      }
      const run = () => summarize(this.runtime.providers, session.model!, older, { previous, instructions: opts.instructions, signal: opts.signal, contextWindow: window })
      const summary = await (this.usage ? this.usage.run({ source: 'chat', ref: id }, run) : run())
      const tail = raw.slice(cut)
      tail[0] = withSummary(tail[0] as UserMessage, summary)
      const kept = [...system, ...tail]
      const archive = [...this.archive(id), ...older]
      this.ctx.db.prepare('UPDATE sessions SET messages = ?, archive = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(kept), JSON.stringify(archive), Date.now(), id)
      this.ctx.kv.set('compactedAt:' + id, Date.now())
      this.ctx.emit('chat', { sessionId: id, type: 'compacted' })
      return this.messages(id)
    } catch (err) {
      this.ctx.emit('chat', { sessionId: id, type: 'compacted', error: errorMessage(err) })
      throw err
    } finally {
      this.compacting.delete(id)
    }
  }

  /** The chat's tools and skills with what each adds to a request (servers that aren't running list no tools). */
  async setup(id: string): Promise<ChatSetup> {
    const session = this.get(id)
    const scope = this.scope(id)
    const mcp = this.runtime.mcpClients
    scope.mcpServers = mcp?.chatServers(session.mcpServers) ?? []
    return this.runtime.setup(scope, mcp?.chatServers(mcp.status().map((s) => s.id)) ?? [])
  }

  private contextEstimated(ref: ModelRef): boolean {
    try {
      const info = this.runtime.providers.get(ref.providerId).models.find((m) => m.id === ref.modelId)
      return !info || contextIsGuess(info)
    } catch {
      return true
    }
  }

  private contextWindow(ref: ModelRef): number {
    try {
      const info = this.runtime.providers.get(ref.providerId).models.find((m) => m.id === ref.modelId)
      return info?.contextWindow || 32_768
    } catch {
      return 32_768
    }
  }

  private archive(id: string): AgentMessage[] {
    const row = this.ctx.db.prepare('SELECT archive FROM sessions WHERE id = ?').get(id) as { archive: string } | undefined
    return json<AgentMessage[]>(row?.archive, [])
  }

  isRunning(id: string): boolean {
    return this.active.has(id)
  }

  abort(id: string): void {
    this.approvals?.cancel(id)
    this.active.get(id)?.abort()
  }

  /** Truncate history to before the given UI message (for edit & resend / regenerate). */
  rewind(id: string, uiMessageId: string): UiMessage[] {
    const raw = this.rawMessages(id)
    const idx = raw.findIndex((m) => 'timestamp' in m && `m${m.timestamp}` === uiMessageId)
    if (idx >= 0 && idx === raw.findIndex((m) => m.role === 'user')) {
      const { summary } = splitSummary(raw[idx] as UserMessage)
      if (summary) this.carry.set(id, summary)
    }
    if (idx >= 0) this.saveMessages(id, raw.slice(0, idx))
    return this.messages(id)
  }

  /** Build the user message; skills invoked with /name and attached files ride along as tagged blocks. */
  private async userMessage(text: string, skillNames: string[], attachments: ChatAttachment[] = []): Promise<UserMessage> {
    const attached = await attachmentContent(attachments)
    if (!skillNames.length && !attached.length) return { role: 'user', content: text, timestamp: Date.now() }
    const blocks: (TextContent | ImageContent)[] = []
    for (const name of [...new Set(skillNames)]) {
      const skill = await this.skills.get(name)
      const extra = skill.files.filter((f) => f !== 'SKILL.md' && f !== 'evals.json')
      const lines = [
        `${SKILL_OPEN}${skill.name}">`,
        `The user invoked the "${skill.name}" skill (/${skill.name}) for this message — follow its instructions.`,
        '',
        `# ${skill.name}`,
        skill.description,
        '',
        this.skills.instructions(skill),
        ...(extra.length ? ['', `Bundled files (load with skill_use + file): ${extra.join(', ')}`] : []),
        SKILL_CLOSE
      ]
      blocks.push({ type: 'text', text: lines.join('\n') })
    }
    blocks.push(...attached)
    // "/name" on its own (the skill named inline, nothing else) asks for the skill to be applied.
    const rest = skillNames.reduce((t, n) => t.replace(new RegExp(`(^|\\s)/${n}(?=\\s|$)`, 'gi'), ' '), text).trim()
    const prompt =
      (rest && text.trim()) ||
      (skillNames.length
        ? `Apply the ${skillNames.map((n) => `/${n}`).join(', ')} skill${skillNames.length > 1 ? 's' : ''}.`
        : `Have a look at the attached ${attached.length > 1 ? 'files' : attached[0].type === 'image' ? 'image' : 'file'}.`)
    return { role: 'user', content: [...blocks, { type: 'text', text: prompt }], timestamp: Date.now() }
  }

  /** The chat's own instructions, after its project's (instructions plus the folder's AGENTS.md) and its agent's. */
  private async instructions(session: ChatSession): Promise<string> {
    const project = (await this.projects?.instructions(session.projectId).catch(() => '')) ?? ''
    const agent = this.agents?.find(session.agentId)
    const role = agent ? [`You are working as the "${agent.name}" agent.${agent.purpose ? ` ${agent.purpose}` : ''}`, agent.instructions.trim()].filter(Boolean).join('\n\n') : ''
    return [project, role, session.systemPrompt.trim()].filter(Boolean).join('\n\n')
  }

  /**
   * Set the chat up from a saved agent: its capabilities, and its model and effort when it has its own.
   * Folder access stays the chat's when the chat has less. null goes back to the default assistant
   * (the chat keeps its current setup).
   */
  useAgent(id: string, agentId: string | null): ChatSession {
    if (!agentId) return this.update(id, { agentId: null })
    const agent = this.agents?.get(agentId)
    if (!agent) throw new Error('Agent not found')
    const cur = this.get(id)
    const patch: Partial<SessionConfig> = { agentId }
    for (const k of SETUP_KEYS) (patch as Record<string, unknown>)[k] = agent[k]
    if (cur.workspace && cur.fileAccess === 'read') patch.fileAccess = 'read'
    if (agent.model) patch.model = agent.model
    if (agent.thinking) patch.thinking = agent.thinking
    return this.update(id, patch)
  }

  /** A new chat holding a finished run's conversation (an automation's result), to read and reply to. */
  fromTranscript(input: { id?: string; title: string; workspace: string | null; agentId: string | null; messages: AgentMessage[]; container?: ContainerSettings | null }): ChatSession {
    // A run that worked in a container hands its copy over: the chat shows its changes to apply.
    const s = this.create({ workspace: input.workspace, fileAccess: input.container ? 'write' : 'read', container: input.container ?? null }, input.id)
    if (input.agentId && this.agents?.find(input.agentId)) this.useAgent(s.id, input.agentId)
    this.saveMessages(s.id, input.messages)
    const chat = this.update(s.id, { title: input.title.slice(0, 80), titleSource: 'user' })
    // Open chat lists refresh on 'end'.
    this.ctx.emit('chat', { sessionId: s.id, type: 'end' } satisfies ChatEvent)
    return chat
  }

  /** An agent's tools and skills with their cost, as if it worked in a folder with full access. */
  async agentSetup(agentId: string): Promise<ChatSetup> {
    const agent = this.agents?.get(agentId)
    if (!agent) throw new Error('Agent not found')
    const base: ToolScope = { collectionIds: [], skillsEnabled: true, workspace: this.ctx.dataDir, fileAccess: 'write', shell: true, sessionId: 'agent-setup', depth: 0, subagents: agent.subagents }
    const scope = agentScope({ ...agent, fileAccess: 'write', shell: true }, base)
    scope.subagents = agent.subagents
    const mcp = this.runtime.mcpClients
    scope.mcpServers = mcp?.chatServers(agent.mcpServers) ?? []
    return this.runtime.setup(scope, mcp?.chatServers(mcp.status().map((s) => s.id)) ?? [])
  }

  /**
   * The scope a run uses: in container mode the workspace is the chat's private copy (made on first
   * use) and commands run in its Linux container.
   */
  private async runScope(id: string): Promise<ToolScope> {
    const scope = this.scope(id)
    const session = this.get(id)
    if (!session.container || !this.containers) return scope
    const settings = session.container
    const containers = this.containers
    const docker = await containers.status()
    if (!docker.available) throw new Error(docker.error ?? 'Docker is not available')
    scope.workspace = await containers.prepare(id, session.workspace)
    scope.container = { image: settings.image, folder: session.workspace, exec: (command, cwd, options) => containers.exec(id, settings, command, cwd, options) }
    return scope
  }

  private scope(id: string): ToolScope {
    const session = this.get(id)
    return {
      collectionIds: session.collectionIds,
      knowledgeEnabled: session.knowledgeEnabled,
      skillsEnabled: session.skillsEnabled,
      webEnabled: session.webEnabled,
      customTools: session.customTools,
      workspace: session.workspace,
      fileAccess: session.fileAccess,
      shell: session.shell,
      sessionId: id,
      subagents: session.subagents,
      codeIntel: session.codeIntel,
      images: session.imagesEnabled,
      disabledTools: session.disabledTools,
      skillsOff: session.skillsOff,
      skillsAlways: session.skillsAlways,
      agentId: session.agentId,
      depth: 0,
      autoApprove: () => this.get(id).autoApprove,
      onAlways: (scope) => {
        const cur = this.get(id).autoApprove
        if (cur !== 'all') this.update(id, { autoApprove: scope === 'all' ? 'all' : 'edits' })
      }
    }
  }

  async send(id: string, text: string, skillNames: string[] = [], attachments: ChatAttachment[] = []): Promise<void> {
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('This chat is already running')
    const message = await this.userMessage(text, skillNames, attachments)
    const names = attachments.map((a) => a.name).join(', ')
    const title = (text.trim() ? text : skillNames.length ? skillNames.map((n) => `/${n}`).join(' ') : names).replace(/\s+/g, ' ').trim().slice(0, 60)
    await this.run(id, message, title)
    for (const name of new Set(skillNames)) this.usage?.skill(name, 'slash')
  }

  /** Send a user message again: drop it and everything after it, then run the same content. */
  async resend(id: string, uiMessageId: string): Promise<void> {
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('This chat is already running')
    const original = this.rawMessages(id).find((m) => m.role === 'user' && `m${m.timestamp}` === uiMessageId) as UserMessage | undefined
    if (!original) throw new Error('That message is no longer in this chat')
    this.rewind(id, uiMessageId)
    // rewind() carries a summary forward and run() re-attaches it; don't send the old copy twice.
    await this.run(id, { ...splitSummary(original).message, timestamp: Date.now() }, '')
  }

  private async run(id: string, prepared: UserMessage, title: string): Promise<void> {
    const session = this.get(id)
    if (!session.model) throw new Error('Pick a model for this chat first (Providers → add one, then choose it in the chat header)')
    const scope = await this.runScope(id)
    // External MCP servers this chat uses: started on demand so their tools are there for the agent.
    const mcp = this.runtime.mcpClients
    if (mcp) {
      scope.mcpServers = mcp.chatServers(session.mcpServers)
      await mcp.ensure(scope.mcpServers)
    }
    // Summarise older turns first if the conversation is about to outgrow the model's context.
    if (this.settings.get().autoCompact) {
      const usage = await this.contextUsage(id)
      const incoming = Math.ceil(contentChars(prepared) / 4) + 2000
      if (usage.threshold && usage.tokens + incoming > usage.threshold) {
        await this.compact(id).catch((err) => this.ctx.log('chat', 'auto-compaction failed', errorMessage(err)))
      }
    }
    const history = this.rawMessages(id)
    const systemPrompt = await this.runtime.systemPrompt(scope, await this.instructions(session))
    const agent = this.runtime.createAgent({ model: session.model, scope, thinking: session.thinking, history, systemPrompt })
    this.active.set(id, agent)

    const emit = (e: ChatEvent) => this.ctx.emit('chat', e)
    const startIndex = history.length
    const partials = new Map<string, ToolDetails>()
    let timer: NodeJS.Timeout | null = null
    const pushTurn = () => {
      timer = null
      const msgs: AgentMessage[] = [...agent.state.messages.slice(startIndex)]
      const streaming = agent.state.streamingMessage
      if (streaming && !msgs.includes(streaming)) msgs.push(streaming)
      const ui = toUiMessages(msgs, agent.state.pendingToolCalls, partials)
      const turn = ui.filter((m) => m.role === 'assistant').at(-1)
      if (turn) emit({ sessionId: id, type: 'message', message: turn })
    }
    const schedule = () => {
      if (!timer) timer = setTimeout(pushTurn, 40)
    }

    agent.subscribe((e) => {
      switch (e.type) {
        case 'tool_execution_update':
          if (e.partialResult?.details) partials.set(e.toolCallId, e.partialResult.details as ToolDetails)
          schedule()
          break
        case 'message_update':
        case 'tool_execution_start':
          schedule()
          break
        case 'message_end':
        case 'tool_execution_end':
          pushTurn()
          this.saveMessages(id, agent.state.messages)
          break
      }
    })

    let message = prepared
    const carried = this.carry.get(id)
    if (carried && !history.some((m) => m.role === 'user')) message = withSummary(message, carried)
    this.carry.delete(id)
    if (session.title === 'New chat' && title) {
      this.update(id, { title, titleSource: 'first-message' })
      emit({ sessionId: id, type: 'title', title })
    }
    emit({ sessionId: id, type: 'start' })
    const userMsg = toUiMessages([message])[0]
    emit({ sessionId: id, type: 'message', message: userMsg })

    const attributed = <T>(fn: () => T): T => (this.usage ? this.usage.run({ source: 'chat', ref: id }, fn) : fn())
    void attributed(async () => {
      let error: string | undefined
      try {
        await agent.prompt(message)
        error = agent.state.errorMessage
      } catch (err) {
        error = errorMessage(err)
      } finally {
        if (timer) clearTimeout(timer)
        pushTurn()
        this.saveMessages(id, agent.state.messages)
        this.active.delete(id)
        // Local servers (LM Studio) load a model on first use: its real context size is known now.
        const ref = this.get(id).model
        if (ref && this.runtime.providers.list().find((p) => p.id === ref.providerId)?.kind === 'openai-compatible') {
          await this.runtime.providers.refreshModel(ref, { force: true, timeoutMs: 3000 }).catch(() => undefined)
        }
        emit({ sessionId: id, type: 'end', error })
      }
      if (!error) await this.retitle(id).catch((err) => this.ctx.log('chat', 'title failed', errorMessage(err)))
    })
  }

  private titling = new Set<string>()

  /**
   * Give the chat an AI-written title: after the first reply, and once more when the conversation
   * has grown (its subject is clearer by then). Titles the user typed are never replaced.
   */
  async retitle(id: string, opts: { force?: boolean } = {}): Promise<string | null> {
    const cfg = this.settings.get()
    const session = this.get(id)
    if ((!cfg.aiTitles && !opts.force) || (session.titleSource === 'user' && !opts.force) || this.titling.has(id)) return null
    const raw = this.rawMessages(id)
    const said = (m: AgentMessage) => {
      const c = (m as { content?: unknown }).content
      const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && !String(b.text).startsWith(SKILL_OPEN) && !String(b.text).startsWith(FILE_OPEN)).map((b) => String(b.text)) : []
      return parts.join('\n').replace(/\s+/g, ' ').trim()
    }
    const users = raw.filter((m) => m.role === 'user').map(said).filter(Boolean)
    const done = session.titleTurns ?? 0
    const due = opts.force || (done === 0 ? users.length >= 1 : done < 4 && users.length >= 4)
    const model = cfg.titleModel ?? session.model
    if (!due || !model || !users.length) return null
    const reply = raw.filter((m) => m.role === 'assistant').map(said).find(Boolean) ?? ''
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
    const excerpt = [
      ...users.slice(0, 2).map((u) => `User: ${clip(u, 700)}`),
      reply ? `Assistant: ${clip(reply, 700)}` : '',
      ...(users.length > 2 ? users.slice(-2).map((u) => `User (later): ${clip(u, 400)}`) : [])
    ]
      .filter(Boolean)
      .join('\n\n')
    this.titling.add(id)
    try {
      const { text } = await this.runtime.providers.complete(model, { system: TITLE_SYSTEM, prompt: `Conversation:\n\n${excerpt}\n\nTitle:`, maxTokens: 400, temperature: 0.3, thinking: 'off' })
      const title = cleanTitle(text)
      if (!title) {
        this.ctx.log('chat', `title: ${model.modelId} replied without a usable title`, JSON.stringify(text.slice(0, 200)))
        return null
      }
      // The user may have renamed the chat while the model was writing.
      if (this.get(id).titleSource === 'user' && !opts.force) return null
      this.update(id, { title, titleSource: 'ai', titleTurns: users.length })
      this.ctx.emit('chat', { sessionId: id, type: 'title', title } satisfies ChatEvent)
      return title
    } finally {
      this.titling.delete(id)
    }
  }

  private rawMessages(id: string): AgentMessage[] {
    const row = this.ctx.db.prepare('SELECT messages FROM sessions WHERE id = ?').get(id) as { messages: string } | undefined
    return json<AgentMessage[]>(row?.messages, [])
  }

  private saveMessages(id: string, messages: AgentMessage[]): void {
    this.ctx.db.prepare('UPDATE sessions SET messages = ?, preview = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(messages), previewOf(messages), Date.now(), id)
  }

  private row(id: string): SessionRow {
    const row = this.ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) throw new Error(`Unknown chat ${id}`)
    return row
  }
}

function toSession(row: SessionRow): ChatSession {
  const config = { ...DEFAULT_CONFIG, ...json<Partial<SessionConfig>>(row.config, {}) }
  return { id: row.id, title: row.title, ...config, ...(row.preview ? { preview: row.preview } : {}), createdAt: row.created_at, updatedAt: row.updated_at }
}

/** One line from the latest turn: the reply's opening, or what was asked when there's no reply yet. */
export function previewOf(messages: AgentMessage[]): string {
  const text = (m: AgentMessage): string => {
    const c = (m as { content?: unknown }).content
    if (typeof c === 'string') return c
    if (!Array.isArray(c)) return ''
    return c
      .filter((b) => b?.type === 'text' && !String(b.text).startsWith(SKILL_OPEN) && !String(b.text).startsWith(FILE_OPEN) && !String(b.text).startsWith(SUMMARY_OPEN))
      .map((b) => String(b.text))
      .join(' ')
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' && m.role !== 'user') continue
    const line = text(m)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#*_`>|[\]]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) return line.slice(0, 140)
  }
  return ''
}

/**
 * Collapse pi agent messages into UI turns: each user message becomes one bubble, and every
 * assistant/toolResult message until the next user message is folded into a single assistant
 * turn with interleaved thinking, text and tool traces.
 */
export function toUiMessages(messages: AgentMessage[], pending?: ReadonlySet<string>, partials?: ReadonlyMap<string, ToolDetails>): UiMessage[] {
  const out: UiMessage[] = []
  const results = new Map<string, ToolResultMessage<ToolDetails>>()
  for (const m of messages) if (m.role === 'toolResult') results.set(m.toolCallId, m as ToolResultMessage<ToolDetails>)

  let turn: UiMessage | null = null
  for (const m of messages) {
    if (m.role === 'user') {
      turn = null
      // Skill blocks from /name invocations become chips; only the user's own text is shown.
      const skills: string[] = []
      const parts: string[] = []
      const attachments: UiAttachment[] = []
      let summary: string | undefined
      for (const c of typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content) {
        if (c.type === 'image') attachments.push({ kind: 'image', mimeType: c.mimeType, data: c.data })
        else if (c.text.startsWith(FILE_OPEN)) attachments.push(parseFileBlock(c.text)!)
        else if (c.text.startsWith(SUMMARY_OPEN)) summary = splitSummary({ role: 'user', content: [c], timestamp: 0 }).summary ?? ''
        else if (c.text.startsWith(SKILL_OPEN)) skills.push(c.text.slice(SKILL_OPEN.length, c.text.indexOf('"', SKILL_OPEN.length)))
        else parts.push(c.text)
      }
      out.push({ id: `m${m.timestamp}`, role: 'user', blocks: [{ type: 'text', text: parts.join('\n') }], createdAt: m.timestamp, ...(skills.length ? { skills } : {}), ...(attachments.length ? { attachments } : {}), ...(summary !== undefined ? { summary } : {}) })
      continue
    }
    if (m.role !== 'assistant') continue
    const a = m as AssistantMessage
    if (!turn) {
      turn = { id: `m${a.timestamp}`, role: 'assistant', blocks: [], createdAt: a.timestamp, model: a.model, usage: { input: 0, output: 0, cached: 0, cost: 0 } }
      out.push(turn)
    }
    for (const block of a.content) {
      if (block.type === 'text') {
        if (block.text) pushText(turn.blocks, 'text', block.text)
      } else if (block.type === 'thinking') {
        if (block.thinking && !block.redacted) pushText(turn.blocks, 'thinking', block.thinking)
      } else if (block.type === 'toolCall') {
        const r = results.get(block.id)
        const trace: ToolTrace = {
          id: block.id,
          name: block.name,
          args: block.arguments,
          status: r ? (r.isError ? 'error' : 'ok') : pending?.has(block.id) || a.stopReason === 'toolUse' ? 'running' : 'error',
          result: r ? r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n') : '',
          durationMs: r?.details?.durationMs ?? null,
          references: r?.details?.references ?? [],
          ...(r?.details?.changes?.length ? { changes: r.details.changes } : {}),
          ...((r?.details?.subagent ?? partials?.get(block.id)?.subagent) ? { subagent: (r?.details?.subagent ?? partials?.get(block.id)?.subagent) as unknown as SubagentRun } : {}),
          ...(block.name === 'generate_image' ? { image: imageTrace(block.arguments, r, partials?.get(block.id)) } : {})
        }
        if (!r && a.stopReason !== 'toolUse' && !pending?.has(block.id)) trace.result = 'Interrupted before the tool ran'
        turn.blocks.push({ type: 'tool', trace })
      }
    }
    if (a.usage) {
      turn.usage!.input += a.usage.input
      turn.usage!.output += a.usage.output
      turn.usage!.cached = (turn.usage!.cached ?? 0) + (a.usage.cacheRead ?? 0)
      turn.usage!.cost += a.usage.cost?.total ?? 0
    }
    if (a.stopReason === 'error') turn.error = a.errorMessage || 'The model returned an error'
    if (a.stopReason === 'aborted') turn.error = 'Stopped'
  }
  return out
}

/** The image card's state: final details, live progress, or an error built from the call. */
function imageTrace(args: unknown, r: ToolResultMessage<ToolDetails> | undefined, partial: ToolDetails | undefined): GeneratedImage {
  const a = (args ?? {}) as { prompt?: string; size?: string }
  const done = r?.details?.image as unknown as GeneratedImage | undefined
  if (done) return done
  if (r?.isError) return { status: 'error', prompt: a.prompt ?? '', size: a.size ?? 'auto', error: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ') }
  return (partial?.image as unknown as GeneratedImage | undefined) ?? { status: 'queued', prompt: a.prompt ?? '', size: a.size ?? 'auto' }
}

function contentChars(m: UserMessage): number {
  if (typeof m.content === 'string') return m.content.length
  return m.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 4800), 0)
}

function pushText(blocks: UiBlock[], type: 'text' | 'thinking', text: string): void {
  const last = blocks.at(-1)
  if (last && last.type === type) last.text += `\n\n${text}`
  else blocks.push({ type, text })
}
