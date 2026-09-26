import { runInNewContext } from 'node:vm'
import { Cron } from 'croner'
import type { ModelRef, RagMode, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun } from '@shared/types'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import type { SettingsService } from '../core/settings'
import { formatHitsForModel, type RagService } from '../rag/rag'
import { skillSystemPrompt, type SkillService } from '../skills/skills'
import type { AgentRuntime } from '../agent/chat'
import { parseJsonLoose } from '../core/llm-json'
import { executeGraph, renderTemplate, type Executor } from './engine'

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
    private deps: { providers: ProviderService; rag: RagService; skills: SkillService; runtime: AgentRuntime; settings: SettingsService }
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

  create(input: { name: string; description?: string; template?: 'blank' | 'rag-digest' }): Workflow {
    const id = newId('wf_')
    const now = Date.now()
    const graph = input.template === 'rag-digest' ? ragDigestTemplate() : blankTemplate()
    this.ctx.db
      .prepare('INSERT INTO workflows (id, name, description, graph, cron, cron_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?)')
      .run(id, input.name.trim() || 'Untitled workflow', input.description ?? '', JSON.stringify(graph), now, now)
    return this.get(id)
  }

  save(id: string, patch: Partial<Pick<Workflow, 'name' | 'description' | 'nodes' | 'edges' | 'cron' | 'cronEnabled'>>): Workflow {
    const cur = this.get(id)
    const cron = patch.cron === undefined ? cur.cron : patch.cron?.trim() || null
    if (cron) {
      const v = validateCron(cron)
      if (!v.ok) throw new Error(`Invalid cron expression: ${v.error}`)
    }
    const next = { ...cur, ...patch, cron }
    this.ctx.db
      .prepare('UPDATE workflows SET name = ?, description = ?, graph = ?, cron = ?, cron_enabled = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, JSON.stringify({ nodes: next.nodes, edges: next.edges }), cron, next.cronEnabled && cron ? 1 : 0, Date.now(), id)
    this.schedule(id)
    return this.get(id)
  }

  remove(id: string): void {
    this.unschedule(id)
    this.ctx.db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
  }

  duplicate(id: string): Workflow {
    const cur = this.get(id)
    const copy = this.create({ name: `${cur.name} (copy)`, description: cur.description })
    return this.save(copy.id, { nodes: cur.nodes, edges: cur.edges, cron: cur.cron, cronEnabled: false })
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

  startRun(id: string, input: unknown, trigger: WorkflowRun['trigger'] = 'manual'): WorkflowRun {
    const { run } = this.begin(id, input, trigger)
    return run
  }

  async run(id: string, input: unknown, trigger: WorkflowRun['trigger'] = 'manual'): Promise<WorkflowRun> {
    const { done } = this.begin(id, input, trigger)
    return done
  }

  private begin(id: string, input: unknown, trigger: WorkflowRun['trigger']): { run: WorkflowRun; done: Promise<WorkflowRun> } {
    const wf = this.get(id)
    const effectiveInput = input === undefined || input === null || input === '' ? this.defaultInput(wf) : input
    const run: WorkflowRun = {
      id: newId('wfr_'),
      workflowId: id,
      trigger,
      status: 'running',
      input: effectiveInput,
      output: null,
      nodes: [],
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    const controller = new AbortController()
    this.running.set(run.id, controller)
    this.persist(run)
    const done = executeGraph(wf, effectiveInput, this.executor(), controller.signal, {
      onUpdate: (traces) => {
        run.nodes = traces
        this.persist(run)
      }
    })
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

  private modelFor(ref: ModelRef | null | undefined): ModelRef {
    const m = ref?.providerId ? ref : this.deps.settings.get().defaultModel
    if (!m) throw new Error('No model selected (and no default model in Settings)')
    return m
  }

  private executor(): Executor {
    const { providers, rag, skills, runtime } = this.deps
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
          const res = await runtime.run({
            model: this.modelFor(d.model),
            prompt: t(d.prompt) || String(prev ?? ''),
            systemPrompt: t(d.system),
            scope: { collectionIds: d.collectionIds ?? [], skillsEnabled: d.skillsEnabled ?? true, workspace: d.workspace || null },
            maxTurns: d.maxTurns ? Number(d.maxTurns) : 12,
            signal
          })
          const tools = res.turn.blocks.filter((b) => b.type === 'tool').map((b) => (b.type === 'tool' ? b.trace.name : ''))
          return { output: d.includeTrace ? { text: res.text, tools } : res.text }
        }

        case 'rag': {
          const res = await rag.search({
            query: t(d.query) || String(prev ?? ''),
            collectionIds: d.collectionIds ?? [],
            k: d.k ? Number(d.k) : 6,
            mode: (d.mode ?? 'hybrid') as RagMode,
            model: d.model?.providerId ? d.model : undefined
          })
          return { output: { text: formatHitsForModel(res.hits), hits: res.hits.map((h) => ({ title: h.title, source: h.source, heading: h.headingPath, text: h.text, score: h.score })), queries: res.queries } }
        }

        case 'skill': {
          const skill = await skills.get(String(d.skill ?? ''))
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

  private toWorkflow(r: WorkflowRow): Workflow {
    const graph = json<{ nodes: WorkflowNode[]; edges: WorkflowEdge[] }>(r.graph, { nodes: [], edges: [] })
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      nodes: graph.nodes,
      edges: graph.edges,
      cron: r.cron,
      cronEnabled: !!r.cron_enabled,
      nextRunAt: this.jobs.get(r.id)?.nextRun()?.getTime() ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
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
