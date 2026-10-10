import { runInNewContext } from 'node:vm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Cron } from 'croner'
import type { Automation, AutomationInput, WorkflowOverview, WorkflowRunSummary, WorkflowTemplate, ModelRef, RagMode, Workflow, WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowRun, WorkflowSnapshot, WorkflowVersion, WorkflowVersionSource } from '@shared/types'
import { describeChange, failureReport } from './history'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import type { SettingsService } from '../core/settings'
import { formatHitsForModel, type RagService } from '../rag/rag'
import { skillSystemPrompt, type SkillService } from '../skills/skills'
import { agentScope, type AgentRuntime } from '../agent/chat'
import type { AgentService } from '../agent/agents'
import type { ToolScope } from '../agent/tools'
import { mcpToolName } from '../mcp/client'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'
import { parseJsonLoose } from '../core/llm-json'
import { executeGraph, renderArgs, renderTemplate, type Executor } from './engine'
import { buildWorkflow } from './builder'

export interface RunOptions {
  /** Overrides the flow's workspace for this run (null = none). */
  workspace?: string | null
}

interface VersionRow {
  id: string
  workflow_id: string
  source: WorkflowVersionSource
  note: string | null
  summary: string
  node_count: number
  created_at: number
}

function toVersion(r: VersionRow): WorkflowVersion {
  return { id: r.id, workflowId: r.workflow_id, source: r.source, note: r.note, summary: r.summary, nodeCount: r.node_count, createdAt: r.created_at }
}

interface WorkflowRow {
  id: string
  name: string
  description: string
  graph: string
  cron: string | null
  cron_enabled: number
  created_at: number
  updated_at: number
}

export function validateCron(expr: string): { ok: boolean; next: number | null; error?: string } {
  try {
    const c = new Cron(expr, { paused: true })
    const next = c.nextRun()?.getTime() ?? null
    c.stop()
    return { ok: true, next }
  } catch (err) {
    return { ok: false, next: null, error: errorMessage(err) }
  }
}

export class WorkflowService {
  private jobs = new Map<string, Cron>()
  private running = new Map<string, AbortController>()

  constructor(
    private ctx: Ctx,
    private deps: { providers: ProviderService; rag: RagService; skills: SkillService; runtime: AgentRuntime; settings: SettingsService; web: WebService; custom: CustomToolService; agents?: AgentService }
  ) {}

  list(): Workflow[] {
    const rows = this.ctx.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as unknown as WorkflowRow[]
    return rows.map((r) => this.toWorkflow(r))
  }

  get(id: string): Workflow {
    const row = this.ctx.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined
    if (!row) throw new Error(`Unknown workflow ${id}`)
    return this.toWorkflow(row)
  }

  /** `source: null` skips the first version (the caller saves real content right after). */
  create(input: { name: string; description?: string; template?: WorkflowTemplate }, source: WorkflowVersionSource | null = 'created'): Workflow {
    const id = newId('wf_')
    const now = Date.now()
    const graph = (TEMPLATES[input.template ?? 'blank'] ?? blankTemplate)()
    this.ctx.db
      .prepare('INSERT INTO workflows (id, name, description, graph, cron, cron_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)')
      .run(id, input.name.trim() || 'Untitled workflow', input.description ?? '', JSON.stringify(graph), now, now)
    const wf = this.get(id)
    if (source) this.recordVersion(wf, source)
    else this.unversioned.add(id)
    return wf
  }

  save(
    id: string,
    patch: Partial<Pick<Workflow, 'name' | 'description' | 'nodes' | 'edges' | 'cron' | 'cronEnabled' | 'workspace' | 'automation'>>,
    meta: { source?: WorkflowVersionSource; note?: string } = {}
  ): Workflow {
    const cur = this.get(id)
    // Flows from before history existed: keep what they were, so the first change can be undone.
    if (!this.unversioned.delete(id) && !this.lastVersion(id)) this.recordVersion(cur, 'original')
    const cron = patch.cron === undefined ? cur.cron : patch.cron?.trim() || null
    if (cron) {
      const v = validateCron(cron)
      if (!v.ok) throw new Error(`Invalid cron expression: ${v.error}`)
    }
    const next = { ...cur, ...patch, cron }
    this.ctx.db
      .prepare('UPDATE workflows SET name = ?, description = ?, graph = ?, cron = ?, cron_enabled = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, JSON.stringify({ nodes: next.nodes, edges: next.edges, workspace: next.workspace?.trim() || null, automation: next.automation ?? null }), cron, next.cronEnabled && cron ? 1 : 0, Date.now(), id)
    this.schedule(id)
    const saved = this.get(id)
    this.recordVersion(saved, meta.source ?? 'edit', meta.note)
    return saved
  }

  // ─── Automations ──────────────────────────────────────────────────────────

  /** Delivers an automation's result (a new chat, a Knowledge note); set up by the app. Returns the new chat's id. */
  deliver: ((wf: Workflow, run: WorkflowRun, transcript: AgentMessage[]) => Promise<string | null>) | null = null

  createAutomation(input: AutomationInput & { name: string; automation: Automation }): Workflow {
    const wf = this.create({ name: input.name }, null)
    return this.saveAutomation(wf.id, input, 'created')
  }

  /** Saves an automation and rebuilds its one-step graph from it. */
  saveAutomation(id: string, input: AutomationInput, source: WorkflowVersionSource = 'edit'): Workflow {
    const cur = this.get(id)
    const automation = cleanAutomation(input.automation ?? cur.automation)
    if (!automation) throw new Error('This flow is not an automation')
    if (!automation.prompt.trim()) throw new Error('Say what the automation should do')
    if (automation.deliver === 'knowledge' && !automation.collectionId) throw new Error('Pick the Knowledge collection to save results to')
    const name = input.name?.trim() || cur.name
    return this.save(
      id,
      { name, ...automationGraph(automation), automation, cron: input.cron === undefined ? cur.cron : input.cron, cronEnabled: input.cronEnabled ?? cur.cronEnabled, workspace: input.workspace === undefined ? cur.workspace : input.workspace },
      { source }
    )
  }

  /** Keeps the graph and drops the automation, so the flow editor takes over. */
  toFlow(id: string): Workflow {
    const cur = this.get(id)
    if (!cur.automation) return cur
    return this.save(id, { automation: null }, { note: 'Turned into a flow' })
  }

  private async afterAutomation(wf: Workflow, run: WorkflowRun, transcript: AgentMessage[]): Promise<void> {
    const a = wf.automation
    if (!a) return
    let chatId: string | null = null
    try {
      chatId = run.status === 'ok' && this.deliver ? await this.deliver(wf, run, transcript) : null
    } catch (err) {
      this.ctx.log('automation', `Delivering ${wf.name} failed:`, errorMessage(err))
    }
    const text = run.status === 'ok' ? (typeof run.output === 'string' ? run.output : JSON.stringify(run.output)) : run.error ?? 'Failed'
    this.ctx.emit('workflow', {
      type: 'automation',
      workflowId: wf.id,
      name: wf.name,
      runId: run.id,
      ok: run.status === 'ok',
      summary: text.replace(/\s+/g, ' ').trim().slice(0, 180),
      chatId,
      // Failed runs always say so; finished ones when the automation asks to notify.
      notify: run.status !== 'ok' || a.deliver === 'notify'
    })
  }

  // ─── History ──────────────────────────────────────────────────────────────

  /** Flows created empty on purpose, whose first save is their first version. */
  private unversioned = new Set<string>()

  private snapshot(wf: Workflow): WorkflowSnapshot {
    return { name: wf.name, description: wf.description, nodes: wf.nodes, edges: wf.edges, workspace: wf.workspace }
  }

  private lastVersion(id: string): { snapshot: WorkflowSnapshot } | null {
    const row = this.ctx.db.prepare('SELECT snapshot FROM workflow_versions WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(id) as { snapshot: string } | undefined
    return row ? { snapshot: json<WorkflowSnapshot>(row.snapshot, { name: '', description: '', nodes: [], edges: [], workspace: null }) } : null
  }

  /** Store the flow as a version when its content changed (schedule changes alone don't count). */
  private recordVersion(wf: Workflow, source: WorkflowVersionSource, note?: string): void {
    const next = this.snapshot(wf)
    const prev = this.lastVersion(wf.id)?.snapshot
    const summary = prev ? describeChange(prev, next) : source === 'original' ? 'As it was before history was kept' : `${next.nodes.length} nodes`
    if (prev && !summary) return
    this.ctx.db
      .prepare('INSERT INTO workflow_versions (id, workflow_id, snapshot, source, note, summary, node_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId('wfv_'), wf.id, JSON.stringify(next), source, note ?? null, summary, next.nodes.length, Date.now())
    // Keep the most recent 100.
    this.ctx.db
      .prepare('DELETE FROM workflow_versions WHERE workflow_id = ? AND id NOT IN (SELECT id FROM workflow_versions WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100)')
      .run(wf.id, wf.id)
  }

  versions(id: string): WorkflowVersion[] {
    const rows = this.ctx.db.prepare('SELECT id, workflow_id, source, note, summary, node_count, created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC').all(id) as unknown as VersionRow[]
    return rows.map(toVersion)
  }

  version(versionId: string): WorkflowVersion {
    const row = this.ctx.db.prepare('SELECT * FROM workflow_versions WHERE id = ?').get(versionId) as (VersionRow & { snapshot: string }) | undefined
    if (!row) throw new Error('That version no longer exists')
    return { ...toVersion(row), snapshot: json<WorkflowSnapshot>(row.snapshot, { name: '', description: '', nodes: [], edges: [], workspace: null }) }
  }

  restore(id: string, versionId: string): Workflow {
    const v = this.version(versionId)
    if (v.workflowId !== id) throw new Error('That version belongs to another flow')
    const s = v.snapshot!
    return this.save(id, { name: s.name, description: s.description, nodes: s.nodes, edges: s.edges, workspace: s.workspace }, { source: 'restore', note: `Restored the version from ${new Date(v.createdAt).toLocaleString()}` })
  }

  /** A description of a failed run for the AI builder: where it broke, what that step got, and what came before. */
  failureReport(runId: string): string {
    const row = this.ctx.db.prepare('SELECT data FROM workflow_runs WHERE id = ?').get(runId) as { data: string } | undefined
    if (!row) throw new Error('That run no longer exists')
    const run = JSON.parse(row.data) as WorkflowRun
    return failureReport(run, this.get(run.workflowId), { tools: this.deps.custom.list() })
  }

  remove(id: string): void {
    this.unschedule(id)
    this.ctx.db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
  }

  createFromGraph(graph: WorkflowGraph): Workflow {
    const wf = this.create({ name: graph.name || 'Assembled workflow', description: graph.description }, null)
    return this.save(wf.id, { nodes: graph.nodes, edges: graph.edges }, { source: 'ai-build' })
  }

  private builds = new Map<string, AbortController>()

  /** Have an agent assemble (or modify) a workflow graph from a description. Not saved — the editor reviews it first. */
  async build(input: { description: string; model?: ModelRef | null; workflowId?: string; buildId: string; fixRunId?: string }): Promise<WorkflowGraph> {
    const model = this.modelFor(input.model)
    const existing = input.workflowId ? this.get(input.workflowId) : undefined
    const controller = new AbortController()
    this.builds.set(input.buildId, controller)
    try {
      return await buildWorkflow(this.ctx, this.deps, {
        description: input.description,
        model,
        buildId: input.buildId,
        signal: controller.signal,
        existing: existing && { name: existing.name, description: existing.description, nodes: existing.nodes, edges: existing.edges },
        failure: input.fixRunId ? this.failureReport(input.fixRunId) : undefined
      })
    } finally {
      this.builds.delete(input.buildId)
    }
  }

  cancelBuild(buildId: string): void {
    this.builds.get(buildId)?.abort()
  }

  duplicate(id: string): Workflow {
    const cur = this.get(id)
    const copy = this.create({ name: `${cur.name} (copy)`, description: cur.description }, null)
    return this.save(copy.id, { nodes: cur.nodes, edges: cur.edges, cron: cur.cron, cronEnabled: false, workspace: cur.workspace }, { source: 'created', note: `Copied from “${cur.name}”` })
  }

  /** Every flow's last runs and upcoming schedule, and the latest runs overall. */
  overview(): WorkflowOverview {
    const week = Date.now() + 7 * 86_400_000
    const labels = new Map<string, Map<string, string>>()
    const label = (wfId: string, nodeId: string) => {
      if (!labels.has(wfId)) {
        const wf = this.find(wfId)
        labels.set(wfId, new Map((wf?.nodes ?? []).map((n) => [n.id, String((n.data as { label?: unknown }).label ?? n.type)])))
      }
      return labels.get(wfId)!.get(nodeId) ?? null
    }
    const summary = (r: WorkflowRun): WorkflowRunSummary => {
      const failed = r.nodes.find((n) => n.status === 'error')
      return {
        id: r.id,
        workflowId: r.workflowId,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt,
        durationMs: r.finishedAt ? r.finishedAt - r.startedAt : null,
        steps: r.nodes.filter((n) => n.status === 'ok' || n.status === 'error').length,
        error: (failed?.error ?? r.error)?.split('\n')[0].slice(0, 200) ?? null,
        failedStep: failed ? label(r.workflowId, failed.nodeId) : null
      }
    }
    const flows = this.list().map((wf) => {
      let upcoming: number[] = []
      if (wf.cronEnabled && wf.cron) {
        try {
          const c = new Cron(wf.cron, { paused: true })
          upcoming = c.nextRuns(60).map((d) => d.getTime()).filter((t) => t <= week)
          c.stop()
        } catch {
          /* invalid expression: nothing scheduled */
        }
      }
      return { id: wf.id, runs: this.runs(wf.id, 10).map(summary), upcoming }
    })
    const recent = (this.ctx.db.prepare('SELECT data FROM workflow_runs ORDER BY started_at DESC LIMIT 12').all() as { data: string }[]).map((r) => summary(JSON.parse(r.data) as WorkflowRun))
    return { flows, recent }
  }

  private find(id: string): Workflow | null {
    try {
      return this.get(id)
    } catch {
      return null
    }
  }

  runs(workflowId: string, limit = 30): WorkflowRun[] {
    const rows = this.ctx.db.prepare('SELECT data FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?').all(workflowId, limit) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as WorkflowRun)
  }

  cancel(runId: string): void {
    this.running.get(runId)?.abort()
  }

  // ─── Scheduling ───────────────────────────────────────────────────────────

  startScheduler(): void {
    for (const wf of this.list()) this.schedule(wf.id)
  }

  stopScheduler(): void {
    for (const id of [...this.jobs.keys()]) this.unschedule(id)
  }

  private schedule(id: string): void {
    this.unschedule(id)
    const wf = this.get(id)
    if (!wf.cron || !wf.cronEnabled) {
      this.ctx.emit('workflow', { type: 'schedule', workflowId: id, nextRunAt: null })
      return
    }
    const job = new Cron(wf.cron, { protect: true, name: id }, async () => {
      try {
        await this.run(id, this.defaultInput(this.get(id)), 'cron')
      } catch (err) {
        this.ctx.log('workflow', `cron run of ${id} failed`, errorMessage(err))
      }
      this.ctx.emit('workflow', { type: 'schedule', workflowId: id, nextRunAt: job.nextRun()?.getTime() ?? null })
    })
    this.jobs.set(id, job)
    this.ctx.emit('workflow', { type: 'schedule', workflowId: id, nextRunAt: job.nextRun()?.getTime() ?? null })
  }

  private unschedule(id: string): void {
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
  }

  private defaultInput(wf: Workflow): unknown {
    const trigger = wf.nodes.find((n) => n.type === 'trigger')
    return json(trigger?.data.defaultInput ?? '{}', {})
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  startRun(id: string, input: unknown, trigger: WorkflowRun['trigger'] = 'manual', opts: RunOptions = {}): WorkflowRun {
    const { run } = this.begin(id, input, trigger, opts)
    return run
  }

  async run(id: string, input: unknown, trigger: WorkflowRun['trigger'] = 'manual', opts: RunOptions = {}): Promise<WorkflowRun> {
    const { done } = this.begin(id, input, trigger, opts)
    return done
  }

  private begin(id: string, input: unknown, trigger: WorkflowRun['trigger'], opts: RunOptions): { run: WorkflowRun; done: Promise<WorkflowRun> } {
    const wf = this.get(id)
    const effectiveInput = input === undefined || input === null || input === '' ? this.defaultInput(wf) : input
    const workspace = (opts.workspace === undefined ? wf.workspace : opts.workspace) || null
    if (workspace && !existsSync(workspace)) throw new Error(`The workspace folder does not exist: ${workspace}`)
    const files = new Set<string>()
    const run: WorkflowRun = {
      id: newId('wfr_'),
      workflowId: id,
      trigger,
      status: 'running',
      input: effectiveInput,
      output: null,
      nodes: [],
      error: null,
      workspace,
      files: [],
      startedAt: Date.now(),
      finishedAt: null
    }
    const controller = new AbortController()
    this.running.set(run.id, controller)
    this.persist(run)
    let transcript: AgentMessage[] = []
    const done = this.deps.providers.usage.run({ source: 'workflow', ref: id }, () =>
      executeGraph(
        wf,
        effectiveInput,
        this.executor({
          workspace,
          onFile: (abs) => {
            files.add(abs)
            run.files = [...files]
          },
          onTranscript: (messages) => (transcript = messages)
        }),
        controller.signal,
        {
          onUpdate: (traces) => {
            run.nodes = traces
            this.persist(run)
          }
        }
      )
    )
      .then(({ output, traces }) => {
        run.nodes = traces
        run.output = output
        run.status = 'ok'
        return run
      })
      .catch((err) => {
        run.status = 'error'
        run.error = errorMessage(err)
        return run
      })
      .finally(() => {
        run.finishedAt = Date.now()
        this.running.delete(run.id)
        this.persist(run)
        this.prune(id)
      })
      .then(async (r) => {
        if (wf.automation) await this.afterAutomation(wf, r, transcript)
        return r
      })
    return { run: { ...run }, done }
  }

  private persist(run: WorkflowRun): void {
    this.ctx.db
      .prepare('INSERT INTO workflow_runs (id, workflow_id, data, started_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(run.id, run.workflowId, JSON.stringify(run), run.startedAt)
    this.ctx.emit('workflow', { type: 'run', run })
  }

  private prune(workflowId: string): void {
    this.ctx.db
      .prepare('DELETE FROM workflow_runs WHERE workflow_id = ? AND id NOT IN (SELECT id FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 200)')
      .run(workflowId, workflowId)
  }

  /**
   * The flow with each Agent step's saved agent written into the step itself (instructions, switches,
   * the skills it may use), for an exported app, which has no saved agents.
   */
  async withAgentsInlined(wf: Workflow): Promise<Workflow> {
    if (!wf.nodes.some((n) => n.type === 'agent' && n.data.agentId)) return wf
    const skills = (await this.deps.skills.list()).map((s) => s.name)
    const nodes = wf.nodes.map((n) => {
      if (n.type !== 'agent' || !n.data.agentId) return n
      const a = this.deps.agents?.find(String(n.data.agentId))
      const { agentId: _a, ...data } = n.data
      if (!a) return { ...n, data }
      return {
        ...n,
        data: {
          ...data,
          system: [`You are the "${a.name}" agent. ${a.purpose}`, a.instructions.trim(), String(n.data.system ?? '')].filter(Boolean).join('\n\n'),
          skillsEnabled: a.skillsEnabled || a.skillsAlways.length > 0,
          skills: skills.filter((s) => !a.skillsOff.includes(s)),
          webEnabled: a.webEnabled,
          customTools: a.customTools,
          collectionIds: a.knowledgeEnabled ? a.collectionIds : []
        }
      }
    })
    return { ...wf, nodes }
  }

  private modelFor(ref: ModelRef | null | undefined): ModelRef {
    const m = ref?.providerId ? ref : this.deps.settings.get().defaultModel
    if (!m) throw new Error('No model selected (and no default model in Settings)')
    return m
  }

  private executor(env: { workspace: string | null; onFile(abs: string): void; onTranscript?(messages: AgentMessage[]): void }): Executor {
    const { providers, rag, skills, runtime, web, custom } = this.deps
    /** Tool-like nodes count as tool calls on the dashboard. */
    const timed = async <T>(name: string, kind: string, fn: () => Promise<T>): Promise<T> => {
      const started = Date.now()
      try {
        const out = await fn()
        providers.usage.tool(name, kind, Date.now() - started, true)
        return out
      } catch (err) {
        providers.usage.tool(name, kind, Date.now() - started, false)
        throw err
      }
    }
    return async (node, { scope, prev, signal }) => {
      const d = node.data
      const t = (s: unknown) => renderTemplate(String(s ?? ''), scope)
      switch (node.type) {
        case 'trigger':
          return { output: scope.input }

        case 'llm': {
          const { text } = await providers.complete(this.modelFor(d.model), {
            system: t(d.system) || undefined,
            prompt: t(d.prompt) || String(prev ?? ''),
            temperature: d.temperature === '' || d.temperature === undefined ? undefined : Number(d.temperature),
            maxTokens: d.maxTokens ? Number(d.maxTokens) : undefined,
            signal
          })
          if (d.json) {
            const parsed = parseJsonLoose(text)
            if (parsed === null) throw new Error('Model reply was not valid JSON')
            return { output: parsed }
          }
          return { output: text }
        }

        case 'agent': {
          // An agent works in its own folder (read-only unless set otherwise) or in the flow's workspace (read & write).
          const workspace = d.workspace || env.workspace
          const fileAccess = d.fileAccess ?? (workspace && workspace === env.workspace ? 'write' : 'read')
          let scope: ToolScope = {
            collectionIds: d.collectionIds ?? [],
            skillsEnabled: d.skillsEnabled ?? true,
            webEnabled: !!d.webEnabled,
            customTools: d.customTools ?? true,
            toolNames: Array.isArray(d.tools) ? d.tools : null,
            skillNames: Array.isArray(d.skills) ? d.skills : null,
            workspace: workspace || null,
            fileAccess,
            // Nobody is watching a flow run: edits inside its workspace are approved up front.
            autoApprove: () => (fileAccess === 'write' ? 'edits' : 'none'),
            onFile: env.onFile,
            codeIntel: false
          }
          // A saved agent brings its own instructions, model, effort and what it may use.
          const saved = d.agentId ? this.deps.agents?.find(String(d.agentId)) : null
          if (d.agentId && !saved) throw new Error('The agent this step runs was deleted. Pick another one in the step settings.')
          let system = t(d.system)
          if (saved) {
            scope = { ...agentScope(saved, scope), toolNames: null, skillNames: null, codeIntel: false, autoApprove: scope.autoApprove, onFile: env.onFile }
            const mcp = runtime.mcpClients
            if (mcp && saved.mcpServers) {
              scope.mcpServers = mcp.chatServers(saved.mcpServers)
              await mcp.ensure(scope.mcpServers)
            }
            system = [`You are the "${saved.name}" agent. ${saved.purpose}`, saved.instructions.trim(), system].filter(Boolean).join('\n\n')
          }
          // An automation's step may use exactly what was picked for it, whoever it runs as.
          if (d.automation) scope = await this.automationScope(d, scope)
          const res = await runtime.run({
            model: d.model?.providerId ? d.model : (saved?.model ?? this.modelFor(null)),
            prompt: t(d.prompt) || String(prev ?? ''),
            systemPrompt: system,
            scope,
            thinking: saved?.thinking ?? undefined,
            maxTurns: d.maxTurns ? Number(d.maxTurns) : 12,
            signal
          })
          if (workspace) for (const b of res.turn.blocks) if (b.type === 'tool') for (const c of b.trace.changes ?? []) env.onFile(join(workspace, c.path))
          if (d.automation) env.onTranscript?.(res.messages)
          const tools = res.turn.blocks.filter((b) => b.type === 'tool').map((b) => (b.type === 'tool' ? b.trace.name : ''))
          return { output: d.includeTrace ? { text: res.text, tools } : res.text }
        }

        case 'rag': {
          const res = await timed('rag_search', 'builtin', () => rag.search({
            query: t(d.query) || String(prev ?? ''),
            collectionIds: d.collectionIds ?? [],
            k: d.k ? Number(d.k) : 6,
            mode: (d.mode ?? 'hybrid') as RagMode,
            model: d.model?.providerId ? d.model : undefined
          }))
          return { output: { text: formatHitsForModel(res.hits), hits: res.hits.map((h) => ({ title: h.title, source: h.source, heading: h.headingPath, text: h.text, score: h.score })), queries: res.queries } }
        }

        case 'web': {
          const res = await timed('web_search', 'builtin', () => web.search(t(d.query) || String(prev ?? ''), { k: d.k ? Number(d.k) : undefined, signal }))
          const fetchTop = Math.min(Number(d.fetchTop) || 0, res.results.length)
          const pages: string[] = []
          for (const r of res.results.slice(0, fetchTop)) {
            const page = await web.fetchPage(r.url, signal).catch((err) => ({ title: r.title, markdown: `(fetch failed: ${err instanceof Error ? err.message : err})` }))
            pages.push(`## ${page.title}\nsource: ${r.url}\n\n${page.markdown}`)
          }
          const list = res.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
          const text = pages.length ? `${list}\n\n---\n\n${pages.join('\n\n---\n\n')}` : list
          return { output: { text, results: res.results, engine: res.engine } }
        }

        case 'tool': {
          const tool = custom.list().find((x) => x.name === d.tool)
          if (!tool) throw new Error(`Custom tool "${d.tool}" not found`)
          const args = renderArgs(d.args, scope)
          const toolEnv = env.workspace ? { workspace: { root: env.workspace, writable: true, onWrite: env.onFile } } : {}
          return { output: await timed(tool.name, 'custom', () => custom.execute(tool, args, signal, toolEnv)) }
        }

        case 'skill': {
          const skill = await skills.get(String(d.skill ?? ''))
          providers.usage.skill(skill.name, 'workflow')
          if ((d.mode ?? 'content') === 'content') return { output: skill.body }
          const { text } = await providers.complete(this.modelFor(d.model), { system: skillSystemPrompt(skill), prompt: t(d.prompt) || String(prev ?? ''), signal })
          return { output: text }
        }

        case 'http': {
          const headers = json<Record<string, string>>(t(d.headers || '{}'), {})
          const method = String(d.method ?? 'GET').toUpperCase()
          const res = await fetch(t(d.url), {
            method,
            headers: { ...(d.body && method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...headers },
            body: method === 'GET' || method === 'HEAD' ? undefined : t(d.body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(Number(d.timeoutMs) || 30_000)])
          })
          const text = await res.text()
          const body = json<unknown>(text, text)
          if (!res.ok && !d.allowErrors) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
          return { output: { status: res.status, body } }
        }

        case 'transform': {
          const value = runInNewContext(`(function(){ ${d.code || 'return prev'} \n})()`, { input: scope.input, prev, nodes: scope, JSON, Math, Date }, { timeout: 1000 })
          return { output: await value }
        }

        case 'condition': {
          const result = runInNewContext(`(function(){ return (${d.expression || 'true'}) })()`, { input: scope.input, prev, nodes: scope, JSON, Math, Date }, { timeout: 500 })
          return { output: prev, branch: result ? 'true' : 'false' }
        }

        case 'output':
          return { output: d.value ? t(d.value) : prev }

        default:
          throw new Error(`Unknown node type ${String(node.type)}`)
      }
    }
  }

  /** The scope of an automation's agent step: its picked tools, servers, collections and skills, and nothing else. */
  private async automationScope(d: Record<string, any>, scope: ToolScope): Promise<ToolScope> {
    const tools: string[] = Array.isArray(d.tools) ? d.tools : []
    const collectionIds: string[] = Array.isArray(d.collectionIds) ? d.collectionIds : []
    const skills: string[] = Array.isArray(d.skills) ? d.skills : []
    const picked: { id: string; tools: string[] | null }[] = Array.isArray(d.servers) ? d.servers : []
    const only = new Set(tools)
    if (collectionIds.length) only.add('rag_search')
    if (skills.length) for (const n of ['skill_list', 'skill_use']) only.add(n)
    const mcp = this.deps.runtime.mcpClients
    const configs = this.deps.settings.get().mcpClients
    const servers = mcp ? mcp.chatServers(picked.map((p) => p.id)) : []
    if (mcp && servers.length) await mcp.ensure(servers)
    for (const p of picked) {
      const config = configs.find((c) => c.id === p.id)
      if (!config || !servers.includes(p.id)) continue
      const names = p.tools ?? mcp?.status().find((s) => s.id === p.id)?.tools.map((t) => t.name) ?? []
      for (const n of names) only.add(mcpToolName(config.name, n))
    }
    const writes = ['write', 'edit', 'ast_edit'].some((n) => only.has(n))
    return {
      ...scope,
      collectionIds,
      knowledgeEnabled: collectionIds.length > 0,
      skillsEnabled: skills.length > 0,
      skillNames: skills,
      skillsOff: [],
      skillsAlways: [],
      webEnabled: true,
      customTools: true,
      toolNames: null,
      disabledTools: [],
      mcpServers: servers,
      onlyTools: [...only],
      fileAccess: writes && scope.workspace ? 'write' : 'read',
      shell: false,
      subagents: false
    }
  }

  private toWorkflow(r: WorkflowRow): Workflow {
    const graph = json<{ nodes: WorkflowNode[]; edges: WorkflowEdge[]; workspace?: string | null; automation?: Automation | null }>(r.graph, { nodes: [], edges: [] })
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      nodes: graph.nodes,
      edges: graph.edges,
      cron: r.cron,
      cronEnabled: !!r.cron_enabled,
      nextRunAt: this.jobs.get(r.id)?.nextRun()?.getTime() ?? null,
      workspace: graph.workspace ?? null,
      automation: graph.automation ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }
}

/** An automation as a graph: Start → one agent step that does the prompt → Output. */
export function automationGraph(a: Automation): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: 'n_trigger', type: 'trigger', position: { x: 0, y: 120 }, data: { key: 'trigger', label: 'Start', defaultInput: '{}' } },
      {
        id: 'n_agent',
        type: 'agent',
        position: { x: 320, y: 100 },
        data: { key: 'result', label: 'Do the task', automation: true, prompt: a.prompt, agentId: a.agentId, tools: a.tools, servers: a.servers, collectionIds: a.collectionIds, skills: a.skills, maxTurns: 24 }
      },
      { id: 'n_out', type: 'output', position: { x: 640, y: 120 }, data: { key: 'output', label: 'Output', value: '{{result}}' } }
    ],
    edges: [
      { id: 'e1', source: 'n_trigger', target: 'n_agent' },
      { id: 'e2', source: 'n_agent', target: 'n_out' }
    ]
  }
}

function cleanAutomation(a: Automation | null | undefined): Automation | null {
  if (!a) return null
  const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x.trim()))] : [])
  return {
    prompt: String(a.prompt ?? ''),
    agentId: a.agentId || null,
    tools: list(a.tools),
    servers: (Array.isArray(a.servers) ? a.servers : []).filter((s) => s && typeof s.id === 'string').map((s) => ({ id: s.id, tools: Array.isArray(s.tools) ? list(s.tools) : null })),
    collectionIds: list(a.collectionIds),
    skills: list(a.skills),
    deliver: a.deliver === 'notify' || a.deliver === 'knowledge' ? a.deliver : 'chat',
    collectionId: a.collectionId || null
  }
}

function blankTemplate(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: 'n_trigger', type: 'trigger', position: { x: 0, y: 120 }, data: { key: 'trigger', label: 'Start', defaultInput: '{\n  "topic": "hello"\n}' } },
      { id: 'n_llm', type: 'llm', position: { x: 320, y: 100 }, data: { key: 'llm_1', label: 'LLM', system: '', prompt: 'Write one sentence about {{input.topic}}.', model: null } },
      { id: 'n_out', type: 'output', position: { x: 640, y: 120 }, data: { key: 'result', label: 'Output', value: '{{llm_1}}' } }
    ],
    edges: [
      { id: 'e1', source: 'n_trigger', target: 'n_llm' },
      { id: 'e2', source: 'n_llm', target: 'n_out' }
    ]
  }
}

/** Fetch a page, turn it into text, and say what it says now. */
function watchPageTemplate(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: 'n_trigger', type: 'trigger', position: { x: 0, y: 120 }, data: { key: 'trigger', label: 'Start', defaultInput: '{\n  "url": "https://example.com/pricing",\n  "watch_for": "price changes"\n}' } },
      { id: 'n_http', type: 'http', position: { x: 300, y: 120 }, data: { key: 'page', label: 'Fetch the page', method: 'GET', url: '{{input.url}}', headers: '{}', body: '' } },
      {
        id: 'n_text',
        type: 'transform',
        position: { x: 600, y: 120 },
        data: { key: 'text', label: 'Page as text', code: "return String(prev.body)\n  .replace(/<(script|style)[\\s\\S]*?<\\/\\1>/gi, ' ')\n  .replace(/<[^>]+>/g, ' ')\n  .replace(/\\s+/g, ' ')\n  .slice(0, 12000)" }
      },
      { id: 'n_llm', type: 'llm', position: { x: 900, y: 120 }, data: { key: 'report', label: 'What it says now', system: 'Be brief and concrete.', prompt: 'Here is the text of {{input.url}}. Report anything about {{input.watch_for}}, quoting the page.\n\n{{text}}', model: null } },
      { id: 'n_out', type: 'output', position: { x: 1200, y: 120 }, data: { key: 'result', label: 'Output', value: '{{report}}' } }
    ],
    edges: [
      { id: 'e1', source: 'n_trigger', target: 'n_http' },
      { id: 'e2', source: 'n_http', target: 'n_text' },
      { id: 'e3', source: 'n_text', target: 'n_llm' },
      { id: 'e4', source: 'n_llm', target: 'n_out' }
    ]
  }
}

/** An agent reads the flow's folder and answers a question about it. */
function summariseFolderTemplate(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: 'n_trigger', type: 'trigger', position: { x: 0, y: 120 }, data: { key: 'trigger', label: 'Start', defaultInput: '{\n  "question": "What is in this folder, and what changed or needs attention?"\n}' } },
      {
        id: 'n_agent',
        type: 'agent',
        position: { x: 320, y: 100 },
        data: { key: 'summary', label: 'Read the folder', prompt: 'Look through the files in your folder and answer: {{input.question}} Name the files you rely on.', system: '', collectionIds: [], skillsEnabled: false, webEnabled: false, customTools: false, fileAccess: 'read', maxTurns: 12 }
      },
      { id: 'n_out', type: 'output', position: { x: 640, y: 120 }, data: { key: 'result', label: 'Output', value: '{{summary}}' } }
    ],
    edges: [
      { id: 'e1', source: 'n_trigger', target: 'n_agent' },
      { id: 'e2', source: 'n_agent', target: 'n_out' }
    ]
  }
}

const TEMPLATES: Record<WorkflowTemplate, () => { nodes: WorkflowNode[]; edges: WorkflowEdge[] }> = {
  blank: blankTemplate,
  'rag-digest': ragDigestTemplate,
  'watch-page': watchPageTemplate,
  'summarise-folder': summariseFolderTemplate
}

function ragDigestTemplate(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: 'n_trigger', type: 'trigger', position: { x: 0, y: 140 }, data: { key: 'trigger', label: 'Start', defaultInput: '{\n  "question": "What changed recently?"\n}' } },
      { id: 'n_rag', type: 'rag', position: { x: 300, y: 40 }, data: { key: 'search', label: 'Search knowledge', query: '{{input.question}}', k: 6, mode: 'hybrid', collectionIds: [] } },
      { id: 'n_cond', type: 'condition', position: { x: 600, y: 140 }, data: { key: 'has_hits', label: 'Any hits?', expression: 'prev.hits.length > 0' } },
      { id: 'n_llm', type: 'llm', position: { x: 900, y: 40 }, data: { key: 'answer', label: 'Summarize', system: 'Answer from the context only. Cite [n].', prompt: 'Question: {{input.question}}\n\nContext:\n{{search.text}}', model: null } },
      { id: 'n_none', type: 'output', position: { x: 900, y: 260 }, data: { key: 'empty', label: 'Nothing found', value: 'No matching documents.' } },
      { id: 'n_out', type: 'output', position: { x: 1200, y: 40 }, data: { key: 'digest', label: 'Output', value: '{{answer}}' } }
    ],
    edges: [
      { id: 'e1', source: 'n_trigger', target: 'n_rag' },
      { id: 'e2', source: 'n_rag', target: 'n_cond' },
      { id: 'e3', source: 'n_cond', target: 'n_llm', sourceHandle: 'true' },
      { id: 'e4', source: 'n_cond', target: 'n_none', sourceHandle: 'false' },
      { id: 'e5', source: 'n_llm', target: 'n_out' }
    ]
  }
}
