import type { DashboardStats, DashboardTotals, UsageRange, UsageSource, WorkflowRun } from '@shared/types'
import { json } from './core/db'
import type { Ctx } from './core/context'
import type { Pricing, UsageService } from './core/usage'
import type { ProviderService } from './providers/providers'
import type { RagService } from './rag/rag'
import type { SkillService } from './skills/skills'
import type { CustomToolService } from './tools/custom'
import type { WorkflowService } from './workflows/workflows'
import type { ChatService } from './agent/chat'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const RANGE_MS: Record<UsageRange, number | null> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, all: null }

interface ModelAgg {
  provider_id: string | null
  model_id: string | null
  kind: string
  calls: number
  errors: number
  input: number
  output: number
  cache: number
  stored_cost: number
  /** Tokens of calls that were recorded without a cost (priced later from the current price list). */
  u_input: number
  u_output: number
  latency: number | null
  last: number
}

/** Aggregates the usage log and the rest of the app into the dashboard's numbers. */
export class DashboardService {
  constructor(
    private ctx: Ctx,
    private deps: {
      usage: UsageService
      providers: ProviderService
      rag: RagService
      skills: SkillService
      custom: CustomToolService
      workflows: WorkflowService
      chat: ChatService
    }
  ) {}

  async stats(range: UsageRange = '7d'): Promise<DashboardStats> {
    const now = Date.now()
    const span = RANGE_MS[range]
    const first = (this.ctx.db.prepare('SELECT MIN(at) AS at FROM usage_events').get() as { at: number | null }).at
    const since = span ? now - span : first
    const from = since ?? now
    const bucketSize = range === '24h' ? HOUR : DAY
    // Bucket in local time so days start at local midnight.
    const shift = -new Date().getTimezoneOffset() * 60_000

    const totals = this.totals(from, now + 1)
    const previous = span ? this.totals(from - span, from) : null

    // Timeline
    const tl = this.q<ModelAgg & { b: number }>(
      `SELECT CAST((at + ?) / ? AS INTEGER) * ? - ? AS b, ${MODEL_COLS} FROM usage_events WHERE at >= ? AND kind IN ('llm','embed') GROUP BY b, provider_id, model_id, kind`,
      shift,
      bucketSize,
      bucketSize,
      shift,
      from
    )
    const startBucket = Math.floor((from + shift) / bucketSize) * bucketSize - shift
    const buckets = new Map<number, DashboardStats['timeline'][number]>()
    for (let t = startBucket; t <= now; t += bucketSize) buckets.set(t, { t, input: 0, output: 0, calls: 0, errors: 0, cost: 0 })
    if (buckets.size > 400) {
      // "all" over a long history: keep the last ~400 buckets.
      for (const k of [...buckets.keys()].slice(0, buckets.size - 400)) buckets.delete(k)
    }
    for (const r of tl) {
      const b = buckets.get(r.b)
      if (!b) continue
      b.input += r.input + r.cache
      b.output += r.output
      if (r.kind === 'llm') {
        b.calls += r.calls
        b.errors += r.errors
      }
      b.cost += this.cost(r).cost
    }

    // Models
    const names = new Map(this.deps.providers.list().map((p) => [p.id, p.name]))
    const models = this.q<ModelAgg>(`SELECT ${MODEL_COLS} FROM usage_events WHERE at >= ? AND kind = 'llm' GROUP BY provider_id, model_id ORDER BY calls DESC`, from).map((r) => {
      const { cost, priced } = this.cost(r)
      return {
        providerId: r.provider_id ?? '',
        provider: names.get(r.provider_id ?? '') ?? 'removed provider',
        modelId: r.model_id ?? 'unknown',
        calls: r.calls,
        errors: r.errors,
        input: r.input + r.cache,
        output: r.output,
        cost,
        priced,
        avgLatencyMs: r.latency === null ? null : Math.round(r.latency),
        lastUsed: r.last
      }
    })

    // Tools & skills
    const tools = this.q<{ name: string; kinds: string; calls: number; errors: number; avg: number | null; last: number }>(
      `SELECT name, GROUP_CONCAT(DISTINCT detail) AS kinds, COUNT(*) AS calls, SUM(1 - ok) AS errors, AVG(duration_ms) AS avg, MAX(at) AS last
       FROM usage_events WHERE at >= ? AND kind = 'tool' GROUP BY name ORDER BY calls DESC LIMIT 15`,
      from
    ).map((r) => ({ name: r.name, kind: r.kinds ?? '', calls: r.calls, errors: r.errors, avgMs: r.avg === null ? null : Math.round(r.avg), lastUsed: r.last }))

    const hub = await this.deps.skills.list().catch(() => [])
    const verdicts = new Map(hub.map((s) => [s.name, s.health?.verdict ?? 'untested']))
    const skillRows = this.q<{ name: string; detail: string; uses: number; last: number }>(
      `SELECT name, detail, COUNT(*) AS uses, MAX(at) AS last FROM usage_events WHERE at >= ? AND kind = 'skill' GROUP BY name, detail`,
      from
    )
    const skillMap = new Map<string, DashboardStats['skills'][number]>()
    for (const r of skillRows) {
      const s = skillMap.get(r.name) ?? { name: r.name, uses: 0, via: {}, lastUsed: 0, verdict: (verdicts.get(r.name) as DashboardStats['skills'][number]['verdict']) ?? null }
      s.uses += r.uses
      s.via[r.detail] = (s.via[r.detail] ?? 0) + r.uses
      s.lastUsed = Math.max(s.lastUsed, r.last)
      skillMap.set(r.name, s)
    }
    const skills = [...skillMap.values()].sort((a, b) => b.uses - a.uses).slice(0, 15)

    // Sources
    const srcRows = this.q<ModelAgg & { source: UsageSource }>(`SELECT source, ${MODEL_COLS} FROM usage_events WHERE at >= ? AND kind IN ('llm','embed') GROUP BY source, provider_id, model_id, kind`, from)
    const srcMap = new Map<UsageSource, DashboardStats['sources'][number]>()
    for (const r of srcRows) {
      const s = srcMap.get(r.source) ?? { source: r.source, calls: 0, tokens: 0, cost: 0 }
      if (r.kind === 'llm') s.calls += r.calls
      s.tokens += r.input + r.output + r.cache
      s.cost += this.cost(r).cost
      srcMap.set(r.source, s)
    }
    const sources = [...srcMap.values()].sort((a, b) => b.tokens - a.tokens)

    // Activity by local hour of day
    const hours = new Array<number>(24).fill(0)
    for (const r of this.q<{ h: number; n: number }>(`SELECT CAST((at + ?) / ? AS INTEGER) % 24 AS h, COUNT(*) AS n FROM usage_events WHERE at >= ? AND kind IN ('llm','tool') GROUP BY h`, shift, HOUR, from)) {
      hours[r.h] = r.n
    }

    // Workflows
    const flows = this.deps.workflows.list()
    const flowNames = new Map(flows.map((w) => [w.id, w.name]))
    const runs = (this.ctx.db.prepare('SELECT data FROM workflow_runs WHERE started_at >= ?').all(from) as { data: string }[])
      .map((r) => json<WorkflowRun | null>(r.data, null))
      .filter((r): r is WorkflowRun => !!r && r.status !== 'running')
    const perFlow = new Map<string, { runs: number; errors: number; ms: number[]; last: number }>()
    for (const r of runs) {
      const f = perFlow.get(r.workflowId) ?? { runs: 0, errors: 0, ms: [], last: 0 }
      f.runs++
      if (r.status === 'error') f.errors++
      if (r.finishedAt) f.ms.push(r.finishedAt - r.startedAt)
      f.last = Math.max(f.last, r.startedAt)
      perFlow.set(r.workflowId, f)
    }
    const allMs = runs.filter((r) => r.finishedAt).map((r) => r.finishedAt! - r.startedAt)
    const workflows: DashboardStats['workflows'] = {
      runs: runs.length,
      ok: runs.filter((r) => r.status === 'ok').length,
      errors: runs.filter((r) => r.status === 'error').length,
      avgMs: allMs.length ? Math.round(avg(allMs)) : null,
      scheduled: flows.filter((w) => w.cronEnabled && w.cron).length,
      top: [...perFlow.entries()]
        .filter(([id]) => flowNames.has(id))
        .map(([id, f]) => ({ id, name: flowNames.get(id)!, runs: f.runs, errors: f.errors, avgMs: f.ms.length ? Math.round(avg(f.ms)) : null, lastRun: f.last }))
        .sort((a, b) => b.runs - a.runs)
        .slice(0, 6)
    }

    // Skill health & inventory
    const count = (v: string) => hub.filter((s) => s.health?.verdict === v).length
    const skillHealth = {
      total: hub.length,
      tested: hub.filter((s) => s.health && s.health.verdict !== 'untested').length,
      passing: count('fresh'),
      failing: count('failing'),
      outdated: count('stale'),
      redundant: count('redundant')
    }
    const providers = this.deps.providers.list()
    const collections = this.deps.rag.listCollections()
    const inventory = {
      providers: providers.length,
      models: providers.reduce((n, p) => n + p.models.length, 0),
      collections: collections.length,
      documents: collections.reduce((n, c) => n + c.docCount, 0),
      chunks: collections.reduce((n, c) => n + c.chunkCount, 0),
      skills: hub.length,
      customTools: this.deps.custom.list().length,
      workflows: flows.length,
      chats: this.deps.chat.list().length
    }

    // Recent activity
    const recent = this.q<{ at: number; kind: 'llm' | 'embed' | 'tool' | 'skill'; source: UsageSource; model_id: string | null; name: string | null; detail: string | null; input_tokens: number; output_tokens: number; duration_ms: number | null; ok: number }>(
      `SELECT at, kind, source, model_id, name, detail, input_tokens, output_tokens, duration_ms, ok FROM usage_events WHERE kind != 'embed' ORDER BY at DESC LIMIT 14`
    ).map((r) => ({
      at: r.at,
      kind: r.kind,
      source: r.source,
      label: (r.kind === 'llm' ? r.model_id : r.name) ?? 'unknown',
      detail:
        r.kind === 'llm'
          ? `${fmt(r.input_tokens)} in · ${fmt(r.output_tokens)} out${r.duration_ms ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ''}`
          : r.kind === 'tool'
            ? `${r.detail === 'builtin' ? 'built-in' : r.detail ?? ''}${r.duration_ms !== null ? ` · ${r.duration_ms}ms` : ''}`
            : `via ${r.detail ?? '?'}`,
      ok: !!r.ok
    }))

    return { range, since, generatedAt: now, totals, previous, bucket: bucketSize === HOUR ? 'hour' : 'day', timeline: [...buckets.values()], models, tools, skills, sources, hours, workflows, skillHealth, inventory, recent }
  }

  private totals(from: number, to: number): DashboardTotals {
    const rows = this.q<ModelAgg>(`SELECT ${MODEL_COLS} FROM usage_events WHERE at >= ? AND at < ? AND kind IN ('llm','embed') GROUP BY provider_id, model_id, kind`, from, to)
    const t: DashboardTotals = { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0, embedTokens: 0, tokens: 0, cost: 0, unpricedTokens: 0, avgLatencyMs: null, toolCalls: 0, toolErrors: 0, skillUses: 0 }
    let latencySum = 0
    let latencyN = 0
    for (const r of rows) {
      const { cost, priced } = this.cost(r)
      t.cost += cost
      if (r.kind === 'embed') {
        t.embedTokens += r.input
        continue
      }
      t.calls += r.calls
      t.errors += r.errors
      t.inputTokens += r.input
      t.outputTokens += r.output
      t.cacheTokens += r.cache
      if (!priced) t.unpricedTokens += r.input + r.output + r.cache
      if (r.latency !== null) {
        latencySum += r.latency * r.calls
        latencyN += r.calls
      }
    }
    t.tokens = t.inputTokens + t.outputTokens + t.cacheTokens + t.embedTokens
    t.avgLatencyMs = latencyN ? Math.round(latencySum / latencyN) : null
    const other = this.ctx.db
      .prepare(`SELECT SUM(kind = 'tool') AS tools, SUM(kind = 'tool' AND ok = 0) AS toolErrors, SUM(kind = 'skill') AS skills FROM usage_events WHERE at >= ? AND at < ?`)
      .get(from, to) as { tools: number | null; toolErrors: number | null; skills: number | null }
    t.toolCalls = other.tools ?? 0
    t.toolErrors = other.toolErrors ?? 0
    t.skillUses = other.skills ?? 0
    return t
  }

  /** Recorded cost, plus the current price for calls that were recorded without one. */
  private cost(r: ModelAgg): { cost: number; priced: boolean } {
    const price: Pricing | null = r.provider_id && r.model_id ? this.deps.usage.pricing(r.provider_id, r.model_id) : null
    const late = price ? (r.u_input * price.input + r.u_output * price.output) / 1e6 : 0
    return { cost: r.stored_cost + late, priced: !!price || r.stored_cost > 0 }
  }

  private q<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.ctx.db.prepare(sql).all(...params) as unknown as T[]
  }
}

const MODEL_COLS = `provider_id, model_id, kind, COUNT(*) AS calls, SUM(1 - ok) AS errors,
  SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read + cache_write) AS cache, SUM(cost) AS stored_cost,
  SUM(CASE WHEN cost = 0 THEN input_tokens ELSE 0 END) AS u_input, SUM(CASE WHEN cost = 0 THEN output_tokens ELSE 0 END) AS u_output,
  AVG(duration_ms) AS latency, MAX(at) AS last`

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}
