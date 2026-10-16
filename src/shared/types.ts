// Domain types shared by the main process and the renderer.

// ─── Providers ────────────────────────────────────────────────────────────────

export type ProviderKind = 'openai' | 'anthropic' | 'openai-compatible'

export interface ModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  vision: boolean
  /** Model produces embeddings rather than chat completions. */
  embedding: boolean
  /** Model generates images (OpenAI Images API, or OpenRouter image output). */
  image?: boolean
  /** User-set price in USD per 1M tokens; overrides the built-in price list. */
  pricing?: { input: number; output: number } | null
  /** Where contextWindow came from: reported by the server, the built-in catalogue, or a default guess. */
  contextSource?: 'server' | 'catalog' | 'guess'
}

/** The context size is a default guess (older model lists don't say where it came from; 32,768 was the default). */
export function contextIsGuess(m: Pick<ModelInfo, 'contextSource' | 'contextWindow'>): boolean {
  return m.contextSource === 'guess' || (!m.contextSource && m.contextWindow === 32_768)
}

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  hasApiKey: boolean
  headers: Record<string, string>
  models: ModelInfo[]
  enabled: boolean
  createdAt: number
  /** Served on this PC by a runner on the Run page: free (no cost), not saved, gone when it stops. */
  local?: boolean
  /** The runner serving it (Run page); such a provider can't be edited on the Models page. */
  runnerId?: string
}

export interface ProviderInput {
  name: string
  kind: ProviderKind
  baseUrl: string
  /** undefined = keep existing key, '' = clear it. */
  apiKey?: string
  headers?: Record<string, string>
  enabled?: boolean
}

export interface ModelRef {
  providerId: string
  modelId: string
}

export interface ProviderPreset {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  needsKey: boolean
  hint: string
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  message: string
  models?: ModelInfo[]
}

// ─── RAG ──────────────────────────────────────────────────────────────────────

export interface Collection {
  id: string
  name: string
  description: string
  embedding: ModelRef | null
  embeddingDim: number | null
  docCount: number
  chunkCount: number
  createdAt: number
}

export type SourceType = 'file' | 'url' | 'text'
export type DocStatus = 'pending' | 'indexing' | 'ready' | 'error'

export interface RagDocument {
  id: string
  collectionId: string
  sourceType: SourceType
  source: string
  title: string
  status: DocStatus
  error: string | null
  chunkCount: number
  bytes: number
  embedded: boolean
  updatedAt: number
}

export interface RagHit {
  chunkId: string
  docId: string
  collectionId: string
  title: string
  source: string
  sourceType: SourceType
  headingPath: string
  text: string
  score: number
  bm25Rank: number | null
  vectorRank: number | null
}

export type RagMode = 'hybrid' | 'keyword' | 'vector' | 'agentic'

export interface RagSearchInput {
  query: string
  collectionIds?: string[]
  k?: number
  mode?: RagMode
  /** Model used for agentic query planning; falls back to settings.defaultModel. */
  model?: ModelRef
}

export interface RagSearchResult {
  hits: RagHit[]
  mode: RagMode
  /** Sub-queries issued in agentic mode. */
  queries: string[]
  notes: string[]
  tookMs: number
}

export interface RagAskResult {
  /** Null when no model is configured or nothing relevant was retrieved. */
  answer: string | null
  model: string | null
  search: RagSearchResult
  error: string | null
  tookMs: number
}

export interface IngestUrlInput {
  collectionId: string
  url: string
  crawl?: boolean
  maxPages?: number
  sameOrigin?: boolean
  /** auto = render with the bundled browser only when the page is a JavaScript shell. */
  render?: 'auto' | 'always' | 'never'
}

export interface IngestProgress {
  collectionId: string
  docId?: string
  message: string
  done: boolean
  error?: string
}

// ─── Skills ───────────────────────────────────────────────────────────────────

export interface SkillSource {
  registry: 'skills.sh'
  /** owner/repo/skill */
  id: string
  hash: string | null
  installedAt: number
  url: string
  /** How the link was made: installed through Cloth, matched from the `skills` CLI lock file, or linked by the user. Absent means 'install'. */
  linkedBy?: 'install' | 'lock' | 'user'
}

export type SkillAuditStatus = 'pass' | 'warn' | 'fail' | 'pending' | 'unknown'

/** Security audits skills.sh shows for a registry skill. */
export interface SkillAudits {
  fetchedAt: number
  /** 'page' = parsed from the skill's skills.sh page; 'api' = from the audit API fallback. */
  source: 'page' | 'api'
  audits: { provider: string; status: SkillAuditStatus; reportUrl: string; analyzedAt?: string; alerts?: number }[]
}

/** A hub skill's link to skills.sh and whether a newer snapshot exists. */
export interface SkillRegistryStatus {
  linked: SkillSource | null
  updateAvailable: boolean
  latest: string | null
}

/** A skills.sh entry that may be where a local skill came from. */
export interface SkillLinkCandidate {
  id: string
  installs: number
  /** Every file in the snapshot equals the local file (ignoring CRLF and BOM). */
  identical: boolean
}

export interface SkillUpdateFile {
  path: string
  kind: 'added' | 'changed' | 'removed'
  diff: string
}

export interface RegistrySkill {
  id: string
  source: string
  skillId: string
  name: string
  installs: number
  url: string
  /** Local hub name when already installed. */
  installedAs: string | null
}

export interface RegistryPreview {
  id: string
  name: string
  description: string
  body: string
  files: { path: string; bytes: number }[]
  hash: string | null
  url: string
  installedAs: string | null
}

export interface Skill {
  name: string
  description: string
  body: string
  frontmatter: Record<string, unknown>
  dir: string
  files: string[]
  updatedAt: number
  /** Set when the skill was installed from the skills.sh registry. */
  source: SkillSource | null
}

/** How a skill has been used: from the usage log. */
export interface SkillUsage {
  total: number
  /** auto (the agent loaded it), slash, mcp, workflow. */
  byVia: Record<string, number>
  /** Loads per week, oldest first (last six weeks). */
  weeks: number[]
  /** Chats it was used in. */
  chats: number
  lastUsedAt: number | null
}

export interface SkillCheck {
  id: string
  level: 'ok' | 'note' | 'warn'
  title: string
  detail?: string
}

/** A line worth reading before trusting an imported skill. */
export interface SkillSafetyFinding {
  kind: 'network' | 'shell' | 'files' | 'injection'
  file: string
  line: number
  text: string
}

/** A request and whether the skill should load for it. */
export interface SkillTrigger {
  prompt: string
  should: boolean
}

export interface SkillTriggerRun {
  model: string
  at: number
  ms: number
  results: (SkillTrigger & { picked: string | null; ok: boolean; error?: string })[]
}

export interface SkillInsight {
  usage: SkillUsage
  checks: SkillCheck[]
  safety: { findings: SkillSafetyFinding[]; reviewed: boolean; reviewedAt: number | null }
  triggers: SkillTrigger[]
  lastTrigger: SkillTriggerRun | null
  /** Skills whose descriptions compete with this one's. */
  overlaps: string[]
}

export interface SkillInput {
  name: string
  description: string
  body: string
  frontmatter?: Record<string, unknown>
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

/** 'off' is only for models that don't reason; 'minimal' is read as 'low' (see shared/effort.ts). */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ChatSession {
  id: string
  title: string
  model: ModelRef | null
  systemPrompt: string
  /** Empty = every collection (when knowledgeEnabled). */
  collectionIds: string[]
  knowledgeEnabled: boolean
  skillsEnabled: boolean
  webEnabled: boolean
  customTools: boolean
  workspace: string | null
  /**
   * What the agent may do and what it asks first: auto (nothing asks, risky actions included),
   * manual (changes and commands run, risky actions ask) or plan (read-only until a plan is approved).
   */
  permissions: Permissions
  /**
   * The access (auto or manual) the chat works with outside Plan mode: the same as `permissions` then,
   * and what a chat in Plan mode goes back to. Missing on older chats (manual).
   */
  access?: 'auto' | 'manual'
  /** The Spec → ship workflow this chat is running, or null for a plain chat. */
  workflow?: SpecWorkflow | null
  /** Derived from `permissions` (permissionCaps); read-only, kept for older screens. */
  fileAccess: FileAccess
  /** Derived from `permissions`: a shell tool (bash, or PowerShell on Windows) in the workspace. */
  shell: boolean
  /** Derived from `permissions`: which actions run without asking first. */
  autoApprove: AutoApprove
  /** Let the agent delegate work to subagents with the `task` tool. */
  subagents: boolean
  /** Language servers (TypeScript, Python) for the `lsp` tool and type checks after edits. */
  codeIntel: boolean
  /** Offer generate_image (needs an image model in Settings). */
  imagesEnabled: boolean
  /** Offer the computer tool: screenshots, mouse and keyboard (needs a model that sees images). */
  computerUse: boolean
  /** The user allowed computer use for this chat (asked on its first action). */
  computerConsent?: boolean
  thinking: ThinkingLevel
  /** Where the title came from: the first message, a model's summary, or the user (never overwritten). */
  titleSource?: 'first-message' | 'ai' | 'user'
  /** How many user messages the AI title was written from. */
  titleTurns?: number
  /** The project this chat is filed under (null = not in a project). */
  projectId: string | null
  /** Work in a Linux container on a private copy of the workspace (null = directly on this PC). */
  container: ContainerSettings | null
  /** External MCP servers whose tools this chat may use (by id); null = the ones on by default. */
  mcpServers: string[] | null
  /** Tools switched off for this chat, by name (built-in, custom and mcp__server__tool). */
  disabledTools: string[]
  /** Skills this chat never lists or loads by itself (/name still invokes them). */
  skillsOff: string[]
  /** Skills whose instructions go with every request. */
  skillsAlways: string[]
  /** The saved agent this chat was set up from (its instructions apply); null = Cloth's default assistant. */
  agentId: string | null
  /** The agent picks a tier (model and effort) for each job it delegates with `task`. */
  autoTiers: boolean
  /** What made this chat when it wasn't the user (an automation's report). */
  origin?: ChatOrigin
  /** The start of the latest message (the reply, else what was asked), for the chat list. */
  preview?: string
  createdAt: number
  updatedAt: number
}

export interface ChatOrigin {
  kind: 'automation'
  workflowId: string
}

export type SkillMode = 'off' | 'auto' | 'always'

/** What an agent may use: the same switches a chat has. */
export interface AgentSetup {
  skillsEnabled: boolean
  skillsOff: string[]
  skillsAlways: string[]
  webEnabled: boolean
  customTools: boolean
  subagents: boolean
  codeIntel: boolean
  imagesEnabled: boolean
  knowledgeEnabled: boolean
  /** Empty = every collection. */
  collectionIds: string[]
  /** null = the servers that are on by default. */
  mcpServers: string[] | null
  disabledTools: string[]
  /** The most it may do in the chat's folder (a chat with less access keeps its own). */
  fileAccess: FileAccess
  shell: boolean
  autoApprove: AutoApprove
}

export const DEFAULT_AGENT_SETUP: AgentSetup = {
  skillsEnabled: true,
  skillsOff: [],
  skillsAlways: [],
  webEnabled: false,
  customTools: true,
  subagents: true,
  codeIntel: true,
  imagesEnabled: true,
  knowledgeEnabled: true,
  collectionIds: [],
  mcpServers: null,
  disabledTools: [],
  fileAccess: 'read',
  shell: false,
  autoApprove: 'none'
}

/** The built-in agents, editable but not deletable. (Scout and worker are access modes of a plain `task` job, not agents.) */
export type AgentBuiltin = 'designer' | 'researcher' | 'reviewer'

/** The skills the built-in Designer always applies. */
export const DESIGNER_SKILLS = ['ui-ux-pro-max', 'frontend-design', 'web-design-guidelines']

/** A saved agent: who it is, what it's for, and what it may use. */
export interface Agent extends AgentSetup {
  id: string
  name: string
  /** How other agents decide to hand it work, and what the user sees in pickers. */
  purpose: string
  /** Its system prompt (added after Cloth's own). */
  instructions: string
  /** null = the model of the chat it works in. */
  model: ModelRef | null
  /** null = the chat's effort. */
  thinking: ThinkingLevel | null
  /** The tier (an AgentTier id) whose model and effort it uses when it has none of its own; null = none. */
  tier: string | null
  builtin: AgentBuiltin | null
  createdAt: number
  updatedAt: number
}

export type AgentInput = Partial<Omit<Agent, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>>

/** Starting points for a new agent. */
export const AGENT_TEMPLATES: { id: string; name: string; summary: string; agent: AgentInput }[] = [
  {
    id: 'ui-reviewer',
    name: 'UI reviewer',
    summary: 'Design skills, a real browser, read and edit',
    agent: {
      name: 'UI reviewer',
      purpose: "Reviews and fixes interfaces against the project's design system, and checks the result in a real browser.",
      instructions:
        `You review and fix user interfaces.

- Start from the project's design system (DESIGN.md or its tokens) and use its colours, type and spacing; never hard-code new values.
- Check contrast, focus states, keyboard use and small screens as well as looks.
- When a browser tool is available, open the page at phone and desktop widths, in light and dark themes, and fix what is off before reporting.
- Keep changes small and say what you changed and why.`,
      fileAccess: 'write',
      shell: false
    }
  },
  {
    id: 'release-helper',
    name: 'Release helper',
    summary: 'Git and shell, asks before every command',
    agent: {
      name: 'Release helper',
      purpose: 'Prepares releases: changelogs, version bumps, tags and checks, asking before each command.',
      instructions:
        `You help prepare releases.

- Read the git history and the changelog before writing anything.
- Explain each command before running it; never push, publish or delete without the user saying so.
- Run the tests and build before calling a release ready.
- Report the version, what changed and anything that blocks the release.`,
      fileAccess: 'write',
      shell: true,
      autoApprove: 'none'
    }
  },
  {
    id: 'code-tour',
    name: 'Code tour guide',
    summary: 'Read-only, code intelligence',
    agent: {
      name: 'Code tour guide',
      purpose: 'Explains how a codebase is organised and how a feature works, with file references; read-only.',
      instructions:
        `You explain codebases.

- Start with the big picture (what it does, how it is laid out), then go as deep as asked.
- Use definitions and references to follow the code rather than guessing.
- Refer to files with paths and line numbers.
- Do not change anything.`,
      fileAccess: 'read',
      codeIntel: true
    }
  }
]

/** What a chat's setup adds to every request, item by item (token counts are estimates). */
export interface ChatSetup {
  /** Every tool the chat could have with its folder settings, on or off. */
  tools: { name: string; description: string; tokens: number; on: boolean }[]
  skills: { name: string; description: string; mode: SkillMode; /** Its line in the skill list. */ listedTokens: number; /** Its instructions, sent each time when Always. */ fullTokens: number }[]
  /** The knowledge section of the system prompt. */
  knowledgeTokens: number
}

export interface ContainerSettings {
  /** Docker image, e.g. node:22 or python:3.12. */
  image: string
  /** Let commands reach the internet (package installs). */
  network: boolean
}

export const DEFAULT_CONTAINER: ContainerSettings = { image: 'node:22', network: true }

/** Docker on this PC, as Cloth sees it. */
export interface ContainerStatus {
  available: boolean
  /** Docker Engine version when it is running. */
  version: string | null
  /** Why containers can't run right now (not installed, not started, …). */
  error: string | null
}

/** A file that differs between a chat's container copy and the real folder. */
export interface ContainerChange {
  path: string
  kind: 'create' | 'modify' | 'delete'
  diff: string
  added: number
  removed: number
  /** The real folder's file also changed since the copy was made: applying would overwrite that. */
  conflict: boolean
  binary?: boolean
}

export interface ContainerChanges {
  /** The real folder the copy came from (null = the chat has no folder; nothing to apply to). */
  folder: string | null
  changes: ContainerChange[]
}

/** A server listening inside a chat's container, opened on this PC. */
export interface ContainerPort {
  /** Port inside the container. */
  port: number
  /** Port on this PC's 127.0.0.1 (null when it couldn't be opened). */
  hostPort: number | null
  url: string | null
  error?: string
}

/** Chat settings a project gives the chats started in it. */
export type ProjectDefaults = Partial<
  Pick<ChatSession, 'model' | 'collectionIds' | 'knowledgeEnabled' | 'skillsEnabled' | 'webEnabled' | 'customTools' | 'permissions' | 'fileAccess' | 'shell' | 'autoApprove' | 'subagents' | 'codeIntel' | 'imagesEnabled' | 'thinking' | 'container' | 'mcpServers'>
>

/** A group of chats that share a folder (optional), instructions and starting settings. */
export interface Project {
  id: string
  name: string
  /** Workspace for the project's chats; null = the project only groups chats. */
  folder: string | null
  /** Accent for the sidebar, as a hex colour. */
  color: string
  /** Added to every chat's system prompt (with the folder's AGENTS.md / CLAUDE.md, if any). */
  instructions: string
  defaults: ProjectDefaults
  /** Design system the project's chats follow (its DESIGN.md joins their instructions). */
  designId: string | null
  /** Set on a project Cloth keeps itself (the Automation folder): it can be edited but not deleted. */
  builtin?: 'automation'
  createdAt: number
  updatedAt: number
}

/** Sidebar accents for projects (new ones take the next in turn). */
export const PROJECT_COLORS = ['#dc2645', '#6b9cf0', '#3fb97a', '#e0a43a', '#c084fc', '#fb923c', '#22b8cf', '#f472b6']

export type ProjectInput = Partial<Pick<Project, 'name' | 'folder' | 'color' | 'instructions' | 'defaults' | 'designId'>>

export type FileAccess = 'read' | 'write'
export type AutoApprove = 'none' | 'edits' | 'all'
/** A chat's permission mode (see ChatSession.permissions). */
export type Permissions = 'auto' | 'manual' | 'plan'

/** A plan the agent proposed with `present_plan` (Plan mode). */
/** The stages of Spec → ship, in order; `done` once the review is accepted. */
export type WorkflowStage = 'grill' | 'spec' | 'tickets' | 'build' | 'review' | 'done'
export const WORKFLOW_STAGES: Exclude<WorkflowStage, 'done'>[] = ['grill', 'spec', 'tickets', 'build', 'review']

/** A chat running Spec → ship: grill, write the spec, cut tickets, build them, review against the spec. */
export interface SpecWorkflow {
  kind: 'spec-ship'
  stage: WorkflowStage
  /** The feature's folder name under docs/specs/, set once the spec is written. */
  slug: string | null
}

/** One grilling round: the decisions that can be settled now, each with a recommended answer. */
export interface QuestionRound {
  round: number
  questions: { title: string; context?: string; recommendation: string }[]
  /** What was written down this round (glossary terms, decision records), for the card's footer. */
  recorded?: string
}

/** A stage that's finished and waits for the user's OK before the next one starts. */
export interface StageGate {
  stage: Exclude<WorkflowStage, 'done'>
  summary: string[]
  /** Files this stage wrote, relative to the workspace. */
  files?: string[]
}

export interface PlanProposal {
  title: string
  steps: string[]
  notes?: string
}

/** One file changed by a write/edit tool call; undoable from its checkpoint. */
export interface FileChange {
  path: string
  kind: 'create' | 'modify'
  /** Unified diff, workspace-relative paths. */
  diff: string
  added: number
  removed: number
  undone?: boolean
}

/** A write, edit or shell command waiting for the user's go-ahead. */
export interface PendingApproval {
  id: string
  sessionId: string
  toolCallId: string | null
  kind: 'write' | 'edit' | 'command' | 'tool' | 'computer'
  /** For external tools: which one (server and tool), with its arguments in `command`. */
  tool?: { server: string; name: string }
  path?: string
  command?: string
  diff?: string
  added?: number
  removed?: number
  /** Why this needs a look in Manual mode ("Pushes to a remote", "Installs packages"…); absent for routine asks. */
  risk?: string
  createdAt: number
}

export type ApprovalDecision = 'allow' | 'deny' | 'always'

/** A question the agent asked with `ask_user`; the chat waits for the answer. */
export interface PendingQuestion {
  id: string
  sessionId: string
  toolCallId: string | null
  question: string
  /** Suggested answers (may be empty: free text only). */
  options: string[]
  /** Several options may be picked. */
  multiple: boolean
  /** A typed answer is accepted besides the options. */
  allowOther: boolean
  createdAt: number
}

export interface ToolTrace {
  id: string
  name: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  result: string
  durationMs: number | null
  references: RagHit[]
  /** Files written or edited by this call. */
  changes?: FileChange[]
  /** For `task` calls: the subagent's own run. */
  subagent?: SubagentRun
  /** For `generate_image` calls. */
  image?: GeneratedImage
  /** For `computer` calls: what was done and a small copy of the screenshot it returned. */
  computer?: ComputerTrace
  /** For `present_plan` calls: the plan waiting for the user's approval. */
  plan?: PlanProposal
  /** For `ask_questions` calls: a grilling round waiting for answers. */
  questions?: QuestionRound
  /** For `finish_stage` calls: a Spec → ship stage waiting for the user's OK. */
  stageGate?: StageGate
}

export interface ComputerTrace {
  action: string
  coordinate?: number[]
  display: number
  /** JPEG data URL. */
  thumbnail?: string
  width?: number
  height?: number
}

export type ImageStatus = 'queued' | 'generating' | 'refining' | 'complete' | 'error'

/** A generated image; files live in the app's data folder and load via cloth-image://<id>. */
export interface GeneratedImage {
  id?: string
  status: ImageStatus
  prompt: string
  revisedPrompt?: string
  size: string
  width?: number
  height?: number
  model?: string
  error?: string
  startedAt?: number
}

export type ImageSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536'

export interface SubagentRun {
  role: 'scout' | 'worker'
  /** The saved agent that ran, when the main agent delegated to one by name. */
  agent?: string
  description: string
  blocks: UiBlock[]
  running: boolean
  /** The model it ran on (resolved: tier, agent, settings or the chat's). */
  model?: string
  /** Input/output/cached tokens and cost so far (updated while it runs, final when done). */
  usage?: UiUsage
  /** The tier it ran at (AgentTier id) and that tier's name at the time. */
  tier?: string
  tierName?: string
  /** Which step of the chat's todo list it worked on (1-based) and that step's text at the time. */
  step?: number
  stepText?: string
  /** While running: the tool it is executing now, with a short summary of its arguments. */
  current?: SubagentActivity
  /** Workspace files it has changed so far (kept when it finishes). */
  files?: string[]
  /** What its report says it achieved (its `Result:` line), once finished. */
  outcome?: 'done' | 'partial' | 'blocked'
}

/** What a running subagent is doing: e.g. { tool: 'read', summary: 'src/auth/refresh.ts' }. */
export interface SubagentActivity {
  tool: string
  summary: string
}

export type UiBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; trace: ToolTrace }

export interface UiUsage {
  /** New (uncached) input tokens. */
  input: number
  output: number
  /** Input tokens read from the provider's cache. */
  cached?: number
  cost: number
}

export interface UiMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: UiBlock[]
  createdAt: number
  model?: string
  usage?: UiUsage
  error?: string
  /** Skills the user invoked with /name for this message. */
  skills?: string[]
  /** Saved agents the user tagged with @name for this message (their names). */
  agents?: string[]
  /** Files and images the user attached to this message. */
  attachments?: UiAttachment[]
  /** Set on the first message after a compaction: the summary of everything before it. */
  summary?: string
  /** Turns that were summarised away — shown for reference, no longer sent to the model. */
  archived?: boolean
  /** Set on the user message that approved a plan: the mode the chat switched to. */
  planApproval?: 'auto' | 'manual'
  /** Set on the user message that moved a Spec → ship chat to a new stage: that stage. */
  workflowStage?: WorkflowStage
}

/** An attachment as the chat shows it: images carry their bytes, files only what was read from them. */
export type UiAttachment = { kind: 'image'; mimeType: string; data: string } | { kind: 'file'; name: string; chars: number; truncated?: boolean }

/** A file or image the user attaches to a message (bytes as base64). */
export interface ChatAttachment {
  name: string
  mimeType: string
  data: string
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ContextUsage {
  /** Estimated tokens the next request will carry (history + system prompt). */
  tokens: number
  /** The model's context window, when known. */
  window: number | null
  /** The window is a default guess — the provider doesn't report this model's size. */
  estimated?: boolean
  /** Tokens at which Cloth summarises automatically. */
  threshold: number | null
  /** What the tokens are spent on (estimates, scaled to `tokens`). */
  breakdown: ContextSlice[]
  /** USD spent in this chat so far, including agents it handed work to. */
  cost: number
}

export type ContextSliceKey = 'system' | 'tools' | 'skills' | 'summary' | 'user' | 'assistant' | 'toolResults'

export interface ContextSlice {
  key: ContextSliceKey
  label: string
  tokens: number
}

export type ChatEvent =
  | { sessionId: string; type: 'start' }
  | { sessionId: string; type: 'message'; message: UiMessage }
  | { sessionId: string; type: 'end'; error?: string }
  | { sessionId: string; type: 'title'; title: string }
  | { sessionId: string; type: 'approval'; approval: PendingApproval }
  | { sessionId: string; type: 'approval-done'; id: string }
  | { sessionId: string; type: 'question'; question: PendingQuestion }
  | { sessionId: string; type: 'question-done'; id: string }
  | { sessionId: string; type: 'compacting' }
  | { sessionId: string; type: 'compacted'; error?: string }

// ─── Workflows ────────────────────────────────────────────────────────────────

export type WorkflowNodeType =
  | 'trigger'
  | 'llm'
  | 'agent'
  | 'rag'
  | 'web'
  | 'skill'
  | 'tool'
  | 'http'
  | 'transform'
  | 'condition'
  | 'loop'
  | 'output'

export interface WorkflowNode {
  id: string
  type: WorkflowNodeType
  position: { x: number; y: number }
  data: Record<string, any> & { key: string; label?: string }
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface Workflow {
  id: string
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  cron: string | null
  cronEnabled: boolean
  nextRunAt: number | null
  /** Folder the flow works in: agent nodes and JavaScript tools can create files here. */
  workspace: string | null
  /** Set when the flow is an automation: written as a prompt and edited on the automation screen. */
  automation: Automation | null
  createdAt: number
  updatedAt: number
}

/** @deprecated The automation's agent now decides how to report (report_in_chat, notify, save_to_knowledge). Kept so old data reads. */
export type AutomationDelivery = 'chat' | 'notify' | 'knowledge'

/** A flow written as a prompt: one agent step with exactly the tools, servers, knowledge and skills it may use. */
export interface Automation {
  prompt: string
  /** The saved agent it runs as (its instructions and model); null = Cloth. */
  agentId: string | null
  /** Built-in and custom tools, by name. */
  tools: string[]
  /** External MCP servers by id, each with the tools it may call (null = all of them). */
  servers: { id: string; tools: string[] | null }[]
  collectionIds: string[]
  skills: string[]
  /** @deprecated Ignored: the agent picks how to report with its reporting tools. Kept so old data reads. */
  deliver?: AutomationDelivery
  /** @deprecated Ignored (was where results went when `deliver` was 'knowledge'); save_to_knowledge uses `collectionIds`. */
  collectionId?: string | null
  /** Also run when this changes (null = only on its schedule or when run by hand). */
  watch: AutomationWatch | null
  /** May run commands: in a container on a copy of its folder, or here but only these commands (null = no commands). */
  commands: AutomationCommands | null
}

/** What an automation watches: files in its folder, or a cheap check (a web page, an MCP tool's answer) every few minutes. */
export type AutomationWatch =
  | { kind: 'files' }
  | { kind: 'url'; url: string; everyMinutes: number }
  | { kind: 'mcp'; serverId: string; tool: string; args: Record<string, unknown>; everyMinutes: number }

export type AutomationCommands = { mode: 'container'; image: string; network: boolean } | { mode: 'allowlist'; allow: string[] }

/** A command an allowlisted automation may run: it starts with an allowed command and chains nothing else. */
export function commandAllowed(command: string, allow: string[]): boolean {
  const c = command.trim().replace(/\s+/g, ' ')
  if (!c || /[;&|`<>\n]|\$\(/.test(c)) return false
  return allow.some((a) => {
    const p = a.trim().replace(/\s+/g, ' ')
    return !!p && (c === p || c.startsWith(`${p} `))
  })
}

/** An automation drafted from a plain description, for the user to check before saving (nothing is saved). */
export interface AutomationDraft {
  /** 2–5 words, sentence case. */
  name: string
  /** The prompt rewritten as a clear instruction, and what it may use (only things that exist). */
  automation: Automation
  /** 5-field cron in local time (e.g. "30 8 * * 1-5"); null = only on changes or by hand. */
  cron: string | null
  /** A folder named in the description that exists on disk; else null. */
  workspace: string | null
}

export interface AutomationInput {
  name?: string
  automation?: Automation
  cron?: string | null
  cronEnabled?: boolean
  workspace?: string | null
}

export type NodeRunStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped'

export interface NodeRunTrace {
  nodeId: string
  key: string
  type: WorkflowNodeType
  status: NodeRunStatus
  input?: unknown
  output?: unknown
  error?: string
  startedAt?: number
  durationMs?: number
  /** Loop nodes: iterations run. Body nodes: times the node ran across iterations. */
  iterations?: number
}

export interface WorkflowRun {
  id: string
  workflowId: string
  trigger: 'manual' | 'cron' | 'mcp' | 'change'
  status: 'running' | 'ok' | 'error'
  input: unknown
  output: unknown
  nodes: NodeRunTrace[]
  error: string | null
  /** The workspace this run used, and the files it created or changed there (absolute paths). */
  workspace?: string | null
  files?: string[]
  /** How an automation's run reported, set when it ends (empty: it had nothing to report). Absent on older runs. */
  reports?: WorkflowRunReport[]
  startedAt: number
  finishedAt: number | null
}

/** One way an automation's run reported: a chat it opened, a notification, or a note saved to Knowledge. */
export type WorkflowRunReport = { kind: 'chat'; chatId: string; title: string } | { kind: 'notify'; title?: string } | { kind: 'knowledge'; collection: string; title: string }

/** A run at a glance, for the Flows overview. */
export interface WorkflowRunSummary {
  id: string
  workflowId: string
  trigger: WorkflowRun['trigger']
  status: WorkflowRun['status']
  startedAt: number
  durationMs: number | null
  /** Steps that ran. */
  steps: number
  error: string | null
  /** Label of the step that failed. */
  failedStep: string | null
}

export interface WorkflowOverview {
  /** Per flow: its last 10 runs (newest first) and its scheduled runs in the next 7 days. */
  flows: { id: string; runs: WorkflowRunSummary[]; upcoming: number[] }[]
  /** The latest runs across every flow, newest first. */
  recent: WorkflowRunSummary[]
}

export type WorkflowEvent =
  | { type: 'run'; run: WorkflowRun }
  /**
   * An automation finished (`chatId` when its agent reported in a chat). `notify` when its agent asked for a desktop
   * notification (then `title` and `summary` are that notification's) or the run failed.
   */
  | { type: 'automation'; workflowId: string; name: string; runId: string; ok: boolean; summary: string; chatId: string | null; notify: boolean; title?: string }
  | { type: 'schedule'; workflowId: string; nextRunAt: number | null }

// ─── Settings & MCP ───────────────────────────────────────────────────────────

/** A level of model and effort the chat agent can pick for delegated work. */
export interface AgentTier {
  /** Stable id: the defaults' are light/medium/careful/heavy; new ones are tier_<random>. */
  id: string
  name: string
  /** null = the model of the chat that delegates. */
  model: ModelRef | null
  /** null = the chat's effort. */
  thinking: ThinkingLevel | null
  /** When to pick it (shown to the agent choosing a tier). */
  purpose: string
  /** Extra rules every job at this tier follows (added to the subagent's system prompt). */
  instructions: string
}

const TIER_BASE_RULES = [
  "- Do exactly the job in the brief. Don't widen the scope, refactor neighbouring code or \"improve\" unrelated things.",
  "- Don't make visual or UX design decisions the brief doesn't settle: report the open question instead of guessing.",
  '- Verify before reporting: build, run the tests or exercise the code path when the project allows it, and say which command you ran and what it showed.'
].join('\n')

/** The default tiers' instructions, by tier id. */
export const DEFAULT_TIER_INSTRUCTIONS: Record<string, string> = {
  light: TIER_BASE_RULES,
  medium: TIER_BASE_RULES,
  careful: `${TIER_BASE_RULES}\n- Before editing, list the invariants and edge cases the change must keep; check each one after the change.`,
  heavy: `${TIER_BASE_RULES}\n- For bugs: reproduce first, confirm the root cause, then fix the cause, not the symptom. If you can't reproduce it, say so and give your strongest hypothesis with its evidence.`
}

export interface Settings {
  defaultModel: ModelRef | null
  /** The design system new projects follow (null = none). */
  defaultDesignId: string | null
  embeddingModel: ModelRef | null
  webEngine: WebEngine
  /** External SearXNG base URL; empty = use the bundled sidecar. */
  searxngUrl: string
  /** Custom Obscura binary; empty = use the bundled one. */
  obscuraPath: string
  /** PEM CA certificate path trusted by web search/fetch; empty uses defaults. */
  webCaCertPath: string
  webResults: number
  /** Let web_fetch reach localhost / private network addresses. */
  webAllowPrivate: boolean
  examplesLoaded: boolean
  mcpEnabled: boolean
  mcpPort: number
  mcpRequireToken: boolean
  /** External MCP servers Cloth connects to as a client (their tools go to chats). */
  mcpClients: McpClientConfig[]
  chunkSize: number
  chunkOverlap: number
  /** Summarise older chat turns automatically when a conversation nears the model's context window. */
  autoCompact: boolean
  /** Name chats with a short AI-written summary of what they're about. */
  aiTitles: boolean
  /** Model that writes chat titles; null = the chat's own model. */
  titleModel: ModelRef | null
  /** Models pinned at the top of the model picker ("providerId::modelId"). */
  starredModels: string[]
  /** Model used by the generate_image tool and the image playground. */
  imageModel: ModelRef | null
  /** Let paired phones connect over the network (home Wi-Fi / Tailscale). */
  remoteEnabled: boolean
  remotePort: number
  /** Keep the PC from sleeping while a phone is connected. */
  remoteKeepAwake: boolean
  /** Subagents (the chat agent's `task` tool). */
  subagents: SubagentSettings
  /** Tiers the chat agent picks from when it delegates (cheapest first). */
  agentTiers: AgentTier[]
  /** The permission mode new chats start in (a project's defaults win). */
  defaultPermissions: Permissions
}

export interface SubagentSettings {
  /** New chats start with subagents on. */
  enabledByDefault: boolean
  /** null = the same model as the chat that delegates. */
  model: ModelRef | null
  /** 'inherit' = the delegating chat's thinking level. */
  thinking: ThinkingLevel | 'inherit'
  /** Agent turns a subagent may take before it has to report. */
  maxTurns: number
  /** Subagents running at once across all chats; extra tasks wait their turn. */
  maxParallel: number
  /** Allow the "worker" role, which can edit files (still subject to the chat's approvals). */
  allowWorkers: boolean
  /** Extra instructions every subagent gets. */
  instructions: string
}

export interface McpStatus {
  running: boolean
  url: string
  port: number
  token: string
  requireToken: boolean
  error: string | null
  tools: { name: string; description: string }[]
  recent: McpCallLog[]
  /** When the port is taken: the next free one to offer instead. */
  suggestedPort: number | null
  /** Apps that have connected to Cloth's server, most recent first. */
  apps: McpApp[]
}

export interface McpApp {
  /** What the app calls itself in the MCP handshake (e.g. "claude-code"). */
  name: string
  lastSeen: number
  calls: number
}

export interface McpCallLog {
  at: number
  tool: string
  args: unknown
  ok: boolean
  durationMs: number
  error?: string
  /** "in": an app called Cloth's server; "out": Cloth called an external server. */
  direction?: 'in' | 'out'
  /** The app (in) or the server (out). */
  peer?: string
}

export interface AppInfo {
  version: string
  dataDir: string
  platform: string
  electron: string
  node: string
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export type ToolParamType = 'string' | 'number' | 'boolean' | 'json'

export interface ToolParam {
  name: string
  type: ToolParamType
  description: string
  required: boolean
}

export type CustomToolKind = 'http' | 'javascript' | 'command' | 'prompt'

export interface CustomTool {
  id: string
  name: string
  description: string
  kind: CustomToolKind
  params: ToolParam[]
  config: Record<string, any>
  enabled: boolean
  /** Who made it: the user on the Tools page, or a model (chat `tool_create` / MCP). */
  createdBy: ToolOrigin
  createdAt: number
  updatedAt: number
}

export type ToolOrigin = 'user' | 'chat' | 'mcp'

export type CustomToolInput = Pick<CustomTool, 'name' | 'description' | 'kind' | 'params' | 'config'> & { enabled?: boolean }

export interface BuiltinToolInfo {
  name: string
  label: string
  description: string
  group: 'knowledge' | 'skills' | 'web' | 'workspace' | 'planning' | 'tools'
  availability: string
  /** Where an agent can call it: chats, subagents, flow Agent steps, and apps connected to Cloth over MCP. */
  where: ToolWhere
  schema: unknown
}

export interface ToolWhere {
  chats: boolean
  subagents: boolean
  flows: boolean
  apps: boolean
}

/** Calls of one tool over the last 30 days, from every source (chats, flows, MCP…). */
export interface ToolUsage {
  calls: number
  errors: number
  lastAt: number
  /** Calls per day for the last 14 days, oldest first. */
  daily: number[]
}

export interface ToolRunResult {
  ok: boolean
  output: string
  durationMs: number
  error?: string
}

// ─── Web search ───────────────────────────────────────────────────────────────

export type WebEngine = 'searxng' | 'obscura'

export interface WebResult {
  title: string
  url: string
  snippet: string
  engine?: string
}

export interface WebSearchResult {
  engine: WebEngine
  query: string
  results: WebResult[]
  tookMs: number
}

export interface WebStatus {
  engine: WebEngine
  searxng: { bundled: boolean; external: string | null; running: boolean; starting: boolean; url: string | null; error: string | null; version: string | null }
  obscura: { available: boolean; path: string | null; version: string | null; error: string | null }
}

// ─── Usage & dashboard ────────────────────────────────────────────────────────

/** Where a model call / tool call / skill use came from. */
export type UsageSource = 'chat' | 'workflow' | 'skills' | 'knowledge' | 'mcp' | 'builder' | 'tools' | 'other'
export type UsageRange = '24h' | '7d' | '30d' | '90d' | 'all'

export interface DashboardTotals {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  embedTokens: number
  /** input + output (+ cache) tokens of model calls, plus embedding tokens. */
  tokens: number
  cost: number
  /** Tokens from models with no known price (local models, or pricing not set). */
  unpricedTokens: number
  avgLatencyMs: number | null
  toolCalls: number
  toolErrors: number
  skillUses: number
}

export interface DashboardStats {
  range: UsageRange
  since: number | null
  generatedAt: number
  totals: DashboardTotals
  /** Same totals for the preceding period of equal length (null for "all"). */
  previous: DashboardTotals | null
  bucket: 'hour' | 'day'
  timeline: { t: number; input: number; output: number; calls: number; errors: number; cost: number }[]
  models: {
    providerId: string
    provider: string
    modelId: string
    calls: number
    errors: number
    input: number
    output: number
    cost: number
    priced: boolean
    avgLatencyMs: number | null
    lastUsed: number
  }[]
  tools: { name: string; kind: string; calls: number; errors: number; avgMs: number | null; lastUsed: number }[]
  skills: { name: string; uses: number; via: Record<string, number>; lastUsed: number }[]
  sources: { source: UsageSource; calls: number; tokens: number; cost: number }[]
  /** Model + tool calls by local hour of day, 0–23. */
  hours: number[]
  workflows: {
    runs: number
    ok: number
    errors: number
    avgMs: number | null
    scheduled: number
    top: { id: string; name: string; runs: number; errors: number; avgMs: number | null; lastRun: number }[]
  }
  inventory: { providers: number; models: number; collections: number; documents: number; chunks: number; skills: number; customTools: number; workflows: number; chats: number }
  recent: { at: number; kind: 'llm' | 'embed' | 'tool' | 'skill'; source: UsageSource; label: string; detail: string; ok: boolean }[]
}

// ─── Remote (phone app) ───────────────────────────────────────────────────────

export interface RemoteDevice {
  id: string
  name: string
  platform: string
  createdAt: number
  lastSeenAt: number | null
  /** Paired but has not connected yet (the QR code is still valid). */
  pending: boolean
  connected: boolean
}

export interface RemoteHostAddress {
  address: string
  /** 'Wi-Fi / LAN', 'Tailscale', or the adapter name. */
  label: string
  kind: 'lan' | 'tailscale' | 'other'
}

export interface RemoteStatus {
  enabled: boolean
  running: boolean
  port: number
  error: string | null
  hosts: RemoteHostAddress[]
  devices: RemoteDevice[]
  keepAwake: boolean
}

export interface RemotePairing {
  deviceId: string
  /** cloth://pair?d=… — encoded in the QR code. */
  link: string
  expiresAt: number
  hosts: RemoteHostAddress[]
}

export interface RemoteDirEntry {
  name: string
  path: string
  dir: boolean
  size?: number
}

// ─── Chat side panel: terminals, files, git ───────────────────────────────────

export interface TerminalInfo {
  id: string
  sessionId: string
  title: string
  /** Where the shell started (inside the container for container chats). */
  cwd: string
  container: boolean
  running: boolean
  exitCode: number | null
}

export type TerminalEvent = { type: 'data'; id: string; data: string } | { type: 'exit'; id: string; code: number | null } | { type: 'opened'; terminal: TerminalInfo } | { type: 'closed'; id: string; sessionId: string }

export interface WorkspaceEntry {
  name: string
  /** Relative to the workspace root, '/'-separated. */
  path: string
  dir: boolean
  size: number
  /** Matched by .gitignore (or a dependency/build folder): shown dimmed. */
  ignored: boolean
}

export interface WorkspaceFile {
  path: string
  size: number
  kind: 'text' | 'image' | 'binary'
  text?: string
  truncated?: boolean
  mimeType?: string
  /** Base64, for images. */
  data?: string
}

export interface WorkspaceRoot {
  /** The folder the panel shows: the chat's folder, or its container copy. */
  path: string | null
  container: boolean
  /** The chat's own folder on this PC (git works here). */
  folder: string | null
}

export interface GitFile {
  path: string
  /** For renames: the old path. */
  from?: string
  /** Index and worktree status letters (porcelain: M A D R C U ?, '.' = unchanged). */
  index: string
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}

export interface GitStatus {
  repo: boolean
  root: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  when: string
}

// ─── External MCP servers (Cloth as a client) ─────────────────────────────────

export interface McpClientConfig {
  id: string
  /** Short name; also the prefix of its tools (mcp__name__tool). */
  name: string
  /** How Cloth reaches it: a program it starts (stdio, the default) or a server at a web address (HTTP). */
  transport?: 'stdio' | 'http'
  /** stdio: the program and its arguments. */
  command: string
  args: string[]
  env: Record<string, string>
  /** http: the server's address, and headers sent with every request (e.g. Authorization). */
  url?: string
  headers?: Record<string, string>
  /** Connect at all. */
  enabled: boolean
  /** Available in chats that haven't chosen their servers. */
  defaultOn: boolean
  /** Ask before each tool call, or let calls run. */
  approval: 'ask' | 'auto'
}

/** The name an agent sees for an external server's tool. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)
}

export interface McpClientStatus {
  id: string
  state: 'off' | 'starting' | 'ready' | 'error'
  error: string | null
  tools: { name: string; description: string; inputSchema?: Record<string, unknown> }[]
}

// ─── Run (local models with llama.cpp's llama-server) ────────────────────────

export type RunnerBuiltin = 'bonsai-2-27b'

export interface RunnerSampling {
  temp?: number
  topP?: number
  topK?: number
  minP?: number
}

export interface Runner {
  id: string
  name: string
  builtin: RunnerBuiltin | null
  /** llama-server(.exe), or the folder holding it. */
  serverPath: string | null
  /** The .gguf model file. */
  modelPath: string | null
  /** Vision projector (.gguf), if any. */
  mmprojPath: string | null
  /** e.g. 'ROCm0', 'Vulkan0'; null = llama.cpp's default. */
  device: string | null
  gpuLayers: number
  contextSize: number
  port: number
  flashAttention: boolean
  sampling: RunnerSampling
  /** More llama-server arguments; quotes group words ("a b" or 'a b'). */
  extraArgs: string
  /** The model id the server answers to (and chats use). */
  alias: string
  /** Offer it in the chat model picker while it runs. */
  useInChats: boolean
  createdAt: number
  updatedAt: number
}

export type RunnerInput = Partial<Omit<Runner, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>> & { name: string }
export type RunnerPatch = Partial<Omit<Runner, 'id' | 'builtin' | 'createdAt' | 'updatedAt'>>

export interface RunnerStatus {
  id: string
  state: 'stopped' | 'starting' | 'running' | 'error'
  pid?: number
  /** http://127.0.0.1:<port> while starting or running. */
  url?: string
  error?: string
  startedAt?: number
  lastTokensPerSecond?: number
}

/** A device from `llama-server --list-devices`. */
export interface RunDevice {
  /** What --device takes, e.g. 'ROCm0'. */
  id: string
  description: string
  totalMiB: number
  freeMiB: number
}

export interface RunDetection {
  runtime: { found: boolean; path: string | null; version?: string }
  model: { found: boolean; path: string | null; mmprojPath: string | null }
}

export type RuntimeBackend = 'hip-radeon' | 'vulkan' | 'cuda-12.4' | 'cpu'

export interface RuntimeOptions {
  /** Release tag, e.g. 'b6500'. */
  tag: string
  /** Where the files come from (the release page). */
  source: string
  assets: { backend: RuntimeBackend; name: string; size: number; url: string }[]
}

export interface ModelDownloadInfo {
  /** Folder the files go into. */
  dir: string
  source: string
  files: {
    name: string
    url: string
    /** Bytes; 0 when the server didn't say. */
    size: number
    /** Bytes already downloaded (a partial download resumes from here). */
    present: number
    /** The vision projector: downloaded when it exists. */
    optional: boolean
  }[]
}

export type RunEvent =
  | { type: 'status'; status: RunnerStatus }
  | { type: 'log'; id: string; lines: string[] }
  | {
      type: 'progress'
      kind: 'runtime' | 'model'
      id: string
      /** File being fetched or unpacked. */
      file?: string
      received: number
      total: number
      state: 'downloading' | 'extracting' | 'done' | 'error' | 'cancelled'
      error?: string
    }
