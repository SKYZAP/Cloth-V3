import { useEffect, useRef } from 'react'

/**
 * Android back button: the most recently opened layer (dialog, sheet, detail view) closes first.
 * Desktop never fires these, so the hook is a no-op there.
 */
const stack: { id: number; fn: () => void }[] = []
let seq = 0

export function useBackHandler(active: boolean, fn: () => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const entry = { id: ++seq, fn: () => ref.current() }
    stack.push(entry)
    return () => {
      const i = stack.findIndex((e) => e.id === entry.id)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}

/** Runs the top handler; false when nothing was open. */
export function handleBack(): boolean {
  const top = stack.at(-1)
  if (!top) return false
  top.fn()
  return true
}
