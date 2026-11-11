import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls } from 'motion/react'
import { createPortal } from 'react-dom'
import { X } from '@phosphor-icons/react'
import { useBackHandler } from '@/lib/back'

/** Vaul-style glide: a long, fully damped tween (same curve as beui's bottom sheet). */
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const
const GLIDE = { duration: 0.5, ease: EASE_DRAWER }
const SHEET_HEIGHT = 0.92
const FLING_DOWN = 600
const FLING_UP = -500
const DISMISS_OFFSET = 120

/**
 * Draggable bottom sheet scoped to its positioned parent (not the whole window): snap points as
 * fractions of the parent's height, elastic drag, fling to switch snaps or dismiss, blurred backdrop.
 * portal lifts it over the whole screen instead, for sheets opened from small controls (a header pill).
 */
export function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  snapPoints = [0.5, SHEET_HEIGHT],
  scrollTo,
  portal
}: {
  open: boolean
  onClose(): void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  snapPoints?: number[]
  /** Element id inside the sheet to scroll to and flash when opened. */
  scrollTo?: string | null
  /** Cover the whole screen (rendered into document.body) rather than the positioned parent. */
  portal?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [visible, setVisible] = useState(open)
  const y = useMotionValue(10_000)
  const anim = useRef<AnimationPlaybackControls | null>(null)
  const drag = useRef<{ startY: number; startSheetY: number; samples: { t: number; y: number }[] } | null>(null)
  useBackHandler(open, onClose)

  const yFor = useCallback((snap: number) => height * (SHEET_HEIGHT - snap), [height])
  const closedY = height * SHEET_HEIGHT + 40
  const backdrop = useTransform(y, (v) => (closedY ? Math.max(0, Math.min(1, 1.6 * (1 - v / closedY))) : 0))

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const glide = useCallback(
    (to: number, done?: () => void) => {
      anim.current?.stop()
      anim.current = animate(y, to, { ...GLIDE, onComplete: done })
    },
    [y]
  )

  useEffect(() => {
    if (!height) return
    if (open) {
      setVisible(true)
      if (y.get() > closedY - 1) y.set(closedY)
      // Open fully; dragging down still stops at the lower snap points before dismissing.
      glide(yFor(snapPoints[snapPoints.length - 1]))
    } else if (visible) {
      glide(closedY, () => setVisible(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, height])

  useEffect(() => {
    if (!open || !scrollTo) return
    const t = setTimeout(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`#${scrollTo}`)
      const body = bodyRef.current
      if (!el || !body) return
      body.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' })
      el.animate([{ backgroundColor: 'rgb(220 38 69 / 0.12)' }, { backgroundColor: 'rgb(220 38 69 / 0)' }], { duration: 1200, delay: 350, easing: 'ease-out' })
    }, 60)
    return () => clearTimeout(t)
  }, [open, scrollTo])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    anim.current?.stop()
    drag.current = { startY: e.clientY, startSheetY: y.get(), samples: [{ t: e.timeStamp, y: e.clientY }] }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    let next = d.startSheetY + (e.clientY - d.startY)
    const top = yFor(snapPoints[snapPoints.length - 1])
    const low = yFor(snapPoints[0])
    if (next < top) next = top + (next - top) * 0.02 // stiff above the highest snap
    if (next > low) next = low + (next - low) * 0.6 // softer pull below the lowest
    y.set(next)
    d.samples.push({ t: e.timeStamp, y: e.clientY })
    if (d.samples.length > 6) d.samples.shift()
  }
  const onPointerUp = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    const a = d.samples[0]
    const b = d.samples[d.samples.length - 1]
    const velocity = ((b.y - a.y) / Math.max(1, b.t - a.t)) * 1000
    const current = y.get()
    if (velocity > FLING_DOWN || current > yFor(snapPoints[0]) + DISMISS_OFFSET) return onClose()
    let target: number
    if (velocity < FLING_UP) target = snapPoints[snapPoints.length - 1]
    else if (velocity > 300) target = snapPoints[0]
    else target = snapPoints.reduce((best, s) => (Math.abs(yFor(s) - current) < Math.abs(yFor(best) - current) ? s : best), snapPoints[0])
    glide(yFor(target))
  }

  const dragProps = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }

  const sheet = (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-40" style={{ pointerEvents: visible ? 'auto' : 'none' }}>
      {visible && (
        <>
          <motion.div className="absolute inset-0 bg-bg/45 backdrop-blur-[3px]" style={{ opacity: backdrop }} onClick={onClose} />
          <motion.section
            role="dialog"
            aria-modal="true"
            className="sheet-glass absolute bottom-0 left-1/2 flex w-[min(780px,calc(100%-32px))] -translate-x-1/2 mobile:w-[calc(100%-12px)] touch-none flex-col rounded-t-[26px] border border-b-0 border-line-strong"
            style={{ height: `${SHEET_HEIGHT * 100}%`, y }}
          >
            <div className="group flex cursor-grab justify-center pb-1 pt-2.5 active:cursor-grabbing" {...dragProps}>
              <div className="h-[5px] w-10 rounded-full bg-[#3a3a42] transition-all duration-300 group-hover:w-12 group-hover:bg-[#55555f]" />
            </div>
            <div className="flex cursor-grab items-center gap-3 px-[22px] pb-3.5 pt-1.5 active:cursor-grabbing" {...dragProps}>
              <div className="min-w-0 flex-1">
                <div className="text-section font-semibold tracking-tight">{title}</div>
                {description && <div className="text-caption text-dim">{description}</div>}
              </div>
              <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg" aria-label="Close">
                <X size={15} />
              </button>
            </div>
            <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-[22px] pb-7 mobile:px-4" style={portal ? { paddingBottom: 'calc(var(--safe-bottom, 0px) + 28px)' } : undefined}>
              {children}
            </div>
          </motion.section>
        </>
      )}
    </div>
  )
  return portal ? createPortal(<div className="pointer-events-none fixed inset-0 z-50">{sheet}</div>, document.body) : sheet
}
