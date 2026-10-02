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
  Project,
  ContainerChanges,
  ContainerStatus,
  ProjectInput,
  GeneratedImage,
  ImageSize,
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
  SkillEvalCase,
  SkillInput,
  SkillRun,
  SkillTestInput,
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
    pickPaths(opts: { directory?: boolean; multiple?: boolean; title?: string }): Promise<string[]>
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
    search(input: RagSearchInput): Promise<RagSearchResult>
    ask(input: RagSearchInput): Promise<RagAskResult>
    loadExamples(): Promise<Collection | null>
  }
  tools: {
    builtins(): Promise<BuiltinToolInfo[]>
    list(): Promise<CustomTool[]>
    create(input: CustomToolInput): Promise<CustomTool>
    update(id: string, input: CustomToolInput): Promise<CustomTool>
    setEnabled(id: string, enabled: boolean): Promise<CustomTool>
    remove(id: string): Promise<void>
    test(tool: Pick<CustomTool, 'kind' | 'config' | 'params'>, args: Record<string, unknown>): Promise<ToolRunResult>
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
    saveEvals(name: string, cases: SkillEvalCase[]): Promise<Skill>
    draftEvals(name: string, model: ModelRef): Promise<SkillEvalCase[]>
    /** Write a new skill with a model from a plain-language request, and save it. */
    generate(input: { request: string; model: ModelRef; name?: string }): Promise<Skill>
    discover(extra?: string[]): Promise<ExternalSkillInfo[]>
    importFrom(path: string, overwrite?: boolean): Promise<string[]>
    exportTo(name: string, targetRoot: string): Promise<string>
    knownSources(): Promise<string[]>
    test(input: SkillTestInput): Promise<SkillRun>
    runs(name: string): Promise<SkillRun[]>
    registrySearch(query: string): Promise<RegistrySkill[]>
    registryPreview(id: string): Promise<RegistryPreview>
    registryInstall(id: string, overwrite?: boolean): Promise<string>
    registryCheckUpdate(name: string): Promise<{ updateAvailable: boolean; current: string | null; latest: string | null }>
    dir(): Promise<string>
  }
  chat: {
    list(): Promise<ChatSession[]>
    create(config?: SessionPatch): Promise<ChatSession>
    update(id: string, patch: SessionPatch): Promise<ChatSession>
    remove(id: string): Promise<void>
    messages(id: string): Promise<UiMessage[]>
    send(id: string, text: string, skills?: string[]): Promise<void>
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
    create(input: { name: string; description?: string; template?: 'blank' | 'rag-digest' }): Promise<Workflow>
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
  skills: { type: 'run'; run: SkillRun } | { type: 'changed'; name: string }
  tools: { type: 'changed'; id: string }
  export: import('./flow-bundle').ExportEvent
  web: { type: 'status' }
  remote: RemoteStatus
}
