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

export interface SkillEvalCase {
  id: string
  prompt: string
  expectations: string[]
}

export type SkillVerdict = 'fresh' | 'stale' | 'failing' | 'redundant' | 'untested'

export interface SkillHealth {
  verdict: SkillVerdict
  lastRunAt: number
  lastScore: number | null
  model: ModelRef
}

export interface SkillSource {
  registry: 'skills.sh'
  /** owner/repo/skill */
  id: string
  hash: string | null
  installedAt: number
  url: string
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
  evals: SkillEvalCase[]
  health: SkillHealth | null
  /** Set when the skill was installed from the skills.sh registry. */
  source: SkillSource | null
}

export interface SkillInput {
  name: string
  description: string
  body: string
  frontmatter?: Record<string, unknown>
}

export interface SkillExpectationResult {
  expectation: string
  pass: boolean
  reason: string
}

export interface SkillCaseResult {
  caseId: string
  prompt: string
  output: string
  expectations: SkillExpectationResult[]
  score: number
  baselineOutput?: string
  baselineScore?: number
}

export interface SkillAuditIssue {
  severity: 'high' | 'medium' | 'low'
  excerpt: string
  problem: string
  suggestion: string
}

export interface SkillRun {
  id: string
  skillName: string
  kind: 'eval' | 'audit'
  model: ModelRef
  judge: ModelRef
  status: 'running' | 'done' | 'error'
  score: number | null
  baselineScore: number | null
  cases: SkillCaseResult[]
  issues: SkillAuditIssue[]
  summary: string
  verdict: SkillVerdict
  error: string | null
  createdAt: number
  finishedAt: number | null
}

export interface SkillTestInput {
  name: string
  model: ModelRef
  judge?: ModelRef
  baseline?: boolean
  audit?: boolean
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high'

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
  /** What the agent may do in the workspace folder. */
  fileAccess: FileAccess
  /** Offer a shell tool (bash, or PowerShell on Windows) that runs in the workspace. */
  shell: boolean
  /** Which actions run without asking first. */
  autoApprove: AutoApprove
  /** Let the agent delegate work to subagents with the `task` tool. */
  subagents: boolean
  /** Language servers (TypeScript, Python) for the `lsp` tool and type checks after edits. */
  codeIntel: boolean
  /** Offer generate_image (needs an image model in Settings). */
  imagesEnabled: boolean
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
  createdAt: number
  updatedAt: number
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

/** Chat settings a project gives the chats started in it. */
export type ProjectDefaults = Partial<
  Pick<ChatSession, 'model' | 'collectionIds' | 'knowledgeEnabled' | 'skillsEnabled' | 'webEnabled' | 'customTools' | 'fileAccess' | 'shell' | 'autoApprove' | 'subagents' | 'codeIntel' | 'imagesEnabled' | 'thinking' | 'container' | 'mcpServers'>
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
  createdAt: number
  updatedAt: number
}

/** Sidebar accents for projects (new ones take the next in turn). */
export const PROJECT_COLORS = ['#dc2645', '#6b9cf0', '#3fb97a', '#e0a43a', '#c084fc', '#fb923c', '#22b8cf', '#f472b6']

export type ProjectInput = Partial<Pick<Project, 'name' | 'folder' | 'color' | 'instructions' | 'defaults' | 'designId'>>

export type FileAccess = 'read' | 'write'
export type AutoApprove = 'none' | 'edits' | 'all'

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
  kind: 'write' | 'edit' | 'command' | 'tool'
  /** For external tools: which one (server and tool), with its arguments in `command`. */
  tool?: { server: string; name: string }
  path?: string
  command?: string
  diff?: string
  added?: number
  removed?: number
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
  description: string
  blocks: UiBlock[]
  running: boolean
  model?: string
  usage?: UiUsage
}

export type UiBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; trace: ToolTrace }

export interface UiUsage {
  input: number
  output: number
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
  /** Files and images the user attached to this message. */
  attachments?: UiAttachment[]
  /** Set on the first message after a compaction: the summary of everything before it. */
  summary?: string
  /** Turns that were summarised away — shown for reference, no longer sent to the model. */
  archived?: boolean
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
  createdAt: number
  updatedAt: number
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
  trigger: 'manual' | 'cron' | 'mcp'
  status: 'running' | 'ok' | 'error'
  input: unknown
  output: unknown
  nodes: NodeRunTrace[]
  error: string | null
  /** The workspace this run used, and the files it created or changed there (absolute paths). */
  workspace?: string | null
  files?: string[]
  startedAt: number
  finishedAt: number | null
}

export type WorkflowEvent =
  | { type: 'run'; run: WorkflowRun }
  | { type: 'schedule'; workflowId: string; nextRunAt: number | null }
  | WorkflowBuildEvent

// ─── Settings & MCP ───────────────────────────────────────────────────────────

export interface Settings {
  defaultModel: ModelRef | null
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
}

export interface McpCallLog {
  at: number
  tool: string
  args: unknown
  ok: boolean
  durationMs: number
  error?: string
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
  schema: unknown
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

// ─── Workflow builder ─────────────────────────────────────────────────────────

export interface WorkflowGraph {
  name: string
  description: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** How a saved version of a flow came about. */
export type WorkflowVersionSource = 'original' | 'created' | 'edit' | 'ai-build' | 'ai-edit' | 'ai-fix' | 'restore'

/** Everything a version restores. */
export interface WorkflowSnapshot extends WorkflowGraph {
  workspace: string | null
}

export interface WorkflowVersion {
  id: string
  workflowId: string
  source: WorkflowVersionSource
  /** Why it was saved, when known (e.g. the error an AI fix addressed). */
  note: string | null
  /** What changed from the version before, in a few words. */
  summary: string
  nodeCount: number
  createdAt: number
  /** Present when one version is fetched on its own. */
  snapshot?: WorkflowSnapshot
}

export interface WorkflowBuildStep {
  tool: string
  args: unknown
  result: string
  ok: boolean
}

export type WorkflowBuildEvent =
  | { type: 'build-step'; buildId: string; step: WorkflowBuildStep }
  | { type: 'build-text'; buildId: string; text: string }

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
  skills: { name: string; uses: number; via: Record<string, number>; lastUsed: number; verdict: SkillVerdict | null }[]
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
  skillHealth: { total: number; tested: number; passing: number; failing: number; outdated: number; redundant: number }
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
  command: string
  args: string[]
  env: Record<string, string>
  /** Connect at all. */
  enabled: boolean
  /** Available in chats that haven't chosen their servers. */
  defaultOn: boolean
  /** Ask before each tool call, or let calls run. */
  approval: 'ask' | 'auto'
}

export interface McpClientStatus {
  id: string
  state: 'off' | 'starting' | 'ready' | 'error'
  error: string | null
  tools: { name: string; description: string }[]
}
