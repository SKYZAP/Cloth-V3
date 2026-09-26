import { useEffect } from 'react'
import clsx from 'clsx'
import { BookOpen, Bot, Cable, Cpu, Settings as SettingsIcon, Sparkles, Workflow as WorkflowIcon, X } from 'lucide-react'
import { useApp, type Page } from './lib/store'
import { useEvent } from './lib/api'
import { ChatPage } from './pages/Chat'
import { KnowledgePage } from './pages/Knowledge'
import { SkillsPage } from './pages/Skills'
import { WorkflowsPage } from './pages/Workflows'
import { ProvidersPage } from './pages/Providers'
import { McpPage } from './pages/Mcp'
import { SettingsPage } from './pages/Settings'
import type { McpStatus } from '@shared/types'
import { useState } from 'react'
import { api } from './lib/api'
import { Logo } from './components/Logo'

const NAV: { page: Page; label: string; icon: typeof Bot }[] = [
  { page: 'chat', label: 'Chat', icon: Bot },
  { page: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { page: 'skills', label: 'Skills', icon: Sparkles },
  { page: 'workflows', label: 'Flows', icon: WorkflowIcon },
  { page: 'providers', label: 'Models', icon: Cpu },
  { page: 'mcp', label: 'MCP', icon: Cable }
]

export function App() {
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

  const isMac = window.cloth.platform === 'darwin'

  return (
    <div className="flex h-full flex-col">
      {/* Title bar */}
      <div className={clsx('drag flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg', isMac ? 'pl-20' : 'pl-3', 'pr-[150px]')}>
        <Logo size={16} />
        <span className="text-[12.5px] font-semibold tracking-tight">Cloth</span>
        <span className="text-[11px] text-dim">offline developer hub</span>
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
          {NAV.map(({ page: p, label, icon: Icon }) => (
            <NavButton key={p} active={page === p} onClick={() => setPage(p)} label={label}>
              <Icon size={18} strokeWidth={1.8} />
            </NavButton>
          ))}
          <div className="flex-1" />
          <NavButton active={page === 'settings'} onClick={() => setPage('settings')} label="Settings">
            <SettingsIcon size={18} strokeWidth={1.8} />
          </NavButton>
        </nav>

        <main className="min-w-0 flex-1 bg-bg">
          {page === 'chat' && <ChatPage />}
          {page === 'knowledge' && <KnowledgePage />}
          {page === 'skills' && <SkillsPage />}
          {page === 'workflows' && <WorkflowsPage />}
          {page === 'providers' && <ProvidersPage />}
          {page === 'mcp' && <McpPage />}
          {page === 'settings' && <SettingsPage />}
        </main>
      </div>
      <Toasts />
    </div>
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

function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-elev px-3 py-2.5 text-[12.5px] shadow-xl shadow-black/50',
            t.kind === 'error' ? 'border-crimson-line' : t.kind === 'ok' ? 'border-ok/30' : 'border-line-strong'
          )}
        >
          <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', t.kind === 'error' ? 'bg-crimson' : t.kind === 'ok' ? 'bg-ok' : 'bg-info')} />
          <span className="selectable flex-1 break-words">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-dim hover:text-fg">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
