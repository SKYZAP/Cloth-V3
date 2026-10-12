import { runInNewContext } from 'node:vm'
import { existsSync, mkdirSync, writeFileSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { sep } from 'node:path'
import { join } from 'node:path'
import { Cron } from 'croner'
import type { Automation, AutomationCommands, AutomationInput, AutomationWatch, WorkflowOverview, WorkflowRunSummary, ModelRef, RagMode, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun, WorkflowRunReport } from '@shared/types'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import type { SettingsService } from '../core/settings'
import { formatHitsForModel, type RagService } from '../rag/rag'
import { skillSystemPrompt, type SkillService } from '../skills/skills'
import { agentScope, type AgentRuntime } from '../agent/chat'
import type { AgentService } from '../agent/agents'
import type { ContainerService } from '../agent/containers'
import type { ToolScope } from '../agent/tools'
import { mcpToolName } from '../mcp/client'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'
import { parseJsonLoose } from '../core/llm-json'
import { executeGraph, renderArgs, renderTemplate, type Executor } from './engine'
import { flowToAutomation } from './convert'
import { REPORT_GUIDANCE, reportTools, reportTranscript, type RunReport } from './report'

export interface RunOptions {
  /** Overrides the flow's workspace for this run (null = none). */
  workspace?: string | null
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
    private deps: { providers: ProviderService; rag: RagService; skills: SkillService; runtime: AgentRuntime; settings: SettingsService; web: WebService; custom: CustomToolService; agents?: AgentService; containers?: ContainerService }
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

  /** A flow with no steps yet; the caller saves its content (an automation, or an exported app's graph). */
  create(input: { name: string; description?: string }): Workflow {
    const id = newId('wf_')
    const now = Date.now()
    this.ctx.db
      .prepare('INSERT INTO workflows (id, name, description, graph, cron, cron_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)')
      .run(id, input.name.trim() || 'Untitled workflow', input.description ?? '', JSON.stringify({ nodes: [], edges: [] }), now, now)
    return this.get(id)
  }

  save(id: string, patch: Partial<Pick<Workflow, 'name' | 'description' | 'nodes' | 'edges' | 'cron' | 'cronEnabled' | 'workspace' | 'automation'>>): Workflow {
    const cur = this.get(id)
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
    return this.get(id)
  }

  // ─── Automations ──────────────────────────────────────────────────────────

  /** Makes the chat an automation's run reported in (its transcript and reports); set up by the app. Returns the chat's id. */
  deliver: ((wf: Workflow, chat: { id: string; title: string; messages: AgentMessage[] }) => Promise<string>) | null = null

  createAutomation(input: AutomationInput & { name: string; automation: Automation }): Workflow {
    const wf = this.create({ name: input.name })
    return this.saveAutomation(wf.id, input)
  }

  /** Saves an automation and rebuilds its one-step graph from it. */
  saveAutomation(id: string, input: AutomationInput): Workflow {
    const cur = this.get(id)
    const automation = cleanAutomation(input.automation ?? cur.automation)
    if (!automation) throw new Error('This flow is not an automation')
    if (!automation.prompt.trim()) throw new Error('Say what the automation should do')
    const workspace = input.workspace === undefined ? cur.workspace : input.workspace
    if (automation.watch?.kind === 'files' && !workspace) throw new Error('Choose the folder to watch')
    if (automation.watch?.kind === 'url' && !/^https?:\/\/\S+$/i.test(automation.watch.url)) throw new Error('Give the address of the page to watch, starting with https://')
    if (automation.watch?.kind === 'mcp' && (!automation.watch.serverId || !automation.watch.tool)) throw new Error('Pick the server and tool to check')
    if (automation.commands && !workspace) throw new Error('Choose a folder for its commands to run in')
    if (automation.commands?.mode === 'allowlist' && !automation.commands.allow.length) throw new Error('List the commands it may run')
    const name = input.name?.trim() || cur.name
    return this.save(id, { name, ...automationGraph(automation), automation, cron: input.cron === undefined ? cur.cron : input.cron, cronEnabled: input.cronEnabled ?? cur.cronEnabled, workspace })
  }

  /**
   * Turns every graph flow into an automation (Flows holds automations only): backs each one up as
   * JSON in <dataDir>/backups/flows first, then rewrites it in place. Flows that are automations already
   * are left alone, so running it again changes nothing. Returns the flows it converted.
   */
  convertFlows(): Workflow[] {
    const rows = this.ctx.db.prepare('SELECT * FROM workflows ORDER BY created_at').all() as unknown as WorkflowRow[]
    const converted: Workflow[] = []
    for (const row of rows) {
      const wf = this.toWorkflow(row)
      if (wf.automation) continue
      try {
        const dir = join(this.ctx.dataDir, 'backups', 'flows')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${wf.id}-${Date.now()}.json`), JSON.stringify(row, null, 2))
        const automation = cleanAutomation(flowToAutomation(wf))!
        converted.push(this.save(wf.id, { ...automationGraph(automation), automation }))
        this.ctx.log('automation', `Converted the flow “${wf.name}” (${wf.id}) into an automation`)
      } catch (err) {
        this.ctx.log('automation', `Converting the flow “${wf.name}” (${wf.id}) failed:`, errorMessage(err))
      }
    }
    return converted
  }

  /**
   * Hands over what the run reported: its chat (made now, with the run's transcript), and a notification.
   * The run record keeps how it reported, for its run history.
   */
  private async afterAutomation(wf: Workflow, run: WorkflowRun, transcript: AgentMessage[], report: RunReport): Promise<void> {
    const a = wf.automation
    if (!a) return
    let chatId: string | null = null
    // A finished run in a container hands its changes over in a chat, whether or not it reported in one.
    const chat = report.chat.length > 0 || (run.status === 'ok' && a.commands?.mode === 'container')
    try {
      if (chat && report.chatId && this.deliver) chatId = await this.deliver(wf, { id: report.chatId, title: report.chat[0]?.title || wf.name, messages: reportTranscript(transcript, report) })
    } catch (err) {
      this.ctx.log('automation', `Delivering ${wf.name} failed:`, errorMessage(err))
    }
    const reports: WorkflowRunReport[] = [
      ...(chatId ? [{ kind: 'chat' as const, chatId, title: report.chat[0]?.title || wf.name }] : []),
      ...report.notes.map((n) => ({ kind: 'notify' as const, title: n.title || undefined })),
      ...report.saved.map((k) => ({ kind: 'knowledge' as const, collection: k.collection, title: k.title }))
    ]
    run.reports = reports
    this.persist(run)
    const ok = run.status === 'ok'
    const note = report.notes.at(-1)
    const text = !ok ? (run.error ?? 'Failed') : note ? report.notes.map((n) => n.body).join(' ') : typeof run.output === 'string' ? run.output : JSON.stringify(run.output)
    this.ctx.emit('workflow', {
      type: 'automation',
      workflowId: wf.id,
      name: wf.name,
      runId: run.id,
      ok,
      summary: text.replace(/\s+/g, ' ').trim().slice(0, 180),
      chatId,
      // Failed runs always say so; finished ones when the agent asked to notify.
      notify: !ok || !!note,
      ...(ok && note?.title ? { title: note.title } : {})
    })
  }

  remove(id: string): void {
    this.unschedule(id)
    this.ctx.db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
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
    this.watch(wf)
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
    this.watchers.get(id)?.()
    this.watchers.delete(id)
  }

  // ─── Watching (automations that run when something changes) ──────────────

  private watchers = new Map<string, () => void>()
  /** When each flow's last run ended (Infinity while one runs): its own writes don't trigger it again. */
  private active = new Map<string, number>()
  /** Waits before a folder change runs the automation, and how long after a run its own writes are ignored. */
  watchTiming = { debounceMs: 4000, quietMs: 5000 }

  private watch(wf: Workflow): void {
    const w = wf.automation?.watch
    if (!w) return
    const id = wf.id
    const busy = () => {
      const at = this.active.get(id)
      return at === Infinity || (at !== undefined && Date.now() - at < this.watchTiming.quietMs)
    }
    if (w.kind === 'files') {
      const root = wf.workspace
      if (!root || !existsSync(root)) return this.ctx.log('automation', `${wf.name}: the folder to watch is missing`)
      const pending = new Set<string>()
      let timer: NodeJS.Timeout | undefined
      const fire = () => {
        if (busy() || !pending.size) return pending.clear()
        const changed = [...pending].sort()
        pending.clear()
        void this.run(id, { changed }, 'change').catch((err) => this.ctx.log('automation', `${wf.name}: run on change failed`, errorMessage(err)))
      }
      let watcher: FSWatcher
      try {
        watcher = fsWatch(root, { recursive: true }, (_event, file) => {
          if (!file) return
          const rel = String(file).split(sep).join('/')
          if (IGNORED.test(rel) || busy()) return
          pending.add(rel)
          clearTimeout(timer)
          timer = setTimeout(fire, this.watchTiming.debounceMs)
        })
      } catch (err) {
        return this.ctx.log('automation', `${wf.name}: can't watch ${root}`, errorMessage(err))
      }
      watcher.on('error', (err) => this.ctx.log('automation', `${wf.name}: watching stopped`, errorMessage(err)))
      this.watchers.set(id, () => {
        clearTimeout(timer)
        watcher.close()
      })
      return
    }
    // A cheap check on an interval: run only when its answer differs from last time.
    const key = `automation.watch.${id}.${createHash('sha1').update(JSON.stringify(w)).digest('hex').slice(0, 12)}`
    const what = w.kind === 'url' ? `the page at ${w.url}` : `the answer from ${w.tool}`
    let stopped = false
    const tick = async () => {
      if (stopped || busy()) return
      let text: string
      try {
        text = await this.probe(w)
      } catch (err) {
        this.ctx.kv.set(key, { ...this.ctx.kv.get(key, {}), checkedAt: Date.now(), error: errorMessage(err) })
        return
      }
      const hash = createHash('sha1').update(text).digest('hex')
      const prev = this.ctx.kv.get<{ hash?: string }>(key, {})
      this.ctx.kv.set(key, { hash, checkedAt: Date.now(), error: null })
      if (stopped || !prev.hash || prev.hash === hash) return
      await this.run(id, { changed: what, now: text.slice(0, 4000) }, 'change').catch((err) => this.ctx.log('automation', `${wf.name}: run on change failed`, errorMessage(err)))
    }
    void tick()
    const timer = setInterval(() => void tick(), w.everyMinutes * 60_000)
    this.checks.set(id, tick)
    this.watchers.set(id, () => {
      stopped = true
      clearInterval(timer)
      this.checks.delete(id)
    })
  }

  private checks = new Map<string, () => Promise<void>>()

  /** Run an automation's check now instead of waiting for its interval (runs it if the answer changed). */
  async checkNow(id: string): Promise<{ checkedAt: number | null; error: string | null }> {
    await this.checks.get(id)?.()
    return this.watchState(id)
  }

  /** What a check-based watch looks at, as text. */
  private async probe(w: Exclude<AutomationWatch, { kind: 'files' }>): Promise<string> {
    if (w.kind === 'mcp') {
      const mcp = this.deps.runtime.mcpClients
      if (!mcp) throw new Error('MCP servers are not available here')
      return mcp.call(w.serverId, w.tool, w.args)
    }
    const res = await fetch(w.url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Cloth automation' } })
    if (!res.ok) throw new Error(`${w.url} answered ${res.status}`)
    const body = await res.text()
    // A page's text, without scripts, styles and markup that change on every load.
    return /<html|<body|<div/i.test(body)
      ? body
          .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : body.trim()
  }

  /** When a check-based watch last looked, and what went wrong if it failed. */
  watchState(id: string): { checkedAt: number | null; error: string | null } {
    const w = this.get(id).automation?.watch
    if (!w || w.kind === 'files') return { checkedAt: null, error: null }
    const key = `automation.watch.${id}.${createHash('sha1').update(JSON.stringify(w)).digest('hex').slice(0, 12)}`
    const v = this.ctx.kv.get<{ checkedAt?: number; error?: string | null }>(key, {})
    return { checkedAt: v.checkedAt ?? null, error: v.error ?? null }
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
    // A container run's copy belongs to the chat its result goes to, made with this id.
    const report: RunReport = { chatId: wf.automation?.commands?.mode === 'container' ? newId('ses_') : null, chat: [], notes: [], saved: [] }
    this.active.set(id, Infinity)
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
          onTranscript: (messages) => (transcript = messages),
          report
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
        this.active.set(id, Date.now())
        this.persist(run)
        this.prune(id)
      })
      .then(async (r) => {
        if (wf.automation) await this.afterAutomation(wf, r, transcript, report)
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

  private executor(env: { workspace: string | null; onFile(abs: string): void; onTranscript?(messages: AgentMessage[]): void; report?: RunReport }): Executor {
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
      const values = scope
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
          // An automation's step may use exactly what was picked for it, whoever it runs as, and decides how to report.
          const report = d.automation ? (env.report ?? { chatId: null, chat: [], notes: [], saved: [] }) : null
          if (report) {
            scope = await this.automationScope(d, scope, report.chatId)
            system = [system, REPORT_GUIDANCE].filter(Boolean).join('\n\n')
          }
          const why = d.automation ? changeNote(values.input) : ''
          const res = await runtime.run({
            model: d.model?.providerId ? d.model : (saved?.model ?? this.modelFor(null)),
            prompt: (t(d.prompt) || String(prev ?? '')) + why,
            systemPrompt: system,
            scope,
            extraTools: report ? reportTools(report, { rag, collectionIds: scope.collectionIds }) : undefined,
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
  private async automationScope(d: Record<string, any>, scope: ToolScope, chatId: string | null): Promise<ToolScope> {
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
    const commands = (d.commands ?? null) as AutomationCommands | null
    const shellTool = process.platform === 'win32' ? 'powershell' : 'bash'
    let extra: Partial<ToolScope> = {}
    if (commands && scope.workspace) {
      if (commands.mode === 'allowlist') {
        only.add(shellTool)
        extra = { shell: true, commandAllow: commands.allow }
      } else {
        // In a container: it works on a copy of its folder, so changes and commands need no approval.
        const containers = this.deps.containers
        if (!containers) throw new Error('Containers are not available here')
        const status = await containers.status(true)
        if (!status.available) throw new Error(status.error ?? 'Docker is not available')
        const id = chatId ?? newId('ses_')
        const settings = { image: commands.image, network: commands.network }
        const copy = await containers.prepare(id, scope.workspace)
        only.add('bash')
        extra = {
          workspace: copy,
          shell: true,
          fileAccess: 'write',
          autoApprove: () => 'all',
          container: { image: settings.image, folder: scope.workspace, exec: (command, cwd, options) => containers.exec(id, settings, command, cwd, options) }
        }
      }
    }
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
      subagents: false,
      ...extra
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
        data: { key: 'result', label: 'Do the task', automation: true, prompt: a.prompt, agentId: a.agentId, tools: a.tools, servers: a.servers, collectionIds: a.collectionIds, skills: a.skills, commands: a.commands, maxTurns: 24 }
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
    // No longer used (the agent decides how to report); kept as they were so old data reads the same.
    ...(a.deliver ? { deliver: a.deliver } : {}),
    ...(a.collectionId ? { collectionId: a.collectionId } : {}),
    watch: cleanWatch(a.watch),
    commands: cleanCommands(a.commands)
  }
}

function cleanWatch(w: AutomationWatch | null | undefined): AutomationWatch | null {
  if (!w) return null
  const every = (n: unknown) => Math.min(24 * 60, Math.max(1, Math.round(Number(n) || 15)))
  if (w.kind === 'files') return { kind: 'files' }
  if (w.kind === 'url') return { kind: 'url', url: String(w.url ?? '').trim(), everyMinutes: every(w.everyMinutes) }
  if (w.kind === 'mcp') return { kind: 'mcp', serverId: String(w.serverId ?? ''), tool: String(w.tool ?? ''), args: w.args && typeof w.args === 'object' ? w.args : {}, everyMinutes: every(w.everyMinutes) }
  return null
}

function cleanCommands(c: AutomationCommands | null | undefined): AutomationCommands | null {
  if (!c) return null
  if (c.mode === 'container') return { mode: 'container', image: String(c.image ?? '').trim() || 'node:22', network: c.network !== false }
  if (c.mode === 'allowlist') return { mode: 'allowlist', allow: [...new Set((Array.isArray(c.allow) ? c.allow : []).map((x) => String(x).trim().replace(/\s+/g, ' ')).filter(Boolean))] }
  return null
}

/** Why a run started, for the agent, when a watched thing changed. */
function changeNote(input: unknown): string {
  const i = input as { changed?: unknown; now?: unknown } | null
  if (!i?.changed) return ''
  if (Array.isArray(i.changed)) return `\n\nThis run started because these files changed in its folder: ${i.changed.slice(0, 50).join(', ')}.`
  return `\n\nThis run started because ${String(i.changed)} changed. What it says now:\n\n${String(i.now ?? '').slice(0, 4000)}`
}

/** Paths a folder watch ignores: version control, dependencies, build output and editor scratch files. */
const IGNORED = /(^|\/)(\.git|node_modules|\.cache|dist|out|build|\.next|\.venv|__pycache__)(\/|$)|~$|\.(swp|tmp|crdownload)$/
