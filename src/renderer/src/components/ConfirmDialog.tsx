import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { Question, Warning } from '@phosphor-icons/react'

export interface ConfirmOptions {
  title?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive action: red confirm button, Cancel focused by default. */
  danger?: boolean
}

interface Request extends ConfirmOptions {
  id: number
  message: string
  resolve(ok: boolean): void
}

let seq = 0
let push: ((r: Request) => void) | null = null
const pending: Request[] = []

/** In-app replacement for window.confirm: resolves true when the user confirms. */
export function confirmAction(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const req: Request = { ...opts, id: ++seq, message, resolve }
    if (push) push(req)
    else pending.push(req) // host not mounted yet
  })
}

/** Mounted once (in App); shows queued confirmation requests one at a time. */
export function ConfirmHost() {
  const [queue, setQueue] = useState<Request[]>([])
  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r])
    if (pending.length) setQueue((q) => [...q, ...pending.splice(0)])
    return () => {
      push = null
    }
  }, [])
  const current = queue[0]
  const close = (ok: boolean) => {
    if (!current) return
    current.resolve(ok)
    setQueue((q) => q.slice(1))
  }
  return <AnimatePresence>{current && <Dialog key={current.id} req={current} onClose={close} />}</AnimatePresence>
}

function Dialog({ req, onClose }: { req: Request; onClose(ok: boolean): void }) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const done = useRef(false)
  const finish = (ok: boolean) => {
    if (done.current) return
    done.current = true
    onClose(ok)
  }
  useEffect(() => {
    // Destructive: default to the safe choice so Enter doesn't delete by accident.
    ;(req.danger ? cancelRef : confirmRef).current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Capture phase + stop: Escape answers this dialog only, not a modal underneath it.
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const Icon = req.danger ? Warning : Question
  const [first, ...rest] = req.message.split(/\n\n+/)
  return (
    <motion.div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 backdrop-blur-[3px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      onMouseDown={() => finish(false)}
    >
      <motion.div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`confirm-title-${req.id}`}
        aria-describedby={`confirm-body-${req.id}`}
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.14 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[440px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border border-line-strong bg-panel shadow-[0_24px_60px_-12px_rgb(0_0_0/0.8)]"
      >
        <div className="flex gap-3.5 px-5 pt-5">
          <div className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]', req.danger ? 'bg-crimson-soft text-crimson-hi' : 'bg-elev-2 text-muted')}>
            <Icon size={18} weight="fill" />
          </div>
          <div className="min-w-0 pt-0.5">
            <div id={`confirm-title-${req.id}`} className="text-[14.5px] font-semibold tracking-tight text-fg">
              {req.title ?? first}
            </div>
            <div id={`confirm-body-${req.id}`} className="selectable mt-1.5 space-y-2 text-[12.5px] leading-relaxed text-muted">
              {(req.title ? [first, ...rest] : rest).map((p, i) => (
                <p key={i} className="whitespace-pre-wrap break-words">
                  {p}
                </p>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2 border-t border-line bg-bg/40 px-5 py-3.5">
          <button
            ref={cancelRef}
            onClick={() => finish(false)}
            className="h-8 rounded-lg border border-line-strong px-3.5 text-[12.5px] font-medium text-muted transition-colors hover:border-line-strong hover:bg-elev-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line"
          >
            {req.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            onClick={() => finish(true)}
            className={clsx(
              'h-8 rounded-lg px-3.5 text-[12.5px] font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
              req.danger ? 'bg-crimson hover:bg-crimson-hi focus-visible:ring-crimson' : 'bg-crimson hover:bg-crimson-hi focus-visible:ring-crimson-line'
            )}
          >
            {req.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
