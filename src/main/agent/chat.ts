import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { getCurrentSystemMessage, type AssistantMessage, type ImageContent, type SystemMessage, type TextContent, type ToolResultMessage, type UserMessage } from '@earendil-works/pi-ai'
import type { ChatOrigin, ComputerTrace, ContainerSettings,GeneratedImage, ImageSize, Permissions, PlanProposal, QuestionRound, StageGate, WorkflowStage } from '@shared/types'
import { nextStage, STAGE_OPEN, STAGE_TEXT, stageNote, WORKFLOW_SECTION, workflowSection } from './workflow'
import { createWorkerTree, finishWorkerTree, parkWorkerTree, type MergeResult, type WorkerTree } from './worktrees'
import { contextIsGuess } from '@shared/types'
import { hasLegacyCaps, isPermissions, legacyPermissions, permissionCaps, type LegacyCaps } from '@shared/permissions'
import { agentSlug } from '@shared/mention'
import { normalizeEffort } from '@shared/effort'
import { toolSummary } from '@shared/tool-summary'
import type { Agent as SavedAgent, AgentSetup, AgentTier, SubagentActivity, TodoItem, ApprovalDecision, ChatAttachment, ChatEvent, ChatSession, ChatSetup, ContextSlice, ContextSliceKey, ContextUsage, FileChange, ModelRef, PendingApproval, PendingQuestion, SubagentRun, SubagentSettings, ThinkingLevel, ToolTrace, UiAttachment, UiBlock, UiMessage } from '@shared/types'
import type { ProjectService } from './projects'
import type { AgentService } from './agents'
import type { McpClientService } from '../mcp/client'
import { attachmentContent, FILE_OPEN, parseFileBlock } from './attachments'
import type { ContainerService } from './containers'
import type { ApprovalService, CheckpointStore } from './workspace'
import type { LspManager } from './lsp'
import { folderNotes, loadRules } from './rules'
import type { ImageService } from '../images'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import { DEFAULT_AGENT_TIERS, DEFAULT_SUBAGENTS, type SettingsService } from '../core/settings'
import type { RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'
import { allowedSkill, buildTools, inPlanMode, type ToolDetails, type ToolScope } from './tools'
import { runAsCall } from './workspace'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { computerOffered, type ComputerController } from '../computer/tool'
import { pruneScreenshots } from '../computer/prune'
import { budget, compactedHistory, estimateHistory, planCompaction, splitSummary, summarize, SUMMARY_OPEN, withSummary } from './compaction'
import type { UsageService } from '../core/usage'

const SUBAGENT_INSTRUCTIONS = (role: 'scout' | 'worker') =>
  [
    'You are a subagent: another agent delegated this job to you. Work autonomously — you cannot ask the user or the other agent questions.',
    role === 'scout'
      ? 'You are a read-only scout: investigate with the tools you have and do not attempt to change anything.'
      : 'You are a worker: make the changes the job asks for, keeping them minimal. Each edit may be reviewed by the user.',
    `When done, reply with a report — it is all the other agent will see. Start it with a line \`Result: done\`, \`Result: partly done\` or \`Result: blocked\`, then: ${role === 'scout' ? 'what you found (file paths with line numbers, names, facts)' : 'the files you changed, one line each with what changed'}; the verification you ran and its outcome; open questions or risks ("none" if none). Keep it under ~300 words, no preamble.`
  ].join('\n')

/** What a subagent's report says it achieved: its first `Result:` line, or undefined without one. */
export function parseOutcome(text: string): SubagentRun['outcome'] {
  const m = /^\s*\**result\**\s*:\s*\**\s*(done|partly done|partially done|blocked)/im.exec(text)
  if (!m) return undefined
  const v = m[1].toLowerCase()
  return v === 'done' ? 'done' : v === 'blocked' ? 'blocked' : 'partial'
}

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
const AGENT_OPEN = '<agent-mention name="'
const AGENT_CLOSE = '</agent-mention>'
const PLAN_OPEN = '<plan-approval mode="'
const PLAN_CLOSE = '</plan-approval>'
/** What the user sees for the message that approves a plan. */
export const PLAN_APPROVED_TEXT = 'Approved the plan'
/** Blocks the user message carries for the model only (never shown as the user's text). */
const hidden = (text: string) => text.startsWith(SKILL_OPEN) || text.startsWith(AGENT_OPEN) || text.startsWith(FILE_OPEN) || text.startsWith(PLAN_OPEN) || text.startsWith(STAGE_OPEN)

/** The system prompt section that says which permission mode the chat is in now. */
export const PERMISSIONS_SECTION = 'permissions'

/**
 * What the agent is told about the chat's permission mode. A chat's system prompt is fixed at its
 * first run (it lives in the history), so this goes in a named section that a later system message
 * replaces whenever the mode changes. null = nothing to say (no folder, not planning).
 */
export function permissionSection(p: Permissions, where: { workspace: string | null; container: unknown }): string | null {
  if (p === 'plan') {
    return [
      '## Permissions: Plan mode',
      'This chat is in Plan mode (this replaces anything said earlier about changing files or approvals): you can read and search, but not change files, run commands or use the computer. First explore what you need to understand the task (read the relevant files, search, look things up). Then call `present_plan` once, with a short title and concrete, ordered steps (which files change and how, what to run, how to check it), plus notes for risks or open questions (notes are Markdown and may include a ```mermaid diagram of the change), and stop — do not write the plan out again as text. The user approves the plan (the chat then leaves Plan mode and you carry it out) or asks for changes; then revise it and call `present_plan` again. Answer plain questions directly, without a plan.'
    ].join('\n')
  }
  if (!where.workspace) return null
  if (where.container) {
    return p === 'auto'
      ? '## Permissions: Auto\nThis chat is in Auto mode (this replaces anything said earlier about approvals): changes and commands in the container run without asking; the user reviews the changes before they reach their folder.'
      : '## Permissions: Manual\nThis chat is in Manual mode (this replaces anything said earlier about approvals): changes and commands in the container run without asking (nothing in the container counts as risky); the user reviews the changes before they reach their folder.'
  }
  return p === 'auto'
    ? '## Permissions: Auto\nThis chat is in Auto mode (this replaces anything said earlier about approvals): nothing needs approval. File changes, commands and risky actions (deleting or writing outside the workspace, git push / reset --hard / clean, installing packages, downloading from the network, running elevated or changing system settings) all run without asking, and the user can undo file changes. Take risky actions only when the task needs them, and say what you did.'
    : '## Permissions: Manual\nThis chat is in Manual mode (this replaces anything said earlier about approvals): file changes and commands run without asking, and the user can undo changes. Risky actions pause until the user OKs them: deleting or writing outside the workspace, git push / reset --hard / clean, installing packages, downloading from the network, running elevated or changing system settings. Batch risky steps where you can (e.g. one install for all packages) and explain why each is needed. If one is declined, do not retry it or work around it; ask how to proceed.'
}

/** What a chat stores: fileAccess / shell / autoApprove are worked out from `permissions`, never stored. */
type SessionConfig = Omit<ChatSession, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'fileAccess' | 'shell' | 'autoApprove'>
/** Settings for a new or changed chat; the old switches (fileAccess, shell, autoApprove) still work and become a permission mode. */
export type SessionInput = Partial<SessionConfig> & LegacyCaps

/**
 * The permission mode from the most specific layer that says anything about it: its `permissions`,
 * else its old switches (filled in from the layers under it), else `fallback`.
 */
function resolvePermissions(layers: SessionInput[], where: { workspace: string | null; container: unknown }, fallback: Permissions): Permissions {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    if (isPermissions(layer.permissions)) return layer.permissions
    if (hasLegacyCaps(layer)) {
      const below = layers.slice(i).reverse().reduce<LegacyCaps>((acc, l) => ({ ...acc, ...definedCaps(l) }), {})
      return legacyPermissions(below, where)
    }
  }
  return fallback
}

const definedCaps = (l: LegacyCaps): LegacyCaps => ({
  ...(l.fileAccess !== undefined ? { fileAccess: l.fileAccess } : {}),
  ...(l.shell !== undefined ? { shell: l.shell } : {}),
  ...(l.autoApprove !== undefined ? { autoApprove: l.autoApprove } : {})
})

/** A config without the old switches (they are derived, never stored). */
function withoutCaps<T extends LegacyCaps>(c: T): Omit<T, 'fileAccess' | 'shell' | 'autoApprove'> {
  const { fileAccess: _f, shell: _s, autoApprove: _a, ...rest } = c
  return rest
}

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
  permissions: 'manual',
  subagents: true,
  codeIntel: true,
  imagesEnabled: true,
  computerUse: false,
  thinking: 'low',
  projectId: null,
  container: null,
  mcpServers: null,
  disabledTools: [],
  skillsOff: [],
  skillsAlways: [],
  agentId: null,
  autoTiers: true,
  contextLimit: null
}

/** The capability switches a chat copies from an agent when it is set up from one (its folder access becomes a permission mode). */
const SETUP_KEYS: (keyof AgentSetup)[] = ['skillsEnabled', 'skillsOff', 'skillsAlways', 'webEnabled', 'customTools', 'subagents', 'codeIntel', 'imagesEnabled', 'knowledgeEnabled', 'collectionIds', 'mcpServers', 'disabledTools']

/**
 * What the Setup panel sets for every chat at once: its tools, skills, servers, knowledge and context
 * limit. Chats set up from an agent keep the agent's own; the rest share one saved setup.
 */
export const SHARED_KEYS = ['skillsEnabled', 'skillsOff', 'skillsAlways', 'webEnabled', 'customTools', 'subagents', 'codeIntel', 'imagesEnabled', 'knowledgeEnabled', 'collectionIds', 'mcpServers', 'disabledTools', 'autoTiers', 'contextLimit'] as const satisfies readonly (keyof SessionConfig)[]
type SharedSetup = Partial<Pick<SessionConfig, (typeof SHARED_KEYS)[number]>>
const SHARED_KV = 'chat.sharedSetup'
const pickShared = (o: Partial<SessionConfig>): SharedSetup => Object.fromEntries(SHARED_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as SharedSetup

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
  /** The latest assistant turn, and what the run is doing now and which files it has changed so far. */
  onEvent?: (turn: UiMessage, progress: RunProgress) => void
  /** Tools only this run gets (an automation's reporting tools), on top of what the scope allows. */
  extraTools?: AgentTool<any, ToolDetails>[]
}

export interface RunProgress {
  /** The tool running now (the latest started, when several run at once); null between tools. */
  current: SubagentActivity | null
  /** Workspace files changed so far, in the order they were first changed. */
  files: string[]
}

/** The model and effort a delegated job runs with, and the tier behind them. */
export interface Delegation {
  model: ModelRef
  thinking: ThinkingLevel | undefined
  tier?: AgentTier
  /** Set when the requested tier doesn't exist (it was ignored). */
  note?: string
}

/**
 * Where a delegated job's model and effort come from: the tier the delegating agent asked for
 * (when its chat lets it pick tiers), else the agent's own model and effort, else the agent's tier,
 * else `fallback` (Settings → Subagents, then the chat). A tier without a model uses the chat's.
 */
export function resolveDelegation(input: {
  tierArg?: string
  autoTiers: boolean
  tiers: AgentTier[]
  agent: { model: ModelRef | null; thinking: ThinkingLevel | null; tier?: string | null } | null
  chat: { model: ModelRef; thinking: ThinkingLevel | undefined }
  fallback: { model: ModelRef; thinking: ThinkingLevel | undefined }
  usable: (m: ModelRef | null | undefined) => m is ModelRef
}): Delegation {
  const { chat, usable } = input
  const byId = (id: string | null | undefined) => (id ? input.tiers.find((t) => t.id === id) : undefined)
  const asked = input.autoTiers && input.tierArg ? input.tierArg : undefined
  const explicit = byId(asked)
  const note = asked && !explicit ? `Note: there is no tier "${asked}", so it was ignored.` : undefined
  if (explicit) return { model: usable(explicit.model) ? explicit.model : chat.model, thinking: explicit.thinking ?? chat.thinking, tier: explicit }
  const agent = input.agent
  const own = agent && usable(agent.model) ? agent.model : null
  const tier = byId(agent?.tier)
  const usesTier = !!tier && (!own || !agent?.thinking)
  return {
    model: own ?? (tier ? (usable(tier.model) ? tier.model : chat.model) : input.fallback.model),
    thinking: agent?.thinking ?? (tier ? (tier.thinking ?? chat.thinking) : input.fallback.thinking),
    ...(usesTier ? { tier } : {}),
    ...(note ? { note } : {})
  }
}

/** Calls fn at most once per `ms` with the latest value (the first at once, the last after the wait). */
export function throttle<T>(fn: (v: T) => void, ms: number): ((v: T) => void) & { cancel(): void } {
  let last = 0
  let timer: NodeJS.Timeout | null = null
  let pending: { v: T } | null = null
  const flush = () => {
    timer = null
    if (!pending) return
    const { v } = pending
    pending = null
    last = Date.now()
    fn(v)
  }
  const call = (v: T) => {
    pending = { v }
    if (timer) return
    const wait = last + ms - Date.now()
    if (wait <= 0) flush()
    else timer = setTimeout(flush, wait)
  }
  return Object.assign(call, {
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    }
  })
}

/** The todo list as the latest successful todo_write left it. */
export function latestTodos(messages: AgentMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'toolResult' || m.toolName !== 'todo_write' || m.isError) continue
    const todos = (m.details as { todos?: TodoItem[] } | undefined)?.todos
    if (Array.isArray(todos)) return todos
  }
  return []
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
    private ws: { approvals?: ApprovalService; checkpoints?: CheckpointStore; lsp?: LspManager; rulesDir?: string; images?: ImageService; settings?: SettingsService; mcp?: McpClientService; agents?: AgentService; computer?: ComputerController | null } = {}
  ) {}

  /** Computer use on this machine (set by the app; absent in tests and on unsupported systems). */
  attachComputer(computer: ComputerController | null): void {
    this.ws.computer = computer
  }

  /** A run is over or waits for the user: give the mouse and keyboard back. */
  releaseComputer(owner: string): void {
    void this.ws.computer?.release(owner)
  }

  private computerAvailable(parent: Omit<AgentRunOptions, 'prompt'>): boolean {
    // Plan mode is read-only: no mouse and keyboard either.
    if (!this.ws.computer || !parent.scope.computerUse || inPlanMode(parent.scope)) return false
    try {
      return computerOffered(parent.scope, this.providers.resolve(parent.model).model.input, true)
    } catch {
      return false
    }
  }

  get mcpClients(): McpClientService | undefined {
    return this.ws.mcp
  }

  /** Saved agents other agents may hand work to by name. */
  delegates(self?: string | null): SavedAgent[] {
    return (this.ws.agents?.list() ?? []).filter((a) => a.id !== self)
  }

  private subagentSettings(): SubagentSettings {
    return this.ws.settings?.get().subagents ?? DEFAULT_SUBAGENTS
  }

  private tiers(): AgentTier[] {
    return this.ws.settings?.get().agentTiers ?? DEFAULT_AGENT_TIERS
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
      'Be precise and concise. Use Markdown. Prefer showing code over describing it.',
      'For a diagram (a flow, a sequence of calls, states, an architecture, a data model, a timeline), write a ```mermaid code block: it is drawn as a diagram. Use one when a picture shows structure or flow more clearly than text, not by default.'
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
      if (scope.autoTiers && this.tiers().length) {
        lines.push(
          'For multi-step work, plan with `todo_write` first and delegate the steps to agents with `task` (pass `step`). Give each job the cheapest `tier` that gets that step right the first time; when unsure between two tiers, pick the higher.',
          "Write each brief so it stands alone: the agent can't see this chat. Name the files, the constraints, what done looks like and how to check it.",
          "Treat each report as a claim: check the changed files (and rerun the check when it's cheap) before telling the user it's done. If something is wrong, send the job back with the specific defects, at most twice, then rethink the plan or ask the user.",
          'Keep visual and UX design decisions yourself; put the decided design into the brief.'
        )
      }
    }
    const external = this.ws.mcp?.tools(scope) ?? []
    if (external.length) {
      const servers = [...new Set(external.map((t) => t.name.split('__')[1]))]
      lines.push('', '## External tools', `Tools from these MCP servers are available (named mcp__<server>__<tool>): ${servers.join(', ')}.${servers.includes('playwright') ? ' With Playwright you can open pages in a real browser, interact with them and take screenshots — use it to check UI you build (open the page, look at the screenshot or snapshot, fix what is off).' : ''}${servers.includes('obsidian') ? " obsidian is the user's notes vault (their second brain): search and read it for context on their projects and setup, and record durable decisions there when asked; read `_CLAUDE.md` in the vault first for its conventions." : ''}${servers.includes('homelab') ? ' homelab deploys docker-compose apps to the Raspberry Pi through Dokploy and gives them a *.example.internal address (attach the domain, then redeploy).' : ''}`)
    }
    if (this.imagesAvailable(scope)) lines.push('', '## Images', 'You can create images with `generate_image` when the user asks for a picture, illustration, logo, mockup or similar. The image appears inline for the user.')
    // A chat's current permission mode is told in its own section (permissionSection), which can change later.
    const planning = inPlanMode(scope) && !!scope.sessionId && !scope.depth
    if (scope.sessionId && !scope.depth) {
      lines.push('', '## Planning', 'For tasks with three or more steps, keep a todo list with `todo_write`: write the plan first, mark one item in_progress while you work on it, and mark items completed as you finish them. Skip it for simple questions.')
      if (this.ws.approvals) lines.push('When you need a decision, a preference or information only the user has before you can continue, ask with the `ask_user` tool (offer options when you can) instead of guessing or ending your reply with questions — the user answers in the chat and you carry on with the answer. Ask one question per call; call it again for the next one. Do not ask about things you can find out yourself.')
    }
    if (scope.workspace) {
      // The same rules the tools are built with (buildTools): outside a chat, changes and commands need approval up front, an allowlist or a container.
      const unattended = !scope.sessionId
      const autoEdits = !!scope.autoApprove && scope.autoApprove() !== 'none'
      // Auto or Manual in a chat: changes and commands run without asking (Manual still asks before risky ones).
      const autoAll = !unattended && !!scope.autoApprove && scope.autoApprove() === 'all'
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
            : autoAll
              ? 'You can change files: use ast_edit for mechanical refactors across many places (renames, API migrations), edit for targeted changes to existing files (exact text replacement) and write for new files or full rewrites. Changes are applied without asking (the user can undo each one), so keep them minimal and focused on the request, and say what you changed when you finish.'
              : 'You can change files: use ast_edit for mechanical refactors across many places (renames, API migrations), edit for targeted changes to existing files (exact text replacement) and write for new files or full rewrites. The user reviews each change as a diff and may decline it — if a change is declined, do not retry it; ask what they would like instead. Keep changes minimal and focused on the request.'
          : planning
            ? 'Access is read-only in Plan mode: you cannot create or modify files or run commands. Put the changes in your plan instead.'
            : 'Access is read-only: you cannot create or modify files. If the user asks for changes, show them as code instead.',
        ...(scope.codeIntel !== false ? ['Use `lsp` for TypeScript/JavaScript/Python code intelligence: go to definition, find references, hover types, outline symbols, and check diagnostics. After you change such files, type errors are reported in the tool result — fix them before finishing.'] : []),
        ...(shell
          ? [
              scope.container
                ? `You can run commands with bash in the container (working directory /workspace). It is Linux: use its package manager or language tools to install what you need. ${unattended ? 'Nobody is watching this run, so commands run without asking.' : 'Unless the user auto-approves commands, they approve each one, so explain why a command is needed.'}`
                : scope.commandAllow?.length
                  ? `You can run only these commands with ${shell} (working directory = the workspace), each on its own and with any arguments: ${scope.commandAllow.map((c) => `\`${c}\``).join(', ')}. Anything else, or chaining commands with ; && | or redirects, is refused.`
                  : autoAll
                    ? `You can run commands with ${shell} (working directory = the workspace). Commands run without asking; the Permissions section says whether risky ones (deleting or writing outside the workspace, git push / reset --hard / clean, installing packages, downloading from the network, running elevated or changing system settings) wait for the user's OK first. If one is declined, do not retry it or work around it; ask how to proceed.`
                    : unattended
                      ? `You can run commands with ${shell} (working directory = the workspace).`
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
      lines.push(...(await this.codingRulesSection(scope.workspace, writable)))
    }
    if (extra.trim()) lines.push('', '## Instructions', extra.trim())
    return lines.join('\n')
  }

  /** The user's coding rules (Settings) and the folder's AGENTS.md, for any agent working in a folder (rules.ts). */
  private async codingRulesSection(folder: string, writable: boolean): Promise<string[]> {
    const rules = this.ws.settings?.get().codingRules.trim() ?? ''
    const notes = await folderNotes(folder)
    const checked = writable && (await loadRules(folder, this.ws.rulesDir ?? null).catch(() => [])).length > 0
    if (!rules && !notes && !checked) return []
    return [
      '',
      '## Coding rules',
      ...(rules ? ['Follow these rules in all code you write or change. Where the project notes below disagree, the project notes win.', '', rules] : []),
      ...(notes ? ['', notes] : []),
      ...(checked ? ['', 'Changed files are checked against the coding rules: violations are reported in the tool result — fix them before finishing.'] : [])
    ]
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
      ...(this.computerAvailable(parent) ? [this.computerTool(scope)] : []),
      ...(this.ws.mcp?.tools(scope) ?? [])
    ]
      .filter((t) => !off.has(t.name) && (!only || only.has(t.name)))
      .concat(parent.extraTools ?? [])
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
    // Only the latest few screenshots go to the model.
    agent.transformContext = async (messages) => pruneScreenshots(messages)
    this.providers.usage.track(agent)
    return agent
  }

  /** computer: screenshots, mouse and keyboard, after the chat's one-time consent. */
  private computerTool(scope: ToolScope): AgentTool<any, ToolDetails> {
    const approvals = this.ws.approvals
    const chat = scope.computer
    const sessionId = scope.sessionId
    const tool = this.ws.computer!.tool({
      owner: scope.computerOwner ?? sessionId ?? 'run',
      consent:
        chat && sessionId && approvals
          ? {
              granted: () => chat.granted(),
              ask: async (toolCallId, text, signal) => {
                const d = await approvals.request({ sessionId, toolCallId, kind: 'computer', command: text }, signal)
                if (d === 'deny') return false
                chat.grant()
                return true
              }
            }
          : null,
      onStop: () => chat?.stop()
    })
    return tool as unknown as AgentTool<any, ToolDetails>
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
    const tiers = parent.scope.autoTiers ? this.tiers() : []
    const steps = !!parent.scope.sessionId && !parent.scope.depth
    return {
      name: 'task',
      label: 'Subagent',
      description: this.subagentSettings().allowWorkers
        ? 'Run a subagent on a self-contained job with its own fresh context and return its report. role sets what a plain job may do: "scout" (default) is read-only — it can read and search but not change anything; "worker" can also edit files in the workspace. The subagent cannot see this conversation — put everything it needs in prompt.'
        : 'Run a read-only subagent on a self-contained job with its own fresh context and return its report. It can read and search but not change anything. The subagent cannot see this conversation — put everything it needs in prompt.',
      parameters: Type.Object({
        description: Type.String({ description: 'Short label for the job (3–6 words), shown to the user' }),
        prompt: Type.String({ description: 'Complete instructions: goal, relevant context, and what to report back' }),
        role: Type.Optional(Type.Union([Type.Literal('scout'), Type.Literal('worker')])),
        ...(this.delegates(parent.scope.agentId).length ? { agent: Type.Optional(Type.String({ description: `A saved agent to run instead of a plain job: ${this.delegates(parent.scope.agentId).map((a) => a.name).join(', ')}` })) } : {}),
        ...(tiers.length
          ? {
              tier: Type.Optional(
                Type.Union(
                  tiers.map((t) => Type.Literal(t.id)),
                  { description: `The model and effort the job runs with. Pick the cheapest tier that gets it right the first time; when unsure between two, pick the higher. ${tiers.map((t) => `${t.id} (${t.name}): ${t.purpose || 'no purpose given'}`).join(' ')}` }
                )
              )
            }
          : {}),
        ...(steps ? { step: Type.Optional(Type.Integer({ description: 'Which step of your todo list this work is for.' })) } : {}),
        ...(parent.scope.workflow?.()?.stage === 'build'
          ? { continueFrom: Type.Optional(Type.String({ description: 'Spec → ship Build only: a branch an earlier worker left unfinished work on (named in its error). The new worker starts from that work instead of from scratch.' })) }
          : {})
      }),
      execute: async (id, params, signal, onUpdate) => {
        const p = params as { description: string; prompt: string; role?: 'scout' | 'worker'; agent?: string; tier?: string; step?: number; continueFrom?: string }
        const cfg = this.subagentSettings()
        const named = p.agent ? this.ws.agents?.byName(p.agent) : null
        if (p.agent && !named) throw new Error(`There is no agent called "${p.agent}". Use role scout or worker instead.`)
        const wantsWrite = named ? named.fileAccess === 'write' : p.role === 'worker'
        const role: SubagentRun['role'] = wantsWrite && cfg.allowWorkers && parent.scope.fileAccess === 'write' ? 'worker' : 'scout'
        let scope: ToolScope = { ...parent.scope, depth: 1, subagents: false, ...(role === 'scout' ? { fileAccess: 'read' as const, shell: false } : {}) }
        if (named) {
          scope = { ...agentScope(named, scope), depth: 1, subagents: false }
          if (named.mcpServers && this.ws.mcp) {
            scope.mcpServers = this.ws.mcp.chatServers(named.mcpServers)
            await this.ws.mcp.ensure(scope.mcpServers)
          }
        }
        // Spec → ship reviewers read the change and the spec: no browser, web, knowledge, MCP or custom tools to wander into.
        if (parent.scope.workflow?.()?.stage === 'review' && role === 'scout') {
          scope = { ...scope, mcpServers: [], webEnabled: false, knowledgeEnabled: false, customTools: false, computerUse: false, images: false }
        }
        const usable = (m: ModelRef | null | undefined): m is ModelRef => !!m && this.providers.list().some((pr) => pr.id === m.providerId && pr.enabled)
        // The tier asked for, the agent's own model and effort, its tier, then Settings → Subagents and the chat.
        // A plain job (no saved agent) goes straight from the tier to Settings → Subagents and the chat.
        const { model, thinking, tier, note } = resolveDelegation({
          tierArg: p.tier,
          autoTiers: !!parent.scope.autoTiers,
          tiers: this.tiers(),
          agent: named ?? null,
          chat: { model: parent.model, thinking: parent.thinking },
          fallback: { model: usable(cfg.model) ? cfg.model : parent.model, thinking: cfg.thinking === 'inherit' ? parent.thinking : cfg.thinking },
          usable
        })
        const todos = steps && typeof p.step === 'number' && Number.isInteger(p.step) ? (parent.scope.todos?.() ?? []) : []
        const step = p.step !== undefined && p.step >= 1 && p.step <= todos.length ? { step: p.step, stepText: todos[p.step - 1].content } : {}
        const base = {
          role,
          ...(named ? { agent: named.name } : {}),
          description: p.description || named?.name || 'Subagent',
          model: model.modelId,
          ...(tier ? { tier: tier.id, tierName: tier.name } : {}),
          ...step
        }
        const release = await this.subagentSlot(signal, () =>
          onUpdate?.({ content: [{ type: 'text', text: 'Queued…' }], details: { subagent: { ...base, blocks: [], running: true } } as unknown as ToolDetails })
        )
        const started = Date.now()
        let files: string[] = []
        // Spec → ship builds tickets in parallel: a worker gets its own git checkout, merged back when it ends.
        const flow = parent.scope.workflow?.()
        let tree: WorkerTree | null = null
        let treeNote = ''
        if (flow?.stage === 'build' && role === 'worker' && scope.workspace && !scope.container) {
          tree = await createWorkerTree(scope.workspace, join(tmpdir(), 'cloth-worktrees'), { slug: flow.slug, label: p.description || 'ticket', id, from: p.continueFrom?.trim() || undefined }).catch((err) => {
            treeNote = `Couldn't make a separate git copy (${errorMessage(err)}), so it worked in the chat's folder.`
            return null
          })
          if (tree) scope = { ...scope, workspace: tree.workspace }
        }
        // Live progress for the chat, at most four updates a second.
        const progress = throttle((run: SubagentRun) => onUpdate?.({ content: [{ type: 'text', text: 'Working…' }], details: { subagent: run } as unknown as ToolDetails }), 250)
        const { result, changes } = await runAsCall(id, 'task', signal, () =>
          this.run({
            model,
            prompt: p.prompt,
            systemPrompt: [
              SUBAGENT_INSTRUCTIONS(role),
              tier?.instructions?.trim() ? `Rules for this job (${tier.name} tier):\n${tier.instructions.trim()}` : '',
              tree
                ? [
                    `You are working in your own git copy of the project, on branch ${tree.branch}. Don't commit, merge or switch branches: when you finish, Cloth commits your changes and merges them into ${tree.base} itself, and tells the agent that sent you whether that worked.`,
                    tree.from
                      ? `It carries on from earlier unfinished work (${tree.from}), with the latest ${tree.base} already merged in${tree.conflicts?.length ? `. These files have merge conflicts (<<<<<<< / ======= / >>>>>>> markers): resolve them first, keeping both sides' intent: ${tree.conflicts.join(', ')}` : ', cleanly'}.`
                      : ''
                  ]
                    .filter(Boolean)
                    .join(' ')
                : '',
              named ? `You are the "${named.name}" agent. ${named.purpose}` : '',
              named ? named.instructions.trim() : cfg.instructions.trim()
            ]
              .filter(Boolean)
              .join('\n\n'),
            scope,
            thinking,
            signal,
            // A ticket is a whole vertical slice: Build workers get more room than a quick job.
            maxTurns: Math.max(1, cfg.maxTurns, tree ? 80 : 0),
            onEvent: (turn, now) => {
              files = now.files
              progress({ ...base, blocks: turn.blocks, running: true, ...(turn.usage ? { usage: turn.usage } : {}), ...(now.current ? { current: now.current } : {}), ...(files.length ? { files } : {}) })
            }
          })
        )
          .catch(async (err) => {
            this.providers.usage.tool('task', 'builtin', Date.now() - started, false)
            if (named) this.providers.usage.agentRun(named.id, role, Date.now() - started, false)
            if (tree) {
              const kept = await parkWorkerTree(tree, p.description || 'ticket').catch(() => null)
              if (kept) throw new Error(`${errorMessage(err)}. Its unfinished work is kept on branch ${kept}: start the next worker with continueFrom "${kept}" to carry on from it.`)
            }
            throw err
          })
          .finally(() => {
            progress.cancel()
            release()
          })
        this.providers.usage.tool('task', 'builtin', Date.now() - started, true)
        if (named) this.providers.usage.agentRun(named.id, role, Date.now() - started, true)
        for (const c of changes) if (!files.includes(c.path)) files = [...files, c.path]
        // Its own checkout: commit and merge back. Its changes are commits now, so they aren't offered for undo.
        let merged = ''
        if (tree) {
          const t = tree
          const m = await finishWorkerTree(t, p.description || 'Ticket').catch((err): MergeResult => ({ merged: false, files: [], error: `Couldn't merge its work: ${errorMessage(err)}. It is kept on branch ${t.branch}.` }))
          merged = m.merged ? (m.files.length ? `Worked in its own git copy; merged into ${t.base} (${m.files.length} file${m.files.length === 1 ? '' : 's'}).` : 'Worked in its own git copy; it changed nothing.') : (m.error ?? 'Not merged.')
          files = m.files
        }
        const report = result.text || '(the subagent finished without a report)'
        const outcome = parseOutcome(result.text)
        const notes = [note, treeNote, merged].filter(Boolean)
        const keep = tree ? [] : changes
        return {
          content: [{ type: 'text', text: notes.length ? `${report}\n\n(${notes.join(' ')})` : report }],
          details: { subagent: { ...base, blocks: result.turn.blocks, running: false, usage: result.turn.usage, ...(files.length ? { files } : {}), ...(outcome ? { outcome } : {}) }, ...(keep.length ? { changes: keep } : {}) } as unknown as ToolDetails
        }
      }
    }
  }

  /** Headless agent run (workflows, MCP). Returns the final assistant text and the turn trace. */
  async run(opts: AgentRunOptions): Promise<{ text: string; turn: UiMessage; messages: AgentMessage[] }> {
    // A run that may use the computer holds it under its own name until it ends.
    const owner = opts.scope.computerUse && !opts.scope.depth ? (opts.scope.computerOwner ?? opts.scope.sessionId ?? newId('run_')) : null
    if (owner) opts = { ...opts, scope: { ...opts.scope, computerOwner: owner } }
    try {
      return await this.runAgent(opts)
    } finally {
      if (owner) this.releaseComputer(owner)
    }
  }

  private async runAgent(opts: AgentRunOptions): Promise<{ text: string; turn: UiMessage; messages: AgentMessage[] }> {
    const systemPrompt = await this.systemPrompt(opts.scope, opts.systemPrompt ?? '')
    const agent = this.createAgent({ ...opts, systemPrompt })
    const startIndex = agent.state.messages.length
    let turns = 0
    const maxTurns = opts.maxTurns ?? 12
    // What it is doing now and the files it has changed, for live progress.
    const running = new Map<string, SubagentActivity>()
    const files: string[] = []
    agent.subscribe((e) => {
      if (e.type === 'turn_end' && ++turns >= maxTurns) agent.abort()
      if (e.type === 'tool_execution_start') running.set(e.toolCallId, { tool: e.toolName, summary: toolSummary(e.toolName, e.args) })
      if (e.type === 'tool_execution_end') {
        running.delete(e.toolCallId)
        const changes = (e.result as { details?: ToolDetails } | undefined)?.details?.changes
        if (!e.isError && Array.isArray(changes)) for (const c of changes) if (c.path && !files.includes(c.path)) files.push(c.path)
      }
      if (opts.onEvent && (e.type === 'message_end' || e.type === 'tool_execution_start' || e.type === 'tool_execution_end')) {
        const turn = toUiMessages(agent.state.messages.slice(startIndex), agent.state.pendingToolCalls).at(-1)
        if (turn?.role === 'assistant') opts.onEvent(turn, { current: [...running.values()].at(-1) ?? null, files: [...files] })
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

  /**
   * Once: Auto became "never asks" and Manual took over what Auto did (asking only before risky
   * actions), so chats, project defaults and the default for new chats saved as Auto move to Manual
   * and keep behaving as before. Returns how many chats moved; later calls do nothing.
   */
  migrateAutoToManual(): number {
    if (this.ctx.kv.get<boolean>('permissions.autoToManual', false)) return 0
    this.ctx.kv.set('permissions.autoToManual', true)
    let moved = 0
    const setChat = this.ctx.db.prepare('UPDATE sessions SET config = ? WHERE id = ?')
    for (const r of this.ctx.db.prepare('SELECT id, config FROM sessions').all() as { id: string; config: string }[]) {
      const config = json<SessionInput>(r.config, {})
      if (config.permissions !== 'auto') continue
      setChat.run(JSON.stringify({ ...config, permissions: 'manual' }), r.id)
      moved++
    }
    const setProject = this.ctx.db.prepare('UPDATE projects SET defaults = ? WHERE id = ?')
    for (const r of this.ctx.db.prepare('SELECT id, defaults FROM projects').all() as { id: string; defaults: string }[]) {
      const defaults = json<{ permissions?: unknown }>(r.defaults, {})
      if (defaults.permissions === 'auto') setProject.run(JSON.stringify({ ...defaults, permissions: 'manual' }), r.id)
    }
    if (this.ctx.kv.get<{ defaultPermissions?: unknown }>('settings', {}).defaultPermissions === 'auto') this.settings.update({ defaultPermissions: 'manual' })
    return moved
  }

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

  /** The setup keys a project's defaults decide for its chats. */
  private projectKeys(projectId: string | null): Set<string> {
    const defaults = projectId ? this.projects?.find(projectId)?.defaults : undefined
    return new Set(Object.keys(defaults ?? {}).filter((k) => (defaults as Record<string, unknown>)[k] !== undefined))
  }

  create(config: SessionInput = {}, id = newId('ses_')): ChatSession {
    const now = Date.now()
    const s = this.settings.get()
    // A chat started in a project begins with the project's folder and settings.
    const fromProject: SessionInput = config.projectId && this.projects ? this.projects.chatConfig(config.projectId) : {}
    // New chats start from the shared setup; a project's defaults and anything asked for win over it.
    const shared = this.ctx.kv.get<SharedSetup>(SHARED_KV, {})
    const full: SessionConfig = { ...DEFAULT_CONFIG, model: s.defaultModel, subagents: s.subagents.enabledByDefault, ...shared, ...withoutCaps(fromProject), ...withoutCaps(config) }
    // Its permission mode: asked for, else the project's, else the default for new chats.
    full.permissions = resolvePermissions([config, fromProject], full, isPermissions(s.defaultPermissions) ? s.defaultPermissions : 'manual')
    full.access = full.permissions === 'plan' ? (full.access ?? 'manual') : full.permissions
    if (!full.model) full.model = s.defaultModel
    this.ctx.db.prepare('INSERT INTO sessions (id, title, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, 'New chat', JSON.stringify(full), now, now)
    return this.get(id)
  }

  /** Change a chat. With `share`, setup changes (tools, skills, servers, knowledge, context limit) also become every other chat's. */
  update(id: string, patch: SessionInput & { title?: string }, opts: { share?: boolean } = {}): ChatSession {
    const cur = this.get(id)
    const { title, fileAccess, shell, autoApprove, ...config } = patch
    const next: SessionConfig = {
      model: cur.model,
      systemPrompt: cur.systemPrompt,
      collectionIds: cur.collectionIds,
      knowledgeEnabled: cur.knowledgeEnabled,
      skillsEnabled: cur.skillsEnabled,
      webEnabled: cur.webEnabled,
      customTools: cur.customTools,
      workspace: cur.workspace,
      permissions: cur.permissions,
      access: cur.access,
      subagents: cur.subagents,
      codeIntel: cur.codeIntel,
      imagesEnabled: cur.imagesEnabled,
      computerUse: cur.computerUse,
      computerConsent: cur.computerConsent,
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
      autoTiers: cur.autoTiers,
      contextLimit: cur.contextLimit,
      origin: cur.origin,
      workflow: cur.workflow ?? null,
      ...config
    }
    // Screens that still set the old switches: they become the matching permission mode.
    if (!isPermissions(config.permissions)) next.permissions = cur.permissions
    if (!isPermissions(config.permissions) && hasLegacyCaps({ fileAccess, shell, autoApprove })) {
      next.permissions = legacyPermissions({ fileAccess: fileAccess ?? cur.fileAccess, shell: shell ?? cur.shell, autoApprove: autoApprove ?? cur.autoApprove }, next)
    }
    // Outside Plan mode the access is the mode itself; Plan mode keeps the one to go back to.
    if (next.permissions !== 'plan') next.access = next.permissions
    else if (!next.access) next.access = cur.permissions === 'auto' ? 'auto' : 'manual'
    // Switching computer use off takes back the chat's consent: switched on again, it asks again.
    if (config.computerUse === false) next.computerConsent = false
    // A title set without saying where it came from was typed by the user: AI titles leave it alone.
    if (title !== undefined && config.titleSource === undefined) next.titleSource = 'user'
    // A change to the shared setup (in a chat not set up from an agent) applies to every such chat.
    this.ctx.db.prepare('UPDATE sessions SET title = ?, config = ?, updated_at = ? WHERE id = ?').run(title ?? cur.title, JSON.stringify(next), Date.now(), id)
    // A setup change in a chat not set up from an agent is the setup for every such chat (what a
    // project's defaults decide stays with the project's chats).
    const own = this.projectKeys(next.projectId)
    const sharedPatch = Object.fromEntries(Object.entries(pickShared(config)).filter(([k]) => !own.has(k))) as SharedSetup
    if (opts.share && !next.agentId && config.agentId === undefined && Object.keys(sharedPatch).length) this.shareSetup(id, sharedPatch)
    return this.get(id)
  }

  /** Save setup keys as the shared setup and apply them to every other chat that isn't an agent's (without reordering the chat list). */
  private shareSetup(from: string, patch: SharedSetup): void {
    this.ctx.kv.set(SHARED_KV, { ...this.ctx.kv.get<SharedSetup>(SHARED_KV, {}), ...patch })
    const rows = this.ctx.db.prepare('SELECT id, config FROM sessions WHERE id != ?').all(from) as { id: string; config: string }[]
    const write = this.ctx.db.prepare('UPDATE sessions SET config = ? WHERE id = ?')
    let changed = 0
    for (const r of rows) {
      const stored = json<SessionInput>(r.config, {})
      if (stored.agentId) continue
      const own = this.projectKeys(stored.projectId ?? null)
      const apply = Object.entries(patch).filter(([k, v]) => !own.has(k) && JSON.stringify((stored as Record<string, unknown>)[k]) !== JSON.stringify(v))
      if (!apply.length) continue
      write.run(JSON.stringify({ ...stored, ...Object.fromEntries(apply) }), r.id)
      changed++
    }
    if (changed) this.ctx.emit('chat', { sessionId: from, type: 'setup' } satisfies ChatEvent)
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
    const window = session.model ? this.contextWindow(session.model, session.contextLimit) : null
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
    return { tokens, window, estimated: session.model && !session.contextLimit ? this.contextEstimated(session.model) : false, threshold: window ? budget(window).threshold : null, breakdown, cost: this.usage?.costFor('chat', id) ?? 0 }
  }

  /**
   * Summarise older turns into a checkpoint carried by the first kept user message. The
   * summarised turns move to the archive (still shown in the UI, no longer sent to the model).
   * `splitTurns` (automatic summarising) may also cut between the steps of a long turn.
   */
  async compact(id: string, opts: { instructions?: string; signal?: AbortSignal; splitTurns?: boolean } = {}): Promise<UiMessage[]> {
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('Wait for the agent to finish first')
    const session = this.get(id)
    if (!session.model) throw new Error('Pick a model for this chat first')
    this.compacting.add(id)
    try {
      await this.summariseHistory(id, session.model, this.rawMessages(id), opts)
      return this.messages(id)
    } finally {
      this.compacting.delete(id)
    }
  }

  /**
   * Summarise `raw` (the chat's history, saved or in flight) up to the cut, archive what was
   * summarised and save the shortened history, which is returned. Emits compacting/compacted like
   * any summarising, with the error when it fails.
   */
  private async summariseHistory(id: string, model: ModelRef, raw: AgentMessage[], opts: { instructions?: string; signal?: AbortSignal; splitTurns?: boolean }): Promise<AgentMessage[]> {
    const window = this.contextWindow(model, this.get(id).contextLimit)
    const plan = planCompaction(raw, budget(window).keep, { steps: opts.splitTurns })
    if (!plan) throw new Error('Not enough conversation to summarise yet')
    this.ctx.emit('chat', { sessionId: id, type: 'compacting' })
    try {
      const run = () => summarize(this.runtime.providers, model, plan.older, { previous: plan.previous, instructions: opts.instructions, signal: opts.signal, contextWindow: window })
      const summary = await (this.usage ? this.usage.run({ source: 'chat', ref: id }, run) : run())
      const kept = compactedHistory(plan, summary)
      const archive = [...this.archive(id), ...plan.older]
      this.ctx.db.prepare('UPDATE sessions SET messages = ?, archive = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(kept), JSON.stringify(archive), Date.now(), id)
      this.ctx.kv.set('compactedAt:' + id, Date.now())
      this.ctx.emit('chat', { sessionId: id, type: 'compacted' })
      return kept
    } catch (err) {
      // Stopping the chat while it summarises isn't a failure worth a message.
      this.ctx.emit('chat', { sessionId: id, type: 'compacted', ...(opts.signal?.aborted ? {} : { error: errorMessage(err) }) })
      throw err
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

  /** The model's context window, or the chat's own limit when it sets one. */
  private contextWindow(ref: ModelRef, limit?: number | null): number {
    if (limit && limit > 0) return limit
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

  /** Build the user message; skills invoked with /name, agents tagged with @name and attached files ride along as tagged blocks. */
  private async userMessage(text: string, skillNames: string[], attachments: ChatAttachment[] = [], agents: SavedAgent[] = []): Promise<UserMessage> {
    const attached = await attachmentContent(attachments)
    if (!skillNames.length && !attached.length && !agents.length) return { role: 'user', content: text, timestamp: Date.now() }
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
    for (const agent of agents) {
      const lines = [
        `${AGENT_OPEN}${agent.name.replace(/"/g, '&quot;')}">`,
        `The user tagged @${agentSlug(agent.name)}. Hand this request to the ${agent.name} agent now with the task tool (agent: "${agent.name}"), giving it the user's request and the context it needs (files, folder, earlier findings). When it finishes, relay its findings; don't redo its work yourself.`,
        AGENT_CLOSE
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
    // The agent's folder access as a mode; a chat that is only planning stays in Plan mode.
    patch.permissions = cur.workspace && cur.permissions === 'plan' ? 'plan' : legacyPermissions(agent, cur)
    if (agent.model) patch.model = agent.model
    if (agent.thinking) patch.thinking = agent.thinking
    return this.update(id, patch)
  }

  /** A new chat holding a finished run's conversation (an automation's result), to read and reply to. */
  fromTranscript(input: { id?: string; title: string; workspace: string | null; agentId: string | null; messages: AgentMessage[]; container?: ContainerSettings | null; projectId?: string | null; origin?: ChatOrigin }): ChatSession {
    // A run that worked in a container hands its copy over: the chat shows its changes to apply.
    const s = this.create(
      {
        workspace: input.workspace,
        // Read-only (Plan) on the real folder; a container copy's changes are reviewed before they apply.
        permissions: input.container ? 'auto' : legacyPermissions({ fileAccess: 'read' }, { workspace: input.workspace }),
        container: input.container ?? null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.origin ? { origin: input.origin } : {})
      },
      input.id
    )
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
    const caps = permissionCaps(session.permissions)
    return {
      collectionIds: session.collectionIds,
      knowledgeEnabled: session.knowledgeEnabled,
      skillsEnabled: session.skillsEnabled,
      webEnabled: session.webEnabled,
      customTools: session.customTools,
      workspace: session.workspace,
      fileAccess: caps.fileAccess,
      shell: caps.shell,
      sessionId: id,
      subagents: session.subagents,
      codeIntel: session.codeIntel,
      images: session.imagesEnabled,
      computerUse: session.computerUse,
      computer: {
        granted: () => !!this.get(id).computerConsent,
        grant: () => void this.update(id, { computerConsent: true }),
        stop: () => this.abort(id)
      },
      disabledTools: session.disabledTools,
      skillsOff: session.skillsOff,
      skillsAlways: session.skillsAlways,
      agentId: session.agentId,
      autoTiers: session.autoTiers,
      todos: () => latestTodos(this.active.get(id)?.state.messages ?? this.rawMessages(id)),
      depth: 0,
      permissions: () => this.get(id).permissions,
      workflow: () => this.get(id).workflow ?? null,
      setWorkflowSlug: (slug: string) => {
        const w = this.get(id).workflow
        if (w && w.slug !== slug) this.update(id, { workflow: { ...w, slug } })
      },
      autoApprove: () => permissionCaps(this.get(id).permissions).autoApprove,
      // "Switch to Auto" on an approval card: the chat switches to Auto (and stops asking).
      onAlways: () => {
        if (this.get(id).permissions === 'manual') this.update(id, { permissions: 'auto' })
      }
    }
  }

  /**
   * The user approved the plan the agent presented in Plan mode: switch the chat to `mode` and
   * carry on, as if they had replied "Approved the plan". Returns the chat with its new mode.
   */
  async approvePlan(id: string, mode: 'auto' | 'manual'): Promise<ChatSession> {
    if (mode !== 'auto' && mode !== 'manual') throw new Error('A plan is approved in Auto or Manual mode')
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('This chat is already running')
    const session = this.update(id, { permissions: mode })
    const how =
      mode === 'auto'
        ? 'This chat is now in Auto mode: changes, commands and risky actions run without asking.'
        : "This chat is now in Manual mode: changes and commands run without asking, but risky actions wait for the user's OK, so batch them and explain why each is needed."
    const note = [`${PLAN_OPEN}${mode}">`, `Plan approved. Carry it out. ${how} Work through the plan step by step (keep the todo list current), then report what you did.`, PLAN_CLOSE].join('\n')
    await this.run(id, { role: 'user', content: [{ type: 'text', text: note }, { type: 'text', text: PLAN_APPROVED_TEXT }], timestamp: Date.now() }, '')
    return session
  }

  /**
   * Start Spec → ship in this chat: it grills first, then writes the spec and tickets (documents only), builds and
   * reviews, waiting for the person's OK between stages. `idea` (optional) is what to build, sent as the first message.
   */
  async startWorkflow(id: string, idea?: string): Promise<ChatSession> {
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('This chat is already running')
    const cur = this.get(id)
    if (!cur.workspace) throw new Error('Spec → ship needs a folder: choose one for this chat first')
    // Plan mode is read-only, and the documents need writing: back to the chat's access (Manual if it has none).
    const session = this.update(id, { workflow: { kind: 'spec-ship', stage: 'grill', slug: null }, ...(cur.permissions === 'plan' ? { permissions: cur.access ?? 'manual' } : {}) })
    const text = idea?.trim()
    await this.run(id, { role: 'user', content: [{ type: 'text', text: stageNote('grill', null) }, { type: 'text', text: text || STAGE_TEXT.grill }], timestamp: Date.now() }, text ? text.slice(0, 60) : '')
    return session
  }

  /** The person approved the current stage: move to the next one and start it. */
  async advanceWorkflow(id: string): Promise<ChatSession> {
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('This chat is already running')
    const w = this.get(id).workflow
    if (!w || w.stage === 'done') throw new Error('This chat is not running Spec → ship')
    const stage = nextStage(w.stage)
    const session = this.update(id, { workflow: { ...w, stage } })
    await this.run(id, { role: 'user', content: [{ type: 'text', text: stageNote(stage, w.slug) }, { type: 'text', text: STAGE_TEXT[stage] }], timestamp: Date.now() }, '')
    return session
  }

  /** Leave Spec → ship: the chat carries on as a normal chat (the documents stay). */
  stopWorkflow(id: string): ChatSession {
    return this.update(id, { workflow: null })
  }

  async send(id: string, text: string, skillNames: string[] = [], attachments: ChatAttachment[] = [], agentNames: string[] = []): Promise<void> {
    if (this.active.has(id) || this.compacting.has(id)) throw new Error('This chat is already running')
    // Tagged agents that are gone (or can't take work from this chat) are dropped; the text stays as written.
    const delegates = this.runtime.delegates(this.get(id).agentId)
    const agents = [...new Set(agentNames.map((n) => n.toLowerCase()))].map((n) => delegates.find((a) => a.name.toLowerCase() === n)).filter((a): a is SavedAgent => !!a)
    const message = await this.userMessage(text, skillNames, attachments, agents)
    const names = attachments.map((a) => a.name).join(', ')
    const title = (text.trim() ? text : skillNames.length ? skillNames.map((n) => `/${n}`).join(' ') : agents.length ? agents.map((a) => `@${agentSlug(a.name)}`).join(' ') : names).replace(/\s+/g, ' ').trim().slice(0, 60)
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
    // A message tagging an agent hands it the work with `task`, even in a chat that doesn't use subagents otherwise.
    if (typeof prepared.content !== 'string' && prepared.content.some((c) => c.type === 'text' && c.text.startsWith(AGENT_OPEN))) scope.subagents = true
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
        await this.compact(id, { splitTurns: true }).catch((err) => this.ctx.log('chat', 'auto-compaction failed', errorMessage(err)))
      }
    }
    const history = this.rawMessages(id)
    const systemPrompt = await this.runtime.systemPrompt(scope, await this.instructions(session))
    const agent = this.runtime.createAgent({ model: session.model, scope, thinking: session.thinking, history, systemPrompt })
    // Tell the agent the chat's permission mode when it is new or changed since the last run.
    const mode = permissionSection(session.permissions, { workspace: session.workspace, container: session.container })
    const told = getCurrentSystemMessage(agent.state.messages)?.sections?.[PERMISSIONS_SECTION] ?? null
    if (mode !== told) {
      const update: SystemMessage = { role: 'system', content: '', sections: { [PERMISSIONS_SECTION]: mode }, timestamp: Date.now() }
      agent.state.messages = [...agent.state.messages, update]
    }
    // And the Spec → ship stage, the same way: a section replaced whenever the stage moves on.
    const stage = workflowSection(session.workflow)
    const toldStage = getCurrentSystemMessage(agent.state.messages)?.sections?.[WORKFLOW_SECTION] ?? null
    if (stage !== toldStage) {
      const update: SystemMessage = { role: 'system', content: '', sections: { [WORKFLOW_SECTION]: stage }, timestamp: Date.now() }
      agent.state.messages = [...agent.state.messages, update]
    }
    this.active.set(id, agent)

    const emit = (e: ChatEvent) => this.ctx.emit('chat', e)
    let startIndex = history.length

    // Tool results pile up between the model calls of one turn: summarise before a call that would
    // outgrow the context too. The first call is covered by the check above.
    const model = session.model
    let retryAbove = 0
    agent.prepareRequest = async ({ context }, signal) => {
      if (!this.settings.get().autoCompact || context.messages.findLast((m) => m.role !== 'system')?.role !== 'toolResult') return
      const window = this.contextWindow(model, this.get(id).contextLimit)
      const { threshold } = budget(window)
      const tokens = estimateHistory(context.messages, this.ctx.kv.get<number>('compactedAt:' + id, 0))
      if (tokens <= Math.max(threshold, retryAbove)) return
      try {
        // The latest step (its tool calls and their results) always stays whole.
        const kept = await this.summariseHistory(id, model, context.messages, { signal, splitTurns: true })
        agent.state.messages = kept
        startIndex = Math.max(0, kept.findLastIndex((m) => m.role === 'user'))
        // Still over the line (one huge result): leave it until it has grown by another tenth of the window.
        const after = estimateHistory(kept, this.ctx.kv.get<number>('compactedAt:' + id, 0))
        retryAbove = after > threshold ? after + Math.round(window / 10) : 0
        return { context: { ...context, messages: kept.slice() } }
      } catch (err) {
        // The turn carries on with the full history; the error was shown like any failed summarising.
        this.ctx.log('chat', 'mid-turn compaction failed', errorMessage(err))
        retryAbove = tokens + Math.round(window / 10)
        return
      }
    }
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
        this.runtime.releaseComputer(id)
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
      const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && !hidden(String(b.text))).map((b) => String(b.text)) : []
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
    // Screenshots beyond the latest few never go to the model again: don't keep them either.
    this.ctx.db.prepare('UPDATE sessions SET messages = ?, preview = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(pruneScreenshots(messages)), previewOf(messages), Date.now(), id)
  }

  private row(id: string): SessionRow {
    const row = this.ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) throw new Error(`Unknown chat ${id}`)
    return row
  }
}

function toSession(row: SessionRow): ChatSession {
  const stored = json<SessionInput>(row.config, {})
  const config: SessionConfig = { ...DEFAULT_CONFIG, ...withoutCaps(stored) }
  // Efforts saved before the four levels ('off', 'minimal') read as Light.
  config.thinking = normalizeEffort(config.thinking)
  // Chats saved before permission modes carry the old switches: they map to a mode (and keep it once saved).
  if (!isPermissions(stored.permissions)) config.permissions = legacyPermissions(stored, config)
  return { id: row.id, title: row.title, ...config, ...permissionCaps(config.permissions), ...(row.preview ? { preview: row.preview } : {}), createdAt: row.created_at, updatedAt: row.updated_at }
}

/** One line from the latest turn: the reply's opening, or what was asked when there's no reply yet. */
export function previewOf(messages: AgentMessage[]): string {
  const text = (m: AgentMessage): string => {
    const c = (m as { content?: unknown }).content
    if (typeof c === 'string') return c
    if (!Array.isArray(c)) return ''
    return c
      .filter((b) => b?.type === 'text' && !hidden(String(b.text)) && !String(b.text).startsWith(SUMMARY_OPEN))
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
      // Skill blocks from /name invocations and agent blocks from @name tags are listed; only the user's own text is shown.
      const skills: string[] = []
      const agents: string[] = []
      const parts: string[] = []
      const attachments: UiAttachment[] = []
      let summary: string | undefined
      let planApproval: UiMessage['planApproval']
      let workflowStage: UiMessage['workflowStage']
      for (const c of typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content) {
        if (c.type === 'image') attachments.push({ kind: 'image', mimeType: c.mimeType, data: c.data })
        else if (c.text.startsWith(STAGE_OPEN)) workflowStage = c.text.slice(STAGE_OPEN.length, c.text.indexOf('"', STAGE_OPEN.length)) as WorkflowStage
        else if (c.text.startsWith(PLAN_OPEN)) planApproval = c.text.startsWith(`${PLAN_OPEN}manual"`) ? 'manual' : 'auto'
        else if (c.text.startsWith(FILE_OPEN)) attachments.push(parseFileBlock(c.text)!)
        else if (c.text.startsWith(SUMMARY_OPEN)) summary = splitSummary({ role: 'user', content: [c], timestamp: 0 }).summary ?? ''
        else if (c.text.startsWith(SKILL_OPEN)) skills.push(c.text.slice(SKILL_OPEN.length, c.text.indexOf('"', SKILL_OPEN.length)))
        else if (c.text.startsWith(AGENT_OPEN)) agents.push(c.text.slice(AGENT_OPEN.length, c.text.indexOf('"', AGENT_OPEN.length)).replace(/&quot;/g, '"'))
        else parts.push(c.text)
      }
      out.push({ id: `m${m.timestamp}`, role: 'user', blocks: [{ type: 'text', text: parts.join('\n') }], createdAt: m.timestamp, ...(skills.length ? { skills } : {}), ...(agents.length ? { agents } : {}), ...(attachments.length ? { attachments } : {}), ...(summary !== undefined ? { summary } : {}), ...(planApproval ? { planApproval } : {}), ...(workflowStage ? { workflowStage } : {}) })
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
          ...(block.name === 'generate_image' ? { image: imageTrace(block.arguments, r, partials?.get(block.id)) } : {}),
          ...(block.name === 'computer' && (r?.details as { action?: unknown } | undefined)?.action ? { computer: r!.details as unknown as ComputerTrace } : {}),
          ...(block.name === 'present_plan' && r?.details?.plan ? { plan: r.details.plan as unknown as PlanProposal } : {}),
          ...(block.name === 'ask_questions' && r?.details?.questions ? { questions: r.details.questions as unknown as QuestionRound } : {}),
          ...(block.name === 'finish_stage' && r?.details?.stageGate ? { stageGate: r.details.stageGate as unknown as StageGate } : {})
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
