import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowCounterClockwise, Brain, CaretRight, CircleNotch, Wrench } from '@phosphor-icons/react'
import type { ToolTrace, UiBlock } from '@shared/types'
import { duration } from '@/lib/format'
import { activityStats, changedFiles, elapsed } from '@/lib/activity'
import { describeTools, ICONS, ToolTraceCard, toolVerb } from './ToolTrace'

const EASE = [0.32, 0.72, 0, 1] as const

const lowerFirst = (s: string) => s && s[0].toLowerCase() + s.slice(1)

/** A stretch of thinking and tool calls, folded into one quiet line that opens into a slim timeline. */
export function ActivityGroup({
  blocks,
  live,
  fresh,
  awaiting,
  onUndo
}: {
  blocks: UiBlock[]
  /** The turn is streaming and this is its last item: show the current step in place of the summary. */
  live: boolean
  fresh?: boolean
  awaiting: Set<string>
  onUndo?(toolCallId: string): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Set<string>>(new Set())
  const traces = useMemo(() => blocks.flatMap((b) => (b.type === 'tool' ? [b.trace] : [])), [blocks])
  const stats = useMemo(() => activityStats(traces), [traces])
  // Nothing that needs the person stays hidden.
  const waiting = traces.some((t) => awaiting.has(t.id))
  const shown = open || waiting
  const toggleRow = (id: string) =>
    setRows((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const caret = (
    <motion.span animate={{ rotate: shown ? 90 : 0 }} transition={{ duration: 0.18, ease: EASE }} className="flex shrink-0">
      <CaretRight size={11} />
    </motion.span>
  )

  return (
    <motion.div initial={fresh ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 28 }} className="mb-3.5 mt-0.5">
      {live ? (
        <LiveLine last={blocks[blocks.length - 1]} open={shown} onToggle={() => setOpen(!open)} />
      ) : (
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={shown}
          className="-ml-1 inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-[3px] text-left text-ui text-dim transition-colors hover:bg-panel hover:text-muted"
        >
          {caret}
          <span className="min-w-0 truncate">
            {!traces.length ? (
              'Thought it through'
            ) : stats.ms > 0 ? (
              <>
                Worked for {duration(stats.ms)}
                <span aria-hidden="true"> · </span>
                {lowerFirst(describeTools(traces))}
              </>
            ) : (
              describeTools(traces)
            )}
          </span>
          {stats.changed && (
            <span className="shrink-0 font-mono text-caption">
              <span className="text-ok">+{stats.added}</span> <span className="text-danger-hi">-{stats.removed}</span>
            </span>
          )}
        </button>
      )}
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="overflow-hidden">
            <div className="my-1.5 ml-1.5 border-l border-line pl-4">
              {blocks.map((b, i) =>
                b.type === 'thinking' ? (
                  <ThinkingRow key={`think:${i}`} text={b.text} />
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
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** The step in progress, updated in place, with a timer since the group started. */
function LiveLine({ last, open, onToggle }: { last: UiBlock | undefined; open: boolean; onToggle(): void }) {
  const [start] = useState(() => Date.now())
  const [now, setNow] = useState(start)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const step = last?.type === 'tool' && last.trace.status === 'running' ? toolVerb(last.trace) : null
  return (
    <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-[9px] text-left text-ui text-muted">
      <span aria-hidden className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-crimson-hi motion-reduce:animate-none" />
      <span aria-live="polite" className="flex min-w-0 items-center gap-[9px]">
        {step ? (
          <>
            <span className="shrink-0">{step.verb}</span>
            <span className="min-w-0 truncate font-mono text-caption text-dim">{step.target}</span>
          </>
        ) : (
          <span className="shimmer-text">{last?.type === 'thinking' ? 'Thinking' : 'Working'}</span>
        )}
      </span>
      <span className="ml-auto shrink-0 font-mono text-caption text-dim">{elapsed(now - start)}</span>
    </button>
  )
}

/** Reasoning summaries arrive as Markdown ("**Title**\n\n…"): plain text reads better in the timeline. */
const plainThought = (text: string) =>
  text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .split('\n')
    .filter((l) => !/^\s*(\.{3}|…)?\s*$/.test(l))
    .join('\n')

export function ThinkingRow({ text: raw }: { text: string }) {
  const text = useMemo(() => plainThought(raw), [raw])
  const [full, setFull] = useState(false)
  const toggle = () => {
    // Selecting text should not fold it.
    if (window.getSelection()?.toString()) return
    setFull(!full)
  }
  return (
    <div className="-ml-1.5 grid grid-cols-[16px_minmax(0,1fr)] gap-2.5 px-1.5 py-1 text-ui">
      <span className="mt-[4px] flex text-dim">
        <Brain size={13} />
      </span>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={full}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setFull(!full)
          }
        }}
        className={clsx('selectable cursor-pointer whitespace-pre-wrap italic text-dim', !full && 'line-clamp-2')}
      >
        {text}
      </div>
    </div>
  )
}

export function ToolRow({ trace, open, awaiting, onToggle }: { trace: ToolTrace; open: boolean; awaiting: boolean; onToggle(): void }) {
  const Icon = ICONS[trace.name] ?? Wrench
  const { verb, target } = toolVerb(trace)
  const failed = trace.status === 'error'
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={clsx('-ml-1.5 grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-2.5 rounded-[7px] px-1.5 py-1 text-left text-ui text-muted transition-colors hover:bg-panel', open && 'bg-panel')}
    >
      <span className={clsx('flex self-center', failed ? 'text-danger-hi' : 'text-dim')}>
        <Icon size={13} />
      </span>
      <span className="min-w-0 truncate">
        <span className="font-medium text-fg">{verb}</span> <span className="font-mono text-caption text-dim">{target}</span>
      </span>
      {awaiting ? (
        <span className="self-center rounded-full bg-warn/10 px-2 py-px text-micro text-warn">{trace.name === 'ask_user' ? 'waiting for you' : 'awaiting approval'}</span>
      ) : trace.status === 'running' ? (
        <CircleNotch size={12} className="self-center animate-spin text-dim motion-reduce:animate-none" />
      ) : (
        <span className={clsx('font-mono text-caption', failed ? 'text-danger-hi' : 'text-dim')}>
          {failed ? `failed${trace.durationMs !== null ? ` · ${duration(trace.durationMs)}` : ''}` : duration(trace.durationMs)}
        </span>
      )}
    </button>
  )
}

/** Every file a finished turn changed, with line counts and one Undo for the lot. */
export function ChangedFiles({ traces, onUndo }: { traces: ToolTrace[]; onUndo?(toolCallId: string): Promise<void> }) {
  const { files, added, removed, undoable } = useMemo(() => changedFiles(traces), [traces])
  const [busy, setBusy] = useState(false)
  if (!files.length) return null
  // Newest first: a checkpoint only restores a file nothing changed since.
  const undoAll = async () => {
    if (!onUndo) return
    setBusy(true)
    try {
      for (const id of undoable) await onUndo(id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mb-2.5 mt-1.5 overflow-hidden rounded-[12px] border border-line">
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2 text-ui text-dim">
        <b className="font-semibold text-fg">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </b>
        <span className="font-mono text-ok">+{added}</span>
        <span className="font-mono text-danger-hi">-{removed}</span>
        {onUndo && undoable.length > 0 ? (
          <button
            disabled={busy}
            onClick={() => void undoAll()}
            title="Restore every file as it was before this reply"
            className="ml-auto flex items-center gap-1 text-caption text-dim transition-colors hover:text-fg disabled:opacity-50"
          >
            <ArrowCounterClockwise size={12} />
            Undo all
          </button>
        ) : (
          !undoable.length && <span className="ml-auto text-caption text-dim">undone</span>
        )}
      </div>
      {files.map((f, i) => (
        <div key={f.path} className={clsx('flex items-center gap-2.5 px-3 py-[7px] text-ui', i > 0 && 'border-t border-line', f.undone && 'line-through opacity-50')}>
          <span className="min-w-0 truncate font-mono text-caption" title={f.path}>
            {f.path}
          </span>
          <span className="ml-auto shrink-0 font-mono text-caption">
            <span className="text-ok">+{f.added}</span> <span className="text-danger-hi">-{f.removed}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
