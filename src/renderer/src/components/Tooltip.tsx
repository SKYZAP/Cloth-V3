import { cloneElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'

/** Room a tip above its trigger needs below the window's top: the strip there (36px, 52px on macOS) holds the window
 *  controls, which the system draws over the page, plus the tip itself. A trigger closer to the top shows its tip below. */
const TOP_CLEARANCE = 96
/** Gap kept between a tip and the window's left and right edges. */
const EDGE = 8

/** Hover/focus tooltip that scales and fades in above its trigger (below it near the top of the window). */
export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactElement<{ 'aria-label'?: string }>; side?: 'top' | 'left' | 'right' }) {
  // A plain-text tip doubles as the trigger's accessible name when it has none (icon-only buttons).
  const named = typeof content === 'string' && !children.props['aria-label'] ? cloneElement(children, { 'aria-label': content }) : children
  const ref = useRef<HTMLSpanElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; place: 'top' | 'bottom' | 'left' | 'right' } | null>(null)
  const [shift, setShift] = useState(0)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setShift(0)
    if (side === 'right') setPos({ x: r.right, y: r.top + r.height / 2, place: 'right' })
    else if (side === 'left') setPos({ x: r.left, y: r.top + r.height / 2, place: 'left' })
    else if (r.top < TOP_CLEARANCE) setPos({ x: r.left + r.width / 2, y: r.bottom, place: 'bottom' })
    else setPos({ x: r.left + r.width / 2, y: r.top, place: 'top' })
  }
  // A centred tip near a side of the window slides inward to stay whole.
  useLayoutEffect(() => {
    if (!pos || (pos.place !== 'top' && pos.place !== 'bottom') || !tip.current) return
    const w = tip.current.offsetWidth
    const left = pos.x - w / 2
    const over = left + w - (window.innerWidth - EDGE)
    setShift(over > 0 ? -over : left < EDGE ? EDGE - left : 0)
  }, [pos])
  const hide = () => setPos(null)
  return (
    <span ref={ref} className="inline-flex" onPointerEnter={(e) => e.pointerType === 'mouse' && show()} onPointerLeave={hide} onFocus={(e) => (e.target as HTMLElement).matches(':focus-visible') && show()} onBlur={hide} onPointerDown={hide}>
      {named}
      {createPortal(
        <AnimatePresence>
          {pos && (
            <motion.div
              key="tip"
              ref={tip}
              initial={{ opacity: 0, scale: 0.92, ...(pos.place === 'top' ? { y: 4 } : pos.place === 'bottom' ? { y: -4 } : { x: pos.place === 'right' ? -4 : 4 }) }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              className={clsx('pointer-events-none fixed z-[80] whitespace-nowrap rounded-[10px] border border-line-strong bg-[#1f1f24] px-2.5 py-1.5 text-caption shadow-xl shadow-black/50', pos.place === 'top' || pos.place === 'bottom' ? '-translate-x-1/2' : pos.place === 'left' ? '-translate-x-full -translate-y-1/2' : '-translate-y-1/2')}
              style={
                pos.place === 'right'
                  ? { left: pos.x + 10, top: pos.y, transformOrigin: 'left center' }
                  : pos.place === 'left'
                    ? { left: pos.x - 10, top: pos.y, transformOrigin: 'right center' }
                    : pos.place === 'bottom'
                      ? { left: pos.x + shift, top: pos.y + 10, transformOrigin: 'top center' }
                      : { left: pos.x + shift, top: pos.y - 10, translateY: '-100%', transformOrigin: 'bottom center' }
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
