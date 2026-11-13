import { lazy, Suspense, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { GearSix } from '@phosphor-icons/react'
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
import { DesignPage } from './pages/Design'
import { SettingsPage, openSettingsSection } from './pages/Settings'
import type { McpStatus } from '@shared/types'
import { useState } from 'react'
import { api } from './lib/api'
import { Logo } from './components/Logo'
import { ConfirmHost } from './components/ConfirmDialog'
import { isMobile } from './lib/platform'
import { ErrorBoundary } from './components/ErrorBoundary'
// Phone-only chrome (and its Capacitor plugins) never loads on the desktop.
const MobileShell = lazy(() => import('./mobile/Shell').then((m) => ({ default: m.MobileShell })))

const item = (page: Page) => NAV.find((n) => n.page === page)!
/** Desktop sidebar, in order: Dashboard, then work, build and connect pages, evenly spaced. */
const SIDEBAR: (typeof NAV)[number][] = [
  item('dashboard'),
  item('chat'),
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

  useEffect(() => {
    void loadProviders()
    void loadCollections()
    void loadSettings()
    void api.mcp.status().then(setMcp)
  }, [loadProviders, loadCollections, loadSettings])
  useEvent('mcp', setMcp)
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
    <div className="flex h-full bg-panel">
      {/* Sidebar: the same grey as the strip above the page, so the two read as one frame around it. */}
      {/* On Chat the chat list sits on the same grey, so a hairline keeps the two apart; other pages' canvas has its own edge. */}
      <nav aria-label="Pages" className={clsx('flex w-[216px] shrink-0 flex-col', ownCanvas && 'border-r border-line')}>
        <div className={clsx('drag flex shrink-0 items-center gap-2 px-4', isMac ? 'h-[52px] items-end pb-2' : 'h-12')}>
          <Logo size={18} />
          <span className="text-body font-semibold tracking-tight">Cloth</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-1 pb-2">
          {SIDEBAR.map(({ page: p, label, icon: Icon }) => (
            <NavItem key={p} active={page === p} onClick={() => setPage(p)} label={label} icon={<Icon size={18} weight={page === p ? 'fill' : 'regular'} />} />
          ))}
        </div>
        <div className="shrink-0 px-2 pb-2">
          <NavItem active={page === 'settings'} onClick={() => setPage('settings')} label="Settings" icon={<GearSix size={18} weight={page === 'settings' ? 'fill' : 'regular'} />} />
          <button
            onClick={() => setPage('mcp')}
            className="mt-2 flex w-full items-center gap-2 border-t border-line px-2.5 pt-3 pb-1 text-left text-caption text-dim hover:text-muted"
            title={mcp?.url}
          >
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', mcp?.running ? 'bg-ok' : 'bg-danger')} />
            <span className="truncate">{mcpLabel}</span>
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Grey strip continuing the sidebar: drags the window and holds the window controls (Windows and Linux).
            The page sits below it on a black canvas with a rounded top-left corner; Chat draws its own canvas on the frame. */}
        <div aria-hidden="true" className="drag h-9 shrink-0" />
        <main className={clsx('min-h-0 min-w-0 flex-1 overflow-hidden', !ownCanvas && 'rounded-tl-xl border-t border-l border-line bg-bg')}>
          <PageContent page={page} />
        </main>
      </div>
      <Toasts />
      <ConfirmHost />
    </div>
    </MotionConfig>
  )
}

function NavItem({ active, onClick, label, icon }: { active: boolean; onClick(): void; label: string; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui transition-colors',
        active ? 'bg-elev-2 font-semibold text-fg' : 'font-medium text-muted hover:bg-elev hover:text-fg'
      )}
    >
      {active && <span className="absolute -left-2 top-[7px] bottom-[7px] w-0.5 rounded-r bg-crimson" />}
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
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
