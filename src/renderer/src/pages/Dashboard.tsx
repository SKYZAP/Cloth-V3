import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { isMobile } from '@/lib/platform'
import { animate, motion } from 'motion/react'
import {
  ArrowClockwise,
  ArrowDownRight,
  ArrowUpRight,
  Books,
  ChatCircleDots,
  Coins,
  Cpu,
  FlowArrow,
  Gauge,
  Lightning,
  PlugsConnected,
  Sparkle,
  Stack,
  Timer,
  Trash,
  Wrench,
  RocketLaunch,
  X,
  type Icon
} from '@phosphor-icons/react'
import type { DashboardStats, DashboardTotals, UsageRange, UsageSource } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp, type Page } from '@/lib/store'
import { compact, duration, timeAgo } from '@/lib/format'
import { Badge, Button, IconButton, Segmented, Spinner, confirmAction, PageTitle } from '@/components/ui'
import type { OnboardingStep } from '@shared/onboarding'
import { Tooltip } from '@/components/Tooltip'
import { INPUT, OTHER, OUTPUT, SERIES, SOURCE, TOOL_KIND, VIA, assignModelSlots, heat, modelColor } from '@/lib/chart-colors'

const RANGES: { value: UsageRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' }
]

/** Model calls keyed the way the timeline splits them, and the colour slot each model keeps. */
const modelKey = (m: { providerId: string; modelId: string }) => `${m.providerId}/${m.modelId}`

/** Gives models seen for the first time a colour slot and saves it, so a model's colour never moves. */
function useModelSlots(stats: DashboardStats | null): Record<string, number> {
  const known = useApp((s) => s.settings?.chartModelSlots) ?? NO_SLOTS
  const update = useApp((s) => s.updateSettings)
  const ranked = stats ? [...stats.models].sort((a, b) => b.input + b.output - (a.input + a.output)).map(modelKey) : []
  const next = assignModelSlots(known, ranked)
  const added = Object.keys(next).length !== Object.keys(known).length
  useEffect(() => {
    if (added) void update({ chartModelSlots: next })
  }, [added, ranked.join('|')])
  return next
}
const NO_SLOTS: Record<string, number> = {}

export function DashboardPage() {
  const [range, setRangeState] = useState<UsageRange>(() => {
    try {
      return (localStorage.getItem('cloth.dashboard.range') as UsageRange) || '7d'
    } catch {
      return '7d'
    }
  })
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(false)
  const setPage = useApp((s) => s.setPage)

  const load = useCallback(async (r: UsageRange) => {
    setLoading(true)
    const s = await attempt(() => api.dashboard.stats(r))
    if (s) setStats(s)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load(range)
    const t = setInterval(() => void load(range), 20_000)
    return () => clearInterval(t)
  }, [range, load])

  const setRange = (r: UsageRange) => {
    try {
      localStorage.setItem('cloth.dashboard.range', r)
    } catch {
      /* ignore */
    }
    setRangeState(r)
  }

  const empty = stats && !stats.totals.calls && !stats.totals.toolCalls && !stats.totals.skillUses && !stats.totals.embedTokens
  const slots = useModelSlots(stats)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-line py-3.5 px-5 mobile:flex-wrap mobile:gap-2 mobile:px-4 mobile:py-3">
        <div className="min-w-0 flex-1 mobile:basis-full">
          <PageTitle>Dashboard</PageTitle>
        </div>
        <Segmented value={range} onChange={setRange} items={RANGES} />
        <Tooltip content="Refresh">
          <IconButton onClick={() => void load(range)} aria-label="Refresh">
            {loading ? <Spinner size={14} /> : <ArrowClockwise size={15} />}
          </IconButton>
        </Tooltip>
        <Tooltip content="Clear usage history">
          <IconButton
            aria-label="Clear usage history"
            onClick={async () => {
              if (!(await confirmAction('All recorded model calls, tokens, tool calls and skill uses will be deleted. Chats, flows and skills are not touched.', { title: 'Clear usage history?', confirmLabel: 'Clear history', danger: true }))) return
              await attempt(() => api.dashboard.clearUsage())
              void load(range)
            }}
          >
            <Trash size={15} />
          </IconButton>
        </Tooltip>
      </div>

      {!stats ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1480px] space-y-4 p-5 mobile:space-y-3 mobile:p-3">
            <SetupCard />
            {empty && (
              <Panel className="flex items-center gap-3 border-line-strong bg-elev px-4 py-3" delay={0}>
                <Lightning size={18} weight="fill" className="shrink-0 text-warn" />
                <div className="text-ui text-muted">
                  Nothing recorded {range === 'all' ? 'yet' : 'in this period'}. Usage is logged as you chat, run flows, test skills, index knowledge or call Cloth over MCP.
                </div>
              </Panel>
            )}
            <Kpis t={stats.totals} prev={stats.previous} onPricing={() => setPage('providers')} />

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
              <Panel className="xl:col-span-8" delay={0.12}>
                <Timeline stats={stats} slots={slots} />
              </Panel>
              <div className="flex flex-col gap-4 xl:col-span-4">
                <Panel className="flex-1" delay={0.16}>
                  <Sources stats={stats} />
                </Panel>
                <Panel delay={0.2}>
                  <Hours hours={stats.hours} />
                </Panel>
              </div>
            </div>

            <Panel delay={0.22}>
              <Models stats={stats} slots={slots} onPricing={() => setPage('providers')} />
            </Panel>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Panel delay={0.26}>
                <Tools stats={stats} />
              </Panel>
              <Panel delay={0.28}>
                <Skills stats={stats} />
              </Panel>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Panel delay={0.3}>
                <Flows stats={stats} onOpen={() => setPage('workflows')} />
              </Panel>
              <Panel delay={0.32}>
                <Library stats={stats} go={setPage} />
              </Panel>
            </div>

            <Panel delay={0.36}>
              <Recent stats={stats} />
            </Panel>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Building blocks ────────────────────────────────────────────────────────

function Panel({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      className={clsx('rounded-[10px] border border-line bg-panel', className)}
    >
      {children}
    </motion.div>
  )
}

function Heading({ icon: I, title, right }: { icon: Icon; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
      <I size={15} className="text-dim" />
      <span className="text-ui font-semibold tracking-tight">{title}</span>
      <div className="flex-1" />
      {right}
    </div>
  )
}

/** Number that eases from its previous value. */
function Count({ value, format = (n) => compact(Math.round(n)) }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const last = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const controls = animate(last.current, value, {
      duration: 0.9,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        el.textContent = format(v)
      }
    })
    last.current = value
    return () => controls.stop()
  }, [value, format])
  return <span ref={ref}>{format(0)}</span>
}

function Bar({ value, max, color = OUTPUT, delay = 0 }: { value: number; max: number; color?: string; delay?: number }) {
  const pct = max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-elev-2">
      <motion.div className="h-full rounded-full" style={{ background: color }} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }} />
    </div>
  )
}

function money(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

function pct(part: number, whole: number): string {
  if (!whole) return '0%'
  const p = (part / whole) * 100
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

/** Change vs the previous period. Only cost and latency are judged (lower is better, green or red); for volumes like tokens and calls more is neither good nor bad, so they stay neutral. */
function Delta({ now, before, lowerIsBetter }: { now: number; before: number | undefined; lowerIsBetter?: boolean }) {
  if (before === undefined) return null
  if (!before && !now) return null
  if (!before) return <span className="rounded bg-elev-2 px-1.5 py-px text-micro text-dim">new</span>
  const change = (now - before) / before
  if (Math.abs(change) < 0.005) return <span className="rounded bg-elev-2 px-1.5 py-px text-micro text-dim">±0%</span>
  const up = change > 0
  const tone = lowerIsBetter === undefined ? 'bg-elev-2 text-muted' : lowerIsBetter !== up ? 'bg-ok/10 text-ok' : 'bg-danger-soft text-danger-hi'
  const I = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={clsx('inline-flex items-center gap-0.5 rounded px-1.5 py-px text-micro font-medium', tone)} title="vs the previous period">
      <I size={10} weight="bold" />
      {Math.abs(change) >= 10 ? `${Math.round(change)}×` : `${Math.round(Math.abs(change) * 100)}%`}
    </span>
  )
}

// ─── KPIs ───────────────────────────────────────────────────────────────────

function Kpis({ t, prev, onPricing }: { t: DashboardTotals; prev: DashboardTotals | null; onPricing(): void }) {
  const secs = useCallback((n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`), [])
  const cards: { icon: Icon; label: string; value: ReactNode; delta: ReactNode; sub: ReactNode; foot?: ReactNode }[] = [
    {
      icon: Stack,
      label: 'Total tokens',
      value: <Count value={t.tokens} />,
      delta: <Delta now={t.tokens} before={prev?.tokens} />,
      sub: (
        <>
          {compact(t.inputTokens + t.cacheTokens)} in · {compact(t.outputTokens)} out{t.embedTokens ? ` · ${compact(t.embedTokens)} embed` : ''}
        </>
      ),
      foot: <SplitBar parts={[{ v: t.inputTokens + t.cacheTokens, c: INPUT }, { v: t.outputTokens, c: OUTPUT }, { v: t.embedTokens, c: SERIES[2] }]} />
    },
    {
      icon: Coins,
      label: 'Estimated cost',
      value: <Count value={t.cost} format={money} />,
      delta: <Delta now={t.cost} before={prev?.cost} lowerIsBetter />,
      sub: t.unpricedTokens ? (
        <button onClick={onPricing} className="text-left hover:text-muted" title="Set prices for models on the Models page">
          {pct(t.unpricedTokens, t.inputTokens + t.outputTokens + t.cacheTokens)} of tokens on unpriced models →
        </button>
      ) : t.calls ? (
        'all model calls priced'
      ) : (
        'no model calls'
      )
    },
    {
      icon: Cpu,
      label: 'Model calls',
      value: <Count value={t.calls} />,
      delta: <Delta now={t.calls} before={prev?.calls} />,
      sub: t.errors ? <span className="text-danger-hi">{pct(t.errors, t.calls)} failed ({t.errors})</span> : 'no failed calls'
    },
    {
      icon: Timer,
      label: 'Avg response time',
      value: t.avgLatencyMs === null ? '—' : <Count value={t.avgLatencyMs} format={secs} />,
      delta: t.avgLatencyMs !== null && prev?.avgLatencyMs ? <Delta now={t.avgLatencyMs} before={prev.avgLatencyMs} lowerIsBetter /> : null,
      sub: 'per model call, incl. thinking'
    },
    {
      icon: Wrench,
      label: 'Tool calls',
      value: <Count value={t.toolCalls} />,
      delta: <Delta now={t.toolCalls} before={prev?.toolCalls} />,
      sub: (
        <>
          {t.skillUses} skill use{t.skillUses === 1 ? '' : 's'}
          {t.toolErrors ? <span className="text-danger-hi"> · {pct(t.toolErrors, t.toolCalls)} tool errors</span> : ''}
        </>
      )
    }
  ]
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((c, i) => (
        <Panel key={c.label} delay={0.04 * i} className={clsx('group relative overflow-hidden p-4', i === cards.length - 1 && cards.length % 2 === 1 && 'col-span-2 md:col-span-1')}>
          <div className="flex items-center gap-2 text-caption font-medium text-dim">
            <c.icon size={14} className="text-muted" />
            {c.label}
            <div className="flex-1" />
            {c.delta}
          </div>
          <div className="mt-2 font-mono text-figure font-semibold leading-none tracking-tight text-fg tabular-nums">{c.value}</div>
          <div className="mt-2 truncate text-caption text-dim mobile:line-clamp-2 mobile:whitespace-normal">{c.sub}</div>
          {c.foot && <div className="mt-2.5">{c.foot}</div>}
        </Panel>
      ))}
    </div>
  )
}

function SplitBar({ parts }: { parts: { v: number; c: string }[] }) {
  const total = parts.reduce((n, p) => n + p.v, 0)
  return (
    <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-elev-2">
      {total > 0 &&
        parts
          .filter((p) => p.v > 0)
          .map((p, i) => (
            <motion.div key={i} style={{ background: p.c }} initial={{ width: 0 }} animate={{ width: `${(p.v / total) * 100}%` }} transition={{ duration: 0.7, delay: 0.1 * i, ease: [0.22, 1, 0.36, 1] }} />
          ))}
    </div>
  )
}

// ─── Timeline ───────────────────────────────────────────────────────────────

type Metric = 'tokens' | 'cost' | 'calls'

type StackBy = 'io' | 'source' | 'model'

/** One coloured part of a bar: a series' share of the bucket. */
interface Part {
  key: string
  label: string
  color: string
}

function Timeline({ stats, slots }: { stats: DashboardStats; slots: Record<string, number> }) {
  const [metric, setMetric] = useState<Metric>('tokens')
  const [stackBy, setStackByState] = useState<StackBy>(() => {
    try {
      return (localStorage.getItem('cloth.dashboard.stackBy') as StackBy) || 'source'
    } catch {
      return 'source'
    }
  })
  const setStackBy = (s: StackBy) => {
    try {
      localStorage.setItem('cloth.dashboard.stackBy', s)
    } catch {
      /* ignore */
    }
    setStackByState(s)
  }
  const [hover, setHover] = useState<number | null>(null)
  const data = stats.timeline
  // The series a tokens bar splits into, largest first, so the biggest part sits on the baseline. Models past the eight
  // colour slots share Other.
  const names = new Map(stats.models.map((m) => [modelKey(m), m.modelId]))
  const parts: Part[] = (() => {
    if (stackBy === 'io') return [{ key: 'input', label: 'input', color: INPUT }, { key: 'output', label: 'output', color: OUTPUT }]
    const sum = new Map<string, number>()
    for (const b of data) for (const [k, n] of Object.entries(stackBy === 'source' ? b.bySource : b.byModel)) sum.set(k, (sum.get(k) ?? 0) + (n ?? 0))
    const keys = [...sum.keys()].sort((a, b) => sum.get(b)! - sum.get(a)!)
    if (stackBy === 'source') return keys.map((k) => ({ key: k, label: SOURCE[k as UsageSource]?.label ?? k, color: SOURCE[k as UsageSource]?.color ?? OTHER }))
    const own = keys.filter((k) => k in slots).map((k) => ({ key: k, label: names.get(k) ?? k.split('/').pop() ?? k, color: modelColor(slots, k) }))
    // Other: models past the colour slots, and embeddings (counted in the total, not a chat model's).
    return data.some((b) => otherTokens(b) > 0) ? [...own, { key: '_other', label: 'Other & embeddings', color: OTHER }] : own
  })()
  function otherTokens(b: DashboardStats['timeline'][number]): number {
    return Math.max(0, b.input + b.output - Object.entries(b.byModel).reduce((n, [k, v]) => n + (k in slots ? v : 0), 0))
  }
  const partValue = (b: DashboardStats['timeline'][number], key: string): number => {
    if (stackBy === 'io') return key === 'input' ? b.input : b.output
    if (stackBy === 'source') return b.bySource[key as UsageSource] ?? 0
    if (key === '_other') return otherTokens(b)
    return b.byModel[key] ?? 0
  }
  const value = (b: DashboardStats['timeline'][number]) => (metric === 'tokens' ? b.input + b.output : metric === 'cost' ? b.cost : b.calls)
  const max = Math.max(...data.map(value), 0)
  const nice = niceMax(max)
  const fmt = (n: number) => (metric === 'cost' ? money(n) : compact(Math.round(n)))
  const label = (t: number) => {
    const d = new Date(t)
    return stats.bucket === 'hour' ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  // Narrow (phone) charts fit fewer date labels before they collide.
  const every = Math.max(1, Math.ceil(data.length / (isMobile ? 4 : 8)))
  const total = data.reduce((n, b) => n + value(b), 0)
  const h = hover !== null ? data[hover] : null

  return (
    <div className="flex h-full flex-col">
      <Heading
        icon={Gauge}
        title="Usage over time"
        right={
          <Segmented
            value={metric}
            onChange={setMetric}
            items={[
              { value: 'tokens', label: 'Tokens' },
              { value: 'cost', label: 'Cost' },
              { value: 'calls', label: 'Calls' }
            ]}
          />
        }
      />
      <div className="flex items-baseline gap-2 px-4">
        <span className="font-mono text-title font-semibold tabular-nums">{h ? fmt(value(h)) : fmt(total)}</span>
        <span className="text-caption text-dim">
          {h ? `${label(h.t)}${stats.bucket === 'day' ? '' : ''}` : `total, per ${stats.bucket}`}
          {h && metric === 'tokens' && ` · ${compact(h.input)} in · ${compact(h.output)} out`}
          {h && metric === 'calls' && h.errors > 0 && <span className="text-danger-hi"> · {h.errors} failed</span>}
        </span>
        <div className="flex-1" />
        {metric === 'tokens' && (
          <Segmented
            value={stackBy}
            onChange={setStackBy}
            items={[
              { value: 'source', label: 'By source' },
              { value: 'model', label: 'By model' },
              { value: 'io', label: 'In / out' }
            ]}
          />
        )}
      </div>
      {metric === 'tokens' && parts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 px-4 text-caption text-dim">
          {parts.map((p) => (
            <span key={p.key} className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} />
              <span className={clsx(stackBy === 'model' && p.key !== '_other' && 'font-mono')}>{p.label}</span>
              {h && <span className="font-mono tabular-nums text-muted">{compact(partValue(h, p.key))}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="relative mt-3 flex-1 px-4 pb-3">
        <div className="relative h-[210px]">
          {[1, 0.5, 0].map((f) => (
            <div key={f} className="absolute inset-x-0 flex items-center gap-2" style={{ top: `${(1 - f) * 100}%` }}>
              <span className="w-12 -translate-y-1/2 text-right font-mono text-micro text-dim">{nice ? fmt(nice * f) : ''}</span>
              <div className="h-px flex-1 -translate-y-1/2 bg-line/70" />
            </div>
          ))}
          <div className="absolute inset-y-0 left-14 right-0 flex items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
            {data.map((b, i) => {
              const v = value(b)
              const hPct = nice ? (v / nice) * 100 : 0
              return (
                <div key={b.t} className="group relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)} onClick={() => setHover(hover === i ? null : i)}>
                  <div className={clsx('absolute inset-0 rounded-sm transition-colors', hover === i && 'bg-elev-2/60')} />
                  <motion.div
                    className="relative flex w-full flex-col-reverse gap-px overflow-hidden rounded-t-[3px]"
                    initial={{ height: 0 }}
                    animate={{ height: `${Math.max(v > 0 ? 1.5 : 0, hPct)}%` }}
                    transition={{ duration: 0.6, delay: 0.15 + i * 0.012, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {metric === 'tokens' ? (
                      // Each part's share of the bar (bySource/byModel split the same tokens as input + output).
                      parts.map((p) => {
                        const n = partValue(b, p.key)
                        return n > 0 && v > 0 ? <div key={p.key} className="shrink-0" style={{ flexBasis: `${(n / v) * 100}%`, background: p.color }} /> : null
                      })
                    ) : (
                      <div className="h-full" style={{ background: metric === 'cost' ? SERIES[3] : OUTPUT }} />
                    )}
                  </motion.div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="ml-14 mt-1.5 flex gap-[3px]">
          {data.map((b, i) => (
            <div key={b.t} className="relative flex-1">
              {i % every === 0 && <span className="absolute left-0 whitespace-nowrap font-mono text-micro text-dim">{label(b.t)}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function niceMax(n: number): number {
  if (n <= 0) return 0
  const exp = Math.pow(10, Math.floor(Math.log10(n)))
  const f = n / exp
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return step * exp
}

// ─── Sources & hours ────────────────────────────────────────────────────────

function Sources({ stats }: { stats: DashboardStats }) {
  const total = stats.sources.reduce((n, s) => n + s.tokens, 0)
  return (
    <div className="pb-3">
      <Heading icon={Lightning} title="Where tokens go" />
      <div className="px-4">
        <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-elev-2">
          {stats.sources.map((s, i) => (
            <motion.div
              key={s.source}
              title={SOURCE[s.source]?.label}
              style={{ background: SOURCE[s.source]?.color ?? OTHER }}
              initial={{ width: 0 }}
              animate={{ width: `${total ? (s.tokens / total) * 100 : 0}%` }}
              transition={{ duration: 0.7, delay: 0.2 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
            />
          ))}
        </div>
        <div className="mt-3 space-y-1.5">
          {!stats.sources.length && <div className="py-3 text-caption text-dim">No model usage yet.</div>}
          {stats.sources.map((s) => (
            <div key={s.source} className="flex items-center gap-2 text-caption">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: SOURCE[s.source]?.color ?? OTHER }} />
              <span className="flex-1 text-muted">{SOURCE[s.source]?.label ?? s.source}</span>
              <span className="font-mono text-caption text-dim">{s.calls} calls</span>
              <span className="w-14 text-right font-mono text-caption text-muted tabular-nums">{compact(s.tokens)}</span>
              <span className="w-10 text-right font-mono text-caption text-dim">{pct(s.tokens, total)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Hours({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 0)
  const peak = max ? hours.indexOf(max) : -1
  const now = new Date().getHours()
  return (
    <div className="pb-3.5">
      <Heading icon={Timer} title="Busiest hours" right={peak >= 0 ? <span className="font-mono text-caption text-dim">peak {String(peak).padStart(2, '0')}:00</span> : null} />
      <div className="px-4">
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
          {hours.map((n, h) => (
            <motion.div
                key={h}
                title={`${String(h).padStart(2, '0')}:00 — ${n} call${n === 1 ? '' : 's'}`}
                className={clsx('h-7 rounded-[3px]', h === now && 'ring-1 ring-line-strong')}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.25 + h * 0.015 }}
                style={{ background: n ? heat(n / max) : 'var(--color-elev-2)' }}
              />
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-micro text-dim">
          <span>00</span>
          <span>06</span>
          <span>12</span>
          <span>18</span>
          <span>23</span>
        </div>
      </div>
    </div>
  )
}

// ─── Models ─────────────────────────────────────────────────────────────────

function Models({ stats, slots, onPricing }: { stats: DashboardStats; slots: Record<string, number>; onPricing(): void }) {
  const maxTokens = Math.max(...stats.models.map((m) => m.input + m.output), 0)
  return (
    <div className="pb-2">
      <Heading icon={Cpu} title="Models" right={<span className="text-caption text-dim">{stats.models.length} used</span>} />
      {!stats.models.length ? (
        <div className="px-4 pb-3 text-caption text-dim">No model calls in this period.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-caption">
            <thead>
              <tr className="border-y border-line text-left text-caption font-medium text-dim">
                <th className="px-4 py-2 font-semibold">Model</th>
                <th className="px-2 py-2 text-right font-semibold">Calls</th>
                <th className="w-[26%] px-2 py-2 font-semibold">Tokens (in / out)</th>
                <th className="px-2 py-2 text-right font-semibold">Cost</th>
                <th className="px-2 py-2 text-right font-semibold">Avg time</th>
                <th className="px-2 py-2 text-right font-semibold">Failed</th>
                <th className="px-4 py-2 text-right font-semibold">Last used</th>
              </tr>
            </thead>
            <tbody>
              {stats.models.map((m, i) => {
                const tokens = m.input + m.output
                return (
                  <tr key={`${m.providerId}/${m.modelId}`} className="border-b border-line/60 last:border-0 hover:bg-elev/60">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 font-mono text-caption text-fg">
                        {/* The model's colour in "Usage over time" when stacked by model. */}
                        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: modelColor(slots, modelKey(m)) }} aria-hidden="true" />
                        {m.modelId}
                      </div>
                      <div className="pl-4 text-caption text-dim">{m.provider}</div>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">{m.calls.toLocaleString()}</td>
                    <td className="px-2 py-2.5">
                      <div className="mb-1 flex justify-between font-mono text-caption tabular-nums">
                        <span className="text-muted">
                          {compact(m.input)} / {compact(m.output)}
                        </span>
                        <span className="text-dim">{compact(tokens)}</span>
                      </div>
                      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-elev-2">
                        <motion.div
                          className="flex h-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${maxTokens ? (tokens / maxTokens) * 100 : 0}%` }}
                          transition={{ duration: 0.7, delay: 0.25 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                        >
                          <div style={{ width: `${tokens ? (m.input / tokens) * 100 : 0}%`, background: INPUT }} />
                          <div className="flex-1" style={{ background: OUTPUT }} />
                        </motion.div>
                      </div>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">
                      {m.priced ? (
                        money(m.cost)
                      ) : (
                        <button onClick={onPricing} className="text-caption text-dim hover:text-fg" title="No price known — set one on the Models page">
                          set price
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-muted">{m.avgLatencyMs === null ? '—' : duration(m.avgLatencyMs)}</td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">{m.errors ? <span className="text-danger-hi">{m.errors}</span> : <span className="text-dim">0</span>}</td>
                    <td className="px-4 py-2.5 text-right text-caption text-dim">{timeAgo(m.lastUsed)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Tools & skills ─────────────────────────────────────────────────────────

function Ranked({ rank, name, sub, right, children }: { rank: number; name: ReactNode; sub?: ReactNode; right: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className={clsx('w-4 shrink-0 text-right font-mono text-caption', rank === 1 ? 'text-fg' : 'text-dim')}>{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-caption text-fg">{name}</span>
          {sub}
          <div className="flex-1" />
          {right}
        </div>
        <div className="mt-1.5">{children}</div>
      </div>
    </div>
  )
}

function Tools({ stats }: { stats: DashboardStats }) {
  const max = stats.tools[0]?.calls ?? 0
  return (
    <div className="pb-2">
      <Heading
        icon={Wrench}
        title="Most used tools"
        right={
          <div className="flex items-center gap-2.5 text-micro text-dim">
            {Object.entries(TOOL_KIND).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: v.color }} />
                {v.label}
              </span>
            ))}
            <span className="ml-1 text-caption">{stats.totals.toolCalls.toLocaleString()} calls</span>
          </div>
        }
      />
      {!stats.tools.length && <div className="px-4 pb-3 text-caption text-dim">No tool calls in this period.</div>}
      {stats.tools.slice(0, 8).map((t, i) => (
        <Ranked
          key={t.name}
          rank={i + 1}
          name={t.name}
          sub={t.kind.split(',').map((k) => (
            <Badge key={k} tone="dim">
              {k === 'builtin' ? 'built-in' : k}
            </Badge>
          ))}
          right={
            <span className="flex items-center gap-2 font-mono text-caption tabular-nums">
              {t.avgMs !== null && <span className="text-dim">{duration(t.avgMs)}</span>}
              <span className="w-10 text-right text-muted">{t.calls}</span>
            </span>
          }
        >
          <Bar value={t.calls} max={max} delay={0.2 + i * 0.05} color={TOOL_KIND[t.kind.split(',')[0] ?? '']?.color ?? OTHER} />
        </Ranked>
      ))}
    </div>
  )
}

function Skills({ stats }: { stats: DashboardStats }) {
  const max = stats.skills[0]?.uses ?? 0
  return (
    <div className="pb-2">
      <Heading
        icon={Sparkle}
        title="Most used skills"
        right={
          <div className="flex items-center gap-2.5 text-micro text-dim">
            {Object.entries(VIA).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: v.color }} />
                {v.label}
              </span>
            ))}
          </div>
        }
      />
      {!stats.skills.length && <div className="px-4 pb-3 text-caption text-dim">No skills used in this period.</div>}
      {stats.skills.slice(0, 8).map((s, i) => (
        <Ranked
          key={s.name}
          rank={i + 1}
          name={s.name}
          right={<span className="w-10 text-right font-mono text-caption text-muted tabular-nums">{s.uses}</span>}
        >
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-elev-2">
            <motion.div
              className="flex h-full gap-px"
              initial={{ width: 0 }}
              animate={{ width: `${max ? (s.uses / max) * 100 : 0}%` }}
              transition={{ duration: 0.7, delay: 0.2 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            >
              {Object.entries(s.via).map(([k, n]) => (
                <div key={k} title={`${VIA[k]?.label ?? k}: ${n}`} style={{ width: `${(n / s.uses) * 100}%`, background: VIA[k]?.color ?? OTHER }} />
              ))}
            </motion.div>
          </div>
        </Ranked>
      ))}
    </div>
  )
}

// ─── Flows, skill health, library ───────────────────────────────────────────

function Ring({ value, size = 64, color = '#5ccb89', children }: { value: number; size?: number; color?: string; children?: ReactNode }) {
  const r = size / 2 - 5
  const c = 2 * Math.PI * r
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-elev-2)" strokeWidth={6} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - Math.min(1, Math.max(0, value))) }}
          transition={{ duration: 1, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-ui font-semibold">{children}</div>
    </div>
  )
}

function Flows({ stats, onOpen }: { stats: DashboardStats; onOpen(): void }) {
  const w = stats.workflows
  const rate = w.runs ? w.ok / w.runs : 0
  return (
    <div className="pb-3">
      <Heading icon={FlowArrow} title="Flows" right={<LinkButton onClick={onOpen}>open</LinkButton>} />
      <div className="flex items-center gap-4 px-4">
        <Ring value={rate} color={rate >= 0.9 ? 'var(--color-ok)' : rate >= 0.6 ? 'var(--color-warn)' : 'var(--color-danger)'}>
          {w.runs ? `${Math.round(rate * 100)}%` : '—'}
        </Ring>
        <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-1.5 text-caption">
          <Stat label="runs" value={w.runs} />
          <Stat label="failed" value={w.errors} tone={w.errors ? 'danger' : undefined} />
          <Stat label="avg duration" value={w.avgMs === null ? '—' : duration(w.avgMs)} />
          <Stat label="scheduled" value={w.scheduled} />
        </div>
      </div>
      <div className="mt-3 space-y-1 px-4">
        {w.top.map((f) => (
          <div key={f.id} className="flex items-center gap-2 text-caption">
            <span className="min-w-0 flex-1 truncate text-muted">{f.name}</span>
            {f.errors > 0 && <span className="font-mono text-micro text-danger-hi">{f.errors}✕</span>}
            <span className="font-mono text-caption text-dim tabular-nums">{f.runs} runs</span>
            <span className="w-12 text-right font-mono text-caption text-dim">{f.avgMs === null ? '' : duration(f.avgMs)}</span>
          </div>
        ))}
        {!w.top.length && <div className="text-caption text-dim">No runs in this period.</div>}
      </div>
    </div>
  )
}

function Library({ stats, go }: { stats: DashboardStats; go(p: Page): void }) {
  const inv = stats.inventory
  const items: { icon: Icon; label: string; value: string; page: Page }[] = [
    { icon: Cpu, label: 'models', value: `${inv.models}`, page: 'providers' },
    { icon: Books, label: 'documents', value: `${compact(inv.documents)}`, page: 'knowledge' },
    { icon: Stack, label: 'chunks', value: compact(inv.chunks), page: 'knowledge' },
    { icon: Sparkle, label: 'skills', value: `${inv.skills}`, page: 'skills' },
    { icon: Wrench, label: 'custom tools', value: `${inv.customTools}`, page: 'tools' },
    { icon: FlowArrow, label: 'flows', value: `${inv.workflows}`, page: 'workflows' },
    { icon: ChatCircleDots, label: 'chats', value: `${inv.chats}`, page: 'chat' },
    { icon: PlugsConnected, label: 'providers', value: `${inv.providers}`, page: 'providers' },
    { icon: Books, label: 'collections', value: `${inv.collections}`, page: 'knowledge' }
  ]
  return (
    <div className="pb-3">
      <Heading icon={Books} title="Library" />
      <div className="grid grid-cols-3 gap-1.5 px-3">
        {items.map((it) => (
          <button key={it.label} onClick={() => go(it.page)} className="group rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-line hover:bg-elev">
            <div className="font-mono text-section font-semibold tabular-nums text-fg">{it.value}</div>
            <div className="flex items-center gap-1 text-micro text-dim group-hover:text-muted">
              <it.icon size={11} />
              {it.label}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function Recent({ stats }: { stats: DashboardStats }) {
  const icon: Record<string, Icon> = { llm: Cpu, tool: Wrench, skill: Sparkle, embed: Stack }
  return (
    <div className="pb-2">
      <Heading icon={Lightning} title="Recent activity" />
      {!stats.recent.length && <div className="px-4 pb-3 text-caption text-dim">Nothing yet.</div>}
      <div className="grid grid-cols-1 lg:grid-cols-2">
        {stats.recent.map((r, i) => {
          const I = icon[r.kind] ?? Lightning
          return (
            <div key={`${r.at}-${i}`} className="flex items-center gap-2.5 border-t border-line/60 px-4 py-2 text-caption">
              <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', r.ok ? 'border-line bg-elev text-muted' : 'border-danger-line bg-danger-soft text-danger-hi')}>
                <I size={12} />
              </span>
              <span className="min-w-0 truncate font-mono text-caption text-fg">{r.label}</span>
              <span className="min-w-0 flex-1 truncate text-caption text-dim">{r.detail}</span>
              <span className="flex shrink-0 items-center gap-1 text-micro text-dim">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: SOURCE[r.source]?.color ?? OTHER }} />
                {SOURCE[r.source]?.label ?? r.source}
              </span>
              <span className="w-14 shrink-0 text-right text-micro text-dim">{timeAgo(r.at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'danger' }) {
  return (
    <div>
      <div className={clsx('font-mono text-body font-semibold tabular-nums', tone === 'danger' ? 'text-danger-hi' : 'text-fg')}>{value}</div>
      <div className="text-micro text-dim">{label}</div>
    </div>
  )
}

function LinkButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="text-caption text-dim hover:text-fg">
      {children} →
    </button>
  )
}

const SETUP_LABEL: Record<OnboardingStep, string> = { welcome: 'Welcome', model: 'model', folder: 'main folder', langs: 'languages', deps: 'tools check', import: 'import', modes: 'ways to work' }

/** Steps of first-run setup still to do (or setup never opened, on an older install), until dismissed. */
function SetupCard() {
  const settings = useApp((s) => s.settings)
  const open = useApp((s) => s.openOnboarding)
  const updateSettings = useApp((s) => s.updateSettings)
  if (isMobile || !settings) return null
  const ob = settings.onboarding
  if (ob?.cardDismissed) return null
  const left = ob ? ob.skipped.filter((s) => s !== 'welcome') : []
  if (ob && ob.completedAt && !left.length) return null
  const resume = left[0] ?? ob?.step ?? 'welcome'
  const text = !ob ? 'Pick your main folder and languages, check your tools, and bring over skills and MCP servers from other coding tools.' : left.length ? `Still to do: ${left.map((s) => SETUP_LABEL[s]).join(', ')}.` : 'Pick up where you left off.'
  return (
    <Panel className="flex items-center gap-3 border-line-strong bg-elev px-4 py-3" delay={0}>
      <RocketLaunch size={18} className="shrink-0 text-crimson-text" />
      <div className="min-w-0 flex-1">
        <div className="text-ui font-semibold">{!ob ? 'Set up Cloth' : `Finish setup${left.length ? `: ${left.length} step${left.length > 1 ? 's' : ''} left` : ''}`}</div>
        <div className="text-caption text-dim">{text}</div>
      </div>
      <Button size="sm" variant="primary" onClick={() => open(resume)}>
        {!ob ? 'Start setup' : 'Continue setup'}
      </Button>
      <IconButton aria-label="Dismiss" onClick={() => void updateSettings({ onboarding: { ...(ob ?? { completedAt: null, skipped: [], step: 'welcome' }), cardDismissed: true } })}>
        <X size={14} />
      </IconButton>
    </Panel>
  )
}
