import { cloneElement, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'

/** Hover/focus tooltip that scales and fades in above its trigger. */
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactElement<{ 'aria-label'?: string }>; side?: 'top' | 'left' | 'right' }) {
  // A plain-text tip doubles as the trigger's accessible name when it has none (icon-only buttons).
  const named = typeof content === 'string' && !children.props['aria-label'] ? cloneElement(children, { 'aria-label': content }) : children
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    if (side === 'right') setPos({ x: r.right, y: r.top + r.height / 2 })
    else if (side === 'left') setPos({ x: r.left, y: r.top + r.height / 2 })
    else setPos({ x: r.left + r.width / 2, y: r.top })
  }
  const hide = () => setPos(null)
  return (
    <span ref={ref} className="inline-flex" onPointerEnter={(e) => e.pointerType === 'mouse' && show()} onPointerLeave={hide} onFocus={(e) => (e.target as HTMLElement).matches(':focus-visible') && show()} onBlur={hide} onPointerDown={hide}>
      {named}
      {createPortal(
        <AnimatePresence>
          {pos && (
            <motion.div
              key="tip"
              initial={{ opacity: 0, scale: 0.92, ...(side === 'top' ? { y: 4 } : { x: side === 'right' ? -4 : 4 }) }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              className={clsx('pointer-events-none fixed z-[80] whitespace-nowrap rounded-[10px] border border-line-strong bg-[#1f1f24] px-2.5 py-1.5 text-caption shadow-xl shadow-black/50', side === 'top' ? '-translate-x-1/2' : side === 'left' ? '-translate-x-full -translate-y-1/2' : '-translate-y-1/2')}
              style={
                side === 'right'
                  ? { left: pos.x + 10, top: pos.y, transformOrigin: 'left center' }
                  : side === 'left'
                    ? { left: pos.x - 10, top: pos.y, transformOrigin: 'right center' }
                    : { left: pos.x, top: pos.y - 10, translateY: '-100%', transformOrigin: 'bottom center' }
              }
            >
              {content}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </span>
  )
}
