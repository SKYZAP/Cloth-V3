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

export interface IngestUrlInput {
  collectionId: string
  url: string
  crawl?: boolean
  maxPages?: number
  sameOrigin?: boolean
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
  collectionIds: string[]
  skillsEnabled: boolean
  webEnabled: boolean
  customTools: boolean
  workspace: string | null
  thinking: ThinkingLevel
  createdAt: number
  updatedAt: number
}

export interface ToolTrace {
  id: string
  name: string
  args: unknown
  status: 'running' | 'ok' | 'error'
  result: string
  durationMs: number | null
  references: RagHit[]
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
}

export type ChatEvent =
  | { sessionId: string; type: 'start' }
  | { sessionId: string; type: 'message'; message: UiMessage }
  | { sessionId: string; type: 'end'; error?: string }
  | { sessionId: string; type: 'title'; title: string }

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
  group: 'knowledge' | 'skills' | 'web' | 'workspace'
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
