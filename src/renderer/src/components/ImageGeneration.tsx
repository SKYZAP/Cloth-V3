// Adapted from beui.dev/components/agents/image-generation (Saurabh) — themed for Cloth:
// Cloth colour tokens, clsx instead of tailwind-merge, Phosphor icons.
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowCounterClockwise, Check, WarningCircle } from '@phosphor-icons/react'

export type ImageGenerationStatus = 'queued' | 'generating' | 'refining' | 'complete' | 'error'

export interface ImageGenerationProps {
  /** The completed media (img, canvas, video…). */
  children?: ReactNode
  status?: ImageGenerationStatus
  label?: string
  prompt?: string
  resolution?: string
  /** CSS aspect ratio reserved before the media is available. */
  aspectRatio?: CSSProperties['aspectRatio']
  size?: 'compact' | 'fluid'
  /** Lets the active dither cluster follow the pointer. */
  interactive?: boolean
  statusText?: string
  showStatus?: boolean
  onRetry?: () => void
  className?: string
  mediaClassName?: string
  statusClassName?: string
  /** Extra controls shown on the status row (e.g. Open / Save). */
  actions?: ReactNode
}

const EASE_OUT = [0.16, 1, 0.3, 1] as const
const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const
const SPRING_PRESS = { type: 'spring', stiffness: 500, damping: 30, mass: 0.6 } as const

const STATUS_TEXT: Record<ImageGenerationStatus, string> = {
  queued: 'Waiting to generate',
  generating: 'Generating image',
  refining: 'Refining details',
  complete: 'Image ready',
  error: 'Generation failed'
}

const MEDIA_STATE: Record<ImageGenerationStatus, { filter: string; opacity: number; scale: number }> = {
  queued: { filter: 'blur(4px) saturate(0.75)', opacity: 0, scale: 1.02 },
  generating: { filter: 'blur(3px) saturate(0.85)', opacity: 0, scale: 1.015 },
  refining: { filter: 'blur(1.5px) saturate(0.95)', opacity: 0.62, scale: 1.005 },
  complete: { filter: 'blur(0px) saturate(1)', opacity: 1, scale: 1 },
  error: { filter: 'blur(2px) saturate(0.5)', opacity: 0.28, scale: 1 }
}

const OVERLAY_OPACITY: Record<ImageGenerationStatus, number> = { queued: 1, generating: 1, refining: 0.48, complete: 0, error: 0 }

const DOT_GAP = 10
const TWO_PI = Math.PI * 2

function useHoverCapable(): boolean {
  const [canHover, setCanHover] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(hover: hover) and (pointer: fine)')
    if (!mq) return
    const update = () => setCanHover(mq.matches)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])
  return canHover
}

function DitherMark({ status, reduce }: { status: ImageGenerationStatus; reduce: boolean }) {
  if (status === 'complete') return <Check aria-hidden="true" size={14} weight="bold" className="text-ok" />
  if (status === 'error') return <WarningCircle aria-hidden="true" size={14} weight="fill" />
  return (
    <motion.span
      aria-hidden="true"
      animate={reduce ? undefined : { rotate: 360 }}
      transition={{ duration: 2.4, ease: EASE_IN_OUT, repeat: Number.POSITIVE_INFINITY }}
      className="grid size-3.5 grid-cols-2 place-items-center gap-0.5 text-crimson-hi"
    >
      <span className="size-1 rounded-[1px] bg-current" />
      <span className="size-1 rounded-[1px] bg-current opacity-55" />
      <span className="size-1 rounded-[1px] bg-current opacity-55" />
      <span className="size-1 rounded-[1px] bg-current" />
    </motion.span>
  )
}

function DitherField({ interactive, reduce, status }: { interactive: boolean; reduce: boolean; status: ImageGenerationStatus }) {
  const canHover = useHoverCapable()
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let frame = 0
    let width = 0
    let height = 0
    let dotColor = 'currentColor'
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, inside: false }
    const pointerEnabled = interactive && canHover && !reduce

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width || canvas.clientWidth || 208
      height = rect.height || canvas.clientHeight || 208
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      dotColor = window.getComputedStyle(canvas).color
      pointer.x = width / 2
      pointer.y = height / 2
      pointer.targetX = pointer.x
      pointer.targetY = pointer.y
    }

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height)
      if (!pointer.inside) {
        pointer.targetX = width / 2 + (reduce ? 0 : Math.sin(time / 1700) * width * 0.12)
        pointer.targetY = height / 2 + (reduce ? 0 : Math.cos(time / 2100) * height * 0.1)
      }
      const follow = reduce ? 1 : pointer.inside ? 0.16 : 0.045
      pointer.x += (pointer.targetX - pointer.x) * follow
      pointer.y += (pointer.targetY - pointer.y) * follow
      const radius = Math.min(width, height) * 0.38
      const columns = Math.ceil(width / DOT_GAP) + 1
      const rows = Math.ceil(height / DOT_GAP) + 1
      const offsetX = (width - (columns - 1) * DOT_GAP) / 2
      const offsetY = (height - (rows - 1) * DOT_GAP) / 2
      context.fillStyle = dotColor
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const anchorX = offsetX + column * DOT_GAP
          const anchorY = offsetY + row * DOT_GAP
          const deltaX = anchorX - pointer.x
          const deltaY = anchorY - pointer.y
          const distance = Math.hypot(deltaX, deltaY)
          const proximity = Math.max(0, 1 - distance / radius)
          const influence = proximity * proximity * (3 - 2 * proximity)
          const displacement = influence * influence * 9
          const directionX = distance > 0 ? deltaX / distance : 0
          const directionY = distance > 0 ? deltaY / distance : 0
          context.globalAlpha = 0.17 + influence * 0.72
          context.beginPath()
          context.arc(anchorX + directionX * displacement, anchorY + directionY * displacement, 0.65 + influence * 0.85, 0, TWO_PI)
          context.fill()
        }
      }
      context.globalAlpha = 1
      if (!reduce) frame = window.requestAnimationFrame(draw)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerEnabled) return
      const rect = canvas.getBoundingClientRect()
      pointer.inside = true
      pointer.targetX = event.clientX - rect.left
      pointer.targetY = event.clientY - rect.top
    }
    const handlePointerLeave = () => {
      pointer.inside = false
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    resize()
    resizeObserver?.observe(canvas)
    canvas.addEventListener('pointermove', handlePointerMove, { passive: true })
    canvas.addEventListener('pointerleave', handlePointerLeave)
    draw(0)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerleave', handlePointerLeave)
    }
  }, [canHover, interactive, reduce])

  return (
    <motion.div
      aria-hidden="true"
      initial={false}
      animate={{ opacity: OVERLAY_OPACITY[status] }}
      transition={{ duration: reduce ? 0 : 0.4, ease: EASE_OUT }}
      className="absolute inset-0 overflow-hidden bg-elev-2"
    >
      {/* Crimson dots on the dark field, in Cloth's accent. */}
      <canvas ref={canvasRef} className="absolute inset-0 size-full text-crimson-hi" />
    </motion.div>
  )
}

export function ImageGeneration({
  children,
  status = 'generating',
  label,
  prompt,
  resolution = '1024 × 1024',
  aspectRatio = '1 / 1',
  size = 'compact',
  interactive = true,
  statusText,
  showStatus = true,
  onRetry,
  className,
  mediaClassName,
  statusClassName,
  actions
}: ImageGenerationProps) {
  const reduce = useReducedMotion() ?? false
  const active = status === 'queued' || status === 'generating' || status === 'refining'
  const mediaState = MEDIA_STATE[status]
  const resolvedStatusText = statusText ?? STATUS_TEXT[status]
  const resolvedLabel = label ?? (prompt ? `${resolvedStatusText}: ${prompt}` : resolvedStatusText)

  return (
    <div data-slot="image-generation" data-state={status} aria-busy={active} className={clsx('w-full', className)}>
      <div className={clsx('w-full', size === 'compact' && 'mx-auto max-w-52')}>
        <div role="img" aria-label={resolvedLabel} style={{ aspectRatio }} className="relative isolate w-full overflow-hidden rounded-[10px] border border-line bg-elev-2">
          <motion.div
            aria-hidden={children ? undefined : true}
            initial={false}
            animate={reduce ? { opacity: mediaState.opacity } : { filter: mediaState.filter, opacity: mediaState.opacity, scale: mediaState.scale }}
            transition={reduce ? { duration: 0 } : { duration: 0.4, ease: EASE_OUT }}
            className={clsx('absolute inset-0 [&>*]:size-full [&>*]:object-cover [&_img]:size-full [&_img]:object-cover', mediaClassName)}
          >
            {children}
          </motion.div>

          <AnimatePresence initial={false}>
            {active ? (
              <motion.div
                key="dither-field"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.25, ease: EASE_OUT }}
                className="absolute inset-0"
              >
                <DitherField interactive={interactive} reduce={reduce} status={status} />
              </motion.div>
            ) : null}
          </AnimatePresence>

          {resolution ? <span className="absolute right-2 top-2 z-10 rounded-full bg-bg/75 px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted backdrop-blur-sm">{resolution}</span> : null}
        </div>

        {showStatus || prompt ? (
          <div className="mt-3 text-left">
            {showStatus ? (
              <div aria-live="polite" className={clsx('flex min-h-5 items-center gap-2 text-[13px] font-medium text-fg', status === 'error' && 'text-danger-hi', statusClassName)}>
                <DitherMark status={status} reduce={reduce} />
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={resolvedStatusText}
                    initial={reduce ? false : { opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? undefined : { opacity: 0, y: -4 }}
                    transition={{ duration: reduce ? 0 : 0.15, ease: EASE_OUT }}
                  >
                    {resolvedStatusText}
                  </motion.span>
                </AnimatePresence>
                {actions ? <span className="ml-auto flex items-center gap-1">{actions}</span> : null}
              </div>
            ) : null}
            {prompt ? <p className="mt-0.5 truncate text-[12px] text-dim">“{prompt}”</p> : null}
          </div>
        ) : null}

        {status === 'error' && onRetry ? (
          <motion.button
            type="button"
            onClick={onRetry}
            whileTap={reduce ? undefined : { scale: 0.96 }}
            transition={SPRING_PRESS}
            className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-[13px] font-medium text-fg outline-none transition-colors hover:bg-elev-2 focus-visible:ring-2 focus-visible:ring-crimson-line"
          >
            <ArrowCounterClockwise aria-hidden="true" size={16} />
            Try again
          </motion.button>
        ) : null}
      </div>
    </div>
  )
}

/** Plays the component's "refining" step for a moment when a result arrives, so the reveal animates. */
export function useRevealStatus(status: ImageGenerationStatus): ImageGenerationStatus {
  const [shown, setShown] = useState(status)
  const prev = useRef(status)
  useEffect(() => {
    const was = prev.current
    prev.current = status
    if (status === 'complete' && (was === 'generating' || was === 'queued')) {
      setShown('refining')
      const t = setTimeout(() => setShown('complete'), 650)
      return () => clearTimeout(t)
    }
    setShown(status)
  }, [status])
  return shown
}
