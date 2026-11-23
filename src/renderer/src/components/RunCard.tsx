import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretRight, CheckCircle, Circle } from '@phosphor-icons/react'
import type { ToolTrace, UiBlock } from '@shared/types'
import { duration } from '@/lib/format'
import { activityStats, currentStep, elapsed, type RunPlan, type RunStep } from '@/lib/activity'
import { ThinkingRow, ToolRow } from './Activity'
import { AgentRunLine } from './AgentRun'
import { describeTools, ToolTraceCard, toolVerb } from './ToolTrace'

const EASE = [0.32, 0.72, 0, 1] as const
/** While a step is live, only its latest blocks show; the rest are one click away. */
const RECENT = 3

const lowerFirst = (s: string) => s && s[0].toLowerCase() + s.slice(1)
const tracesOf = (blocks: UiBlock[], indices: number[]): ToolTrace[] => indices.flatMap((i) => (blocks[i]?.type === 'tool' ? [(blocks[i] as { trace: ToolTrace }).trace] : []))

/**
 * A turn that keeps a todo list, shown as its plan: one row per step, with the thinking and tool calls done for
 * that step under it. While it runs, the card is open on the current step and shows its latest actions; once it
 * is done it folds into one line, like an activity group.
 */
export function RunCard({
  plan,
  blocks,
  live,
  fresh,
  awaiting,
  onUndo
}: {
  plan: RunPlan
  blocks: UiBlock[]
  /** The turn is still streaming. */
  live: boolean
  fresh?: boolean
  awaiting: Set<string>
  onUndo?(toolCallId: string): Promise<void>
}) {
  const stepTraces = useMemo(() => plan.steps.map((s) => tracesOf(blocks, s.indices)), [plan, blocks])
  const traces = useMemo(() => stepTraces.flat(), [stepTraces])
  const stats = useMemo(() => activityStats(traces), [traces])
  const cur = currentStep(plan)
  const running = live && cur >= 0
  const waiting = stepTraces.findIndex((ts) => ts.some((t) => awaiting.has(t.id)))
  const done = plan.steps.filter((s) => s.status === 'completed').length
  const [open, setOpen] = useState(false)
  // Open while it runs or needs the person; folded once done, until opened.
  const shown = running || waiting >= 0 || open

  return (
    <motion.div initial={fresh ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 28 }} className="mb-3.5 mt-0.5">
      {!running && (
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={shown}
          className="-ml-1 inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-[3px] text-left text-ui text-dim transition-colors hover:bg-panel hover:text-muted"
        >
          <motion.span animate={{ rotate: shown ? 90 : 0 }} transition={{ duration: 0.18, ease: EASE }} className="flex shrink-0">
            <CaretRight size={11} />
          </motion.span>
          <span className="min-w-0 truncate">
            {stats.ms > 0 && <>Worked for {duration(stats.ms)} · </>}
            <span className="text-muted">
              {done} of {plan.steps.length} steps
            </span>
            {traces.length > 0 && <> · {lowerFirst(describeTools(traces))}</>}
          </span>
          {stats.changed && (
            <span className="shrink-0 font-mono text-caption">
              <span className="text-ok">+{stats.added}</span> <span className="text-danger-hi">-{stats.removed}</span>
            </span>
          )}
          {stats.failed > 0 && <span className="shrink-0 font-mono text-caption text-danger-hi">{stats.failed} failed</span>}
          <Segments steps={plan.steps} cur={-1} small />
        </button>
      )}
      <AnimatePresence initial={false}>
        {shown && (
          <motion.section
            aria-label="Run"
            initial={running ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className={clsx('overflow-hidden rounded-[12px] border border-line bg-panel', !running && 'mt-1.5')}
          >
            {running && <LiveHeader plan={plan} cur={cur} waiting={waiting >= 0} traces={stepTraces[cur] ?? []} stats={stats} />}
            <div className="py-1">
              {plan.steps.map((s, k) => (
                <StepRow
                  key={`${k}:${s.text}`}
                  step={s}
                  traces={stepTraces[k]}
                  blocks={blocks}
                  current={running && k === cur}
                  waiting={k === waiting}
                  awaiting={awaiting}
                  onUndo={onUndo}
                />
              ))}
            </div>
          </motion.section>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** One cell per step: done, current or still to do. */
function Segments({ steps, cur, waiting, small }: { steps: RunStep[]; cur: number; waiting?: boolean; small?: boolean }) {
  return (
    <span aria-hidden="true" className={clsx('grid shrink-0 gap-[3px]', small ? 'w-auto' : 'w-full')} style={{ gridTemplateColumns: `repeat(${steps.length}, ${small ? '10px' : 'minmax(0, 1fr)'})` }}>
      {steps.map((s, k) => (
        <span
          key={k}
          className={clsx(
            'rounded-[2px]',
            small ? 'h-[4px]' : 'h-[4px]',
            s.status === 'completed' ? 'bg-ok' : k === cur ? clsx('bg-warn', !waiting && 'animate-pulse motion-reduce:animate-none') : 'bg-elev-2'
          )}
        />
      ))}
    </span>
  )
}

/** The live card's top: what it is doing now, which step, a timer and the step meter. */
function LiveHeader({ plan, cur, waiting, traces, stats }: { plan: RunPlan; cur: number; waiting: boolean; traces: ToolTrace[]; stats: ReturnType<typeof activityStats> }) {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(start)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const step = plan.steps[cur]
  const doing = [...traces].reverse().find((t) => t.status === 'running')
  const action = doing ? toolVerb(doing) : null
  return (
    <div className="flex flex-col gap-2 border-b border-line px-3.5 pb-2.5 pt-3">
      <div className="flex items-center gap-2.5">
        {waiting ? (
          <span aria-hidden className="mx-[2px] h-2 w-2 shrink-0 rounded-full bg-warn" />
        ) : (
          <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-crimson-hi motion-reduce:animate-none" />
        )}
        <span aria-live="polite" className="flex min-w-0 items-center gap-2 text-body font-medium text-fg">
          {waiting ? (
            <span className="truncate">Needs you · {step?.text}</span>
          ) : action ? (
            <>
              <span className="shrink-0">{action.verb}</span>
              <span className="min-w-0 truncate font-mono text-caption font-normal text-dim">{action.target}</span>
            </>
          ) : (
            <span className="truncate">{step?.text}</span>
          )}
        </span>
        <span className="ml-auto shrink-0 font-mono text-caption tabular-nums text-dim">{elapsed(now - start)}</span>
      </div>
      <div className="flex items-center gap-2 text-caption text-dim">
        <span>
          Step {cur + 1} of {plan.steps.length}
        </span>
        {stats.changed && (
          <span className="ml-auto font-mono">
            <span className="text-ok">+{stats.added}</span> <span className="text-danger-hi">-{stats.removed}</span>
          </span>
        )}
      </div>
      <Segments steps={plan.steps} cur={cur} waiting={waiting} />
    </div>
  )
}

function StepIcon({ status, current, waiting }: { status: RunStep['status']; current: boolean; waiting: boolean }) {
  if (waiting) return <span className="mx-[3px] h-2 w-2 rounded-full bg-warn" />
  if (status === 'completed') return <CheckCircle size={15} weight="fill" className="text-ok" />
  if (current || status === 'in_progress') return <span className="mx-[3px] h-2 w-2 animate-pulse rounded-full bg-warn motion-reduce:animate-none" />
  return <Circle size={15} className="text-dim" />
}

/** A step: its status, what it took, and (opened) the work done for it. The current and waiting steps open by themselves. */
function StepRow({
  step,
  traces,
  blocks,
  current,
  waiting,
  awaiting,
  onUndo
}: {
  step: RunStep
  traces: ToolTrace[]
  blocks: UiBlock[]
  current: boolean
  waiting: boolean
  awaiting: Set<string>
  onUndo?(toolCallId: string): Promise<void>
}) {
  const [open, setOpen] = useState<boolean | null>(null)
  const [all, setAll] = useState(false)
  const stats = useMemo(() => activityStats(traces), [traces])
  const canOpen = step.indices.length > 0
  // Follows the run (open while current or waiting) until the person opens or closes it themselves.
  const shown = canOpen && (open ?? (current || waiting))
  const live = current && !waiting
  const hidden = live && !all ? Math.max(0, step.indices.length - RECENT) : 0
  const indices = hidden ? step.indices.slice(-RECENT) : step.indices
  const earlier = hidden ? step.indices.slice(0, hidden).filter((i) => blocks[i]?.type === 'tool').length : 0
  const pending = step.status !== 'completed' && !current && !waiting

  return (
    <div className={clsx((current || waiting) && (waiting ? 'bg-warn/5' : 'bg-elev/40'))}>
      <button
        onClick={() => canOpen && setOpen(!shown)}
        aria-expanded={canOpen ? shown : undefined}
        disabled={!canOpen}
        aria-current={current ? 'step' : undefined}
        className={clsx('grid w-full grid-cols-[12px_18px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-[6px] text-left text-ui', canOpen && 'transition-colors hover:bg-elev-2')}
      >
        <span className="flex text-dim">{canOpen && <CaretRight size={10} className={clsx('transition-transform duration-150', shown && 'rotate-90')} />}</span>
        <span className="flex items-center justify-center">
          <StepIcon status={step.status} current={current} waiting={waiting} />
        </span>
        <span className={clsx('min-w-0 truncate', current || waiting ? 'font-medium text-fg' : pending ? 'text-dim' : 'text-muted')}>{step.text}</span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-caption text-dim">
          {waiting ? (
            <span className="rounded-full bg-warn/10 px-2 py-px font-sans text-micro text-warn">needs you</span>
          ) : (
            <>
              {stats.changed && (
                <span>
                  <span className="text-ok">+{stats.added}</span> <span className="text-danger-hi">-{stats.removed}</span>
                </span>
              )}
              {stats.failed > 0 && <span className="text-danger-hi">{stats.failed} failed</span>}
              {!current && stats.ms > 0 && <span>{duration(stats.ms)}</span>}
            </>
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: EASE }} className="overflow-hidden">
            <div className="mb-2 ml-[37px] mr-3 border-l border-line pl-4">
              {earlier > 0 && (
                <button onClick={() => setAll(true)} className="-ml-1.5 rounded-[7px] px-1.5 py-1 text-caption text-dim transition-colors hover:bg-elev-2 hover:text-muted">
                  {earlier} earlier {earlier === 1 ? 'action' : 'actions'}
                </button>
              )}
              <StepBlocks blocks={blocks} indices={indices} awaiting={awaiting} onUndo={onUndo} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** A step's thinking, tool calls (each opens to its card) and agent runs. */
function StepBlocks({ blocks, indices, awaiting, onUndo }: { blocks: UiBlock[]; indices: number[]; awaiting: Set<string>; onUndo?(toolCallId: string): Promise<void> }) {
  const [rows, setRows] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setRows((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return (
    <>
      {indices.map((i) => {
        const b = blocks[i]
        if (!b) return null
        if (b.type === 'thinking') return <ThinkingRow key={`think:${i}`} text={b.text} />
        if (b.type !== 'tool') return null
        if (b.trace.subagent)
          return (
            <div key={b.trace.id} className="my-1">
              <AgentRunLine trace={b.trace} awaiting={awaiting} onUndo={onUndo} />
            </div>
          )
        return (
          <div key={b.trace.id}>
            <ToolRow trace={b.trace} open={rows.has(b.trace.id)} awaiting={awaiting.has(b.trace.id)} onToggle={() => toggle(b.trace.id)} />
            {rows.has(b.trace.id) && (
              <div className="mb-2 ml-[26px] [&>div]:mb-0">
                <ToolTraceCard trace={b.trace} awaiting={awaiting.has(b.trace.id)} onUndo={onUndo} compact defaultOpen />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
