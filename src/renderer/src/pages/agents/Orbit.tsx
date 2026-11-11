import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { motion, useReducedMotion } from 'motion/react'
import type { Agent, AgentActivity } from '@shared/types'
import { useEvent } from '@/lib/api'
import { Tile } from './Tile'

/** What an agent is doing right now, from the jobs Cloth hands it. */
export type Live = { state: 'working' | 'done' | 'failed'; text: string; at: number }
type Pulse = { key: number; agentId: string; dir: 'out' | 'back'; ok: boolean }

const EASE = [0.65, 0, 0.35, 1] as const
/** How long "Done just now" stays before the agent reads as idle again. */
const SETTLE_MS = 8000

/**
 * Live job state for the team: who is working on what, plus the dots that travel between Cloth and an
 * agent as work goes out and results come back. Seeded from the jobs already running when the page opens.
 */
export function useTeamLive(activity: Record<string, AgentActivity>) {
  const reduce = useReducedMotion() ?? false
  const [live, setLive] = useState<Record<string, Live>>({})
  const [pulses, setPulses] = useState<Pulse[]>([])
  const [latest, setLatest] = useState('')
  const seq = useRef(0)
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  useEffect(() => {
    setLive((cur) => {
      let next = cur
      for (const [id, a] of Object.entries(activity))
        if (a.running && !cur[id]) next = { ...next, [id]: { state: 'working', text: a.current ?? '', at: Date.now() } }
      return next
    })
  }, [activity])

  useEvent('agents', (e) => {
    if (e.type !== 'job') return
    const at = Date.now()
    const key = ++seq.current
    if (e.state === 'start') {
      setLive((cur) => ({ ...cur, [e.agentId]: { state: 'working', text: e.description, at } }))
      if (!reduce) setPulses((p) => [...p, { key, agentId: e.agentId, dir: 'out', ok: true }])
      setLatest(`Handed off: ${e.description}`)
      return
    }
    const ok = e.state === 'done'
    setLive((cur) => ({ ...cur, [e.agentId]: { state: ok ? 'done' : 'failed', text: e.description, at } }))
    if (!reduce) setPulses((p) => [...p, { key, agentId: e.agentId, dir: 'back', ok }])
    timers.current.push(
      window.setTimeout(
        () =>
          setLive((cur) => {
            if (cur[e.agentId]?.at !== at) return cur
            const { [e.agentId]: _, ...rest } = cur
            return rest
          }),
        SETTLE_MS
      )
    )
    setLatest(`${ok ? 'Finished' : 'Failed'}: ${e.description}`)
  })

  const done = (key: number) => setPulses((p) => p.filter((x) => x.key !== key))
  return { live, pulses, latest, done }
}

const HEIGHT = 292
const CY = 128

/**
 * Cloth in the middle with the team around it. Each line is the path Cloth hands work along: a crimson dot
 * travels out when a job starts and a green one comes back when it ends. Nothing moves while nothing runs.
 */
export function TeamOrbit({
  agents,
  activity,
  team,
  match,
  selected,
  onOpen
}: {
  agents: Agent[]
  activity: Record<string, AgentActivity>
  team: ReturnType<typeof useTeamLive>
  match(a: Agent): boolean
  selected: string | null
  onOpen(id: string): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<string | null>(null)
  // Each arrival rings the tile it reached once.
  const [rings, setRings] = useState<Record<string, number>>({})
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cx = width / 2
  const rx = Math.min(width * 0.38, 440)
  // Tall enough that an agent straight below Cloth clears its name and line.
  const ry = 102
  const n = agents.length
  // Spread around the ring, starting so that nobody sits right on top of Cloth.
  const pos = agents.map((_, i) => {
    const t = -Math.PI / 2 + Math.PI / Math.max(n, 1) + (i * 2 * Math.PI) / Math.max(n, 1)
    return { x: cx + rx * Math.cos(t), y: CY + ry * Math.sin(t) }
  })
  const index = new Map(agents.map((a, i) => [a.id, i]))
  const focus = hover

  return (
    <div ref={box} className="relative w-full" style={{ height: HEIGHT }} onMouseLeave={() => setHover(null)}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_45%_60%_at_50%_45%,rgb(220_38_69/0.07),transparent_70%)]" />
      {width > 0 && (
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${HEIGHT}`}>
          <ellipse cx={cx} cy={CY} rx={rx} ry={ry} fill="none" stroke="var(--color-line)" strokeDasharray="2 6" />
          {agents.map((a, i) => {
            const working = team.live[a.id]?.state === 'working'
            const on = focus === a.id
            return (
              <motion.line
                key={a.id}
                x1={cx}
                y1={CY}
                x2={pos[i].x}
                y2={pos[i].y}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1, opacity: focus && !on ? 0.25 : match(a) ? 1 : 0.3 }}
                transition={{ pathLength: { duration: 0.42, delay: 0.18 + i * 0.04, ease: 'easeOut' }, opacity: { duration: 0.16 } }}
                stroke={on ? 'var(--color-crimson-hi)' : working ? 'var(--color-crimson-line)' : 'var(--color-line-strong)'}
                strokeWidth={1.25}
              />
            )
          })}
          {team.pulses.map((p) => {
            const i = index.get(p.agentId)
            if (i === undefined) return null
            const from = p.dir === 'out' ? { cx, cy: CY } : { cx: pos[i].x, cy: pos[i].y }
            const to = p.dir === 'out' ? { cx: pos[i].x, cy: pos[i].y } : { cx, cy: CY }
            return (
              <motion.circle
                key={p.key}
                r={4.5}
                fill={p.dir === 'out' ? 'var(--color-crimson-hi)' : p.ok ? 'var(--color-ok)' : 'var(--color-danger)'}
                initial={from}
                animate={to}
                transition={{ duration: p.dir === 'out' ? 0.9 : 0.7, ease: EASE }}
                onAnimationComplete={() => {
                  team.done(p.key)
                  const target = p.dir === 'out' ? p.agentId : 'cloth'
                  setRings((r) => ({ ...r, [target]: (r[target] ?? 0) + 1 }))
                }}
              />
            )
          })}
        </svg>
      )}

      {width > 0 && (
        <>
          <div className="pointer-events-none absolute grid justify-items-center gap-1" style={{ left: cx, top: CY, transform: 'translate(-50%, -28px)' }}>
            <motion.span
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
              className="relative flex h-14 w-14 items-center justify-center rounded-[16px] bg-crimson text-[19px] font-semibold text-white shadow-[0_0_0_1px_var(--color-crimson-line),0_0_40px_-6px_rgb(220_38_69/0.55)]"
              aria-hidden="true"
            >
              C
              <Ring n={rings.cloth} tone="ok" />
            </motion.span>
            <span className="rounded-[6px] bg-bg/80 px-1.5 text-ui font-semibold">Cloth</span>
            <span className="-mt-1 whitespace-nowrap rounded-[6px] bg-bg/80 px-1.5 text-caption text-dim">The main agent in every chat</span>
          </div>

          {agents.map((a, i) => {
            const l = team.live[a.id]
            const act = activity[a.id]
            const dim = (focus && focus !== a.id) || !match(a)
            return (
              <div key={a.id} className="absolute" style={{ left: pos[i].x, top: pos[i].y, transform: 'translate(-50%, -20px)' }}>
              <motion.button
                type="button"
                data-focus-key={`orbit-${a.id}`}
                onClick={() => onOpen(a.id)}
                onMouseEnter={() => setHover(a.id)}
                onFocus={() => setHover(a.id)}
                onBlur={() => setHover(null)}
                aria-label={`${a.name}: ${status(l, act)}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: dim ? 0.35 : 1 }}
                transition={{ opacity: { duration: 0.16 }, default: { delay: 0.3 + i * 0.05 } }}
                className="group grid max-w-[150px] justify-items-center gap-1 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-crimson-line"
              >
                <span className={clsx('relative rounded-[10px] transition-transform duration-200 group-hover:scale-[1.08]', selected === a.id && 'scale-[1.08] ring-2 ring-crimson-line')}>
                  <Tile name={a.name} builtin={a.builtin} size="lg" className="shadow-[inset_0_0_0_1px_var(--color-line-strong)]" />
                  <Ring n={rings[a.id]} tone="crimson" />
                </span>
                <span className="max-w-full truncate rounded-[6px] bg-bg/80 px-1.5 text-caption font-semibold">{a.name}</span>
                <span
                  className={clsx(
                    '-mt-1 max-w-full truncate text-caption',
                    l?.state === 'working' ? 'text-info' : l?.state === 'done' ? 'text-ok' : l?.state === 'failed' ? 'text-danger-hi' : 'text-dim'
                  )}
                  title={l?.text || undefined}
                >
                  {status(l, act)}
                </span>
              </motion.button>
              </div>
            )
          })}
        </>
      )}

      <p aria-live="polite" className="pointer-events-none absolute bottom-1 left-0 max-w-[60%] truncate font-mono text-caption text-dim">
        {team.latest}
      </p>
    </div>
  )
}

/** One ring that grows and fades from a tile, each time `n` goes up. */
function Ring({ n, tone }: { n?: number; tone: 'crimson' | 'ok' }) {
  if (!n) return null
  return (
    <motion.span
      key={n}
      aria-hidden="true"
      initial={{ opacity: 0.9, scale: 0.9 }}
      animate={{ opacity: 0, scale: 1.4 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className={clsx('pointer-events-none absolute -inset-1 rounded-[14px] border-[1.5px]', tone === 'ok' ? 'border-ok' : 'border-crimson-hi')}
    />
  )
}

function status(l: Live | undefined, act: AgentActivity | undefined): string {
  if (l?.state === 'working') return l.text ? `Working: ${l.text}` : 'Working'
  if (l?.state === 'done') return 'Done just now'
  if (l?.state === 'failed') return 'Failed just now'
  if (act?.jobs) return `${act.jobs} job${act.jobs === 1 ? '' : 's'} this week`
  return 'Not used yet'
}
