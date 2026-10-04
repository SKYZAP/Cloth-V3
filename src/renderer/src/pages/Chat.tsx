import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import {
  ArrowClockwise,
  ArrowUp,
  Books,
  Brain,
  CaretRight,
  Check,
  ChatCircleDots,
  Copy,
  Cube,
  Desktop,
  FolderDashed,
  FolderPlus,
  FolderSimple,
  GlobeHemisphereWest,
  GraduationCap,
  LockSimple,
  PencilSimpleLine,
  Robot,
  ImageSquare,
  Plugs,
  Code,
  ShieldCheck,
  ShieldWarning,
  SidebarSimple,
  TerminalWindow,
  MagnifyingGlass,
  NotePencil,
  Paperclip,
  Plus,
  SlidersHorizontal,
  Sparkle,
  Stack,
  Stop,
  ToggleRight,
  Trash,
  Wrench,
  X,
  type Icon
} from '@phosphor-icons/react'
import { DEFAULT_CONTAINER } from '@shared/types'
import type { ApprovalDecision, AutoApprove, ChatSession, McpClientStatus, WorkspaceFile, Collection, ContainerStatus, Project, ContextUsage, PendingApproval, PendingQuestion, RagHit, Skill, ThinkingLevel, UiMessage } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { compact, timeAgo } from '@/lib/format'
import { Button, Empty, Input, ListPane, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Markdown } from '@/components/Markdown'
import { ReferenceCard, ToolGroup, ToolTraceCard } from '@/components/ToolTrace'
import { BottomSheet } from '@/components/BottomSheet'
import { Tooltip } from '@/components/Tooltip'
import { Logo } from '@/components/Logo'
import { ApprovalCard } from '@/components/ApprovalCard'
import { QuestionCard } from '@/components/QuestionCard'
import { ContextMeter, latestTodos, PlanPanel } from '@/components/Planning'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { isMobile, useSideBySide } from '@/lib/platform'
import { ProjectDialog, ProjectHeader } from './chat/Projects'
import { ContainerPill } from './chat/ContainerChanges'
import { MAX_ATTACHMENTS, PendingAttachments, readAttachments, SentAttachments, type Pending } from './chat/Attachments'
import { SidePanel, usePanelState } from './chat/SidePanel'

const SPRING_PRESS = { type: 'spring', stiffness: 700, damping: 14 } as const
const ENTER = { type: 'spring', stiffness: 260, damping: 28 } as const
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']
const COLLAPSED_KEY = 'cloth.projects.collapsed'

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

export function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  // Only say there are no chats once the list has actually loaded (not while the phone is reconnecting).
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem('cloth.chat') || null)
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(false)
  const side = useSideBySide()

  const load = async () => {
    const list = await api.chat.list()
    setSessions(list)
    setLoaded(true)
    setRunning(new Set(await api.chat.running()))
    if (!activeId || !list.some((s) => s.id === activeId)) setActiveId(list[0]?.id ?? null)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem('cloth.chat', activeId)
    } catch {
      /* storage unavailable */
    }
  }, [activeId])

  useEvent('chat', (e) => {
    if (e.type === 'start') setRunning((r) => new Set(r).add(e.sessionId))
    if (e.type === 'end')
      setRunning((r) => {
        const n = new Set(r)
        n.delete(e.sessionId)
        return n
      })
    if (e.type === 'title') setSessions((ss) => ss.map((s) => (s.id === e.sessionId ? { ...s, title: e.title } : s)))
  })

  const create = async (projectId: string | null = null) => {
    const s = await attempt(() => api.chat.create(projectId ? { projectId } : {}))
    if (s) {
      setSessions((ss) => [s, ...ss])
      setActiveId(s.id)
      setOpen(true)
      if (projectId) setCollapsed((c) => toggled(c, projectId, false))
    }
  }

  const remove = async (id: string) => {
    await attempt(() => api.chat.remove(id))
    const rest = sessions.filter((s) => s.id !== id)
    setSessions(rest)
    if (activeId === id) setActiveId(rest[0]?.id ?? null)
  }

  // Projects: collapsible groups of chats, remembered per device.
  const [projects, setProjects] = useState<Project[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readJson<string[]>(COLLAPSED_KEY, [])))
  const [editing, setEditing] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null })
  const loadProjects = async () => setProjects(await api.projects.list())
  useEffect(() => {
    void loadProjects().catch(() => undefined)
  }, [])
  useEffect(() => writeJson(COLLAPSED_KEY, [...collapsed]), [collapsed])
  const toggled = (set: Set<string>, id: string, value = !set.has(id)) => {
    const next = new Set(set)
    if (value) next.add(id)
    else next.delete(id)
    return next
  }

  const active = sessions.find((s) => s.id === activeId) ?? null
  const shown = sessions.filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()))
  const known = new Set(projects.map((p) => p.id))
  const loose = shown.filter((s) => !s.projectId || !known.has(s.projectId))

  const row = (s: ChatSession, nested: boolean) => {
    const on = s.id === activeId
    return (
      <div
        key={s.id}
        onClick={() => (setActiveId(s.id), setOpen(true))}
        className={clsx(
          'group mx-0.5 my-1 flex cursor-default items-center gap-2 rounded-[10px] border py-[11px] pr-2 transition-colors duration-200 mobile:py-3.5',
          nested ? 'pl-6' : 'pl-3.5',
          on && side ? 'border-crimson bg-elev-2' : 'border-transparent hover:bg-elev'
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {running.has(s.id) && <span className="pulse-crimson h-1.5 w-1.5 shrink-0 rounded-full bg-crimson" />}
            <span className={clsx('truncate text-[12.5px] font-semibold mobile:text-[14.5px]', on ? 'text-fg' : 'text-fg/90')}>{s.title}</span>
          </div>
          <div className="mt-px truncate text-[11px] text-dim mobile:text-[12px]">
            {s.model?.modelId ?? 'no model'} · {timeAgo(s.updatedAt)}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            void remove(s.id)
          }}
          title="Delete chat"
          className={clsx(
            'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-dim transition-colors hover:bg-hover hover:text-crimson-hi',
            on || isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        >
          <Trash size={15} />
        </button>
      </div>
    )
  }

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        header={
          <div className="flex gap-2">
            <div className="relative flex-1">
              <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" />
              <Input className="pl-7" placeholder="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <motion.button
              whileTap={{ scale: 0.9 }}
              transition={SPRING_PRESS}
              onClick={() => setEditing({ open: true, project: null })}
              title="New project"
              aria-label="New project"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted hover:border-line-strong hover:text-fg"
            >
              <FolderPlus size={16} />
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              transition={SPRING_PRESS}
              onClick={() => void create()}
              title="New chat"
              aria-label="New chat"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crimson text-white hover:bg-crimson-hi"
            >
              <Plus size={16} weight="bold" />
            </motion.button>
          </div>
        }
      >
        {projects.map((p) => {
          const chats = shown.filter((s) => s.projectId === p.id)
          // While searching, only projects with matches show, opened up.
          if (filter && !chats.length) return null
          const isCollapsed = !filter && collapsed.has(p.id)
          return (
            <div key={p.id}>
              <ProjectHeader
                project={p}
                count={chats.length}
                collapsed={isCollapsed}
                running={chats.some((s) => running.has(s.id))}
                onToggle={() => setCollapsed((c) => toggled(c, p.id))}
                onNewChat={() => void create(p.id)}
                onEdit={() => setEditing({ open: true, project: p })}
              />
              <AnimatePresence initial={false}>
                {!isCollapsed && (
                  <motion.div key="chats" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }} className="overflow-hidden">
                    {chats.map((s) => row(s, true))}
                    {!chats.length && (
                      <button onClick={() => void create(p.id)} className="mx-0.5 my-1 w-[calc(100%-4px)] rounded-[10px] py-2 pl-6 text-left text-[12px] text-dim hover:bg-elev hover:text-muted">
                        No chats yet — start one
                      </button>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
        {!!projects.length && !!loose.length && <div className="mx-2 mb-0.5 mt-4 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim">Chats</div>}
        {loose.map((s) => row(s, false))}
        {loaded && !sessions.length && !projects.length && <div className="p-4 text-center text-[12px] text-dim">No chats yet</div>}
      </ListPane>

      <ProjectDialog
        open={editing.open}
        project={editing.project}
        from={active}
        onClose={() => setEditing((e) => ({ ...e, open: false }))}
        onSaved={(p) => {
          setEditing({ open: false, project: null })
          void loadProjects()
          // A new folder may have moved chats with it.
          void load()
          setCollapsed((c) => toggled(c, p.id, false))
        }}
        onDeleted={() => {
          setEditing({ open: false, project: null })
          void loadProjects()
          void load()
        }}
      />

      <SplitDetail>
        {active ? (
          <ChatView
            key={active.id}
            session={active}
            running={running.has(active.id)}
            onChange={(s) => setSessions((ss) => ss.map((x) => (x.id === s.id ? s : x)))}
          />
        ) : (
          <Empty icon={<Logo size={22} />} title="Start a conversation" action={<Button variant="primary" onClick={() => void create()}>New chat</Button>}>
            Chat with any registered model. The agent can search your knowledge base and the web, load skills, call your tools, and read or edit files in a workspace folder — every tool call is traced.
          </Empty>
        )}
      </SplitDetail>
    </SplitRoot>
  )
}

type SheetSection = 'knowledge' | 'workspace' | 'thinking' | 'capabilities' | 'external' | null

function ChatView({ session, running, onChange }: { session: ChatSession; running: boolean; onChange(s: ChatSession): void }) {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sheet, setSheet] = useState<{ open: boolean; section: SheetSection }>({ open: false, section: null })
  const [invoked, setInvoked] = useState<string[]>([])
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [slash, setSlash] = useState<{ query: string; start: number; end: number } | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [attachments, setAttachments] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const collections = useApp((s) => s.collections)
  const providers = useApp((s) => s.providers)
  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  // Messages present when the chat opened render still; anything after animates in.
  const initialIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    void api.skills.list().then(setSkills).catch(() => undefined)
  }, [])

  useEffect(() => {
    void api.chat.messages(session.id).then((ms) => {
      initialIds.current = new Set(ms.map((m) => m.id))
      setMessages(ms)
    })
    void api.chat.pendingApprovals(session.id).then(setApprovals)
    void api.chat.pendingQuestions(session.id).then(setQuestions)
    setShowArchived(false)
  }, [session.id])

  const refreshUsage = () => void api.chat.contextUsage(session.id).then(setUsage).catch(() => setUsage(null))
  useEffect(refreshUsage, [session.id, session.model?.modelId])

  useEvent('chat', (e) => {
    if (e.sessionId !== session.id) return
    if (e.type === 'message') {
      setMessages((ms) => {
        const i = ms.findIndex((m) => m.id === e.message.id)
        if (i < 0) return [...ms, e.message]
        const next = ms.slice()
        next[i] = e.message
        return next
      })
    }
    if (e.type === 'approval') setApprovals((as) => (as.some((a) => a.id === e.approval.id) ? as : [...as, e.approval]))
    if (e.type === 'approval-done') setApprovals((as) => as.filter((a) => a.id !== e.id))
    if (e.type === 'question') setQuestions((qs) => (qs.some((q) => q.id === e.question.id) ? qs : [...qs, e.question]))
    if (e.type === 'question-done') setQuestions((qs) => qs.filter((q) => q.id !== e.id))
    if (e.type === 'compacting') setCompacting(true)
    if (e.type === 'compacted') {
      setCompacting(false)
      void api.chat.messages(session.id).then(setMessages)
      refreshUsage()
      if (e.error) useApp.getState().toast(`Couldn't summarise: ${e.error}`, 'error')
    }
    if (e.type === 'end') {
      setApprovals([])
      setQuestions([])
      refreshUsage()
      void api.chat.messages(session.id).then(setMessages)
      if (e.error && !/abort/i.test(e.error)) useApp.getState().toast(e.error, 'error')
    }
  })

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: initialIds.current && initialIds.current.size !== messages.length ? 'smooth' : 'auto' })
  }, [messages])

  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(220, el.scrollHeight)}px`
  }, [draft])

  const [titling, setTitling] = useState(false)
  const update = async (patch: Partial<ChatSession>) => {
    const s = await attempt(() => api.chat.update(session.id, patch))
    if (s) onChange(s)
  }

  const send = async (text = draft, withSkills = invoked) => {
    const t = text.trim()
    const files = attachments
    if ((!t && !withSkills.length && !files.length) || running) return
    stick.current = true
    setDraft('')
    setInvoked([])
    setSlash(null)
    setAttachments([])
    const sent = await attempt(async () => {
      await api.chat.send(session.id, t, withSkills, files.map(({ name, mimeType, data }) => ({ name, mimeType, data })))
      return true
    })
    // Keep what the user wrote and attached when the send is refused (an unreadable file, no model).
    if (!sent) {
      setDraft((d) => d || t)
      setAttachments(files)
    } else files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview))
  }

  const attach = async (files: File[]) => {
    if (!files.length) return
    const room = MAX_ATTACHMENTS - attachments.length
    if (room <= 0) return void useApp.getState().toast(`Attach up to ${MAX_ATTACHMENTS} files at a time`, 'error')
    const { ok, errors } = await readAttachments(files.slice(0, room))
    if (files.length > room) errors.push(`Only the first ${room} file${room > 1 ? 's were' : ' was'} added (${MAX_ATTACHMENTS} at most)`)
    setAttachments((cur) => [...cur, ...ok])
    if (errors.length) useApp.getState().toast(errors.join(' · '), 'error')
    textarea.current?.focus()
  }
  // ─── Side panel (terminal, files, git) ──────────────────────────────────────
  const [panel, setPanel] = usePanelState()
  useEffect(() => {
    // Ctrl+` opens the terminal (or closes the panel when it's already showing it).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '`' || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setPanel(panel.open && panel.tab === 'terminal' ? { open: false } : { open: true, tab: 'terminal' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const attachWorkspaceFile = async (f: WorkspaceFile) => {
    const bytes = f.kind === 'image' && f.data ? Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)) : new TextEncoder().encode(f.text ?? '')
    await attach([new File([bytes], f.path.split('/').pop() || 'file', { type: f.mimeType ?? 'text/plain' })])
    if (isMobile) setPanel({ open: false })
  }
  const insertPath = (path: string) => {
    setDraft((d) => `${d}${d && !/\s$/.test(d) ? ' ' : ''}\`${path}\` `)
    if (isMobile) setPanel({ open: false })
    textarea.current?.focus()
  }
  const pickFolder = async () => {
    const [folder] = await api.app.pickPaths({ directory: true, title: 'Choose a folder for this chat' })
    if (folder) await update({ workspace: folder })
  }

  const unattach = (key: string) =>
    setAttachments((cur) => {
      const gone = cur.find((a) => a.key === key)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return cur.filter((a) => a.key !== key)
    })

  // Slash commands: "/name" at the start of a word opens the skill picker.
  const matches = useMemo(() => {
    if (!slash) return []
    const q = slash.query.toLowerCase()
    return skills
      .filter((sk) => !invoked.includes(sk.name) && (!q || sk.name.includes(q) || sk.description.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 8)
  }, [slash, skills, invoked])

  const detectSlash = (value: string, caret: number) => {
    const m = /(^|\s)\/([a-z0-9-]*)$/.exec(value.slice(0, caret))
    if (!m) return setSlash(null)
    if (!slash) void api.skills.list().then(setSkills).catch(() => undefined)
    setSlash({ query: m[2], start: caret - m[2].length - 1, end: caret })
    setSlashIndex(0)
  }

  const pickSkill = (sk: Skill) => {
    if (!slash) return
    const at = slash.start
    setDraft(draft.slice(0, slash.start) + draft.slice(slash.end))
    setInvoked((cur) => (cur.includes(sk.name) ? cur : [...cur, sk.name]))
    setSlash(null)
    requestAnimationFrame(() => {
      const el = textarea.current
      if (!el) return
      el.focus()
      el.setSelectionRange(at, at)
    })
  }

  const decide = async (a: PendingApproval, decision: ApprovalDecision) => {
    await attempt(() => api.chat.resolveApproval(a.id, decision))
    // "always" changes this chat's approval policy.
    if (decision === 'always') {
      const s = (await api.chat.list()).find((x) => x.id === session.id)
      if (s) onChange(s)
    }
  }

  const undo = async (toolCallId: string) => {
    try {
      setMessages(await api.chat.undoChange(session.id, toolCallId))
      useApp.getState().toast('Changes undone', 'ok')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/changed since/.test(msg)) return void useApp.getState().toast(msg, 'error')
      if (!(await confirmAction(`${msg}.`, { title: 'Undo anyway?', confirmLabel: 'Overwrite newer changes', danger: true }))) return
      const ms = await attempt(() => api.chat.undoChange(session.id, toolCallId, true))
      if (ms) setMessages(ms)
    }
  }
  const compactNow = async () => {
    const ms = await attempt(() => api.chat.compact(session.id), 'Earlier messages summarised')
    if (ms) setMessages(ms)
  }
  const archived = useMemo(() => messages.filter((m) => m.archived), [messages])
  const live = useMemo(() => messages.filter((m) => !m.archived), [messages])
  const todos = useMemo(() => latestTodos(messages), [messages])
  // The plan stays pinned while it has open items, then lingers briefly once finished and goes away
  // (a finished plan doesn't come back when the next message starts a run).
  const planActive = !!todos?.length && todos.some((t) => t.status !== 'completed')
  const planDone = !!todos?.length && !planActive
  const [planLingering, setPlanLingering] = useState(false)
  const planWasActive = useRef(false)
  useEffect(() => {
    if (planActive) {
      planWasActive.current = true
      setPlanLingering(false)
      return
    }
    if (!planWasActive.current) return
    planWasActive.current = false
    if (!planDone) return
    setPlanLingering(true)
    const t = setTimeout(() => setPlanLingering(false), 3000)
    return () => {
      clearTimeout(t)
      setPlanLingering(false)
    }
  }, [planActive, planDone])
  const showPlan = planActive || planLingering
  const awaiting = useMemo(() => new Set([...approvals, ...questions].map((a) => a.toolCallId).filter((x): x is string => !!x)), [approvals, questions])

  const regenerate = async (assistantId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantId)
    const user = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user')
    if (!user) return
    setMessages((ms) => ms.slice(0, ms.indexOf(user)))
    await attempt(() => api.chat.resend(session.id, user.id))
    void api.chat.messages(session.id).then(setMessages)
  }

  const provider = providers.find((p) => p.id === session.model?.providerId)
  const reasoning = !!provider?.models.find((m) => m.id === session.model?.modelId)?.reasoning
  const selected = session.knowledgeEnabled ? (session.collectionIds.length ? session.collectionIds.filter((id) => collections.some((c) => c.id === id)) : collections.map((c) => c.id)) : []
  const openSheet = (section: SheetSection) => setSheet({ open: true, section })
  const waiting = running && messages.at(-1)?.role === 'user'
  const noVision = !!provider && !provider.models.find((m) => m.id === session.model?.modelId)?.vision

  return (
    <div className="flex h-full min-w-0">
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        void attach([...e.dataTransfer.files])
      }}
    >
      <AnimatePresence>
        {dragging && (
          <motion.div
            key="drop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-[22px] border-2 border-dashed border-crimson-line bg-bg/85 text-[14px] text-fg backdrop-blur-sm"
          >
            <Paperclip size={26} className="text-crimson-hi" />
            Drop files or images to attach
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header floats over the conversation and fades into it */}
      <header className="absolute inset-x-0 top-0 z-10 flex h-14 items-center gap-3 bg-gradient-to-b from-bg from-55% to-transparent px-5 mobile:gap-1.5 mobile:px-3">
        <SplitBack />
        <input
          key={session.title}
          className="min-w-0 flex-1 truncate bg-transparent text-[14px] font-semibold tracking-tight outline-none focus-visible:outline-none"
          defaultValue={session.title}
          onBlur={(e) => e.target.value.trim() && e.target.value !== session.title && void update({ title: e.target.value.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {session.titleSource && (
          <Tooltip content={titling ? 'Writing a title…' : 'Write a new title with AI'}>
            <button
              onClick={async () => {
                setTitling(true)
                await attempt(() => api.chat.retitle(session.id))
                setTitling(false)
              }}
              disabled={titling}
              aria-label="Write a new title with AI"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev-2 hover:text-crimson-hi disabled:opacity-60 mobile:hidden"
            >
              <Sparkle size={14} className={titling ? 'animate-pulse text-crimson-hi' : undefined} />
            </button>
          </Tooltip>
        )}
        {session.container && <ContainerPill session={session} running={running} />}
        <ModelPicker pill className="w-64 mobile:w-[46%] mobile:shrink-0" value={session.model} onChange={(model) => void update({ model })} />
        <Tooltip content={panel.open ? 'Hide terminal, files and git' : 'Terminal, files and git (Ctrl+`)'}>
          <motion.button
            whileTap={{ scale: 0.88 }}
            transition={SPRING_PRESS}
            onClick={() => setPanel({ open: !panel.open })}
            aria-pressed={panel.open}
            aria-label="Toggle side panel"
            className={clsx('flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-elev-2', panel.open ? 'text-crimson-hi' : 'text-dim hover:text-fg')}
          >
            <SidebarSimple size={17} weight={panel.open ? 'fill' : 'regular'} className="-scale-x-100" />
          </motion.button>
        </Tooltip>
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        // Attached images load after the scroll to the bottom and push the latest message down.
        onLoadCapture={(e) => {
          const el = e.currentTarget
          if (stick.current && e.target instanceof HTMLImageElement) el.scrollTo({ top: el.scrollHeight })
        }}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        }}
      >
        {/* A chat log: screen readers announce new turns, and wait while a reply is still streaming. */}
        <div role="log" aria-label="Conversation" aria-live="polite" aria-busy={running} className="mx-auto w-[min(740px,calc(100%-64px))] pb-[220px] pt-[84px] mobile:w-[calc(100%-28px)] mobile:pb-[190px] mobile:pt-[64px]">
          {!messages.length && <Welcome onPick={(t) => void send(t)} hasKnowledge={collections.length > 0} />}
          {archived.length > 0 && (
            <div className="mb-6">
              <button onClick={() => setShowArchived(!showArchived)} className="mx-auto flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[11.5px] text-dim transition-colors hover:border-line-strong hover:text-muted">
                <CaretRight size={11} className={clsx('transition-transform', showArchived && 'rotate-90')} />
                {showArchived ? 'Hide' : 'Show'} {archived.length} earlier message{archived.length === 1 ? '' : 's'} (summarised)
              </button>
              {showArchived && (
                <div className="mt-6 opacity-55">
                  {archived.map((m) =>
                    m.role === 'user' ? <UserBubble key={m.id} message={m} fresh={false} /> : <AssistantTurn key={m.id} message={m} fresh={false} streaming={false} onRegenerate={() => undefined} awaiting={awaiting} />
                  )}
                </div>
              )}
            </div>
          )}
          {live.map((m, i) => {
            const fresh = !!initialIds.current && !initialIds.current.has(m.id)
            return m.role === 'user' ? (
              <div key={m.id}>
                {m.summary !== undefined && <SummaryDivider summary={m.summary} />}
                <UserBubble message={m} fresh={fresh} />
              </div>
            ) : (
              <AssistantTurn key={m.id} message={m} fresh={fresh} streaming={running && i === live.length - 1} onRegenerate={() => void regenerate(m.id)} awaiting={awaiting} onUndo={running ? undefined : undo} />
            )
          })}
          <AnimatePresence>
            {approvals.map((a) => (
              <ApprovalCard key={a.id} approval={a} onDecide={(d) => decide(a, d)} />
            ))}
            {questions.map((q) => (
              <QuestionCard key={q.id} question={q} onAnswer={(answer) => attempt(() => api.chat.answerQuestion(q.id, answer)).then(() => undefined)} />
            ))}
          </AnimatePresence>
          <AnimatePresence>
            {compacting && (
              <motion.div key="compacting" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mb-9 flex items-center justify-center gap-2 text-[12.5px] text-dim">
                <NotePencil size={14} />
                <span className="shimmer-text">Summarising earlier conversation</span>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {waiting && (
              <motion.div key="thinking" initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0 }} transition={ENTER} className="mb-9 grid grid-cols-[28px_1fr] gap-4">
                <Logo size={28} />
                <div className="flex items-center gap-2 pt-1 text-[12.5px] text-dim">
                  <Brain size={14} />
                  <span className="shimmer-text">Thinking</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Composer: floats over a gradient fade — no divider line */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-b from-transparent via-bg/90 via-40% to-bg pb-[22px] pt-12 mobile:pb-2.5 mobile:pt-8">
        <AnimatePresence>{showPlan && todos && <PlanPanel key="plan" todos={todos} />}</AnimatePresence>
        <div
          className={clsx(
            'group/composer pointer-events-auto relative mx-auto w-[min(740px,calc(100%-64px))] rounded-[22px] mobile:w-[calc(100%-20px)] border border-line-strong bg-panel shadow-[0_12px_40px_-12px_rgb(0_0_0/0.7)] transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(.32,.72,0,1)]',
            'focus-within:-translate-y-px focus-within:border-crimson-line focus-within:shadow-[0_16px_44px_-14px_rgb(0_0_0/0.8),0_0_0_4px_rgb(220_38_69/0.10)]'
          )}
        >
          <AnimatePresence>
            {slash && <SlashMenu key="slash" skills={matches} total={skills.length} index={slashIndex} query={slash.query} onPick={pickSkill} onHover={setSlashIndex} />}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {invoked.length > 0 && (
              <motion.div key="chips" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }} className="overflow-hidden">
                <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                  <AnimatePresence initial={false}>
                    {invoked.map((name) => (
                      <motion.span
                        key={name}
                        layout
                        initial={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
                        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                        className="flex items-center gap-1.5 rounded-full border border-crimson-line bg-crimson-soft py-0.5 pl-2 pr-1 font-mono text-[11.5px] text-crimson-hi"
                      >
                        <Sparkle size={12} weight="fill" />/{name}
                        <button onClick={() => setInvoked((cur) => cur.filter((n) => n !== name))} className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-crimson-line" aria-label={`Remove ${name}`}>
                          <X size={10} weight="bold" />
                        </button>
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <PendingAttachments items={attachments} onRemove={unattach} noVision={noVision} />
          <textarea
            ref={textarea}
            value={draft}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (!files.length) return
              e.preventDefault()
              void attach(files)
            }}
            onChange={(e) => {
              setDraft(e.target.value)
              detectSlash(e.target.value, e.target.selectionStart)
            }}
            onSelect={(e) => {
              const el = e.currentTarget
              if (slash && (el.selectionStart < slash.start || el.selectionStart !== el.selectionEnd)) setSlash(null)
            }}
            onBlur={() => setTimeout(() => setSlash(null), 120)}
            onKeyDown={(e) => {
              if (slash && matches.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickSkill(matches[Math.min(slashIndex, matches.length - 1)])
                  return
                }
              }
              if (slash && e.key === 'Escape') {
                e.preventDefault()
                setSlash(null)
                return
              }
              if (e.key === 'Backspace' && invoked.length && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
                setInvoked((cur) => cur.slice(0, -1))
                return
              }
              // Phones: Enter is a newline; the send button sends.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isMobile) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            placeholder={!session.model ? 'Pick a model above to start' : invoked.length ? 'Add details for the skill, or just send…' : 'Ask anything — type / to invoke a skill'}
            className="block max-h-[220px] w-full resize-none bg-transparent px-[18px] pb-1.5 pt-4 text-[14.5px] leading-relaxed text-fg outline-none placeholder:text-dim focus-visible:outline-none"
          />
          <div className="flex items-center gap-0.5 pb-2 pl-2.5 pr-2 pt-1.5">
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void attach([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
            <ComposerToggle icon={Paperclip} label="Attach" active={attachments.length > 0} state="Files and images · or drop / paste them" count={attachments.length || undefined} onClick={() => fileInput.current?.click()} />
            <Tooltip content="Knowledge, folder, tools and instructions for this chat">
              <button onClick={() => openSheet(null)} className="ml-0.5 flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] px-2 text-[12.5px] text-muted transition-colors hover:bg-elev-2 hover:text-fg">
                <SlidersHorizontal size={16} />
                <span className="mobile:hidden">Context</span>
              </button>
            </Tooltip>
            <ComposerChips session={session} selected={selected} collections={collections.length} reasoning={reasoning} onOpen={openSheet} />
            <div className="flex-1" />
            <ContextMeter usage={usage} busy={compacting} onCompact={() => void compactNow()} />
            <SendButton running={running} disabled={!running && ((!draft.trim() && !invoked.length && !attachments.length) || !session.model)} onSend={() => void send()} onStop={() => void api.chat.abort(session.id)} />
          </div>
        </div>
      </div>

      <BottomSheet
        open={sheet.open}
        onClose={() => setSheet((s) => ({ ...s, open: false }))}
        title="Chat context"
        description="What this chat's agent can see and do. Drag down to close."
        scrollTo={sheet.section ? `sheet-${sheet.section}` : null}
      >
        <ContextSheet session={session} collections={collections} selected={selected} reasoning={reasoning} update={update} />
      </BottomSheet>
    </div>
    {panel.open && <SidePanel session={session} state={panel} set={setPanel} onAttach={(f) => void attachWorkspaceFile(f)} onInsert={insertPath} onPickFolder={() => void pickFolder()} />}
    </div>
  )
}

const VERDICT_DOT: Record<string, string> = { fresh: 'bg-ok', stale: 'bg-warn', failing: 'bg-crimson', redundant: 'bg-info', untested: 'bg-line-strong' }

function SlashMenu({ skills, total, index, query, onPick, onHover }: { skills: Skill[]; total: number; index: number; query: string; onPick(s: Skill): void; onHover(i: number): void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      style={{ transformOrigin: 'bottom left' }}
      className="sheet-glass absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[18px] border border-line-strong"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2 text-[11px] text-dim">
        <span className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.06em]">
          <Sparkle size={12} /> Skills
          {query ? <span className="font-mono normal-case tracking-normal text-muted">/{query}</span> : null}
        </span>
        <span>
          <Key>↑</Key> <Key>↓</Key> navigate · <Key>Enter</Key> invoke · <Key>Esc</Key> close
        </span>
      </div>
      {skills.length ? (
        <LayoutGroup id="slash">
          <div className="max-h-72 overflow-y-auto p-1.5">
            {skills.map((sk, i) => (
              <button key={sk.name} onMouseEnter={() => onHover(i)} onClick={() => onPick(sk)} className="relative flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left">
                {i === index && <motion.span layoutId="slash-hl" transition={{ type: 'spring', stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-xl bg-elev-2" />}
                <span className={clsx('relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition-colors', i === index ? 'bg-crimson-soft text-crimson-hi' : 'bg-elev text-dim')}>
                  <Sparkle size={16} weight={i === index ? 'fill' : 'regular'} />
                </span>
                <span className="relative min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] text-fg">/{sk.name}</span>
                    <span className={clsx('h-1.5 w-1.5 rounded-full', VERDICT_DOT[sk.health?.verdict ?? 'untested'])} title={sk.health?.verdict ?? 'untested'} />
                  </span>
                  <span className="block truncate text-[11.5px] text-dim">{sk.description || 'No description'}</span>
                </span>
              </button>
            ))}
          </div>
        </LayoutGroup>
      ) : (
        <div className="px-4 py-4 text-[12px] text-dim">{total ? `No skill matches “/${query}”.` : 'No skills yet — create or import one on the Skills page.'}</div>
      )}
    </motion.div>
  )
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-b-2 border-line-strong px-1 font-mono text-[10px] text-muted">{children}</kbd>
}

/** What this chat has switched on, as readable chips; each opens its part of the context sheet. */
function ComposerChips({ session, selected, collections, reasoning, onOpen }: { session: ChatSession; selected: string[]; collections: number; reasoning: boolean; onOpen(s: SheetSection): void }) {
  const settings = useApp((s) => s.settings)
  const servers = (settings?.mcpClients ?? []).filter((c) => c.enabled)
  const chosen = session.mcpServers ?? servers.filter((c) => c.defaultOn).map((c) => c.id)
  const folder = session.workspace?.split(/[\\/]/).pop()
  const chips: { key: string; icon: Icon; label: string; detail?: string; title: string; section: SheetSection }[] = []
  if (session.container) chips.push({ key: 'container', icon: Cube, label: folder ?? 'Container', detail: 'container', title: `Works in a ${session.container.image} container`, section: 'workspace' })
  else if (folder) chips.push({ key: 'folder', icon: FolderSimple, label: folder, detail: session.fileAccess === 'write' ? (session.shell ? 'edits + shell' : 'edits') : session.shell ? 'read + shell' : 'read-only', title: session.workspace ?? '', section: 'workspace' })
  if (selected.length) chips.push({ key: 'knowledge', icon: Books, label: 'Knowledge', detail: selected.length === collections ? undefined : String(selected.length), title: `${selected.length} collection${selected.length > 1 ? 's' : ''}`, section: 'knowledge' })
  if (session.webEnabled) chips.push({ key: 'web', icon: GlobeHemisphereWest, label: 'Web', title: 'Web search and pages', section: 'capabilities' })
  if (reasoning && session.thinking !== 'off') chips.push({ key: 'thinking', icon: Brain, label: 'Thinking', detail: session.thinking, title: 'Reasoning effort', section: 'thinking' })
  for (const c of servers) if (chosen.includes(c.id)) chips.push({ key: c.id, icon: Plugs, label: c.name, title: `Tools from the ${c.name} MCP server`, section: 'external' })
  if (!session.skillsEnabled) chips.push({ key: 'skills', icon: Sparkle, label: 'Skills off', title: 'Skills are off (/name still invokes one)', section: 'capabilities' })
  if (!chips.length) return null
  return (
    <div className="ml-1 flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {chips.map((c) => (
        <button
          key={c.key}
          onClick={() => onOpen(c.section)}
          title={c.title}
          className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elev px-2 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          <c.icon size={12} />
          <span className="max-w-[160px] truncate">{c.label}</span>
          {c.detail && <span className="text-dim">{c.detail}</span>}
        </button>
      ))}
    </div>
  )
}

function ComposerToggle({ icon: I, label, active, state, count, onClick }: { icon: Icon; label: string; active: boolean; state?: string; count?: number; onClick(): void }) {
  return (
    <Tooltip
      content={
        <>
          <b className="font-semibold">{label}</b>
          <span className={clsx('ml-1.5 capitalize', active ? 'text-crimson-hi' : 'text-dim')}>{state ?? (active ? 'On' : 'Off')}</span>
        </>
      }
    >
      <motion.button
        whileTap={{ scale: 0.86 }}
        transition={SPRING_PRESS}
        onClick={onClick}
        aria-pressed={active}
        aria-label={label}
        className={clsx(
          'relative flex h-[34px] w-[34px] items-center justify-center rounded-[11px] transition-colors duration-200',
          active ? 'text-crimson-hi' : 'text-dim hover:bg-elev-2 hover:text-muted'
        )}
      >
        <I size={18} weight={active ? 'fill' : 'regular'} className={active ? 'glow-crimson' : ''} />
        <motion.span
          initial={false}
          animate={{ scale: active && count === undefined ? 1 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 18 }}
          className="absolute bottom-[3px] left-1/2 -ml-0.5 h-1 w-1 rounded-full bg-crimson-hi"
        />
        <AnimatePresence>
          {count !== undefined && (
            <motion.span
              key={count}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              className="absolute right-0.5 top-[3px] h-3.5 min-w-3.5 rounded-full bg-crimson px-[3px] text-center text-[9px] font-bold leading-[14px] text-white"
            >
              {count}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </Tooltip>
  )
}

function SendButton({ running, disabled, onSend, onStop }: { running: boolean; disabled: boolean; onSend(): void; onStop(): void }) {
  return (
    <motion.button
      whileTap={{ scale: 0.92 }}
      onClick={running ? onStop : onSend}
      disabled={disabled}
      title={running ? 'Stop' : isMobile ? 'Send' : 'Send (Enter) — Shift+Enter for a new line'}
      aria-label={running ? 'Stop the reply' : 'Send message'}
      className="relative h-9 w-9 overflow-hidden rounded-xl bg-crimson text-white transition-colors hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={running ? 'stop' : 'send'}
          initial={{ opacity: 0, scale: 0.6, y: running ? 8 : -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: running ? -8 : 8 }}
          transition={{ type: 'spring', stiffness: 500, damping: 26 }}
          className="absolute inset-0 flex items-center justify-center"
        >
          {running ? <Stop size={16} weight="fill" /> : <ArrowUp size={17} weight="bold" />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  )
}

function ContextSheet({
  session,
  collections,
  selected,
  reasoning,
  update
}: {
  session: ChatSession
  collections: Collection[]
  selected: string[]
  reasoning: boolean
  update(p: Partial<ChatSession>): Promise<void>
}) {
  const [instructions, setInstructions] = useState(session.systemPrompt)
  useEffect(() => setInstructions(session.systemPrompt), [session.systemPrompt])
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    void api.projects.list().then(setProjects, () => undefined)
  }, [])
  // Moving into a project with a folder gives a folder-less chat that folder to work in.
  const moveTo = (p: Project | null) =>
    void update({ projectId: p?.id ?? null, ...(p?.folder && !session.workspace ? { workspace: p.folder } : {}) })

  const toggleCollection = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    if (!next.length) return void update({ knowledgeEnabled: false, collectionIds: [] })
    void update({ knowledgeEnabled: true, collectionIds: next.length === collections.length ? [] : next })
  }

  return (
    <div className="space-y-[22px]">
      {!!projects.length && (
        <SheetSection id="sheet-project" icon={FolderSimple} title="Project">
          <div className="flex flex-wrap gap-1.5">
            {[null, ...projects].map((p) => {
              const on = (p?.id ?? null) === session.projectId
              return (
                <button
                  key={p?.id ?? 'none'}
                  onClick={() => moveTo(p)}
                  aria-pressed={on}
                  className={clsx('flex h-8 items-center gap-2 rounded-[10px] border px-3 text-[12.5px] transition-colors mobile:h-10', on ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line bg-elev text-muted hover:border-line-strong')}
                >
                  {p ? <FolderSimple size={14} weight="fill" style={{ color: p.color }} /> : <X size={12} />}
                  {p?.name ?? 'No project'}
                </button>
              )
            })}
          </div>
        </SheetSection>
      )}
      <SheetSection id="sheet-knowledge" icon={Books} title="Knowledge">
        {collections.length ? (
          <div className="grid grid-cols-3 gap-2 mobile:grid-cols-2">
            {collections.map((c) => {
              const on = selected.includes(c.id)
              const I = c.name === 'Cloth examples' ? GraduationCap : c.embeddingDim ? Stack : Books
              return (
                <motion.button
                  key={c.id}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => toggleCollection(c.id)}
                  className={clsx(
                    'relative rounded-[14px] border p-3 text-left transition-colors',
                    on ? 'border-crimson-line bg-gradient-to-b from-crimson-soft to-elev' : 'border-line bg-elev hover:border-line-strong'
                  )}
                >
                  <div className={clsx('mb-2.5 flex h-7 w-7 items-center justify-center rounded-[9px] transition-colors', on ? 'bg-crimson-soft text-crimson-hi' : 'bg-elev-2 text-muted')}>
                    <I size={15} weight="fill" />
                  </div>
                  <div className="truncate pr-6 text-[12.5px] font-semibold">{c.name}</div>
                  <div className="text-[11px] text-dim">
                    {c.docCount} docs · {c.embeddingDim ? 'hybrid' : 'BM25'}
                  </div>
                  <motion.div
                    initial={false}
                    animate={{ scale: on ? 1 : 0.85, backgroundColor: on ? '#dc2645' : 'rgba(0,0,0,0)', borderColor: on ? '#dc2645' : '#303036' }}
                    transition={{ type: 'spring', stiffness: 600, damping: 18 }}
                    className="absolute right-2.5 top-2.5 flex h-[18px] w-[18px] items-center justify-center rounded-md border-[1.5px] text-white"
                  >
                    {on && <Check size={11} weight="bold" />}
                  </motion.div>
                </motion.button>
              )
            })}
          </div>
        ) : (
          <div className="rounded-[14px] border border-dashed border-line-strong p-3 text-[12px] text-dim">No collections yet — add knowledge on the Knowledge page.</div>
        )}
      </SheetSection>

      <SheetSection id="sheet-capabilities" icon={ToggleRight} title="Capabilities">
        <div className="grid grid-cols-3 gap-2 mobile:grid-cols-1">
          <Capability icon={Sparkle} title="Skills" sub="skill_list · skill_use" on={session.skillsEnabled} onToggle={() => void update({ skillsEnabled: !session.skillsEnabled })} />
          <Capability icon={GlobeHemisphereWest} title="Web" sub="web_search · web_fetch" on={session.webEnabled} onToggle={() => void update({ webEnabled: !session.webEnabled })} />
          <Capability icon={Wrench} title="Custom tools" sub="From the Tools page" on={session.customTools} onToggle={() => void update({ customTools: !session.customTools })} />
          <Capability icon={Robot} title="Subagents" sub="task · delegate in parallel" on={session.subagents} onToggle={() => void update({ subagents: !session.subagents })} />
          <Capability icon={ImageSquare} title="Images" sub="generate_image · needs an image model" on={session.imagesEnabled} onToggle={() => void update({ imagesEnabled: !session.imagesEnabled })} />
        </div>
      </SheetSection>

      <ExternalTools session={session} update={update} />

      <SheetSection id="sheet-thinking" icon={Brain} title="Thinking">
        {reasoning ? (
          <LayoutGroup id={`thinking-${session.id}`}>
            <div className="inline-flex rounded-xl border border-line bg-bg p-[3px] mobile:flex mobile:w-full">
              {THINKING_LEVELS.map((l) => (
                <button key={l} onClick={() => void update({ thinking: l })} className={clsx('relative h-[30px] rounded-[9px] px-3.5 text-[12px] capitalize transition-colors mobile:h-9 mobile:flex-1 mobile:px-0', session.thinking === l ? 'text-fg' : 'text-dim hover:text-muted')}>
                  {session.thinking === l && (
                    <motion.span layoutId="thinking-pill" transition={{ type: 'spring', stiffness: 420, damping: 30 }} className="absolute inset-0 rounded-[9px] bg-elev-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_2px_8px_rgb(0_0_0/0.4)]" />
                  )}
                  <span className="relative">{l}</span>
                </button>
              ))}
            </div>
          </LayoutGroup>
        ) : (
          <div className="text-[12px] text-dim">This model isn't marked as a reasoning model. Tick “Reason” for it on the Models page to enable thinking levels.</div>
        )}
      </SheetSection>

      <SheetSection id="sheet-workspace" icon={FolderSimple} title="Workspace">
        <div className="mb-3 space-y-3">
          <OptionRow
            label="Runs in"
            value={session.container ? 'container' : 'local'}
            onChange={(v) => void update(v === 'container' ? { container: session.container ?? DEFAULT_CONTAINER, fileAccess: 'write', shell: true } : { container: null })}
            options={[
              { value: 'local', icon: Desktop, title: 'This PC', sub: 'Works directly in the folder' },
              { value: 'container', icon: Cube, title: 'Linux container', sub: 'A copy of the folder, in Docker' }
            ]}
          />
          {session.container && <ContainerOptions session={session} update={update} />}
        </div>
        <div className={clsx('flex items-center gap-2.5 rounded-[14px] border px-3 py-2.5', session.workspace ? 'border-line bg-elev' : 'border-dashed border-line-strong')}>
          {session.workspace ? <FolderSimple size={18} weight="fill" className="text-crimson-hi" /> : <FolderDashed size={18} className="text-dim" />}
          <span className={clsx('min-w-0 flex-1 truncate font-mono text-[12px]', session.workspace ? 'text-fg' : 'text-dim')}>{session.workspace ?? (session.container ? 'No folder — the container starts empty' : "No folder — the agent can't read files")}</span>
          {session.workspace && (
            <Button size="sm" variant="ghost" onClick={() => void update({ workspace: null })}>
              Clear
            </Button>
          )}
          <Button
            size="sm"
            onClick={async () => {
              const [dir] = await api.app.pickPaths({ directory: true, title: 'Choose workspace' })
              if (dir) void update({ workspace: dir })
            }}
          >
            Choose…
          </Button>
        </div>
        {session.workspace || session.container ? (
          <div className="mt-3 space-y-3">
            <OptionRow
              label="Files"
              value={session.fileAccess}
              onChange={(fileAccess) => void update({ fileAccess })}
              options={[
                { value: 'read', icon: LockSimple, title: 'Read only', sub: 'read · ls · find · grep' },
                { value: 'write', icon: PencilSimpleLine, title: 'Read & write', sub: '+ write · edit, each change undoable' }
              ]}
            />
            <OptionRow
              label="Shell"
              value={session.shell ? 'on' : 'off'}
              onChange={(v) => void update({ shell: v === 'on' })}
              options={[
                { value: 'off', icon: X, title: 'No commands', sub: 'The agent cannot run programs' },
                { value: 'on', icon: TerminalWindow, title: session.container || window.cloth.platform !== 'win32' ? 'bash' : 'PowerShell', sub: session.container ? 'Runs in the container' : 'Runs in the workspace folder' }
              ]}
            />
            <OptionRow
              label="Code intel"
              value={session.codeIntel ? 'on' : 'off'}
              onChange={(v) => void update({ codeIntel: v === 'on' })}
              options={[
                { value: 'off', icon: X, title: 'Off', sub: 'No language servers' },
                { value: 'on', icon: Code, title: 'TypeScript · Python', sub: 'Definitions, references, type errors' }
              ]}
            />
            <OptionRow<AutoApprove>
              label="Approvals"
              value={session.autoApprove}
              onChange={(autoApprove) => void update({ autoApprove })}
              options={[
                { value: 'none', icon: ShieldCheck, title: 'Ask every time', sub: 'Review each change and command' },
                { value: 'edits', icon: PencilSimpleLine, title: 'Auto-approve edits', sub: 'Still ask before commands' },
                { value: 'all', icon: ShieldWarning, title: 'Auto-approve all', sub: 'Edits and commands run unasked', danger: true }
              ]}
            />
          </div>
        ) : (
          <div className="mt-1.5 text-[11px] text-dim">Pick a folder to let the agent read it — and, if you allow it, edit files and run commands there.</div>
        )}
      </SheetSection>

      <SheetSection icon={NotePencil} title="Instructions">
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => instructions !== session.systemPrompt && void update({ systemPrompt: instructions })}
          placeholder="e.g. Prefer idiomatic TypeScript; cite the knowledge base."
          className="min-h-[84px] w-full resize-y rounded-[14px] border border-line bg-bg px-3.5 py-3 text-[13px] leading-relaxed text-fg outline-none transition-[border-color,box-shadow] placeholder:text-dim focus:border-crimson-line focus:shadow-[0_0_0_4px_rgb(220_38_69/0.1)] focus-visible:outline-none"
        />
        <div className="mt-1 text-[11px] text-dim">Appended to Cloth's system prompt for this chat. Saved when you click away.</div>
      </SheetSection>
    </div>
  )
}

/** Image and network for a container chat, and a warning when Docker can't be reached. */
function ContainerOptions({ session, update }: { session: ChatSession; update(p: Partial<ChatSession>): Promise<void> }) {
  const settings = session.container ?? DEFAULT_CONTAINER
  const [image, setImage] = useState(settings.image)
  const [docker, setDocker] = useState<ContainerStatus | null>(null)
  useEffect(() => setImage(settings.image), [settings.image])
  useEffect(() => {
    void api.containers.status(true).then(setDocker, () => undefined)
  }, [])
  const saveImage = () => {
    const next = image.trim()
    if (next && next !== settings.image) void update({ container: { ...settings, image: next } })
    else setImage(settings.image)
  }
  return (
    <>
      {docker && !docker.available && (
        <div className="flex items-center gap-2 rounded-[12px] border border-warn/40 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn">
          <span className="min-w-0 flex-1">{docker.error}</span>
          <Button size="sm" variant="ghost" onClick={() => void api.containers.status(true).then(setDocker)}>
            Check again
          </Button>
        </div>
      )}
      <div className="grid grid-cols-[76px_1fr] items-center gap-3 mobile:grid-cols-1 mobile:gap-1.5">
        <div className="text-[12px] text-muted">Image</div>
        <div className="flex gap-1.5">
          <input
            value={image}
            onChange={(e) => setImage(e.target.value)}
            onBlur={saveImage}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            spellCheck={false}
            aria-label="Docker image"
            className="h-9 min-w-0 flex-1 rounded-[12px] border border-line bg-bg px-3 font-mono text-[12.5px] outline-none focus:border-crimson-line"
          />
          {['node:22', 'python:3.12', 'ubuntu:24.04'].filter((i) => i !== settings.image).map((i) => (
            <button key={i} onClick={() => void update({ container: { ...settings, image: i } })} className="h-9 shrink-0 rounded-[12px] border border-line px-2.5 font-mono text-[11.5px] text-muted hover:border-line-strong hover:text-fg mobile:hidden">
              {i}
            </button>
          ))}
        </div>
      </div>
      <OptionRow
        label="Network"
        value={settings.network ? 'on' : 'off'}
        onChange={(v) => void update({ container: { ...settings, network: v === 'on' } })}
        options={[
          { value: 'on', icon: GlobeHemisphereWest, title: 'Online', sub: 'Can install packages' },
          { value: 'off', icon: X, title: 'Offline', sub: 'No network access' }
        ]}
      />
    </>
  )
}

function OptionRow<T extends string>({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: T
  onChange(v: T): void
  options: { value: T; icon: Icon; title: string; sub: string; danger?: boolean }[]
}) {
  return (
    <div className="grid grid-cols-[76px_1fr] items-start gap-3 mobile:grid-cols-1 mobile:gap-1.5">
      <div className="pt-2.5 text-[12px] text-muted mobile:pt-0">{label}</div>
      <div className="grid gap-2" style={{ gridTemplateColumns: isMobile ? '1fr' : `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => {
          const on = o.value === value
          return (
            <motion.button
              key={o.value}
              whileTap={{ scale: 0.98 }}
              onClick={() => onChange(o.value)}
              aria-pressed={on}
              className={clsx(
                'flex items-center gap-2.5 rounded-[12px] border px-2.5 py-2 text-left transition-colors',
                on ? (o.danger ? 'border-warn/50 bg-warn/[0.07]' : 'border-crimson-line bg-gradient-to-b from-crimson-soft to-elev') : 'border-line bg-elev hover:border-line-strong'
              )}
            >
              <o.icon size={16} weight={on ? 'fill' : 'regular'} className={clsx('shrink-0', on ? (o.danger ? 'text-warn' : 'text-crimson-hi') : 'text-dim')} />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium">{o.title}</span>
                <span className="block truncate text-[10.5px] text-dim">{o.sub}</span>
              </span>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

function SheetSection({ id, icon: I, title, children }: { id?: string; icon: Icon; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="-mx-2 rounded-xl px-2 py-1">
      <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-dim">
        <I size={14} />
        {title}
      </div>
      {children}
    </section>
  )
}

/** External MCP servers this chat may use (set up on the MCP page). */
function ExternalTools({ session, update }: { session: ChatSession; update(p: Partial<ChatSession>): Promise<void> }) {
  const settings = useApp((s) => s.settings)
  const [status, setStatus] = useState<McpClientStatus[]>([])
  const load = () => void api.mcp.clients().then(setStatus).catch(() => undefined)
  useEffect(load, [])
  useEvent('mcpClients', load)
  const servers = (settings?.mcpClients ?? []).filter((c) => c.enabled)
  if (!servers.length) return null
  const chosen = session.mcpServers ?? servers.filter((c) => c.defaultOn).map((c) => c.id)
  const toggle = (id: string) => void update({ mcpServers: chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id] })
  return (
    <SheetSection id="sheet-external" icon={Plugs} title="External tools">
      <div className="grid grid-cols-3 gap-2 mobile:grid-cols-1">
        {servers.map((c) => {
          const st = status.find((x) => x.id === c.id)
          const sub = st?.state === 'ready' ? `${st.tools.length} tools · ${c.approval === 'ask' ? 'asks first' : 'runs freely'}` : st?.state === 'error' ? 'failed to start — see MCP page' : 'starts when the chat runs'
          return <Capability key={c.id} icon={Plugs} title={c.name} sub={sub} on={chosen.includes(c.id)} onToggle={() => toggle(c.id)} />
        })}
      </div>
    </SheetSection>
  )
}

function Capability({ icon: I, title, sub, on, onToggle }: { icon: Icon; title: string; sub: string; on: boolean; onToggle(): void }) {
  return (
    <motion.button whileTap={{ scale: 0.98 }} onClick={onToggle} aria-pressed={on} className="flex items-center gap-3 rounded-[14px] border border-line bg-elev p-3 text-left">
      <div className={clsx('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px] transition-[background-color,color,box-shadow] duration-300', on ? 'bg-crimson-soft text-crimson-hi shadow-[0_0_20px_-4px_rgb(220_38_69/0.4)]' : 'bg-elev-2 text-dim')}>
        <I size={18} weight={on ? 'fill' : 'regular'} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">{title}</div>
        <div className="truncate text-[11px] text-dim">{sub}</div>
      </div>
      <div className={clsx('relative h-5 w-[34px] shrink-0 rounded-full transition-colors duration-300', on ? 'bg-crimson' : 'bg-line-strong')}>
        <motion.span initial={false} animate={{ x: on ? 14 : 0 }} transition={{ type: 'spring', stiffness: 500, damping: 24 }} className="absolute left-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-white" />
      </div>
    </motion.button>
  )
}

function Welcome({ onPick, hasKnowledge }: { onPick(t: string): void; hasKnowledge: boolean }) {
  const prompts = [
    hasKnowledge ? 'Search my knowledge base and summarize the key concepts' : 'Explain the difference between BM25 and dense retrieval',
    'Which skills do I have, and when should I use each?',
    'Draft a TypeScript function that debounces async calls, with tests'
  ]
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={ENTER} className="flex flex-col items-center pt-16 text-center">
      <Logo size={40} />
      <div className="mt-5 text-[20px] font-semibold tracking-tight">What are we building?</div>
      <div className="mt-1 text-[13px] text-dim">A local agent with traced tools, grounded in your knowledge, skills and the web.</div>
      <div className="mt-8 grid w-full max-w-xl gap-2">
        {prompts.map((p, i) => (
          <motion.button
            key={p}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...ENTER, delay: 0.08 + i * 0.06 }}
            whileHover={{ x: 3 }}
            onClick={() => onPick(p)}
            className="flex items-center gap-2.5 rounded-[14px] border border-line bg-panel px-4 py-3 text-left text-[13px] text-muted transition-colors hover:border-crimson-line hover:text-fg"
          >
            <ChatCircleDots size={16} className="shrink-0 text-crimson-hi" />
            {p}
          </motion.button>
        ))}
      </div>
    </motion.div>
  )
}

const enterProps = (fresh: boolean) =>
  fresh ? { initial: { opacity: 0, y: 14, filter: 'blur(6px)' }, animate: { opacity: 1, y: 0, filter: 'blur(0px)' }, transition: ENTER } : { initial: false as const }

function UserBubble({ message, fresh }: { message: UiMessage; fresh: boolean }) {
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return (
    <motion.div {...enterProps(fresh)} className="mb-9 flex flex-col items-end gap-1.5">
      {message.skills?.length ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {message.skills.map((name) => (
            <span key={name} className="flex items-center gap-1.5 rounded-full border border-crimson-line bg-crimson-soft px-2 py-0.5 font-mono text-[11px] text-crimson-hi">
              <Sparkle size={11} weight="fill" />/{name}
            </span>
          ))}
        </div>
      ) : null}
      {message.attachments?.length ? <SentAttachments items={message.attachments} /> : null}
      {text.trim() && <div className="selectable max-w-[78%] whitespace-pre-wrap mobile:max-w-[86%] rounded-[20px] rounded-br-md border border-line bg-elev-2 px-4 py-[11px] text-[14px] leading-relaxed">{text}</div>}
    </motion.div>
  )
}

function AssistantTurn({
  message,
  streaming,
  fresh,
  onRegenerate,
  awaiting,
  onUndo
}: {
  message: UiMessage
  streaming: boolean
  fresh: boolean
  onRegenerate(): void
  awaiting: Set<string>
  onUndo?(toolCallId: string): Promise<void>
}) {
  const [showSources, setShowSources] = useState(false)
  const [copied, setCopied] = useState(false)
  // Citations [n] refer to the most recent search before each text block.
  const blocks = useMemo(() => {
    let refs: RagHit[] = []
    return message.blocks.map((b) => {
      if (b.type === 'tool' && b.trace.references.length) refs = b.trace.references
      return { block: b, refs }
    })
  }, [message.blocks])
  const allRefs = useMemo(() => {
    const seen = new Map<string, RagHit>()
    for (const b of message.blocks) if (b.type === 'tool') for (const r of b.trace.references) if (!seen.has(r.chunkId)) seen.set(r.chunkId, r)
    return [...seen.values()]
  }, [message.blocks])
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n')
  const lastTextIdx = message.blocks.map((b) => b.type).lastIndexOf('text')
  const lastTodoIdx = message.blocks.map((b) => (b.type === 'tool' && b.trace.name === 'todo_write' ? 't' : '')).lastIndexOf('t')
  // Consecutive tool calls fold into one line. Plan updates other than the latest are dropped (the plan
  // panel shows the plan); images, questions and subagents keep their own cards.
  const items = useMemo(() => {
    const out: ({ kind: 'block'; i: number } | { kind: 'group'; indices: number[] })[] = []
    let run: number[] = []
    const flush = () => {
      if (run.length >= 2) out.push({ kind: 'group', indices: run })
      else for (const i of run) out.push({ kind: 'block', i })
      run = []
    }
    message.blocks.forEach((b, i) => {
      if (b.type === 'tool') {
        const t = b.trace
        if (t.name === 'todo_write' && i !== lastTodoIdx) return
        if (t.name === 'todo_write' || t.name === 'generate_image' || t.name === 'ask_user' || t.name === 'task' || t.subagent) {
          flush()
          out.push({ kind: 'block', i })
        } else run.push(i)
        return
      }
      flush()
      out.push({ kind: 'block', i })
    })
    flush()
    return out
  }, [message.blocks, lastTodoIdx])

  return (
    <motion.div {...enterProps(fresh)} className="group mb-9 grid grid-cols-[28px_1fr] gap-4 mobile:mb-7 mobile:grid-cols-1">
      <div className="mt-0.5 mobile:hidden">
        <Logo size={28} />
      </div>
      <div className="min-w-0">
        {items.map((item) => {
          if (item.kind === 'group') {
            const traces = item.indices.map((j) => (message.blocks[j] as Extract<UiMessage['blocks'][number], { type: 'tool' }>).trace)
            return <ToolGroup key={traces[0].id} traces={traces} fresh={fresh} awaiting={awaiting} onUndo={onUndo} />
          }
          const i = item.i
          const { block, refs } = blocks[i]
          if (block.type === 'thinking') return <Thinking key={i} text={block.text} live={streaming && i === message.blocks.length - 1} />
          if (block.type === 'tool') return <ToolTraceCard key={block.trace.id} trace={block.trace} fresh={fresh} awaiting={awaiting.has(block.trace.id)} onUndo={onUndo} superseded={block.trace.name === 'todo_write' && i !== lastTodoIdx} />
          return <Markdown key={i} text={block.text} references={refs} streaming={streaming && i === lastTextIdx && i === message.blocks.length - 1} className="mb-1" />
        })}
        {message.error && <div className="mt-2 rounded-xl border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">{message.error}</div>}
        {!streaming && (
          <motion.div initial={fresh ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="mt-2 flex items-center gap-3 text-[11.5px] text-dim">
            {message.model && <span className="font-mono">{message.model}</span>}
            {message.usage && message.usage.input + message.usage.output > 0 && (
              <span title="input / output tokens">
                {compact(message.usage.input)} in · {compact(message.usage.output)} out{message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(4)}` : ''}
              </span>
            )}
            {allRefs.length > 0 && (
              <button onClick={() => setShowSources(!showSources)} className="flex items-center gap-1 text-muted transition-colors hover:text-fg">
                <Books size={13} /> {allRefs.length} sources
                <motion.span animate={{ rotate: showSources ? 90 : 0 }} className="flex">
                  <CaretRight size={11} />
                </motion.span>
              </button>
            )}
            <div className="ml-auto flex gap-0.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100 mobile:opacity-100">
              <Tooltip content={copied ? 'Copied' : 'Copy'}>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev-2 hover:text-fg"
                  onClick={() => {
                    void navigator.clipboard.writeText(text)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1200)
                  }}
                >
                  {copied ? <Check size={15} className="text-ok" /> : <Copy size={15} />}
                </button>
              </Tooltip>
              <Tooltip content="Regenerate">
                <button className="flex h-7 w-7 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev-2 hover:text-fg" onClick={onRegenerate}>
                  <ArrowClockwise size={15} />
                </button>
              </Tooltip>
            </div>
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {showSources && (
            <motion.div key="sources" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 30 }} className="overflow-hidden">
              <div className="grid gap-1.5 pt-2">
                {allRefs.map((r, i) => (
                  <ReferenceCard key={r.chunkId} hit={r} n={i + 1} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

function SummaryDivider({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-line-strong" />
        <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg">
          <NotePencil size={12} className="text-crimson-hi" />
          Earlier conversation summarised
          <CaretRight size={11} className={clsx('text-dim transition-transform', open && 'rotate-90')} />
        </button>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-line-strong" />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-3 rounded-[14px] border border-line bg-panel px-4 py-3 text-[13px]">
              <Markdown text={summary} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-2.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[12.5px] text-dim transition-colors hover:text-muted">
        <Brain size={14} />
        <span className={live ? 'shimmer-text' : ''}>{live ? 'Thinking' : 'Thought process'}</span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }} className="flex">
          <CaretRight size={11} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="t" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 30 }} className="overflow-hidden">
            <div className="selectable mt-2 whitespace-pre-wrap border-l-2 border-line pl-3 text-[12.5px] leading-relaxed text-dim">{text}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
