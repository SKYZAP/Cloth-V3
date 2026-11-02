import { useEffect, useRef, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import { FolderSimple, GitBranch, ListChecks, Robot, Rows, SlidersHorizontal, TerminalWindow, X } from '@phosphor-icons/react'
import type { ChatSession, UiMessage, WorkspaceFile } from '@shared/types'
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
  { id: 'spec', label: 'Spec', icon: ListChecks }
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
  const stackTab = (tab: PanelTab) => {
    if (!isMobile && canStack(stack)) apply(stackBelow(stack, tab))
  }
  const focusAt = (i: number) => {
    if (!isMobile && i !== state.focus) apply(focusSection(stack, i))
  }

  // Right-click a tab for "Stack below".
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
      {/* Narrow panels: the tabs drop to icons (the open one keeps its name while there is room). */}
      <div className="@container flex h-14 shrink-0 items-center gap-0.5 border-b border-line px-2 @[520px]:gap-1">
        {TABS.map((t) => {
          const on = shown.includes(t.id)
          const focused = on && shown[focus] === t.id
          return (
            <div key={t.id} className="group/tab relative">
              <button
                onClick={() => pick(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.shiftKey && !isMobile) {
                    e.preventDefault()
                    stackTab(t.id)
                  }
                }}
                onContextMenu={(e) => {
                  if (isMobile) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const keyboard = e.clientX === 0 && e.clientY === 0
                  setMenu({ tab: t.id, x: Math.min(keyboard ? r.left : e.clientX, window.innerWidth - 168), y: keyboard ? r.bottom + 4 : e.clientY, from: e.currentTarget })
                }}
                className={clsx(
                  'flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-[12.5px] transition-colors',
                  focused ? 'bg-elev-2 text-fg' : on ? 'bg-elev text-fg hover:bg-elev-2' : 'text-muted hover:bg-elev hover:text-fg'
                )}
                aria-pressed={on}
                aria-label={t.label}
                title={t.label}
                aria-keyshortcuts={isMobile ? undefined : 'Shift+Enter'}
              >
                <t.icon size={14} weight={focused ? 'fill' : 'regular'} className="shrink-0" />
                <span className={clsx('whitespace-nowrap', focused ? 'hidden @[380px]:inline' : 'hidden @[520px]:inline')}>{t.label}</span>
              </button>
              {!isMobile && (
                <button
                  onClick={() => stackTab(t.id)}
                  aria-disabled={!canStack(stack)}
                  aria-label={`Stack ${t.label} below`}
                  title={canStack(stack) ? 'Stack below' : FULL}
                  className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-md border border-line bg-panel text-dim opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/tab:opacity-100 aria-disabled:cursor-not-allowed aria-disabled:hover:text-dim"
                >
                  <Rows size={14} />
                </button>
              )}
            </div>
          )
        })}
        <div className="flex-1" />
        <button onClick={() => set({ open: false })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg" aria-label="Close panel" title="Close (Ctrl+`)">
          <X size={15} />
        </button>
      </div>
      <div ref={body} className="relative grid min-h-0 flex-1" style={{ gridTemplateRows: rows, gridTemplateColumns: 'minmax(0, 1fr)' }}>
        {multi &&
          shown.map((tab, i) => {
            const t = TABS.find((x) => x.id === tab)!
            return [
              <div
                key={`header-${tab}`}
                style={{ gridRow: row(i) - 1, gridColumn: 1 }}
                onPointerDown={() => focusAt(i)}
                className="flex h-7 items-center gap-1.5 border-b border-line pl-2.5 pr-0.5 text-[12px] text-muted"
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
      </div>
      {menu && (
        <div ref={menuRef} role="menu" className="fixed z-50 w-40 rounded-lg border border-line-strong bg-panel p-1 shadow-lg shadow-black/40" style={{ left: menu.x, top: menu.y }}>
          <button
            role="menuitem"
            aria-disabled={!canStack(stack)}
            title={canStack(stack) ? undefined : FULL}
            onClick={() => {
              if (!canStack(stack)) return
              stackTab(menu.tab)
              setMenu(null)
              menu.from.focus()
            }}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-muted hover:bg-elev-2 hover:text-fg focus-visible:bg-elev-2 focus-visible:text-fg focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted"
          >
            <Rows size={14} />
            Stack below
          </button>
        </div>
      )}
    </aside>
  )
}

