import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { create } from 'zustand'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretLeft } from '@phosphor-icons/react'
import { isMobile } from '@/lib/platform'
import { useBackHandler } from '@/lib/back'
import { EASE_DRAWER } from './BottomSheet'

const SplitCtx = createContext<{ open: boolean; onBack(): void } | null>(null)
const BackCtx = createContext<(() => void) | null>(null)

/** How many phone detail screens are open: the tab bar steps aside while any is (more room for a chat or a flow). */
export const useDetailOpen = create<{ count: number }>(() => ({ count: 0 }))

/**
 * A list (ListPane) beside the selected item's detail (SplitDetail). On the desktop both show side by
 * side; on the phone the list fills the screen and the detail slides over it while `open`
 * (Android back returns to the list).
 */
export function SplitRoot({ open, onBack, children }: { open: boolean; onBack(): void; children: ReactNode }) {
  useBackHandler(isMobile && open, onBack)
  useEffect(() => {
    if (!isMobile || !open) return
    useDetailOpen.setState((s) => ({ count: s.count + 1 }))
    return () => useDetailOpen.setState((s) => ({ count: s.count - 1 }))
  }, [open])
  if (!isMobile) return <div className="flex h-full">{children}</div>
  return (
    <SplitCtx.Provider value={{ open, onBack }}>
      <div className="relative h-full overflow-hidden">{children}</div>
    </SplitCtx.Provider>
  )
}

export function SplitDetail({ children }: { children: ReactNode }) {
  const split = useContext(SplitCtx)
  if (!split) return <div className="min-w-0 flex-1">{children}</div>
  return (
    <AnimatePresence initial={false}>
      {split.open && (
        <motion.div
          key="detail"
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ duration: 0.42, ease: EASE_DRAWER }}
          className="absolute inset-0 z-20 bg-bg shadow-[-12px_0_40px_rgb(0_0_0/0.5)]"
        >
          <BackCtx.Provider value={split.onBack}>{children}</BackCtx.Provider>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Back-to-list button for a detail header; renders nothing outside a phone SplitDetail. */
export function SplitBack({ className }: { className?: string }) {
  const back = useContext(BackCtx)
  if (!back) return null
  return (
    <button onClick={back} aria-label="Back" className={clsx('-ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted active:bg-elev-2', className)}>
      <CaretLeft size={20} weight="bold" />
    </button>
  )
}
