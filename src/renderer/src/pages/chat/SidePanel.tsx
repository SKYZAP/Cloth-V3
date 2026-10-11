import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { FolderSimple, GitBranch, SlidersHorizontal, TerminalWindow, X } from '@phosphor-icons/react'
import type { ChatSession, WorkspaceFile } from '@shared/types'
import { isMobile } from '@/lib/platform'
import { Terminals } from './Terminals'
import { Files } from './Files'
import { GitPanel } from './GitPanel'
import { SetupPanel } from './Setup'

export type PanelTab = 'setup' | 'terminal' | 'files' | 'git'
const KEY = 'cloth.chat.panel'

export interface PanelState {
  open: boolean
  tab: PanelTab
  width: number
}

/** Whether the side panel is open, which tab, and how wide — remembered across chats and restarts. */
export function usePanelState(): [PanelState, (p: Partial<PanelState>) => void] {
  const [state, setState] = useState<PanelState>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PanelState>
      return { open: !isMobile && !!raw.open, tab: raw.tab ?? 'setup', width: raw.width ?? 400 }
    } catch {
      return { open: false, tab: 'setup', width: 400 }
    }
  })
  const set = (p: Partial<PanelState>) =>
    setState((cur) => {
      const next = { ...cur, ...p }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  return [state, set]
}

const TABS: { id: PanelTab; label: string; icon: typeof TerminalWindow }[] = [
  { id: 'setup', label: 'Setup', icon: SlidersHorizontal },
  { id: 'files', label: 'Files', icon: FolderSimple },
  { id: 'terminal', label: 'Terminal', icon: TerminalWindow },
  { id: 'git', label: 'Git', icon: GitBranch }
]

/** The chat's side panel: what the chat can use, the folder's files, terminals and git changes. */
export function SidePanel({
  session,
  update,
  state,
  set,
  onAttach,
  onInsert,
  onPickFolder
}: {
  session: ChatSession
  update(p: Partial<ChatSession>): Promise<void>
  state: PanelState
  set(p: Partial<PanelState>): void
  onAttach(f: WorkspaceFile): void
  onInsert(path: string): void
  onPickFolder(): void
}) {
  // Tabs mount on first visit and then stay mounted (terminals keep running, trees stay expanded).
  const [seen, setSeen] = useState<Set<PanelTab>>(new Set([state.tab]))
  // Clicking Setup again goes back to its overview from a section.
  const [setupKey, setSetupKey] = useState(0)
  useEffect(() => setSeen((s) => (s.has(state.tab) ? s : new Set([...s, state.tab]))), [state.tab])
  // Files and git start afresh on another folder (files also when the chat moves in or out of a container).
  const folder = session.workspace ?? ''
  const filesKey = `${folder}|${!!session.container}`

  // Drag the left edge to resize.
  const drag = useRef<{ x: number; w: number } | null>(null)
  const max = () => Math.max(360, Math.floor(window.innerWidth * 0.6))

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-line bg-bg mobile:fixed mobile:inset-0 mobile:z-50 mobile:w-full mobile:border-l-0 mobile:pt-[env(safe-area-inset-top)]"
      style={isMobile ? undefined : { width: Math.min(state.width, max()) }}
    >
      {!isMobile && (
        <div
          className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-crimson-line/40"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, w: Math.min(state.width, max()) }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            set({ width: Math.max(320, Math.min(max(), drag.current.w - (e.clientX - drag.current.x))) })
          }}
          onPointerUp={() => (drag.current = null)}
          onDoubleClick={() => set({ width: 400 })}
          title="Drag to resize · double-click to reset"
        />
      )}
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => (t.id === 'setup' && state.tab === 'setup' ? setSetupKey((n) => n + 1) : set({ tab: t.id }))}
            className={clsx('flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] transition-colors', state.tab === t.id ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev hover:text-fg')}
            aria-pressed={state.tab === t.id}
          >
            <t.icon size={14} weight={state.tab === t.id ? 'fill' : 'regular'} />
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={() => set({ open: false })} className="flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg" aria-label="Close panel" title="Close (Ctrl+`)">
          <X size={15} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {state.tab === 'setup' && (
          <div className="absolute inset-0">
            <SetupPanel key={setupKey} session={session} update={update} />
          </div>
        )}
        {seen.has('terminal') && (
          <div className={clsx('absolute inset-0', state.tab !== 'terminal' && 'invisible')}>
            <Terminals sessionId={session.id} visible={state.tab === 'terminal'} hasFolder={!!session.workspace} container={!!session.container} />
          </div>
        )}
        {seen.has('files') && (
          <div className={clsx('absolute inset-0', state.tab !== 'files' && 'hidden')}>
            <Files key={filesKey} sessionId={session.id} visible={state.tab === 'files'} onAttach={onAttach} onInsert={onInsert} onPickFolder={onPickFolder} />
          </div>
        )}
        {seen.has('git') && (
          <div className={clsx('absolute inset-0', state.tab !== 'git' && 'hidden')}>
            <GitPanel key={folder} sessionId={session.id} visible={state.tab === 'git'} />
          </div>
        )}
      </div>
    </aside>
  )
}
