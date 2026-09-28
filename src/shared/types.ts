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
  createdAt: number
  updatedAt: number
}

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
  kind: 'write' | 'edit' | 'command'
  path?: string
  command?: string
  diff?: string
  added?: number
  removed?: number
  createdAt: number
}

export type ApprovalDecision = 'allow' | 'deny' | 'always'

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
  /** Set on the first message after a compaction: the summary of everything before it. */
  summary?: string
  /** Turns that were summarised away — shown for reference, no longer sent to the model. */
  archived?: boolean
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
  webResults: number
  /** Let web_fetch reach localhost / private network addresses. */
  webAllowPrivate: boolean
  examplesLoaded: boolean
  mcpEnabled: boolean
  mcpPort: number
  mcpRequireToken: boolean
  chunkSize: number
  chunkOverlap: number
  /** Summarise older chat turns automatically when a conversation nears the model's context window. */
  autoCompact: boolean
  /** Model used by the generate_image tool and the image playground. */
  imageModel: ModelRef | null
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
  createdAt: number
  updatedAt: number
}

export type CustomToolInput = Pick<CustomTool, 'name' | 'description' | 'kind' | 'params' | 'config'> & { enabled?: boolean }

export interface BuiltinToolInfo {
  name: string
  label: string
  description: string
  group: 'knowledge' | 'skills' | 'web' | 'workspace' | 'planning'
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
