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
    contextUsage(id: string): Promise<ContextUsage>
  }
  workflows: {
    list(): Promise<Workflow[]>
    get(id: string): Promise<Workflow>
    create(input: { name: string; description?: string; template?: 'blank' | 'rag-digest' }): Promise<Workflow>
    save(id: string, patch: Partial<Pick<Workflow, 'name' | 'description' | 'nodes' | 'edges' | 'cron' | 'cronEnabled'>>): Promise<Workflow>
    remove(id: string): Promise<void>
    duplicate(id: string): Promise<Workflow>
    run(id: string, input?: unknown): Promise<WorkflowRun>
    cancel(runId: string): Promise<void>
    runs(id: string): Promise<WorkflowRun[]>
    validateCron(expr: string): Promise<{ ok: boolean; next: number | null; error?: string }>
    build(input: { description: string; model?: ModelRef | null; workflowId?: string; buildId: string }): Promise<WorkflowGraph>
    cancelBuild(buildId: string): Promise<void>
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
  web: { type: 'status' }
  remote: RemoteStatus
}
