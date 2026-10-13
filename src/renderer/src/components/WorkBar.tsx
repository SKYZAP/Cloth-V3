import { useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretDown, CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react'
import { formatCost } from '@/lib/format'
import { runCardId, shortfall, type BarRow, type RunInfo, type StepStatus, type WorkBar as Bar } from '@/lib/workbar'

/** Scroll the chat to a run's card and flash it briefly. */
export function scrollToRun(cardId: string) {
  const el = document.getElementById(runCardId(cardId))
  if (!el) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
  el.animate(
    [{ boxShadow: '0 0 0 2px var(--color-crimson-line)' }, { boxShadow: '0 0 0 2px var(--color-crimson-line)', offset: 0.6 }, { boxShadow: '0 0 0 2px transparent' }],
    { duration: reduce ? 900 : 1600, easing: 'ease-out' }
  )
}

/** "{agent, or Scout / Worker for a plain job} · {tier}". */
export const runLabel = (r: RunInfo) => (r.tierName ? `${r.name} · ${r.tierName}` : r.name)

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'completed') return <CheckCircle size={14} weight="fill" className="text-ok" />
  if (status === 'in_progress') return <span className="mx-[3px] h-2 w-2 animate-pulse rounded-full bg-warn" />
  if (status === 'failed') return <WarningCircle size={14} weight="fill" className="text-crimson-hi" />
  return <Circle size={14} className="text-dim" />
}

function Row({ row }: { row: BarRow }) {
  const run = row.run
  const short = run ? shortfall(run) : null
  const body = (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {short && row.status === 'completed' ? (
          <span className={clsx('mx-[3px] h-2 w-2 rounded-full', run?.outcome === 'partial' ? 'bg-warn' : 'bg-crimson')} aria-label={short} />
        ) : (
          <StatusIcon status={row.status} />
        )}
      </span>
      <span className={clsx('min-w-0 flex-1 truncate', row.status === 'completed' ? 'text-muted' : row.status === 'in_progress' ? 'text-fg' : 'text-dim')}>
        {row.n !== undefined && <span className="mr-1.5 font-mono text-[11px] text-dim">{row.n}</span>}
        {row.text}
        {run?.current && (
          <span className="ml-2 text-dim">
            {run.current.tool} {run.current.summary}…
          </span>
        )}
      </span>
      {run ? (
        <span className="flex shrink-0 items-center gap-2 text-[11px]">
          {row.runs > 1 && <span className="text-dim">{row.runs} runs</span>}
          <span className="rounded-full bg-agent-soft px-1.5 py-px text-agent">{runLabel(run)}</span>
          {short && <span className={clsx('text-[10.5px]', run.outcome === 'partial' ? 'text-warn' : 'text-crimson-hi')}>{short}</span>}
          {run.cost > 0 && <span className="font-mono text-dim">{formatCost(run.cost)}</span>}
        </span>
      ) : (
        row.n !== undefined && row.status !== 'pending' && <span className="shrink-0 text-[11px] text-dim">Cloth</span>
      )}
    </>
  )
  const cls = 'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px]'
  return run ? (
    <button onClick={() => scrollToRun(run.cardId)} className={clsx(cls, 'transition-colors hover:bg-elev-2')} title="Show this run">
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/** The current turn's plan and agent runs, pinned above the message box. */
export function WorkBar({ bar }: { bar: Bar }) {
  const [open, setOpen] = useState(false)
  const { completed, inProgress, rest } = bar.progress
  const total = completed + inProgress + rest || 1
  const title = bar.mode === 'todos' ? (bar.current ?? 'All steps done') : 'Agents at work'
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="overflow-hidden rounded-[12px] border border-line bg-panel"
    >
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="relative flex h-9 w-full items-center gap-3 px-3 text-left">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{title}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-dim">{bar.mode === 'todos' ? `${bar.done} of ${bar.total}` : `${bar.runCount} agent${bar.runCount === 1 ? '' : 's'}`}</span>
        {bar.cost > 0 && <span className="shrink-0 font-mono text-[11px] tabular-nums text-dim">{formatCost(bar.cost)}</span>}
        <motion.span animate={{ rotate: open ? 0 : 180 }} transition={{ duration: 0.25 }} className="flex shrink-0 text-dim">
          <CaretDown size={13} />
        </motion.span>
        <span className="absolute inset-x-0 bottom-0 flex h-1 bg-line" aria-hidden="true">
          <span className="h-full bg-ok transition-[width] duration-300" style={{ width: `${(completed / total) * 100}%` }} />
          <span className="h-full bg-warn transition-[width] duration-300" style={{ width: `${(inProgress / total) * 100}%` }} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 32 }} className="overflow-hidden">
            <div className="max-h-64 overflow-y-auto px-1.5 py-1.5">
              {bar.rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
