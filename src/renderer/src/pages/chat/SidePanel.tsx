import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import { FileText, FolderSimple, GitBranch, ListChecks, Robot, Rows, SlidersHorizontal, TerminalWindow, X } from '@phosphor-icons/react'
import { OpenSpecPanel } from './OpenSpec'
import type { ChatSession, TerminalInfo, UiMessage, WorkspaceFile } from '@shared/types'
import { terminalsAfter } from '@shared/terminal-tabs'
import { api, useEvent } from '@/lib/api'
import { chatAgents } from '@/lib/workbar'
import { Tooltip } from '@/components/Tooltip'
import { canStack, focusOrReplace, focusSection, migrate, resize, shownTabs, stackBelow, unstack, type PanelStack, type PanelTab } from '@shared/panel-stack'
import { isMobile } from '@/lib/platform'
import { IconButton } from '@/components/ui'
import { Terminals } from './Terminals'
import { Files } from './Files'
import { GitPanel } from './GitPanel'
import { SetupPanel } from './Setup'
import { AgentsPanel } from './AgentsPanel'
import { SpecPanel } from './Workflow'
import { docsVersion, ticketProgress } from '@/lib/tickets'
import { useSetupNav } from './setupNav'

export type { PanelTab } from '@shared/panel-stack'
const KEY = 'cloth.chat.panel'

export interface PanelState extends PanelStack {
  open: boolean
  width: number
}

/** Whether the side panel is open, which tabs it stacks, and how big — remembered across chats and restarts. */
export function usePanelState(): [PanelState, (p: Partial<PanelState>) => void] {
  const [state, setState] = useState<PanelState>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PanelState>
      return { open: !isMobile && !!raw.open, width: raw.width ?? 400, ...migrate(raw) }
    } catch {
      return { open: false, width: 400, ...migrate(null) }
    }
  })
  const write = (fn: (cur: PanelState) => PanelState) =>
    setState((cur) => {
      const next = fn(cur)
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  const set = (p: Partial<PanelState>) => write((cur) => ({ ...cur, ...p }))
  // openSetupSection() / openAgentRun(): open the panel with Setup or Agents shown (the tab then shows the section or run itself).
  const navSeq = useSetupNav((s) => s.seq)
  const handledSeq = useRef(navSeq)
  useEffect(() => {
    if (navSeq === handledSeq.current) return
    handledSeq.current = navSeq
    const tab = useSetupNav.getState().tab
    // open last: focusOrReplace returns the whole state, including open: false.
    write((cur) => ({ ...cur, ...(isMobile ? { stack: [tab], sizes: [1], focus: 0 } : focusOrReplace(cur, tab)), open: true }))
  }, [navSeq]) // eslint-disable-line react-hooks/exhaustive-deps
  return [state, set]
}

const TABS: { id: PanelTab; label: string; icon: typeof TerminalWindow }[] = [
  { id: 'setup', label: 'Setup', icon: SlidersHorizontal },
  { id: 'files', label: 'Files', icon: FolderSimple },
  { id: 'terminal', label: 'Terminal', icon: TerminalWindow },
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'agents', label: 'Agents', icon: Robot },
  { id: 'spec', label: 'Spec', icon: ListChecks },
  { id: 'openspec', label: 'OpenSpec', icon: FileText }
]

const HEADER = 28
const HANDLE = 4
const FULL = 'Up to three can be stacked'

/** The chat's side panel: what the chat can use, the folder's files, terminals, git changes and agent runs — up to three stacked. */
export function SidePanel({
  session,
  messages,
  update,
  state,
  set,
  onAttach,
  onInsert,
  onPickFolder
}: {
  session: ChatSession
  /** The chat's messages (the Agents tab lists their agent runs). */
  messages: UiMessage[]
  update(p: Partial<ChatSession>): Promise<void>
  state: PanelState
  set(p: Partial<PanelState>): void
  onAttach(f: WorkspaceFile): void
  onInsert(path: string): void
  onPickFolder(): void
}) {
  const shown = shownTabs(state, isMobile)
  const multi = shown.length > 1
  const focus = isMobile ? 0 : Math.min(state.focus, shown.length - 1)
  const stack: PanelStack = { stack: state.stack, sizes: state.sizes, focus: state.focus }
  const apply = (s: PanelStack) => set({ stack: s.stack, sizes: s.sizes, focus: s.focus })

  // Tabs mount on first show and then stay mounted (terminals keep running, trees stay expanded).
  const [seen, setSeen] = useState<Set<PanelTab>>(() => new Set(shown))
  const shownKey = shown.join(',')
  useEffect(() => {
    const tabs = shownKey.split(',') as PanelTab[]
    setSeen((s) => (tabs.every((t) => s.has(t)) ? s : new Set([...s, ...tabs])))
  }, [shownKey])
  // Clicking Setup again goes back to its overview from a section.
  const [setupKey, setSetupKey] = useState(0)
  // Files and git start afresh on another folder (files also when the chat moves in or out of a container).
  const folder = session.workspace ?? ''
  const filesKey = `${folder}|${!!session.container}`

  const pick = (tab: PanelTab) => {
    if (isMobile) {
      if (tab === 'setup' && shown[0] === 'setup') setSetupKey((n) => n + 1)
      else set({ stack: [tab], sizes: [1], focus: 0 })
      return
    }
    if (tab === 'setup' && shown[focus] === 'setup') setSetupKey((n) => n + 1)
    else apply(focusOrReplace(stack, tab))
  }
  const focusAt = (i: number) => {
    if (!isMobile && i !== state.focus) apply(focusSection(stack, i))
  }

  // Drag the left edge to resize.
  const drag = useRef<{ x: number; w: number } | null>(null)
  const max = () => Math.max(360, Math.floor(window.innerWidth * 0.6))

  // Drag the handle between two sections to share their height.
  const body = useRef<HTMLDivElement>(null)
  const split = useRef<{ i: number; y: number; sizes: number[]; total: number } | null>(null)

  // Every tab's content is one element in a fixed place in the tree; showing it in a section only sets its grid row,
  // so moving a tab between sections never remounts it (terminals keep running).
  const rows = multi ? shown.map((_, i) => `${HEADER}px minmax(0, ${state.sizes[i] ?? 1}fr)`).join(` ${HANDLE}px `) : 'minmax(0, 1fr)'
  const row = (i: number) => (multi ? 3 * i + 2 : 1)
  const place = (tab: PanelTab): CSSProperties | undefined => {
    const i = shown.indexOf(tab)
    return i < 0 ? undefined : { gridRow: row(i), gridColumn: 1 }
  }
  const sectionEvents = (tab: PanelTab) => {
    const i = shown.indexOf(tab)
    return i < 0 ? {} : { onPointerDownCapture: () => focusAt(i), onFocusCapture: () => focusAt(i) }
  }
  const visible = (tab: PanelTab) => shown.includes(tab)

  return (
    <aside
      aria-label="Side panel"
      className={clsx(
        'relative flex h-full shrink-0 flex-col',
        isMobile
          ? 'fixed inset-0 z-50 w-full bg-bg pt-[env(safe-area-inset-top)]'
          : // Below 1180px it floats over the conversation (beside the dock) so the message column keeps its width.
            'overflow-hidden rounded-xl border border-line bg-card max-[1180px]:absolute max-[1180px]:top-0 max-[1180px]:right-14 max-[1180px]:bottom-2 max-[1180px]:z-40 max-[1180px]:h-auto max-[1180px]:shadow-[-30px_0_60px_-20px_rgb(0_0_0/0.8)]'
      )}
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
      {isMobile ? (
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2">
        {TABS.map((t) => {
          const on = shown.includes(t.id)
          return (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className={clsx('flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-ui transition-colors', on ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev hover:text-fg')}
              aria-pressed={on}
              aria-label={t.label}
              title={t.label}
            >
              <t.icon size={14} weight={on ? 'fill' : 'regular'} className="shrink-0" />
              {on && <span className="whitespace-nowrap">{t.label}</span>}
            </button>
          )
        })}
        <div className="flex-1" />
        <button onClick={() => set({ open: false })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg" aria-label="Close panel" title="Close">
          <X size={15} />
        </button>
      </div>
      ) : (
        !multi && (
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pl-3.5 pr-1.5">
            {(() => {
              const t = TABS.find((x) => x.id === shown[0])!
              return (
                <>
                  <t.icon size={15} weight="fill" className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-ui font-semibold">{t.label}</span>
                </>
              )
            })()}
            <IconButton className="h-7 w-7" onClick={() => set({ open: false })} aria-label="Close panel" title="Close (Ctrl+.)">
              <X size={14} />
            </IconButton>
          </div>
        )
      )}
      <div ref={body} className="relative grid min-h-0 flex-1" style={{ gridTemplateRows: rows, gridTemplateColumns: 'minmax(0, 1fr)' }}>
        {multi &&
          shown.map((tab, i) => {
            const t = TABS.find((x) => x.id === tab)!
            return [
              <div
                key={`header-${tab}`}
                style={{ gridRow: row(i) - 1, gridColumn: 1 }}
                onPointerDown={() => focusAt(i)}
                className="flex h-7 items-center gap-1.5 border-b border-line pl-2.5 pr-0.5 text-caption text-muted"
              >
                <t.icon size={13} weight={i === focus ? 'fill' : 'regular'} />
                <span className={clsx('min-w-0 flex-1 truncate', i === focus && 'text-fg')}>{t.label}</span>
                <IconButton className="h-6 w-6" onClick={() => apply(unstack(stack, i))} aria-label={`Unstack ${t.label}`} title="Unstack">
                  <X size={12} />
                </IconButton>
              </div>,
              i < shown.length - 1 && (
                <div
                  key={`handle-${i}`}
                  role="separator"
                  aria-orientation="horizontal"
                  style={{ gridRow: row(i) + 1, gridColumn: 1 }}
                  className="cursor-row-resize border-t border-line hover:bg-line-strong"
                  onPointerDown={(e) => {
                    const total = (body.current?.clientHeight ?? 0) - shown.length * HEADER - (shown.length - 1) * HANDLE
                    split.current = { i, y: e.clientY, sizes: [...state.sizes], total }
                    e.currentTarget.setPointerCapture(e.pointerId)
                  }}
                  onPointerMove={(e) => {
                    const s = split.current
                    if (s) set({ sizes: resize(s.sizes, s.i, e.clientY - s.y, s.total) })
                  }}
                  onPointerUp={() => (split.current = null)}
                />
              )
            ]
          })}
        {visible('setup') && (
          <div className="relative min-h-0" style={place('setup')} {...sectionEvents('setup')}>
            <div className="absolute inset-0">
              <SetupPanel key={setupKey} session={session} update={update} />
            </div>
          </div>
        )}
        {seen.has('terminal') && (
          <div className={clsx(visible('terminal') ? 'relative min-h-0' : 'invisible absolute inset-0')} style={place('terminal')} {...sectionEvents('terminal')}>
            <div className="absolute inset-0">
              <Terminals sessionId={session.id} visible={visible('terminal')} hasFolder={!!session.workspace} container={!!session.container} onPickFolder={onPickFolder} />
            </div>
          </div>
        )}
        {seen.has('files') && (
          <div className={clsx('relative min-h-0', !visible('files') && 'hidden')} style={place('files')} {...sectionEvents('files')}>
            <div className="absolute inset-0">
              <Files key={filesKey} sessionId={session.id} visible={visible('files')} onAttach={onAttach} onInsert={onInsert} onPickFolder={onPickFolder} />
            </div>
          </div>
        )}
        {seen.has('git') && (
          <div className={clsx('relative min-h-0', !visible('git') && 'hidden')} style={place('git')} {...sectionEvents('git')}>
            <div className="absolute inset-0">
              <GitPanel key={folder} sessionId={session.id} visible={visible('git')} />
            </div>
          </div>
        )}
        {visible('agents') && (
          <div className="relative min-h-0" style={place('agents')} {...sectionEvents('agents')}>
            <div className="absolute inset-0">
              <AgentsPanel messages={messages} />
            </div>
          </div>
        )}
        {visible('spec') && (
          <div className="relative min-h-0" style={place('spec')} {...sectionEvents('spec')}>
            <div className="absolute inset-0">
              <SpecPanel sessionId={session.id} workflow={session.workflow} version={docsVersion(messages)} {...ticketProgress(messages)} />
            </div>
          </div>
        )}
        {visible('openspec') && (
          <div className="relative min-h-0" style={place('openspec')} {...sectionEvents('openspec')}>
            <div className="absolute inset-0">
              <OpenSpecPanel sessionId={session.id} visible={visible('openspec')} />
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}

/** What the dock shows on each tab while the panel is closed or showing something else: running shells, git changes, running agents. */
function useDockBadges(session: ChatSession, messages: UiMessage[]) {
  const agents = useMemo(() => chatAgents(messages).runs.filter((r) => r.status === 'running').length, [messages])
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null)
  useEffect(() => {
    let live = true
    setTerminals(null)
    void api.panel.terminals(session.id).then(
      (ts) => live && setTerminals(ts),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [session.id])
  useEvent('terminal', (e) => {
    if (e.type !== 'data') setTerminals((cur) => terminalsAfter(cur, session.id, e))
  })
  const [changes, setChanges] = useState<number | null>(null)
  const hasFolder = !!session.workspace || !!session.container
  const loadGit = useRef<() => void>(() => undefined)
  useEffect(() => {
    setChanges(null)
    if (!hasFolder) return
    let live = true
    loadGit.current = () => {
      if (document.hidden) return
      void api.panel.gitStatus(session.id).then(
        (s) => live && setChanges(s?.repo ? s.files.length : null),
        () => live && setChanges(null)
      )
    }
    loadGit.current()
    const t = setInterval(() => loadGit.current(), 10_000)
    return () => {
      live = false
      clearInterval(t)
      loadGit.current = () => undefined
    }
  }, [session.id, session.workspace, hasFolder, session.container])
  useEvent('chat', (e) => {
    if (e.sessionId === session.id && e.type === 'end') loadGit.current()
  })
  return { agents, terminals: terminals?.filter((t) => t.running).length ?? 0, changes }
}

/**
 * The side panel's tabs on the window frame, to the right of the panel: always visible, with what each tab has going on.
 * Clicking a tab shows it (in the focused section); clicking the tab already in front closes the panel.
 * Right-click or Shift+Enter stacks a tab below the others (up to three).
 */
export function PanelDock({ session, messages, state, set }: { session: ChatSession; messages: UiMessage[]; state: PanelState; set(p: Partial<PanelState>): void }) {
  const shown = state.open ? shownTabs(state, false) : []
  const focus = Math.min(state.focus, Math.max(0, shown.length - 1))
  const stack: PanelStack = { stack: state.stack, sizes: state.sizes, focus: state.focus }
  const badges = useDockBadges(session, messages)

  const pick = (tab: PanelTab) => {
    if (state.open && shown[focus] === tab) return set({ open: false })
    set({ ...focusOrReplace(stack, tab), open: true })
  }
  const stackable = (tab: PanelTab) => stack.stack.includes(tab) || canStack(stack)
  const stackTab = (tab: PanelTab) => {
    // Closed: the panel comes back as it was, with this tab added below.
    if (stackable(tab)) set({ ...stackBelow(stack, tab), open: true })
  }

  const [menu, setMenu] = useState<{ tab: PanelTab; x: number; y: number; from: HTMLElement } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const away = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(null)
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setMenu(null)
      menu.from.focus()
    }
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const status = (tab: PanelTab): string | null => {
    if (tab === 'terminal' && badges.terminals) return `${badges.terminals} running`
    if (tab === 'git' && badges.changes) return `${badges.changes} change${badges.changes === 1 ? '' : 's'}`
    if (tab === 'agents' && badges.agents) return `${badges.agents} running`
    if (tab === 'spec' && session.workflow && session.workflow.stage !== 'done') return 'In progress'
    if (tab === 'openspec' && session.openspec && session.openspec.step !== 'done') return session.openspec.awaitingReview ? 'Waiting for you' : 'In progress'
    return null
  }

  return (
    <nav aria-label="Side panel tabs" className="flex w-12 shrink-0 flex-col items-center gap-0.5">
      {TABS.map((t) => {
        const on = shown.includes(t.id)
        const front = on && shown[focus] === t.id
        const note = status(t.id)
        const shortcut = t.id === 'terminal' ? ' (Ctrl+`)' : ''
        return (
          <Tooltip
            key={t.id}
            side="left"
            content={
              <>
                {front ? `Hide ${t.label}` : t.label}
                {note ? ` · ${note}` : ''}
                {shortcut}
                <span className="block text-dim">Right-click to stack below</span>
              </>
            }
          >
            <button
              onClick={() => pick(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) {
                  e.preventDefault()
                  stackTab(t.id)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const keyboard = e.clientX === 0 && e.clientY === 0
                setMenu({ tab: t.id, x: Math.min(keyboard ? r.left - 168 : e.clientX, window.innerWidth - 168), y: keyboard ? r.top : e.clientY, from: e.currentTarget })
              }}
              aria-pressed={on}
              aria-label={note ? `${t.label}, ${note}` : t.label}
              aria-keyshortcuts="Shift+Enter"
              className={clsx('relative flex h-9 w-9 items-center justify-center rounded-[9px] transition-colors', on ? 'bg-elev-2 text-fg' : 'text-dim hover:bg-elev hover:text-fg')}
            >
              {front && <span className="absolute -right-1.5 top-[9px] bottom-[9px] w-0.5 rounded-l bg-crimson" />}
              <t.icon size={18} weight={on ? 'fill' : 'regular'} />
              {t.id === 'git' && !!badges.changes && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-panel bg-elev-2 px-1 text-[9.5px] font-semibold tabular-nums text-fg">
                  {badges.changes > 99 ? '99+' : badges.changes}
                </span>
              )}
              {t.id === 'terminal' && badges.terminals > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-ok ring-2 ring-panel" />}
              {t.id === 'agents' && badges.agents > 0 && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-info ring-2 ring-panel" />}
              {t.id === 'spec' && note && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-mode ring-2 ring-panel" />}
              {t.id === 'openspec' && note && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-ospec ring-2 ring-panel" />}
            </button>
          </Tooltip>
        )
      })}
      {menu && (
        <div ref={menuRef} role="menu" className="fixed z-50 w-40 rounded-lg border border-line-strong bg-panel p-1 shadow-lg shadow-black/40" style={{ left: menu.x, top: menu.y }}>
          <button
            role="menuitem"
            aria-disabled={!stackable(menu.tab)}
            title={stackable(menu.tab) ? undefined : FULL}
            onClick={() => {
              if (!stackable(menu.tab)) return
              stackTab(menu.tab)
              setMenu(null)
              menu.from.focus()
            }}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui text-muted hover:bg-elev-2 hover:text-fg focus-visible:bg-elev-2 focus-visible:text-fg focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted"
          >
            <Rows size={14} />
            Stack below
          </button>
        </div>
      )}
    </nav>
  )
}
