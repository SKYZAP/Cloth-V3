import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { CaretLeft, CaretRight, Check } from '@phosphor-icons/react'

/** One line of a context menu: an action, a submenu, an action that asks first (inside the menu), or a divider. */
export type MenuEntry =
  | { kind: 'item'; label: string; icon?: ReactNode; hint?: string; danger?: boolean; checked?: boolean; run(): void }
  | { kind: 'sub'; label: string; icon?: ReactNode; entries: MenuEntry[] }
  | { kind: 'confirm'; label: string; icon?: ReactNode; question: string; confirmLabel: string; run(): void }
  | { kind: 'sep' }

type View = { title?: string; entries: MenuEntry[] } | { title?: string; confirm: Extract<MenuEntry, { kind: 'confirm' }> }

const ITEM = 'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui text-fg transition-colors hover:bg-elev-2 focus-visible:bg-elev-2 focus-visible:outline-none'

/** A menu at a point (a right-click, or the row it was opened from by keyboard), kept inside the window.
 *  ↑↓ move, → opens a submenu, ← goes back, Esc closes. A `confirm` entry asks inside the menu, not in a dialog. */
export function ContextMenu({ at, entries, onClose, label }: { at: { x: number; y: number }; entries: MenuEntry[]; onClose(): void; label?: string }) {
  const [stack, setStack] = useState<View[]>([{ entries }])
  const view = stack[stack.length - 1]
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)

  // Kept inside the window: opens up or left when there isn't room.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = Math.max(6, Math.min(at.x, innerWidth - r.width - 6))
    const y = at.y + r.height > innerHeight - 6 ? Math.max(6, at.y - r.height) : at.y
    setPos({ x, y })
  }, [at, stack])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role^=menuitem]')?.focus()
  }, [stack])

  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return stack.length > 1 ? setStack((s) => s.slice(0, -1)) : onClose()
      }
      if (e.key === 'ArrowLeft' && stack.length > 1) return setStack((s) => s.slice(0, -1))
      if (e.key === 'ArrowRight') {
        const el = document.activeElement as HTMLElement | null
        if (el?.dataset.sub !== undefined) el.click()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
      e.preventDefault()
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
    }
    const blur = () => onClose()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', keys, true)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', blur)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', keys, true)
      window.removeEventListener('blur', blur)
      window.removeEventListener('resize', blur)
    }
  }, [stack, onClose])

  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[60] w-60 rounded-xl border border-line-strong bg-panel p-1 shadow-[0_20px_50px_-10px_rgb(0_0_0/0.8)]"
    >
      {stack.length > 1 && (
        <>
          <button role="menuitem" className={clsx(ITEM, 'text-muted')} onClick={() => setStack((s) => s.slice(0, -1))}>
            <CaretLeft size={11} /> {view.title}
          </button>
          <div className="mx-1.5 my-1 border-t border-line" />
        </>
      )}
      {'confirm' in view ? (
        <div className="px-2.5 pb-1.5 pt-0.5">
          <p className="text-caption leading-relaxed text-muted">{view.confirm.question}</p>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button role="menuitem" className="h-7 rounded-lg border border-line-strong px-2.5 text-caption font-medium text-fg hover:bg-elev-2 focus-visible:bg-elev-2 focus-visible:outline-none" onClick={() => setStack((s) => s.slice(0, -1))}>
              Cancel
            </button>
            <button role="menuitem" className="h-7 rounded-lg bg-crimson px-2.5 text-caption font-semibold text-white hover:bg-crimson-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line" onClick={run(view.confirm.run)}>
              {view.confirm.confirmLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          {view.entries.map((e, i) =>
            e.kind === 'sep' ? (
              <div key={i} className="mx-1.5 my-1 border-t border-line" />
            ) : e.kind === 'sub' ? (
              <button key={i} role="menuitem" aria-haspopup="menu" data-sub="" className={ITEM} onClick={() => setStack((s) => [...s, { title: e.label, entries: e.entries }])}>
                <span className="flex w-4 shrink-0 justify-center text-muted">{e.icon}</span>
                <span className="flex-1 truncate">{e.label}</span>
                <CaretRight size={11} className="text-dim" />
              </button>
            ) : e.kind === 'confirm' ? (
              <button key={i} role="menuitem" className={clsx(ITEM, 'text-danger')} onClick={() => setStack((s) => [...s, { title: e.label.replace(/…$/, ''), confirm: e }])}>
                <span className="flex w-4 shrink-0 justify-center">{e.icon}</span>
                <span className="flex-1 truncate">{e.label}</span>
              </button>
            ) : (
              <button key={i} role={e.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={e.checked} className={clsx(ITEM, e.danger && 'text-danger')} onClick={run(e.run)}>
                <span className={clsx('flex w-4 shrink-0 justify-center', !e.danger && 'text-muted')}>{e.icon}</span>
                <span className="flex-1 truncate">{e.label}</span>
                {e.hint && <span className="font-mono text-micro text-dim">{e.hint}</span>}
                {e.checked && <Check size={13} className="text-crimson-hi" />}
              </button>
            )
          )}
        </div>
      )}
    </div>,
    document.body
  )
}
