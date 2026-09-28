import { useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretDown, CheckCircle, Circle, CircleNotch, ListChecks } from '@phosphor-icons/react'
import type { ContextUsage, TodoItem, UiMessage } from '@shared/types'
import { compact } from '@/lib/format'
import { Tooltip } from './Tooltip'

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
      className="pointer-events-auto mx-auto mb-2 w-[min(740px,calc(100%-64px))] overflow-hidden rounded-[16px] border border-line bg-panel/95 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)] backdrop-blur"
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

/** Ring showing how full the model's context is; click to summarise now. */
export function ContextMeter({ usage, busy, onCompact }: { usage: ContextUsage | null; busy: boolean; onCompact(): void }) {
  if (!usage?.window) return null
  const frac = Math.min(1, usage.tokens / usage.window)
  const near = usage.threshold ? usage.tokens / usage.threshold : frac
  const color = near >= 0.9 ? '#dc2645' : near >= 0.7 ? '#e0a43a' : '#a3a3ad'
  const pct = Math.round(frac * 100)
  const r = 6
  return (
    <Tooltip
      content={
        <span>
          <b className="font-semibold">Context</b> {compact(usage.tokens)} / {compact(usage.window)} tokens
          {usage.threshold ? <span className="text-dim"> · summarises at {compact(usage.threshold)}</span> : null}
          <span className="block text-dim">Click to summarise earlier messages now</span>
        </span>
      }
    >
      {/* A filled pie (not a thin arc) plus the percentage, so it reads as a gauge rather than a spinner. */}
      <button
        onClick={onCompact}
        disabled={busy}
        aria-label="Summarise conversation"
        className="mr-2 flex h-[30px] items-center gap-1.5 rounded-full border border-line px-2.5 font-mono text-[11px] tabular-nums text-dim transition-colors hover:border-line-strong hover:text-muted disabled:opacity-60"
      >
        {busy ? (
          <CircleNotch size={13} className="animate-spin text-crimson-hi" />
        ) : (
          <svg width={14} height={14} viewBox="0 0 14 14" className="-rotate-90">
            <circle cx={7} cy={7} r={r} fill="var(--color-elev-2)" stroke="var(--color-line-strong)" strokeWidth={1} />
            <motion.circle
              cx={7}
              cy={7}
              r={r / 2}
              fill="none"
              stroke={color}
              strokeWidth={r}
              strokeDasharray={Math.PI * r}
              animate={{ strokeDashoffset: Math.PI * r * (1 - Math.max(frac, 0.02)) }}
              transition={{ type: 'spring', stiffness: 120, damping: 24 }}
            />
          </svg>
        )}
        {busy ? 'summarising' : `${pct < 1 && usage.tokens > 0 ? '<1' : pct}%`}
      </button>
    </Tooltip>
  )
}
