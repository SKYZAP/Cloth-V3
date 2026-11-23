import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle, Circle, CircleNotch } from '@phosphor-icons/react'
import type { ContextSliceKey, ContextUsage, TodoItem } from '@shared/types'
import { compact } from '@/lib/format'

export { todosOf } from '@/lib/activity'

export function TodoList({ todos, dense }: { todos: TodoItem[]; dense?: boolean }) {
  return (
    <ul className={clsx('space-y-0.5', dense && 'text-ui')}>
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
                <CircleNotch size={15} className="animate-spin text-muted" />
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

const SLICE_COLOR: Record<ContextSliceKey, string> = {
  system: '#8b8b95',
  tools: '#6cb2ec',
  skills: '#e0a43a',
  summary: '#c9a3f5',
  user: '#5ccb89',
  assistant: '#cf2845',
  toolResults: '#fb923c'
}

const pctOf = (n: number, of: number) => {
  const p = of ? (n / of) * 100 : 0
  // One decimal below 10% so small parts stay distinguishable and parts add up to the total.
  if (p > 0 && p < 0.1) return '<0.1%'
  return p < 10 ? `${p.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(p)}%`
}

/** Segmented bar of the context window (what the tokens are spent on); click for the breakdown. */
export function ContextMeter({ usage, busy, onCompact, onStrip }: { usage: ContextUsage | null; busy: boolean; onCompact(): void; onStrip(): void }) {
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
  const tone = near >= 0.9 ? 'text-danger-hi' : near >= 0.7 ? 'text-warn' : 'text-dim'
  // Biggest share first, in the list and the bar alike.
  const slices = [...usage.breakdown].sort((a, b) => b.tokens - a.tokens)
  const toolTokens = usage.breakdown.find((s) => s.key === 'toolResults')?.tokens ?? 0

  /** `of`: what 100% width represents — the whole window (panel) or just what is used (compact pill). */
  const Bar = ({ className, marker, of = window_ }: { className: string; marker?: boolean; of?: number }) => (
    <div className={clsx('relative flex overflow-hidden rounded-[3px] border border-line-strong bg-elev-2', className)}>
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
    <div ref={ref} className="relative">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            style={{ transformOrigin: 'bottom right' }}
            className="absolute bottom-full right-0 z-40 mb-2.5 w-[320px] rounded-[14px] mobile:-right-12 mobile:w-[min(320px,calc(100vw-20px))] border border-line-strong bg-panel p-3.5 shadow-[0_16px_44px_-12px_rgb(0_0_0/0.8)]"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-ui font-semibold">Context</span>
              <span className="font-mono text-caption tabular-nums text-muted" title={usage.estimated ? "Estimated — the provider doesn't report this model's context size" : undefined}>
                {compact(usage.tokens)} / {usage.estimated ? '≈' : ''}
                {compact(window_)}
              </span>
              {usage.estimated && <span className="text-micro text-dim">estimated</span>}
              <div className="flex-1" />
              <span className={clsx('font-mono text-caption tabular-nums', tone)}>{pctOf(usage.tokens, window_)} used</span>
            </div>
            <Bar className="mt-2.5 h-2.5" marker />
            <div className="mt-3 space-y-1">
              {slices.map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-caption">
                  <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: SLICE_COLOR[s.key] }} />
                  <span className="flex-1 text-muted">{s.label}</span>
                  <span className="font-mono text-caption tabular-nums text-dim">{compact(s.tokens)}</span>
                  <span className="w-12 text-right font-mono text-caption tabular-nums text-muted" title={`${pctOf(s.tokens, usage.tokens)} of what is used`}>
                    {pctOf(s.tokens, window_)}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 text-caption">
                <span className="h-2 w-2 shrink-0 rounded-[3px] border border-line-strong bg-elev-2" />
                <span className="flex-1 text-dim">Free</span>
                <span className="font-mono text-caption tabular-nums text-dim">{compact(Math.max(0, window_ - usage.tokens))}</span>
                <span className="w-12 text-right font-mono text-caption tabular-nums text-dim">{pctOf(Math.max(0, window_ - usage.tokens), window_)}</span>
              </div>
            </div>
            <div className="mt-3 flex items-start gap-2 border-t border-line pt-2.5">
              <span className="flex-1 text-caption leading-snug text-dim">
                {usage.threshold ? `Older messages are summarised automatically at ${compact(usage.threshold)}.` : 'Summarise older messages to free up space.'} Shares are estimates.
              </span>
              <div className="flex shrink-0 flex-col items-stretch gap-1.5">
                <button
                  disabled={busy}
                  onClick={() => {
                    setOpen(false)
                    onCompact()
                  }}
                  className="h-7 rounded-lg border border-line-strong px-2.5 text-caption font-medium text-muted transition-colors hover:border-crimson-line hover:text-fg disabled:opacity-50"
                >
                  Summarise now
                </button>
                <button
                  disabled={busy || !toolTokens}
                  title="Replace the output of every tool call with a short note for the model. The chat still shows each result."
                  onClick={() => {
                    setOpen(false)
                    onStrip()
                  }}
                  className="h-7 rounded-lg border border-line-strong px-2.5 text-caption font-medium text-muted transition-colors hover:border-crimson-line hover:text-fg disabled:opacity-50"
                >
                  Strip tool calls
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        onClick={() => setOpen(!open)}
        aria-label="Context usage"
        title="Context window: how full it is and what fills it"
        aria-expanded={open}
        className={clsx('flex h-7 items-center gap-2 rounded-lg px-2 transition-colors', open ? 'bg-elev-2' : 'hover:bg-elev')}
      >
        {busy ? <CircleNotch size={12} className="animate-spin text-muted" /> : <Bar className="h-2.5 w-12 @[560px]:w-20 mobile:hidden" />}
        <span className={clsx('font-mono text-caption tabular-nums', busy ? 'text-dim' : tone)}>{busy ? 'summarising' : pctOf(usage.tokens, window_)}</span>
      </button>
    </div>
  )
}
