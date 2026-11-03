import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretRight, CheckCircle, MinusCircle, SidebarSimple, WarningCircle, XCircle } from '@phosphor-icons/react'
import type { ToolTrace } from '@shared/types'
import { duration, formatCost } from '@/lib/format'
import { elapsed, recentSteps, runNow, runState, runStepCount, runToolIds, type RunState } from '@/lib/activity'
import { runAbout, runCardId, runName } from '@/lib/workbar'
import { openAgentRun } from '@/pages/chat/setupNav'
import { ThinkingRow, ToolRow } from './Activity'
import { ToolTraceCard, toolVerb } from './ToolTrace'

const EASE = [0.32, 0.72, 0, 1] as const
/** Steps an opened run shows before "… earlier steps". */
const RECENT = 5

const RESULT: Record<Exclude<RunState, 'running'>, { word: string; cls: string }> = {
  done: { word: 'Done', cls: 'text-ok' },
  partial: { word: 'Partly done', cls: 'text-warn' },
  blocked: { word: 'Blocked', cls: 'text-danger-hi' },
  failed: { word: 'Failed', cls: 'text-danger-hi' }
}

function StateIcon({ state }: { state: RunState }) {
  if (state === 'running') return <span aria-label="Working" className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-agent motion-reduce:animate-none" />
  const Icon = state === 'done' ? CheckCircle : state === 'partial' ? WarningCircle : state === 'blocked' ? MinusCircle : XCircle
  return <Icon size={14} weight="fill" aria-hidden className={clsx('shrink-0', RESULT[state].cls)} />
}

/** Seconds since mount, ticking while `on`. */
function useElapsed(on: boolean): string {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(start)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [on])
  return elapsed(now - start)
}

/** A subagent run as one quiet line, like the folded activity lines; opens into its latest steps. */
export function AgentRunLine({ trace, fresh, awaiting, onUndo }: { trace: ToolTrace; fresh?: boolean; awaiting: Set<string>; onUndo?(toolCallId: string): Promise<void> }) {
  const run = trace.subagent!
  const state = runState(trace)
  const running = state === 'running'
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const [rows, setRows] = useState<Set<string>>(new Set())
  const ids = useMemo(() => runToolIds(run.blocks), [run.blocks])
  // Nothing that needs the person stays hidden.
  const waiting = awaiting.has(trace.id) || ids.some((id) => awaiting.has(id))
  const shown = open || waiting
  const count = runStepCount(run)
  const { steps, earlier, offset } = recentSteps(run.blocks, RECENT, all)
  const now = runNow(run.blocks)
  const timer = useElapsed(running)
  const cost = run.usage?.cost ?? 0
  const stepWord = `${count} step${count === 1 ? '' : 's'}`
  const numbers = running ? `${stepWord} · ${timer}` : [stepWord, trace.durationMs !== null ? duration(trace.durationMs) : '', cost > 0 ? formatCost(cost) : ''].filter(Boolean).join(' · ')
  const toggleRow = (id: string) =>
    setRows((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const step = now.kind === 'tool' ? toolVerb(now.trace) : null

  return (
    <motion.div id={runCardId(trace.id)} initial={fresh ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 28 }} className="mb-1.5 rounded-lg">
      <button onClick={() => setOpen(!open)} aria-expanded={shown} className="-ml-1 flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-panel">
        <motion.span animate={{ rotate: shown ? 90 : 0 }} transition={{ duration: 0.18, ease: EASE }} className="flex shrink-0 text-dim">
          <CaretRight size={11} />
        </motion.span>
        <StateIcon state={state} />
        <span title={runAbout(run)} className={clsx('shrink-0 text-[13px] font-semibold', run.agent ? 'text-agent' : 'text-fg')}>
          {runName(run)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{run.description}</span>
        {!running && <span className={clsx('shrink-0 text-[11px] font-semibold', RESULT[state as Exclude<RunState, 'running'>].cls)}>{RESULT[state as Exclude<RunState, 'running'>].word}</span>}
        {waiting && <span className="shrink-0 rounded-full bg-warn/10 px-2 py-px text-[10.5px] text-warn">awaiting approval</span>}
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-dim">{numbers}</span>
      </button>
      {running && !shown && (
        <div aria-live="polite" className="ml-[26px] flex min-w-0 items-center gap-2">
          {step ? (
            <>
              <span className="shrink-0 text-[12px] font-medium text-muted">{step.verb}</span>
              <span className="min-w-0 truncate font-mono text-[11.5px] text-dim">{step.target}</span>
            </>
          ) : now.kind === 'thinking' ? (
            <span className="shimmer-text text-[12px] font-medium">Thinking</span>
          ) : (
            <span className="text-[12px] font-medium text-muted">Queued</span>
          )}
        </div>
      )}
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="overflow-hidden">
            <div className="my-1.5 ml-1.5 border-l border-line pl-4">
              {offset > 0 && (
                <button onClick={() => setAll(true)} className="py-0.5 text-[12px] text-dim transition-colors hover:text-muted">
                  {earlier ? `… ${earlier} earlier step${earlier === 1 ? '' : 's'}` : '… earlier thinking'}
                </button>
              )}
              {steps.map((b, i) =>
                b.type === 'thinking' ? (
                  <ThinkingRow key={`think:${offset + i}`} text={b.text} />
                ) : b.type === 'tool' ? (
                  <div key={b.trace.id}>
                    <ToolRow trace={b.trace} open={rows.has(b.trace.id)} awaiting={awaiting.has(b.trace.id)} onToggle={() => toggleRow(b.trace.id)} />
                    {rows.has(b.trace.id) && (
                      <div className="mb-2 ml-[26px] [&>div]:mb-0">
                        <ToolTraceCard trace={b.trace} awaiting={awaiting.has(b.trace.id)} onUndo={onUndo} compact defaultOpen />
                      </div>
                    )}
                  </div>
                ) : null
              )}
              <button onClick={() => openAgentRun(trace.id)} className="mt-1 flex items-center gap-1.5 text-[12px] text-dim transition-colors hover:text-fg">
                <SidebarSimple size={12} />
                Open in the Agents tab
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
