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
  type Icon
} from '@phosphor-icons/react'
import type { DashboardStats, DashboardTotals, UsageRange, UsageSource } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp, type Page } from '@/lib/store'
import { compact, duration, timeAgo } from '@/lib/format'
import { Badge, IconButton, Segmented, Spinner, confirmAction } from '@/components/ui'
import { Tooltip } from '@/components/Tooltip'

const RANGES: { value: UsageRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' }
]

const SOURCE: Record<UsageSource, { label: string; color: string }> = {
  chat: { label: 'Chat', color: '#dc2645' },
  workflow: { label: 'Flows', color: '#fb923c' },
  skills: { label: 'Skill tests', color: '#e0a43a' },
  knowledge: { label: 'Knowledge', color: '#6b9cf0' },
  mcp: { label: 'MCP clients', color: '#3fb97a' },
  builder: { label: 'Flow builder', color: '#c084fc' },
  tools: { label: 'Tools page', color: '#a3e635' },
  other: { label: 'Other', color: '#6c6c76' }
}

const VIA: Record<string, { label: string; color: string }> = {
  slash: { label: '/ command', color: '#dc2645' },
  tool: { label: 'agent', color: '#e0a43a' },
  mcp: { label: 'MCP', color: '#3fb97a' },
  workflow: { label: 'flow', color: '#fb923c' }
}

const INPUT = '#4b4b56'
const OUTPUT = '#dc2645'

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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-line px-5 py-3.5 mobile:flex-wrap mobile:gap-2 mobile:px-4 mobile:py-3">
        <div className="min-w-0 flex-1 mobile:basis-full">
          <div className="text-[15px] font-semibold tracking-tight">Dashboard</div>
          <div className="truncate text-[12px] text-dim mobile:hidden">
            Models, tokens, cost, tools and skills across chat, flows, skill tests and MCP
            {stats && <> · updated {timeAgo(stats.generatedAt)}</>}
          </div>
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
            {empty && (
              <Panel className="flex items-center gap-3 border-crimson-line bg-crimson-soft px-4 py-3" delay={0}>
                <Lightning size={18} weight="fill" className="shrink-0 text-crimson-hi" />
                <div className="text-[12.5px] text-muted">
                  Nothing recorded {range === 'all' ? 'yet' : 'in this period'}. Usage is logged as you chat, run flows, test skills, index knowledge or call Cloth over MCP.
                </div>
              </Panel>
            )}
            <Kpis t={stats.totals} prev={stats.previous} onPricing={() => setPage('providers')} />

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
              <Panel className="xl:col-span-8" delay={0.12}>
                <Timeline stats={stats} />
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
              <Models stats={stats} onPricing={() => setPage('providers')} />
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
      <I size={15} className="text-crimson-hi" />
      <span className="text-[12.5px] font-semibold tracking-tight">{title}</span>
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

function Delta({ now, before, invert }: { now: number; before: number | undefined; invert?: boolean }) {
  if (before === undefined) return null
  if (!before && !now) return null
  if (!before) return <span className="rounded bg-elev-2 px-1.5 py-px text-[10.5px] text-dim">new</span>
  const change = (now - before) / before
  if (Math.abs(change) < 0.005) return <span className="rounded bg-elev-2 px-1.5 py-px text-[10.5px] text-dim">±0%</span>
  const up = change > 0
  const good = invert ? !up : up
  const I = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={clsx('inline-flex items-center gap-0.5 rounded px-1.5 py-px text-[10.5px] font-medium', good ? 'bg-ok/10 text-ok' : 'bg-crimson-soft text-crimson-hi')} title="vs the previous period">
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
      foot: <SplitBar parts={[{ v: t.inputTokens + t.cacheTokens, c: INPUT }, { v: t.outputTokens, c: OUTPUT }, { v: t.embedTokens, c: '#6b9cf0' }]} />
    },
    {
      icon: Coins,
      label: 'Estimated cost',
      value: <Count value={t.cost} format={money} />,
      delta: <Delta now={t.cost} before={prev?.cost} invert />,
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
      sub: t.errors ? <span className="text-crimson-hi">{pct(t.errors, t.calls)} failed ({t.errors})</span> : 'no failed calls'
    },
    {
      icon: Timer,
      label: 'Avg response time',
      value: t.avgLatencyMs === null ? '—' : <Count value={t.avgLatencyMs} format={secs} />,
      delta: t.avgLatencyMs !== null && prev?.avgLatencyMs ? <Delta now={t.avgLatencyMs} before={prev.avgLatencyMs} invert /> : null,
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
          {t.toolErrors ? <span className="text-crimson-hi"> · {pct(t.toolErrors, t.toolCalls)} tool errors</span> : ''}
        </>
      )
    }
  ]
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      {cards.map((c, i) => (
        <Panel key={c.label} delay={0.04 * i} className={clsx('group relative overflow-hidden p-4', i === cards.length - 1 && cards.length % 2 === 1 && 'col-span-2 md:col-span-1')}>
          <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-crimson/5 blur-2xl transition-opacity group-hover:bg-crimson/10" />
          <div className="flex items-center gap-2 text-[11.5px] font-medium text-dim">
            <c.icon size={14} className="text-muted" />
            {c.label}
            <div className="flex-1" />
            {c.delta}
          </div>
          <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight text-fg tabular-nums">{c.value}</div>
          <div className="mt-2 truncate text-[11.5px] text-dim mobile:line-clamp-2 mobile:whitespace-normal">{c.sub}</div>
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

function Timeline({ stats }: { stats: DashboardStats }) {
  const [metric, setMetric] = useState<Metric>('tokens')
  const [hover, setHover] = useState<number | null>(null)
  const data = stats.timeline
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
        <span className="font-mono text-[18px] font-semibold tabular-nums">{h ? fmt(value(h)) : fmt(total)}</span>
        <span className="text-[11.5px] text-dim">
          {h ? `${label(h.t)}${stats.bucket === 'day' ? '' : ''}` : `total, per ${stats.bucket}`}
          {h && metric === 'tokens' && ` · ${compact(h.input)} in · ${compact(h.output)} out`}
          {h && metric === 'calls' && h.errors > 0 && <span className="text-crimson-hi"> · {h.errors} failed</span>}
        </span>
        <div className="flex-1" />
        {metric === 'tokens' && (
          <div className="flex items-center gap-3 text-[11px] text-dim">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: INPUT }} /> input
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: OUTPUT }} /> output
            </span>
          </div>
        )}
      </div>
      <div className="relative mt-3 flex-1 px-4 pb-3">
        <div className="relative h-[210px]">
          {[1, 0.5, 0].map((f) => (
            <div key={f} className="absolute inset-x-0 flex items-center gap-2" style={{ top: `${(1 - f) * 100}%` }}>
              <span className="w-12 -translate-y-1/2 text-right font-mono text-[10px] text-dim">{nice ? fmt(nice * f) : ''}</span>
              <div className="h-px flex-1 -translate-y-1/2 bg-line/70" />
            </div>
          ))}
          <div className="absolute inset-y-0 left-14 right-0 flex items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
            {data.map((b, i) => {
              const v = value(b)
              const hPct = nice ? (v / nice) * 100 : 0
              const inShare = metric === 'tokens' && v ? b.input / v : 0
              return (
                <div key={b.t} className="group relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)} onClick={() => setHover(hover === i ? null : i)}>
                  <div className={clsx('absolute inset-0 rounded-sm transition-colors', hover === i && 'bg-elev-2/60')} />
                  <motion.div
                    className="relative flex w-full flex-col-reverse overflow-hidden rounded-t-[3px]"
                    initial={{ height: 0 }}
                    animate={{ height: `${Math.max(v > 0 ? 1.5 : 0, hPct)}%` }}
                    transition={{ duration: 0.6, delay: 0.15 + i * 0.012, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {metric === 'tokens' ? (
                      <>
                        <div style={{ height: `${inShare * 100}%`, background: INPUT }} />
                        <div className="flex-1" style={{ background: OUTPUT }} />
                      </>
                    ) : (
                      <div className="h-full" style={{ background: metric === 'cost' ? '#e0a43a' : OUTPUT }} />
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
              {i % every === 0 && <span className="absolute left-0 whitespace-nowrap font-mono text-[10px] text-dim">{label(b.t)}</span>}
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
              style={{ background: SOURCE[s.source]?.color ?? '#555' }}
              initial={{ width: 0 }}
              animate={{ width: `${total ? (s.tokens / total) * 100 : 0}%` }}
              transition={{ duration: 0.7, delay: 0.2 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
            />
          ))}
        </div>
        <div className="mt-3 space-y-1.5">
          {!stats.sources.length && <div className="py-3 text-[12px] text-dim">No model usage yet.</div>}
          {stats.sources.map((s) => (
            <div key={s.source} className="flex items-center gap-2 text-[12px]">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: SOURCE[s.source]?.color ?? '#555' }} />
              <span className="flex-1 text-muted">{SOURCE[s.source]?.label ?? s.source}</span>
              <span className="font-mono text-[11px] text-dim">{s.calls} calls</span>
              <span className="w-14 text-right font-mono text-[11px] text-muted tabular-nums">{compact(s.tokens)}</span>
              <span className="w-10 text-right font-mono text-[11px] text-dim">{pct(s.tokens, total)}</span>
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
      <Heading icon={Timer} title="Busiest hours" right={peak >= 0 ? <span className="font-mono text-[11px] text-dim">peak {String(peak).padStart(2, '0')}:00</span> : null} />
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
                style={{ background: n ? `rgb(220 38 69 / ${0.14 + 0.86 * (n / max)})` : 'var(--color-elev-2)' }}
              />
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] text-dim">
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

function Models({ stats, onPricing }: { stats: DashboardStats; onPricing(): void }) {
  const maxTokens = Math.max(...stats.models.map((m) => m.input + m.output), 0)
  return (
    <div className="pb-2">
      <Heading icon={Cpu} title="Models" right={<span className="text-[11px] text-dim">{stats.models.length} used</span>} />
      {!stats.models.length ? (
        <div className="px-4 pb-3 text-[12px] text-dim">No model calls in this period.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[12px]">
            <thead>
              <tr className="border-y border-line text-left text-[12px] font-medium text-dim">
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
                      <div className="font-mono text-[12px] text-fg">{m.modelId}</div>
                      <div className="text-[11px] text-dim">{m.provider}</div>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">{m.calls.toLocaleString()}</td>
                    <td className="px-2 py-2.5">
                      <div className="mb-1 flex justify-between font-mono text-[11px] tabular-nums">
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
                        <button onClick={onPricing} className="text-[11px] text-dim hover:text-crimson-hi" title="No price known — set one on the Models page">
                          set price
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums text-muted">{m.avgLatencyMs === null ? '—' : duration(m.avgLatencyMs)}</td>
                    <td className="px-2 py-2.5 text-right font-mono tabular-nums">{m.errors ? <span className="text-crimson-hi">{m.errors}</span> : <span className="text-dim">0</span>}</td>
                    <td className="px-4 py-2.5 text-right text-[11.5px] text-dim">{timeAgo(m.lastUsed)}</td>
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
      <span className={clsx('w-4 shrink-0 text-right font-mono text-[11px]', rank === 1 ? 'text-crimson-hi' : 'text-dim')}>{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[12px] text-fg">{name}</span>
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
      <Heading icon={Wrench} title="Most used tools" right={<span className="text-[11px] text-dim">{stats.totals.toolCalls.toLocaleString()} calls</span>} />
      {!stats.tools.length && <div className="px-4 pb-3 text-[12px] text-dim">No tool calls in this period.</div>}
      {stats.tools.slice(0, 8).map((t, i) => (
        <Ranked
          key={t.name}
          rank={i + 1}
          name={t.name}
          sub={t.kind.split(',').map((k) => (
            <Badge key={k} tone={k === 'custom' ? 'info' : k === 'mcp' ? 'ok' : 'dim'}>
              {k === 'builtin' ? 'built-in' : k}
            </Badge>
          ))}
          right={
            <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
              {t.errors > 0 && <span className="text-crimson-hi">{t.errors} failed</span>}
              {t.avgMs !== null && <span className="text-dim">{duration(t.avgMs)}</span>}
              <span className="w-10 text-right text-muted">{t.calls}</span>
            </span>
          }
        >
          <Bar value={t.calls} max={max} delay={0.2 + i * 0.05} color={i === 0 ? OUTPUT : '#7a2233'} />
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
          <div className="flex items-center gap-2.5 text-[10.5px] text-dim">
            {Object.entries(VIA).map(([k, v]) => (
              <span key={k} className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: v.color }} />
                {v.label}
              </span>
            ))}
          </div>
        }
      />
      {!stats.skills.length && <div className="px-4 pb-3 text-[12px] text-dim">No skills used in this period. Invoke one with / in chat, or let an agent load it.</div>}
      {stats.skills.slice(0, 8).map((s, i) => (
        <Ranked
          key={s.name}
          rank={i + 1}
          name={s.name}
          right={<span className="w-10 text-right font-mono text-[11px] text-muted tabular-nums">{s.uses}</span>}
        >
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-elev-2">
            <motion.div
              className="flex h-full gap-px"
              initial={{ width: 0 }}
              animate={{ width: `${max ? (s.uses / max) * 100 : 0}%` }}
              transition={{ duration: 0.7, delay: 0.2 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            >
              {Object.entries(s.via).map(([k, n]) => (
                <div key={k} title={`${VIA[k]?.label ?? k}: ${n}`} style={{ width: `${(n / s.uses) * 100}%`, background: VIA[k]?.color ?? '#555' }} />
              ))}
            </motion.div>
          </div>
        </Ranked>
      ))}
    </div>
  )
}

// ─── Flows, skill health, library ───────────────────────────────────────────

function Ring({ value, size = 64, color = '#3fb97a', children }: { value: number; size?: number; color?: string; children?: ReactNode }) {
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
      <div className="absolute inset-0 flex items-center justify-center font-mono text-[12.5px] font-semibold">{children}</div>
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
        <Ring value={rate} color={rate >= 0.9 ? '#3fb97a' : rate >= 0.6 ? '#e0a43a' : '#dc2645'}>
          {w.runs ? `${Math.round(rate * 100)}%` : '—'}
        </Ring>
        <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px]">
          <Stat label="runs" value={w.runs} />
          <Stat label="failed" value={w.errors} tone={w.errors ? 'crimson' : undefined} />
          <Stat label="avg duration" value={w.avgMs === null ? '—' : duration(w.avgMs)} />
          <Stat label="scheduled" value={w.scheduled} />
        </div>
      </div>
      <div className="mt-3 space-y-1 px-4">
        {w.top.map((f) => (
          <div key={f.id} className="flex items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1 truncate text-muted">{f.name}</span>
            {f.errors > 0 && <span className="font-mono text-[10.5px] text-crimson-hi">{f.errors}✕</span>}
            <span className="font-mono text-[11px] text-dim tabular-nums">{f.runs} runs</span>
            <span className="w-12 text-right font-mono text-[11px] text-dim">{f.avgMs === null ? '' : duration(f.avgMs)}</span>
          </div>
        ))}
        {!w.top.length && <div className="text-[12px] text-dim">No runs in this period.</div>}
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
            <div className="font-mono text-[16px] font-semibold tabular-nums text-fg">{it.value}</div>
            <div className="flex items-center gap-1 text-[10.5px] text-dim group-hover:text-muted">
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
      {!stats.recent.length && <div className="px-4 pb-3 text-[12px] text-dim">Nothing yet.</div>}
      <div className="grid grid-cols-1 lg:grid-cols-2">
        {stats.recent.map((r, i) => {
          const I = icon[r.kind] ?? Lightning
          return (
            <div key={`${r.at}-${i}`} className="flex items-center gap-2.5 border-t border-line/60 px-4 py-2 text-[12px]">
              <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border', r.ok ? 'border-line bg-elev text-muted' : 'border-crimson-line bg-crimson-soft text-crimson-hi')}>
                <I size={12} />
              </span>
              <span className="min-w-0 truncate font-mono text-[11.5px] text-fg">{r.label}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{r.detail}</span>
              <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-dim">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: SOURCE[r.source]?.color ?? '#555' }} />
                {SOURCE[r.source]?.label ?? r.source}
              </span>
              <span className="w-14 shrink-0 text-right text-[10.5px] text-dim">{timeAgo(r.at)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'crimson' }) {
  return (
    <div>
      <div className={clsx('font-mono text-[14px] font-semibold tabular-nums', tone === 'crimson' ? 'text-crimson-hi' : 'text-fg')}>{value}</div>
      <div className="text-[10.5px] text-dim">{label}</div>
    </div>
  )
}

function LinkButton({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="text-[11px] text-dim hover:text-crimson-hi">
      {children} →
    </button>
  )
}
