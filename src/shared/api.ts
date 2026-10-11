import type { DesignDraft, DesignInput, DesignSystem } from './design'
import type {
  AppInfo,
  BuiltinToolInfo,
  CustomTool,
  CustomToolInput,
  ToolRunResult,
  WebSearchResult,
  WebStatus,
  WebEngine,
  WorkflowGraph,
  ChatSession,
  ChatAttachment,
  GitCommit,
  GitStatus,
  TerminalInfo,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceRoot,
  Project,
  ContainerChanges,
  ContainerPort,
  ContainerStatus,
  ProjectInput,
  GeneratedImage,
  ImageSize,
  ChatSetup,
  ThinkingLevel,
  Agent,
  AgentInput,
  ContextUsage,
  ApprovalDecision,
  PendingApproval,
  PendingQuestion,
  DashboardStats,
  UsageRange,
  Collection,
  IngestUrlInput,
  McpStatus,
  ModelInfo,
  ModelRef,
  Provider,
  ProviderInput,
  ProviderPreset,
  ProviderTestResult,
  RagDocument,
  RagAskResult,
  RegistryPreview,
  RegistrySkill,
  RagSearchInput,
  RagSearchResult,
  Settings,
  Skill,
  SkillInput,
  UiMessage,
  Workflow,
  WorkflowRun,
  RemoteStatus,
  RemotePairing,
  RemoteDirEntry
} from './types'

export interface ExternalSkillInfo {
  name: string
  description: string
  dir: string
  source: string
  imported: boolean
}

export type SessionPatch = Partial<Omit<ChatSession, 'id' | 'createdAt' | 'updatedAt'>>

/** The whole main-process surface the renderer can call. Every method is async over IPC. */
export interface ClothApi {
  app: {
    info(): Promise<AppInfo>
    pickPaths(opts: { directory?: boolean; multiple?: boolean; title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string[]>
    openPath(path: string): Promise<void>
    /** Reveal a file in Explorer / Finder. */
    showInFolder(path: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  providers: {
    presets(): Promise<ProviderPreset[]>
    list(): Promise<Provider[]>
    create(input: ProviderInput): Promise<Provider>
    update(id: string, input: Partial<ProviderInput>): Promise<Provider>
    remove(id: string): Promise<void>
    test(id: string): Promise<ProviderTestResult>
    refreshModels(id: string): Promise<Provider>
    setModels(id: string, models: ModelInfo[]): Promise<Provider>
    ping(ref: ModelRef): Promise<{ ok: boolean; text: string; latencyMs: number }>
  }
  rag: {
    collections(): Promise<Collection[]>
    createCollection(input: { name: string; description?: string; embedding?: ModelRef | null }): Promise<Collection>
    updateCollection(id: string, patch: { name?: string; description?: string; embedding?: ModelRef | null }): Promise<Collection>
    deleteCollection(id: string): Promise<void>
    documents(collectionId: string): Promise<RagDocument[]>
    chunks(docId: string): Promise<{ id: string; ord: number; headingPath: string; text: string; embedded: boolean }[]>
    deleteDocument(docId: string): Promise<void>
    reindexDocument(docId: string): Promise<RagDocument>
    ingestPaths(collectionId: string, paths: string[]): Promise<{ queued: number }>
    ingestUrl(input: IngestUrlInput): Promise<{ queued: number }>
    ingestText(collectionId: string, title: string, text: string): Promise<RagDocument>
    embedMissing(collectionId: string): Promise<number>
    /** Re-index the documents from one folder or site: new and changed files come in, missing ones go. */
    syncSource(collectionId: string, source: string): Promise<{ removed: number; queued: number }>
    search(input: RagSearchInput): Promise<RagSearchResult>
    ask(input: RagSearchInput): Promise<RagAskResult>
    loadExamples(): Promise<Collection | null>
  }
  tools: {
    builtins(): Promise<BuiltinToolInfo[]>
    /** Calls per tool name over the last 30 days. */
    usage(): Promise<Record<string, import('./types').ToolUsage>>
    list(): Promise<CustomTool[]>
    create(input: CustomToolInput): Promise<CustomTool>
    update(id: string, input: CustomToolInput): Promise<CustomTool>
    setEnabled(id: string, enabled: boolean): Promise<CustomTool>
    remove(id: string): Promise<void>
    test(tool: Pick<CustomTool, 'kind' | 'config' | 'params'>, args: Record<string, unknown>): Promise<ToolRunResult>
    /** Run a built-in tool that only reads, outside any chat. `folder` is where file tools look. */
    tryBuiltin(name: string, args: Record<string, unknown>, folder: string | null): Promise<ToolRunResult>
    /** The built-in tools tryBuiltin can run. */
    tryable(): Promise<string[]>
    /** A tool written from a description, for the user to check and save. Not saved. */
    draft(description: string): Promise<CustomToolInput>
    /** Which agents and automations can call each tool, by tool name (external tools by their agent-facing name). */
    usedBy(): Promise<Record<string, string[]>>
  }
  web: {
    status(): Promise<WebStatus>
    search(query: string, opts?: { k?: number; engine?: WebEngine }): Promise<WebSearchResult>
    startSearxng(): Promise<WebStatus>
    stopSearxng(): Promise<WebStatus>
  }
  skills: {
    list(): Promise<Skill[]>
    get(name: string): Promise<Skill>
    create(input: SkillInput): Promise<Skill>
    update(name: string, input: SkillInput): Promise<Skill>
    remove(name: string): Promise<void>
    readFile(name: string, path: string): Promise<string>
    writeFile(name: string, path: string, content: string): Promise<void>
    /** Write a new skill with a model from a plain-language request, and save it. */
    generate(input: { request: string; model: ModelRef; name?: string }): Promise<Skill>
    discover(extra?: string[]): Promise<ExternalSkillInfo[]>
    importFrom(path: string, overwrite?: boolean): Promise<string[]>
    exportTo(name: string, targetRoot: string): Promise<string>
    knownSources(): Promise<string[]>
    registrySearch(query: string): Promise<RegistrySkill[]>
    registryPreview(id: string): Promise<RegistryPreview>
    registryInstall(id: string, overwrite?: boolean): Promise<string>
    registryCheckUpdate(name: string): Promise<{ updateAvailable: boolean; current: string | null; latest: string | null }>
    /** Each file an update from skills.sh would add, change or remove, with a diff (CRLF and BOM ignored). */
    registryUpdateDiff(name: string): Promise<import('./types').SkillUpdateFile[]>
    /** The skill's skills.sh link (linking it from the `skills` CLI lock file when that matches) and whether an update is available. */
    registryStatus(name: string): Promise<import('./types').SkillRegistryStatus>
    /** Security audits skills.sh shows for a linked skill (cached 24 h; refresh bypasses the cache). Null when not linked or unavailable. */
    registryAudits(name: string, refresh?: boolean): Promise<import('./types').SkillAudits | null>
    /** Search skills.sh for where a local skill may have come from (up to 3 candidates). */
    registryLinkCandidates(name: string): Promise<import('./types').SkillLinkCandidate[]>
    registryLink(name: string, id: string): Promise<import('./types').SkillSource>
    registryUnlink(name: string): Promise<void>
    /** Write the latest snapshot into the skill's own folder, keeping evals.json and the link. Returns the skill name. */
    registryUpdate(name: string): Promise<string>
    /** Usage, local checks, a safety scan and the trigger check for the Overview tab. */
    insight(name: string): Promise<import('./types').SkillInsight>
    saveTriggers(name: string, triggers: import('./types').SkillTrigger[]): Promise<import('./types').SkillTrigger[]>
    draftTriggers(name: string, model: ModelRef): Promise<import('./types').SkillTrigger[]>
    runTriggers(name: string, model: ModelRef): Promise<import('./types').SkillTriggerRun>
    markReviewed(name: string, reviewed: boolean): Promise<void>
    usageAll(): Promise<Record<string, { total: number; lastUsedAt: number }>>
    /** A new chat with the skill set to Always. */
    tryInChat(name: string): Promise<ChatSession>
    dir(): Promise<string>
  }
  /** The chat side panel: the chat's files, terminals and git. */
  panel: {
    root(sessionId: string): Promise<WorkspaceRoot>
    list(sessionId: string, dir: string): Promise<WorkspaceEntry[]>
    read(sessionId: string, path: string): Promise<WorkspaceFile>
    /** Desktop only: open with the default app / show in Explorer. */
    open(sessionId: string, path: string): Promise<void>
    reveal(sessionId: string, path: string): Promise<void>
    terminals(sessionId: string): Promise<TerminalInfo[]>
    openTerminal(sessionId: string, size: { cols: number; rows: number }): Promise<TerminalInfo>
    terminalBuffer(id: string): Promise<string>
    writeTerminal(id: string, data: string): Promise<void>
    resizeTerminal(id: string, cols: number, rows: number): Promise<void>
    closeTerminal(id: string): Promise<void>
    gitStatus(sessionId: string): Promise<GitStatus>
    /** `git init` in the chat's folder (default branch main where supported); nothing is committed. */
    gitInit(sessionId: string): Promise<GitStatus>
    gitDiff(sessionId: string, path: string, staged: boolean): Promise<string>
    gitStage(sessionId: string, paths: string[]): Promise<GitStatus>
    gitUnstage(sessionId: string, paths: string[]): Promise<GitStatus>
    /** Tracked files go back to the last commit's version; untracked ones are deleted. */
    gitDiscard(sessionId: string, paths: string[]): Promise<GitStatus>
    gitCommit(sessionId: string, message: string, all: boolean): Promise<{ hash: string; status: GitStatus }>
    gitLog(sessionId: string): Promise<GitCommit[]>
    gitPush(sessionId: string): Promise<string>
    gitPull(sessionId: string): Promise<string>
    commitMessage(sessionId: string, all: boolean): Promise<string>
  }
  chat: {
    list(): Promise<ChatSession[]>
    create(config?: SessionPatch): Promise<ChatSession>
    update(id: string, patch: SessionPatch): Promise<ChatSession>
    remove(id: string): Promise<void>
    messages(id: string): Promise<UiMessage[]>
    /** agents: the names of saved agents tagged with @name (ones that no longer exist are dropped). */
    send(id: string, text: string, skills?: string[], attachments?: ChatAttachment[], agents?: string[]): Promise<void>
    /** Run a user message again: drops it and everything after, then sends the same content (skills and attachments included). */
    resend(id: string, messageId: string): Promise<void>
    abort(id: string): Promise<void>
    rewind(id: string, messageId: string): Promise<UiMessage[]>
    running(): Promise<string[]>
    pendingApprovals(id: string): Promise<PendingApproval[]>
    resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>
    pendingQuestions(id: string): Promise<PendingQuestion[]>
    /** null = the user skipped the question. */
    answerQuestion(questionId: string, answer: string | null): Promise<void>
    undoChange(id: string, toolCallId: string, force?: boolean): Promise<UiMessage[]>
    compact(id: string, instructions?: string): Promise<UiMessage[]>
    /** Write a new AI title now (also replaces a title the user typed). */
    retitle(id: string): Promise<string | null>
    contextUsage(id: string): Promise<ContextUsage>
    /** The chat's tools and skills with what each adds to a request. */
    setup(id: string): Promise<ChatSetup>
    /** Set the chat up from a saved agent (its model, effort and capabilities); null = the default assistant. */
    useAgent(id: string, agentId: string | null): Promise<ChatSession>
  }
  agents: {
    /** Jobs each agent ran as a subagent in the last 7 days, by agent id. */
    activity(): Promise<Record<string, { jobs: number; failed: number; lastAt: number }>>
    list(): Promise<Agent[]>
    create(input?: AgentInput & { template?: string }): Promise<Agent>
    update(id: string, patch: AgentInput): Promise<Agent>
    duplicate(id: string): Promise<Agent>
    remove(id: string): Promise<void>
    /** Its tools and skills with what each adds to a request (as if it had full access to a folder). */
    setup(id: string): Promise<ChatSetup>
    /** A name and purpose from a description, to check before generating. */
    draft(description: string, model?: ModelRef | null, thinking?: ThinkingLevel): Promise<{ name: string; purpose: string }>
    /** Write the instructions and save the agent. */
    generate(input: { description: string; name: string; purpose: string; model?: ModelRef | null; thinking?: ThinkingLevel }): Promise<Agent>
    /** The instructions with a change applied (not saved). */
    rewrite(instructions: string, request: string, model?: ModelRef | null, thinking?: ThinkingLevel): Promise<string>
  }
  /** Run page: local models served by llama.cpp's llama-server. Events arrive on the 'runs' channel. */
  runs: {
    /** Every runner; the built-in Bonsai runner first (its paths filled in when found on disk). */
    list(): Promise<import('./types').Runner[]>
    status(): Promise<import('./types').RunnerStatus[]>
    create(input: import('./types').RunnerInput): Promise<import('./types').Runner>
    /** Server settings apply on the next start; name, alias and "use in chats" at once. */
    update(id: string, patch: import('./types').RunnerPatch): Promise<import('./types').Runner>
    /** Stops it first. The built-in runner can't be removed. */
    remove(id: string): Promise<void>
    /** Returns at once ('starting', or 'error' with a reason); 'running' arrives as a status event once /health is ok. */
    start(id: string): Promise<import('./types').RunnerStatus>
    stop(id: string): Promise<import('./types').RunnerStatus>
    /** The last ~2000 lines of llama-server output (kept after it stops). */
    logs(id: string): Promise<string[]>
    /** `llama-server --list-devices` for this runner's server. */
    devices(id: string): Promise<import('./types').RunDevice[]>
    /** PrismML's llama.cpp and the Bonsai model on this PC. */
    detect(): Promise<import('./types').RunDetection>
    /** PrismML's latest Windows builds with sizes (reads GitHub; nothing is downloaded). */
    runtimeOptions(): Promise<import('./types').RuntimeOptions>
    /** Download and unpack a build, then set the runner's serverPath. Progress: 'progress' events (kind 'runtime'). */
    downloadRuntime(id: string, backend: import('./types').RuntimeBackend): Promise<import('./types').Runner>
    /** Bonsai's files on Hugging Face with sizes and what's already downloaded (HEAD only). */
    modelDownloadInfo(): Promise<import('./types').ModelDownloadInfo>
    /** Download (resuming a partial file) and set the runner's model and projector. Progress: kind 'model'. */
    downloadModel(id: string): Promise<import('./types').Runner>
    cancelDownload(id: string): Promise<void>
  }
  containers: {
    status(force?: boolean): Promise<ContainerStatus>
    /** What a container chat changed in its copy, against the real folder. */
    changes(sessionId: string): Promise<ContainerChanges>
    /** Copy changes (all, or these paths) into the real folder. */
    apply(sessionId: string, paths?: string[]): Promise<ContainerChanges>
    /** Revert changes in the copy (all, or these paths). */
    discard(sessionId: string, paths?: string[]): Promise<ContainerChanges>
    /** Throw away the container (the copy stays); the next command starts a fresh one. */
    reset(sessionId: string): Promise<void>
    /** Servers listening in the chat's container, opened on this PC. */
    ports(sessionId: string): Promise<ContainerPort[]>
  }
  design: {
    list(): Promise<DesignSystem[]>
    create(draft?: Partial<DesignDraft>): Promise<DesignSystem>
    update(id: string, patch: Partial<DesignDraft>): Promise<DesignSystem>
    duplicate(id: string): Promise<DesignSystem>
    /** Projects following it stop doing so. */
    remove(id: string): Promise<void>
    /** A design proposed by a model from a description; not saved. */
    generate(input: { prompt: string; model: ModelRef; current?: DesignInput }): Promise<DesignDraft>
    /** Three different looks for a description, with words for its sample screen; not saved. */
    looks(input: { prompt: string; model: ModelRef; logoColor?: string | null; avoid?: string[] }): Promise<import('./design').DesignLooks>
    /** Writes DESIGN.md, tokens.css, tailwind.css and tokens.json into the folder. */
    export(id: string, folder: string): Promise<string[]>
    /** Every project with a folder and the state of the system's files in its design/ folder. */
    projects(designId: string): Promise<import('./design').DesignProjectSync[]>
    projectDiff(designId: string, projectId: string, path: string): Promise<string>
    /** Write files into a project's design/ folder; the project then follows the system. */
    writeProject(designId: string, projectId: string, paths: string[]): Promise<import('./design').DesignProjectSync>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: ProjectInput): Promise<Project>
    /** Changing the folder moves the chats that were working in the old one. */
    update(id: string, patch: ProjectInput): Promise<Project>
    /** Its chats are kept (taken out of the project) unless deleteChats. */
    remove(id: string, opts?: { deleteChats?: boolean }): Promise<void>
  }
  workflows: {
    list(): Promise<Workflow[]>
    get(id: string): Promise<Workflow>
    create(input: { name: string; description?: string; template?: import('./types').WorkflowTemplate }): Promise<Workflow>
    /** Run history and upcoming schedule for every flow, for the overview. */
    overview(): Promise<import('./types').WorkflowOverview>
    save(
      id: string,
      patch: Partial<Pick<Workflow, 'name' | 'description' | 'nodes' | 'edges' | 'cron' | 'cronEnabled' | 'workspace'>>,
      meta?: { source?: import('./types').WorkflowVersionSource; note?: string }
    ): Promise<Workflow>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<Workflow>
    run(id: string, input?: unknown): Promise<WorkflowRun>
    cancel(runId: string): Promise<void>
    runs(id: string): Promise<WorkflowRun[]>
    validateCron(expr: string): Promise<{ ok: boolean; next: number | null; error?: string }>
    /** `fixRunId`: repair the flow so that failed run would succeed (the builder gets the failure details). */
    build(input: { description: string; model?: ModelRef | null; workflowId?: string; buildId: string; fixRunId?: string }): Promise<WorkflowGraph>
    /** The failure report the builder gets for a failed run. */
    failureReport(runId: string): Promise<string>
    versions(id: string): Promise<import('./types').WorkflowVersion[]>
    version(versionId: string): Promise<import('./types').WorkflowVersion>
    /** Bring back an earlier version (saved as a new version; nothing is lost). */
    restore(id: string, versionId: string): Promise<Workflow>
    cancelBuild(buildId: string): Promise<void>
    /** What exporting this flow as an app would include, and whether the toolchain is ready. */
    exportPreview(id: string): Promise<import('./flow-bundle').ExportPreview>
    /** Start exporting; progress arrives as 'export' events. Returns the export id. */
    exportStart(input: import('./flow-bundle').ExportInput): Promise<string>
    exportCancel(exportId: string): Promise<void>
    createFromGraph(graph: WorkflowGraph): Promise<Workflow>
    /** A new automation: a prompt, how often it runs and what it may use. */
    createAutomation(input: import('./types').AutomationInput & { name: string; automation: import('./types').Automation }): Promise<Workflow>
    saveAutomation(id: string, input: import('./types').AutomationInput): Promise<Workflow>
    /** When an automation's check last looked (watching a page or an MCP tool), and its error. */
    watchState(id: string): Promise<{ checkedAt: number | null; error: string | null }>
    /** Run an automation's check now; it runs the automation if the answer changed. */
    checkNow(id: string): Promise<{ checkedAt: number | null; error: string | null }>
    /** Turn an automation into an ordinary flow, edited step by step from then on. */
    toFlow(id: string): Promise<Workflow>
  }
  dashboard: {
    stats(range: UsageRange): Promise<DashboardStats>
    clearUsage(): Promise<void>
  }
  images: {
    defaultModel(): Promise<ModelRef | null>
    generate(input: { prompt: string; size?: ImageSize; model?: ModelRef | null }): Promise<GeneratedImage>
    open(id: string): Promise<void>
    saveAs(id: string): Promise<string | null>
  }
  mcp: {
    status(): Promise<McpStatus>
    restart(): Promise<McpStatus>
    rotateToken(): Promise<McpStatus>
    /** External servers Cloth connects to (configs live in settings.mcpClients). */
    clients(): Promise<import('./types').McpClientStatus[]>
    clientPresets(): Promise<Omit<import('./types').McpClientConfig, 'id'>[]>
    startClient(id: string): Promise<import('./types').McpClientStatus>
    stopClient(id: string): Promise<void>
    /** Recent calls Cloth made to external servers, newest first. */
    externalCalls(): Promise<import('./types').McpCallLog[]>
    /** Call one of a server's tools directly (the Tools page's Try it). */
    callTool(id: string, tool: string, args: Record<string, unknown>): Promise<ToolRunResult>
  }
  /** Phone app: pairing on the desktop; file browsing and image bytes for the phone. */
  remote: {
    status(): Promise<RemoteStatus>
    pair(): Promise<RemotePairing>
    cancelPairing(deviceId: string): Promise<RemoteStatus>
    revoke(deviceId: string): Promise<RemoteStatus>
    rename(deviceId: string, name: string): Promise<RemoteStatus>
    /** Drives / home folders to start browsing from. */
    roots(): Promise<RemoteDirEntry[]>
    listDir(path: string): Promise<{ path: string; parent: string | null; entries: RemoteDirEntry[] }>
    imageData(id: string): Promise<{ mime: string; data: string } | null>
  }
}

export type EventMap = {
  chat: import('./types').ChatEvent
  workflow: import('./types').WorkflowEvent
  ingest: import('./types').IngestProgress
  mcp: McpStatus
  skills: { type: 'changed'; name: string }
  tools: { type: 'changed'; id: string }
  export: import('./flow-bundle').ExportEvent
  web: { type: 'status' }
  remote: RemoteStatus
  terminal: import('./types').TerminalEvent
  mcpClients: { type: 'changed' }
  agents: { type: 'changed' }
  mcpCalls: import('./types').McpCallLog
  containers: { sessionId: string; ports: import('./types').ContainerPort[] }
  runs: import('./types').RunEvent
}
