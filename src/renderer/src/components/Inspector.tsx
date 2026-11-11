import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { X } from '@phosphor-icons/react'
import { isMobile } from '@/lib/platform'

/**
 * A panel from the right over a page's overview (full screen on a phone): details open beside what you
 * were looking at instead of replacing it. Takes focus when it opens and closes on Escape or a click
 * outside; the page returns focus to whatever opened it.
 */
export function Inspector({ open, label, onClose, width = 820, children }: { open: boolean; label: string; onClose(): void; width?: number; children: ReactNode }) {
  return (
    <AnimatePresence>
      {open && <motion.div key="backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="absolute inset-0 z-20 bg-black/40" onClick={onClose} aria-hidden="true" />}
      {open && (
        <Panel key="panel" label={label} onClose={onClose} width={width}>
          {children}
        </Panel>
      )}
    </AnimatePresence>
  )
}

function Panel({ label, onClose, width, children }: { label: string; onClose(): void; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modal opened from inside the panel handles its own Escape.
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <motion.div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 24, opacity: 0, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 40 }}
      style={isMobile ? undefined : { width: `min(${width}px, calc(100% - 120px))` }}
      className={clsx('absolute inset-y-0 right-0 z-30 flex flex-col border-l border-line-strong bg-bg shadow-[-24px_0_60px_-20px_rgb(0_0_0/0.8)] outline-none', isMobile && 'left-0')}
    >
      {children}
    </motion.div>
  )
}

/** Returns focus to the element marked `data-focus-key={key}` after an inspector closes. */
export function refocus(key: string | null): void {
  if (!key) return
  requestAnimationFrame(() => (document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus())
}

/** Title row of an inspector: a heading, optional actions, and Close. */
export function InspectorHead({ title, sub, actions, onClose }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; onClose(): void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-section font-semibold">{title}</h2>
        {sub && <div className="truncate text-caption text-dim">{sub}</div>}
      </div>
      {actions}
      <button onClick={onClose} aria-label="Close" title="Close (Esc)" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg">
        <X size={15} />
      </button>
    </div>
  )
}
