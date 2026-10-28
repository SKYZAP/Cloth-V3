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

const RAIL = NAV.filter((n) => n.page !== 'settings')

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

  return (
    <MotionConfig reducedMotion="user">
    <div className="flex h-full flex-col">
      {/* Title bar */}
      <div className={clsx('drag flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg', isMac ? 'pl-20' : 'pl-3', 'pr-[150px]')}>
        <Logo size={16} />
        <span className="text-[12.5px] font-semibold tracking-tight">Cloth</span>
        <div className="flex-1" />
        <button
          onClick={() => setPage('mcp')}
          className="no-drag flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] text-dim hover:bg-elev hover:text-muted"
          title={mcp?.url}
        >
          <span className={clsx('h-1.5 w-1.5 rounded-full', mcp?.running ? 'bg-ok' : 'bg-crimson')} />
          MCP {mcp?.running ? `:${mcp.port}` : 'offline'}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Nav rail */}
        <nav className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-bg py-2">
          {RAIL.map(({ page: p, label, icon: Icon }) => (
            <NavButton key={p} active={page === p} onClick={() => setPage(p)} label={label}>
              <Icon size={19} weight={page === p ? 'fill' : 'regular'} />
            </NavButton>
          ))}
          <div className="flex-1" />
          <NavButton active={page === 'settings'} onClick={() => setPage('settings')} label="Settings">
            <GearSix size={19} weight={page === 'settings' ? 'fill' : 'regular'} />
          </NavButton>
        </nav>

        <main className="min-w-0 flex-1 bg-bg">
          <PageContent page={page} />
        </main>
      </div>
      <Toasts />
      <ConfirmHost />
    </div>
    </MotionConfig>
  )
}

function NavButton({ active, onClick, label, children }: { active: boolean; onClick(): void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'relative flex w-14 flex-col items-center gap-1 rounded-lg py-2 text-[10px] font-medium transition-colors',
        active ? 'bg-elev-2 text-fg' : 'text-dim hover:bg-elev hover:text-muted'
      )}
    >
      {active && <span className="absolute -left-1.5 top-2.5 bottom-2.5 w-[3px] rounded-r bg-crimson" />}
      <span className={active ? 'text-crimson-hi' : ''}>{children}</span>
      {label}
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
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-elev px-3 py-2.5 text-[12.5px] shadow-xl shadow-black/50',
            t.kind === 'error' ? 'border-crimson-line' : t.kind === 'ok' ? 'border-ok/30' : 'border-line-strong'
          )}
        >
          <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', t.kind === 'error' ? 'bg-crimson' : t.kind === 'ok' ? 'bg-ok' : 'bg-info')} />
          <span className="selectable flex-1 break-words">
            {t.text}
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
                className="mt-1.5 block font-medium text-crimson-hi hover:text-fg"
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
