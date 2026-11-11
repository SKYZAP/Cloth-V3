import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretDown, CaretRight, CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react'
import type { SpecWorkflow, WorkflowStage } from '@shared/types'
import { routeStages } from '@shared/types'
import { formatCost } from '@/lib/format'
import type { StageItem, StageRecord } from '@/lib/stages'
import { RouteBadge, STAGE_LABEL, STAGE_YOU } from '@/pages/chat/Workflow'
import { barSegments, runCardId, shortfall, type BarRow, type RunInfo, type StepStatus, type WorkBar as Bar } from '@/lib/workbar'

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

/** The run's name: the saved agent, else Explorer or Builder (the effort is in the Agents tab). */
export const runLabel = (r: RunInfo) => r.name

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'completed') return <CheckCircle size={14} weight="fill" className="text-ok" />
  if (status === 'in_progress') return <span className="mx-[3px] h-2 w-2 animate-pulse rounded-full bg-warn" />
  if (status === 'failed') return <WarningCircle size={14} weight="fill" className="text-danger-hi" />
  return <Circle size={14} className="text-dim" />
}

function Row({ row }: { row: BarRow }) {
  const run = row.run
  const short = run ? shortfall(run) : null
  const body = (
    <>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {short && row.status === 'completed' ? (
          <span className={clsx('mx-[3px] h-2 w-2 rounded-full', run?.outcome === 'partial' ? 'bg-warn' : 'bg-danger')} aria-label={short} />
        ) : (
          <StatusIcon status={row.status} />
        )}
      </span>
      <span className={clsx('min-w-0 flex-1 truncate', row.status === 'completed' ? 'text-muted' : row.status === 'in_progress' ? 'text-fg' : 'text-dim')}>
        {row.n !== undefined && <span className="mr-1.5 font-mono text-caption text-dim">{row.n}</span>}
        {row.text}
        {run?.current && (
          <span className="ml-2 text-dim">
            {run.current.tool} {run.current.summary}…
          </span>
        )}
      </span>
      {run ? (
        <span className="flex shrink-0 items-center gap-2 text-caption">
          {row.runs > 1 && <span className="text-dim">{row.runs} runs</span>}
          <span className="rounded-full bg-agent-soft px-1.5 py-px text-agent">{runLabel(run)}</span>
          {short && <span className={clsx('text-micro', run.outcome === 'partial' ? 'text-warn' : 'text-danger-hi')}>{short}</span>}
          {run.cost > 0 && <span className="font-mono text-dim">{formatCost(run.cost)}</span>}
        </span>
      ) : (
        row.n !== undefined && row.status !== 'pending' && <span className="shrink-0 text-caption text-dim">Cloth</span>
      )}
    </>
  )
  const cls = 'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-caption'
  return run ? (
    <button onClick={() => scrollToRun(run.cardId)} className={clsx(cls, 'transition-colors hover:bg-elev-2')} title="Show this run">
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

const TONE = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger-hi' } as const

/** One line under a finished stage: a round, an agent run, a step or a line of the stage's summary. */
function ItemRow({ item }: { item: StageItem }) {
  const body = (
    <>
      <span className="min-w-0 flex-1 truncate text-muted">{item.text}</span>
      {item.note && <span className={clsx('max-w-[45%] shrink-0 truncate text-caption', item.tone ? TONE[item.tone] : 'text-dim')}>{item.note}</span>}
      {!!item.cost && <span className="shrink-0 font-mono text-caption tabular-nums text-dim">{formatCost(item.cost)}</span>}
    </>
  )
  const cls = 'flex w-full items-center gap-2 rounded-md px-1.5 py-[3px] text-left text-caption'
  return item.cardId ? (
    <button onClick={() => scrollToRun(item.cardId!)} className={clsx(cls, 'transition-colors hover:bg-elev-2')} title="Show this run">
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  )
}

/** A stage in the Spec → Ship list: a row that opens to what the stage did (the current one opens to its live steps). */
function StageRow({ n, stage, status, record, live, note }: { n: number; stage: Exclude<WorkflowStage, 'done'>; status: StepStatus; record?: StageRecord; live: Bar | null; note: string }) {
  const current = status === 'in_progress'
  const items = record?.items ?? []
  const files = record?.files ?? []
  const canOpen = current ? !!live?.rows.length || items.length > 0 : items.length > 0 || files.length > 0
  const [open, setOpen] = useState(current)
  // The stage being worked on opens; one that just finished folds away.
  useEffect(() => setOpen(current), [current])
  const shown = open && canOpen
  const summary = [record?.summary, current && live?.mode === 'todos' ? `${live.done} of ${live.total} steps` : ''].filter(Boolean).join(' · ')
  return (
    <div aria-current={current ? 'step' : undefined}>
      <button
        onClick={() => canOpen && setOpen(!open)}
        aria-expanded={canOpen ? shown : undefined}
        disabled={!canOpen}
        className={clsx('grid w-full grid-cols-[12px_18px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1.5 py-1 text-left text-ui', canOpen && 'transition-colors hover:bg-elev-2')}
      >
        <span className="flex text-dim">{canOpen && <CaretRight size={11} className={clsx('transition-transform duration-150', shown && 'rotate-90')} />}</span>
        <StatusIcon status={status} />
        <span className={clsx('min-w-0 truncate', current ? 'text-fg' : status === 'completed' ? 'text-muted' : 'text-dim')}>
          {n} · {STAGE_LABEL[stage]}
          {record?.route && (
            <span className="ml-1.5 align-[1px]">
              <RouteBadge route={record.route} />
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-caption">
          {current && STAGE_YOU[stage] ? <span className="text-warn">needs you</span> : note ? <span className="text-dim">{note}</span> : null}
          {summary && <span className="text-dim mobile:hidden">{summary}</span>}
          {!!record?.cost && <span className="font-mono tabular-nums text-dim">{formatCost(record.cost)}</span>}
        </span>
      </button>
      {shown && (
        <div className="mb-1 ml-[30px] border-l border-line pl-1.5">
          {current && live?.rows.length
            ? live.rows.map((row) => <Row key={row.key} row={row} />)
            : items.map((item) => <ItemRow key={item.key} item={item} />)}
          {!current && files.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1.5 py-1">
              {files.map((f) => (
                <span key={f} title={f} className="max-w-[220px] truncate rounded-md bg-elev-2 px-1.5 py-px font-mono text-micro text-dim">
                  {f.split('/').pop()}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Above this many steps the meter is one continuous bar instead of segments. */
const MAX_SEGMENTS = 12

/** The header's step meter: one segment per step, or a continuous bar for long lists. */
function Meter({ bar }: { bar: Bar }) {
  const segments = barSegments(bar)
  if (!segments.length) return null
  const total = segments.length
  const completed = segments.filter((s) => s === 'completed').length
  const inProgress = segments.filter((s) => s === 'in_progress').length
  const label = `${completed} of ${total} steps done${inProgress ? `, ${inProgress} in progress` : ''}`
  if (total > MAX_SEGMENTS) {
    return (
      <span role="img" aria-label={label} className="flex h-[6px] w-[96px] shrink-0 overflow-hidden rounded-[2px] border border-line-strong bg-elev-2 mobile:hidden">
        <span className="h-full bg-ok transition-[width] duration-300" style={{ width: `${(completed / total) * 100}%` }} />
        <span className="h-full bg-warn transition-[width] duration-300" style={{ width: `${(inProgress / total) * 100}%` }} />
      </span>
    )
  }
  return (
    <span role="img" aria-label={label} className="flex shrink-0 items-center gap-[2px] mobile:hidden">
      {segments.map((s, i) => (
        <span
          key={i}
          className={clsx(
            'box-border h-[6px] w-[14px] rounded-[2px]',
            s === 'completed' ? 'bg-ok' : s === 'failed' ? 'bg-danger' : s === 'in_progress' ? 'animate-pulse bg-warn motion-reduce:animate-none' : 'border border-line-strong bg-transparent'
          )}
        />
      ))}
    </span>
  )
}

/** The current turn's plan and agent runs, pinned above the message box. */
export function WorkBar({
  bar,
  flow,
  stages: records,
  onAutoContinue
}: {
  bar: Bar | null
  flow?: SpecWorkflow | null
  /** What each stage reached so far did and cost (Spec → Ship only). */
  stages?: Partial<Record<WorkflowStage, StageRecord>>
  onAutoContinue?(on: boolean): void
}) {
  const [open, setOpen] = useState(false)
  const stage = flow && flow.stage !== 'done' ? flow.stage : null
  // Only the stages this change's route walks through: Quick has no Spec or Tickets stage.
  const stages = routeStages(flow?.route)
  // An older chat may still be at the Tickets stage, which is part of Spec now.
  const at = stage ? stages.indexOf(stage === 'tickets' ? 'spec' : stage) : -1
  const autoContinue = flow?.autoContinue !== false
  const title = bar ? (bar.mode === 'todos' ? (bar.current ?? 'All steps done') : 'Agents at work') : ''
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="overflow-hidden rounded-[12px] border border-line bg-panel"
    >
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-9 w-full items-center gap-3 px-3 text-left">
        {stage ? (
          <>
            <span className="min-w-0 flex-1 truncate text-ui text-fg">
              <b className="mr-1.5 font-semibold text-mode">Spec → Ship</b>
              {flow?.route && (
                <span className="mr-1.5 align-[1px]">
                  <RouteBadge route={flow.route} />
                </span>
              )}
              {STAGE_LABEL[stage]}
              {STAGE_YOU[stage] ? <span className="text-warn"> · {STAGE_YOU[stage]}</span> : bar?.current ? <span className="text-muted"> · {bar.current}</span> : null}
            </span>
            <span role="img" aria-label={`Stage ${at + 1} of ${stages.length}: ${STAGE_LABEL[stage]}`} className="flex shrink-0 items-center gap-[2px] mobile:hidden">
              {stages.map((s, i) => (
                <span key={s} className={clsx('box-border h-[6px] w-[14px] rounded-[2px]', i < at ? 'bg-ok' : i === at ? 'animate-pulse bg-mode motion-reduce:animate-none' : 'border border-line-strong')} />
              ))}
            </span>
            <span className="shrink-0 font-mono text-caption tabular-nums text-dim">
              {at + 1} of {stages.length}
            </span>
          </>
        ) : (
          bar && (
            <>
              <span className="min-w-0 flex-1 truncate text-ui text-fg">{title}</span>
              <Meter bar={bar} />
              <span className="shrink-0 font-mono text-caption tabular-nums text-dim">{bar.mode === 'todos' ? `${bar.done} of ${bar.total}` : `${bar.runCount} agent${bar.runCount === 1 ? '' : 's'}`}</span>
            </>
          )
        )}
        {bar && bar.cost > 0 && <span className="shrink-0 font-mono text-caption tabular-nums text-dim">{formatCost(bar.cost)}</span>}
        <motion.span animate={{ rotate: open ? 0 : 180 }} transition={{ duration: 0.25 }} className="flex shrink-0 text-dim">
          <CaretDown size={13} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 32 }} className="overflow-hidden">
            <div className="max-h-80 overflow-y-auto px-1.5 py-1.5">
              {stage &&
                stages.map((s, i) => (
                  <StageRow
                    key={s}
                    n={i + 1}
                    stage={s}
                    status={i < at ? 'completed' : i === at ? 'in_progress' : 'pending'}
                    record={i <= at ? records?.[s] : undefined}
                    live={i === at ? bar : null}
                    note={i > at && autoContinue && (s === 'review' || (s === 'build' && (flow?.route === 'quick' || !flow?.approveSpec))) ? 'continues on its own' : ''}
                  />
                ))}
              {stage && onAutoContinue && (
                <label className="mx-1.5 mt-1 flex cursor-pointer items-center gap-2 border-t border-line px-1.5 pb-0.5 pt-2 text-caption text-muted">
                  <input type="checkbox" checked={autoContinue} onChange={(e) => onAutoContinue(e.target.checked)} className="size-[13px] shrink-0 accent-crimson" />
                  Build, check and fix on its own, then report back
                </label>
              )}
              {!stage &&
                bar?.rows.map((row) => (
                  <Row key={row.key} row={row} />
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
