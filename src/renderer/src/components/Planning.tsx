import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretDown, CheckCircle, Circle, CircleNotch, ListChecks } from '@phosphor-icons/react'
import type { ContextSliceKey, ContextUsage, TodoItem, UiMessage } from '@shared/types'
import { compact } from '@/lib/format'

/** The todos from the most recent todo_write call in the (non-archived) conversation. */
export function latestTodos(messages: UiMessage[]): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.archived) break
    for (let j = m.blocks.length - 1; j >= 0; j--) {
      const b = m.blocks[j]
      if (b.type === 'tool' && b.trace.name === 'todo_write' && b.trace.status !== 'error') return todosOf(b.trace.args)
    }
  }
  return null
}

export function todosOf(args: unknown): TodoItem[] {
  const list = (args as { todos?: unknown })?.todos
  return Array.isArray(list) ? list.filter((t): t is TodoItem => !!t && typeof (t as TodoItem).content === 'string') : []
}

export function TodoList({ todos, dense }: { todos: TodoItem[]; dense?: boolean }) {
  return (
    <ul className={clsx('space-y-0.5', dense && 'text-[12.5px]')}>
      <AnimatePresence initial={false}>
        {todos.map((t, i) => (
          <motion.li
            key={`${i}-${t.content}`}
            layout
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.03, type: 'spring', stiffness: 420, damping: 30 }}
            className="flex items-start gap-2 py-0.5"
          >
            <span className="mt-[3px] flex shrink-0">
              {t.status === 'completed' ? (
                <motion.span key="done" initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 15 }}>
                  <CheckCircle size={15} weight="fill" className="text-ok" />
                </motion.span>
              ) : t.status === 'in_progress' ? (
                <CircleNotch size={15} className="animate-spin text-crimson-hi" />
              ) : (
                <Circle size={15} className="text-dim" />
              )}
            </span>
            <span className={clsx('leading-snug', t.status === 'completed' ? 'text-dim line-through decoration-line-strong' : t.status === 'in_progress' ? 'font-medium text-fg' : 'text-muted')}>{t.content}</span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}

/** Pinned above the composer while a plan is being worked through. */
export function PlanPanel({ todos }: { todos: TodoItem[] }) {
  const [open, setOpen] = useState(true)
  const done = todos.filter((t) => t.status === 'completed').length
  const current = todos.find((t) => t.status === 'in_progress')
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      className="pointer-events-auto mx-auto mb-2 w-[min(740px,calc(100%-64px))] overflow-hidden mobile:w-[calc(100%-20px)] rounded-[16px] border border-line bg-panel/95 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)] backdrop-blur"
    >
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left">
        <ListChecks size={15} className="text-crimson-hi" />
        <span className="text-[12px] font-semibold">Plan</span>
        <span className="font-mono text-[11px] text-dim">
          {done}/{todos.length}
        </span>
        <div className="mx-1 h-1 w-24 overflow-hidden rounded-full bg-elev-2">
          <motion.div className="h-full rounded-full bg-crimson" animate={{ width: `${todos.length ? (done / todos.length) * 100 : 0}%` }} transition={{ type: 'spring', stiffness: 200, damping: 28 }} />
        </div>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{!open && current ? current.content : ''}</span>
        <motion.span animate={{ rotate: open ? 0 : -90 }} className="flex text-dim">
          <CaretDown size={13} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 32 }} className="overflow-hidden">
            <div className="max-h-44 overflow-y-auto px-3.5 pb-2.5">
              <TodoList todos={todos} dense />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

const SLICE_COLOR: Record<ContextSliceKey, string> = {
  system: '#8b8b95',
  tools: '#6b9cf0',
  skills: '#e0a43a',
  summary: '#c084fc',
  user: '#3fb97a',
  assistant: '#dc2645',
  toolResults: '#fb923c'
}

const pctOf = (n: number, of: number) => {
  const p = of ? (n / of) * 100 : 0
  // One decimal below 10% so small parts stay distinguishable and parts add up to the total.
  if (p > 0 && p < 0.1) return '<0.1%'
  return p < 10 ? `${p.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(p)}%`
}

/** Segmented bar of the context window (what the tokens are spent on); click for the breakdown. */
export function ContextMeter({ usage, busy, onCompact }: { usage: ContextUsage | null; busy: boolean; onCompact(): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  if (!usage?.window) return null
  const window_ = usage.window
  const used = Math.min(usage.tokens, window_)
  const near = usage.threshold ? usage.tokens / usage.threshold : used / window_
  const tone = near >= 0.9 ? 'text-crimson-hi' : near >= 0.7 ? 'text-warn' : 'text-dim'
  const slices = usage.breakdown

  /** `of`: what 100% width represents — the whole window (panel) or just what is used (compact pill). */
  const Bar = ({ className, marker, of = window_ }: { className: string; marker?: boolean; of?: number }) => (
    <div className={clsx('relative flex overflow-hidden rounded-full bg-elev-2', className)}>
      {slices.map((s, i) => (
        <motion.div
          key={s.key}
          className="h-full"
          style={{ background: SLICE_COLOR[s.key] }}
          initial={false}
          animate={{ width: `${(Math.min(s.tokens, of) / of) * 100}%` }}
          transition={{ type: 'spring', stiffness: 160, damping: 26, delay: i * 0.02 }}
        />
      ))}
      {marker && usage.threshold && <div className="absolute inset-y-0 w-px bg-fg/60" style={{ left: `${(usage.threshold / window_) * 100}%` }} title="Summarises automatically here" />}
    </div>
  )

  return (
    <div ref={ref} className="relative mr-2">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            style={{ transformOrigin: 'bottom right' }}
            className="absolute bottom-full right-0 z-40 mb-2.5 w-[320px] rounded-[16px] mobile:-right-12 mobile:w-[min(320px,calc(100vw-20px))] border border-line-strong bg-panel p-3.5 shadow-[0_16px_44px_-12px_rgb(0_0_0/0.8)]"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[12.5px] font-semibold">Context</span>
              <span className="font-mono text-[11px] tabular-nums text-muted" title={usage.estimated ? "Estimated — the provider doesn't report this model's context size" : undefined}>
                {compact(usage.tokens)} / {usage.estimated ? '≈' : ''}
                {compact(window_)}
              </span>
              {usage.estimated && <span className="text-[10.5px] text-dim">estimated</span>}
              <div className="flex-1" />
              <span className={clsx('font-mono text-[11px] tabular-nums', tone)}>{pctOf(usage.tokens, window_)} used</span>
            </div>
            <Bar className="mt-2.5 h-2.5" marker />
            <div className="mt-3 space-y-1">
              {slices.map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-[12px]">
                  <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: SLICE_COLOR[s.key] }} />
                  <span className="flex-1 text-muted">{s.label}</span>
                  <span className="font-mono text-[11px] tabular-nums text-dim">{compact(s.tokens)}</span>
                  <span className="w-12 text-right font-mono text-[11px] tabular-nums text-muted" title={`${pctOf(s.tokens, usage.tokens)} of what is used`}>
                    {pctOf(s.tokens, window_)}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 text-[12px]">
                <span className="h-2 w-2 shrink-0 rounded-[3px] border border-line-strong bg-elev-2" />
                <span className="flex-1 text-dim">Free</span>
                <span className="font-mono text-[11px] tabular-nums text-dim">{compact(Math.max(0, window_ - usage.tokens))}</span>
                <span className="w-12 text-right font-mono text-[11px] tabular-nums text-dim">{pctOf(Math.max(0, window_ - usage.tokens), window_)}</span>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5">
              <span className="flex-1 text-[11px] leading-snug text-dim">
                {usage.threshold ? `Older messages are summarised automatically at ${compact(usage.threshold)}.` : 'Summarise older messages to free up space.'} Shares are estimates.
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  setOpen(false)
                  onCompact()
                }}
                className="h-7 shrink-0 rounded-lg border border-line-strong px-2.5 text-[11.5px] font-medium text-muted transition-colors hover:border-crimson-line hover:text-fg disabled:opacity-50"
              >
                Summarise now
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        onClick={() => setOpen(!open)}
        aria-label="Context usage"
        title="Context window: how full it is and what fills it"
        aria-expanded={open}
        className={clsx('flex h-[30px] items-center gap-2 rounded-full border px-2.5 transition-colors', open ? 'border-line-strong bg-elev-2' : 'border-line hover:border-line-strong')}
      >
        {busy ? <CircleNotch size={12} className="animate-spin text-crimson-hi" /> : <Bar className="h-1.5 w-24 mobile:w-10" />}
        <span className={clsx('font-mono text-[11px] tabular-nums', busy ? 'text-dim' : tone)}>{busy ? 'summarising' : pctOf(usage.tokens, window_)}</span>
      </button>
    </div>
  )
}
