import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'motion/react'
import { ArrowClockwise, ChartLineUp, ChatCircleDots, DotsThreeOutline, FlowArrow, Books, Desktop, SignOut, WifiSlash, type Icon } from '@phosphor-icons/react'
import { PageContent, Toasts } from '@/App'
import { NAV } from '@/lib/nav'
import { useApp, type Page } from '@/lib/store'
import { handleBack, useBackHandler } from '@/lib/back'
import { ConfirmHost } from '@/components/ConfirmDialog'
import { BottomSheet } from '@/components/BottomSheet'
import { confirmAction } from '@/components/ui'
import { forgetPairing, reconnectNow, useConnection } from './bridge'
import { MobileHosts } from './Hosts'
import { exitApp, onBackButton, onKeyboard } from './native'

const TABS: { page: Page; label: string; icon: Icon }[] = [
  { page: 'chat', label: 'Chat', icon: ChatCircleDots },
  { page: 'workflows', label: 'Flows', icon: FlowArrow },
  { page: 'knowledge', label: 'Knowledge', icon: Books },
  { page: 'dashboard', label: 'Dashboard', icon: ChartLineUp }
]
const MORE = NAV.filter((n) => !TABS.some((t) => t.page === n.page))

/** The phone's frame around the shared pages: bottom tabs, a "More" sheet and connection status. */
export function MobileShell() {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const { loadProviders, loadCollections, loadSettings } = useApp()
  const generation = useConnection((s) => s.generation)
  const [more, setMore] = useState(false)
  const [typing, setTyping] = useState(false)
  useEffect(() => onKeyboard(setTyping), [])

  // Reload shared data on start and after every reconnect (screens remount via `generation`).
  useEffect(() => {
    void loadProviders().catch(() => undefined)
    void loadCollections().catch(() => undefined)
    void loadSettings().catch(() => undefined)
  }, [generation, loadProviders, loadCollections, loadSettings])

  useEffect(
    () =>
      onBackButton(() => {
        if (handleBack()) return
        if (useApp.getState().page !== 'chat') useApp.getState().setPage('chat')
        else exitApp()
      }),
    []
  )
  useBackHandler(more, () => setMore(false))

  const go = (p: Page) => {
    setMore(false)
    setPage(p)
  }
  const inMore = MORE.some((m) => m.page === page)

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative flex h-full flex-col bg-bg pt-[var(--safe-top)]">
        <ConnectionBanner />
        <main className="relative min-h-0 flex-1" key={`${page}-${generation}`}>
          <PageContent page={page} />
        </main>

        <nav className={clsx('relative z-30 flex shrink-0 border-t border-line bg-panel/95 pb-[var(--safe-bottom)] backdrop-blur', typing && 'hidden')}>
          <LayoutGroup id="tabs">
            {TABS.map((t) => (
              <Tab key={t.page} icon={t.icon} label={t.label} active={page === t.page && !more} onClick={() => go(t.page)} />
            ))}
            <Tab icon={DotsThreeOutline} label="More" active={more || inMore} onClick={() => setMore(!more)} />
          </LayoutGroup>
        </nav>

        <BottomSheet open={more} onClose={() => setMore(false)} title="More" snapPoints={[0.62]}>
          <MoreSheet page={page} onGo={go} />
        </BottomSheet>

        <MobileHosts />
        <Toasts />
        <ConfirmHost />
      </div>
    </MotionConfig>
  )
}

function Tab({ icon: I, label, active, onClick }: { icon: Icon; label: string; active: boolean; onClick(): void }) {
  return (
    <button onClick={onClick} className="relative flex h-[60px] flex-1 flex-col items-center justify-center gap-1 text-[10.5px] font-medium">
      {active && <motion.span layoutId="tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} className="absolute top-2 h-8 w-14 rounded-full bg-crimson-soft" />}
      <I size={22} weight={active ? 'fill' : 'regular'} className={clsx('relative transition-colors', active ? 'text-crimson-hi' : 'text-dim')} />
      <span className={clsx('relative transition-colors', active ? 'text-fg' : 'text-dim')}>{label}</span>
    </button>
  )
}

function MoreSheet({ page, onGo }: { page: Page; onGo(p: Page): void }) {
  const info = useConnection((s) => s.info)
  const state = useConnection((s) => s.state)
  const forget = async () => {
    if (!(await confirmAction('This phone will stop connecting to your PC. To use it again, pair it from Settings → Phone on the PC.', { title: 'Forget this PC?', confirmLabel: 'Forget', danger: true }))) return
    await forgetPairing()
  }
  return (
    <div className="space-y-5 pb-4">
      <div className="grid grid-cols-3 gap-2.5">
        {MORE.map(({ page: p, label, icon: I }) => (
          <motion.button
            key={p}
            whileTap={{ scale: 0.95 }}
            onClick={() => onGo(p)}
            className={clsx('flex flex-col items-center gap-2 rounded-2xl border py-4 text-[12.5px] font-medium', page === p ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line bg-elev text-muted')}
          >
            <I size={24} weight={page === p ? 'fill' : 'regular'} className={page === p ? 'text-crimson-hi' : ''} />
            {label}
          </motion.button>
        ))}
      </div>

      <div className="rounded-2xl border border-line bg-elev p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-elev-2 text-crimson-hi">
            <Desktop size={20} weight="fill" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold">{info?.desktop ?? 'Your PC'}</div>
            <div className="flex items-center gap-1.5 text-[12px] text-dim">
              <span className={clsx('h-1.5 w-1.5 rounded-full', state === 'online' ? 'bg-ok' : state === 'connecting' ? 'bg-warn' : 'bg-crimson')} />
              {state === 'online' ? `Connected · ${info?.host}` : state === 'connecting' ? 'Connecting…' : 'Offline'}
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={reconnectNow} disabled={state === 'online'} className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-line-strong text-[13px] text-muted disabled:opacity-40">
            <ArrowClockwise size={15} /> Reconnect
          </button>
          <button onClick={() => void forget()} className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl border border-crimson-line text-[13px] text-crimson-hi">
            <SignOut size={15} /> Forget PC
          </button>
        </div>
      </div>
    </div>
  )
}

/** Slides in under the status bar while the PC is unreachable. */
function ConnectionBanner() {
  const state = useConnection((s) => s.state)
  const info = useConnection((s) => s.info)
  const [shown, setShown] = useState(false)
  // Ignore blips: only show after a second of not being online.
  useEffect(() => {
    if (state === 'online') return setShown(false)
    const t = setTimeout(() => setShown(true), 1000)
    return () => clearTimeout(t)
  }, [state])
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div key="banner" initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 36 }} className="shrink-0 overflow-hidden">
          <div className="flex items-center gap-2.5 border-b border-crimson-line bg-crimson-soft px-4 py-2.5 text-[12.5px]">
            <WifiSlash size={16} className="shrink-0 text-crimson-hi" />
            <span className="min-w-0 flex-1 truncate text-fg">
              {state === 'connecting' ? `Reconnecting to ${info?.desktop ?? 'your PC'}…` : (info?.error ?? `Can't reach ${info?.desktop ?? 'your PC'}`)}
            </span>
            {state !== 'connecting' && (
              <button onClick={reconnectNow} className="shrink-0 rounded-lg px-2 py-1 font-semibold text-crimson-hi active:bg-crimson-line">
                Retry
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
