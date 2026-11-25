import { lazy, Suspense, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { CaretLeft, CaretRight, GearSix } from '@phosphor-icons/react'
import { NAV } from './lib/nav'
import { MotionConfig } from 'motion/react'
import { useApp, type Page } from './lib/store'
import { useEvent } from './lib/api'
import { ChatPage } from './pages/Chat'
import { DashboardPage } from './pages/Dashboard'
import { KnowledgePage } from './pages/Knowledge'
import { SkillsPage } from './pages/Skills'
import { AgentsPage } from './pages/Agents'
import { ToolsPage } from './pages/Tools'
import { WorkflowsPage } from './pages/Workflows'
import { ProvidersPage } from './pages/Providers'
import { McpPage } from './pages/Mcp'
import { RunPage } from './pages/Run'
import { BoardsPage } from './pages/Boards'
import { SwatchesPage } from './pages/Swatches'
import { DesignPage } from './pages/Design'
import { SettingsPage, openSettingsSection } from './pages/Settings'
import type { McpStatus } from '@shared/types'
import { useState } from 'react'
import { api } from './lib/api'
import { Logo } from './components/Logo'
import { ConfirmHost } from './components/ConfirmDialog'
import { Onboarding } from './components/Onboarding'
import { isMobile } from './lib/platform'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Tooltip } from './components/Tooltip'
// Phone-only chrome (and its Capacitor plugins) never loads on the desktop.
const MobileShell = lazy(() => import('./mobile/Shell').then((m) => ({ default: m.MobileShell })))

const item = (page: Page) => NAV.find((n) => n.page === page)!
/** Desktop sidebar, in order: Dashboard, then work, build and connect pages, evenly spaced. */
const SIDEBAR: (typeof NAV)[number][] = [
  item('dashboard'),
  item('chat'),
  item('boards'),
  item('swatches'),
  item('workflows'),
  item('agents'),
  item('skills'),
  item('tools'),
  item('knowledge'),
  item('providers'),
  item('run'),
  { ...item('mcp'), label: 'MCP servers' }
]

export function App() {
  return isMobile ? (
    <Suspense fallback={null}>
      <MobileShell />
    </Suspense>
  ) : (
    <DesktopApp />
  )
}

/** Renders one page of the app — shared by the desktop window and the phone shell. */
export function PageContent({ page }: { page: Page }) {
  return (
    <ErrorBoundary resetKey={page} label="page">
      {page === 'dashboard' && <DashboardPage />}
      {page === 'chat' && <ChatPage />}
      {page === 'boards' && <BoardsPage />}
      {page === 'swatches' && <SwatchesPage />}
      {page === 'knowledge' && <KnowledgePage />}
      {page === 'skills' && <SkillsPage />}
      {page === 'agents' && <AgentsPage />}
      {page === 'tools' && <ToolsPage />}
      {page === 'workflows' && <WorkflowsPage />}
      {page === 'providers' && <ProvidersPage />}
      {page === 'run' && <RunPage />}
      {page === 'mcp' && <McpPage />}
      {page === 'design' && <DesignPage />}
      {page === 'settings' && <SettingsPage />}
    </ErrorBoundary>
  )
}

function DesktopApp() {
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const { loadProviders, loadCollections, loadSettings } = useApp()
  const [mcp, setMcp] = useState<McpStatus | null>(null)
  // The page sidebar folds to a rail of icons (Ctrl+B, on any page); remembered on this device.
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLDED_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_KEY, folded ? '1' : '0')
    } catch {
      // Storage can be unavailable; the sidebar still folds for this session.
    }
  }, [folded])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setFolded((f) => !f)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    void loadCollections()
    void Promise.all([loadProviders(), loadSettings()]).then(() => {
      // First launch: setup opens by itself. Installs that already have a provider get the Dashboard card instead.
      const st = useApp.getState()
      if (st.settings && !st.settings.onboarding && !st.providers.some((p) => !p.local)) st.openOnboarding('welcome')
    })
    void api.mcp.status().then(setMcp)
  }, [loadProviders, loadCollections, loadSettings])
  useEvent('mcp', setMcp)
  // MCP servers added or changed outside this window's own edits (setup's import, a chat's add_mcp_server, the phone):
  // refresh the settings everywhere, so the MCP page and every chat's Setup list them at once.
  useEvent('mcpClients', () => void api.settings.get().then((fresh) => useApp.setState({ settings: fresh })))
  // Computer use is missing a macOS permission: say which and offer the settings pane.
  const toast = useApp((s) => s.toast)
  useEvent('computer', (n) => toast(n.text, 'error', { label: 'Open System Settings', run: () => void api.app.openPrivacySettings(n.kind) }))
  // The launch check found a newer Cloth: say so once per version, wherever the user is.
  const announced = useRef<string | null>(null)
  useEvent('updates', (u) => {
    if (u.state !== 'available' || !u.version || announced.current === u.version || useApp.getState().page === 'settings') return
    announced.current = u.version
    toast(`Cloth ${u.version} is available`, 'info', { label: 'Open Settings', run: () => openSettingsSection('about') })
  })

  const isMac = window.cloth.platform === 'darwin'
  // Chat lays its own surfaces on the frame (chat list, conversation canvas, side panel card), so it gets no canvas from here.
  const ownCanvas = page === 'chat'
  const mcpLabel = mcp ? (mcp.running ? `Connected · port ${mcp.port}` : 'MCP server offline') : 'Starting…'
  return (
    <MotionConfig reducedMotion="user">
    <div className="relative flex h-full bg-panel">
      {/* The app's name sits in the middle of the strip along the top, clear of the sidebar and the window controls. */}
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-0 z-10 flex h-9 -translate-x-1/2 items-center gap-2">
        <Logo size={16} />
        <span className="text-ui font-semibold tracking-tight">Cloth</span>
      </div>
      {/* Sidebar: the same grey as the strip above the page, so the two read as one frame around it. Folds to a rail of icons
          from a handle on its right edge, which shows while the pointer is over the sidebar. */}
      <div className="group/side relative flex shrink-0">
      <nav
        aria-label="Pages"
        className={clsx('flex shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none', folded ? 'w-14' : 'w-[216px]')}
      >
        <div aria-hidden="true" className={clsx('drag shrink-0', isMac ? 'h-[52px]' : 'h-9')} />
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 pt-1 pb-2">
          {SIDEBAR.map(({ page: p, label, icon: Icon }) => (
            <NavItem key={p} folded={folded} active={page === p} onClick={() => setPage(p)} label={label} icon={<Icon size={18} weight={page === p ? 'fill' : 'regular'} />} />
          ))}
        </div>
        <div className="shrink-0 px-2 pb-2">
          <NavItem folded={folded} active={page === 'settings'} onClick={() => setPage('settings')} label="Settings" icon={<GearSix size={18} weight={page === 'settings' ? 'fill' : 'regular'} />} />
          {folded ? (
            <div className="mt-2 flex justify-center border-t border-line pt-2">
              <Tooltip content={mcpLabel} side="right">
                <button onClick={() => setPage('mcp')} className="flex h-7 w-10 items-center justify-center rounded-md hover:bg-elev">
                  <span className={clsx('h-1.5 w-1.5 rounded-full', mcp?.running ? 'bg-ok' : 'bg-danger')} />
                </button>
              </Tooltip>
            </div>
          ) : (
            <button
              onClick={() => setPage('mcp')}
              className="mt-2 flex w-full items-center gap-2 border-t border-line px-2.5 pt-3 pb-1 text-left text-caption text-dim hover:text-muted"
              title={mcp?.url}
            >
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', mcp?.running ? 'bg-ok' : 'bg-danger')} />
              <span className="truncate">{mcpLabel}</span>
            </button>
          )}
        </div>
      </nav>
        {/* The edge itself: a strip straddling the border that lights up and folds the sidebar when clicked. Mouse only; the round button below is the keyboard way in. */}
        <button
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setFolded((f) => !f)}
          className={clsx('group/edge no-drag absolute -right-1.5 bottom-0 z-20 w-3 cursor-pointer', isMac ? 'top-[52px]' : 'top-9')}
        >
          <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover/edge:bg-crimson-line" />
        </button>
        <div className={clsx('no-drag absolute -right-2.5 z-30 opacity-0 transition-opacity duration-150 group-hover/side:opacity-100 has-[:focus-visible]:opacity-100 motion-reduce:transition-none', isMac ? 'top-[60px]' : 'top-11')}>
          <Tooltip content={folded ? 'Expand the sidebar (Ctrl+B)' : 'Collapse the sidebar (Ctrl+B)'} side="right">
            <button
              onClick={() => setFolded((f) => !f)}
              aria-expanded={!folded}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-elev-2 text-muted shadow-md shadow-black/40 outline-none transition-colors hover:border-crimson-line hover:text-fg focus-visible:ring-2 focus-visible:ring-crimson"
            >
              {folded ? <CaretRight size={11} weight="bold" /> : <CaretLeft size={11} weight="bold" />}
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Grey strip continuing the sidebar: drags the window and holds the window controls (Windows and Linux).
            The page sits below it on a black canvas with a rounded top-left corner; Chat draws its own canvas on the frame. */}
        <div aria-hidden="true" className="drag h-9 shrink-0" />
        <main className={clsx('min-h-0 min-w-0 flex-1 overflow-hidden', !ownCanvas && 'rounded-tl-xl border-t border-l border-line bg-bg')}>
          <PageContent page={page} />
        </main>
      </div>
      <Onboarding />
      <Toasts />
      <ConfirmHost />
    </div>
    </MotionConfig>
  )
}

const FOLDED_KEY = 'cloth.sidebar.folded'

/** On the folded rail, a control's name shows beside it on hover or keyboard focus. */
function Rail({ folded, label, children }: { folded: boolean; label: string; children: React.ReactElement<{ 'aria-label'?: string }> }) {
  return folded ? (
    <Tooltip content={label} side="right">
      {children}
    </Tooltip>
  ) : (
    children
  )
}

function NavItem({ active, onClick, label, icon, folded }: { active: boolean; onClick(): void; label: string; icon: React.ReactNode; folded: boolean }) {
  return (
    <Rail folded={folded} label={label}>
      <button
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        aria-label={folded ? label : undefined}
        className={clsx(
          'relative flex h-8 items-center rounded-md text-left text-ui transition-colors',
          folded ? 'w-10 justify-center' : 'w-full gap-2.5 px-2.5',
          active ? 'bg-elev-2 font-semibold text-fg' : 'font-medium text-muted hover:bg-elev hover:text-fg'
        )}
      >
        {active && <span className="absolute -left-2 top-[7px] bottom-[7px] w-0.5 rounded-r bg-crimson" />}
        <span className="shrink-0">{icon}</span>
        {!folded && <span className="truncate whitespace-nowrap">{label}</span>}
      </button>
    </Rail>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-96 flex-col gap-2 mobile:inset-x-3 mobile:bottom-[calc(var(--safe-bottom)+76px)] mobile:w-auto">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-elev px-3 py-2.5 text-ui shadow-xl shadow-black/50',
            t.kind === 'error' ? 'border-danger-line' : t.kind === 'ok' ? 'border-ok/30' : 'border-line-strong'
          )}
        >
          <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', t.kind === 'error' ? 'bg-danger' : t.kind === 'ok' ? 'bg-ok' : 'bg-info')} />
          <span className="selectable flex-1 break-words">
            {t.text}
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
                className="mt-1.5 block font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
              >
                {t.action.label}
              </button>
            )}
          </span>
          <button onClick={() => dismiss(t.id)} className="text-dim hover:text-fg">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
