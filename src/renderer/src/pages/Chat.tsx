import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import {
  ArrowClockwise,
  ArrowDown,
  ArrowUp,
  Books,
  Brain,
  CaretRight,
  Check,
  ChatCircleDots,
  Copy,
  FolderPlus,
  FolderSimple,
  SidebarSimple,
  MagnifyingGlass,
  NotePencil,
  Paperclip,
  Plus,
  Sparkle,
  Stop,
  Trash,
  type Icon
} from '@phosphor-icons/react'
import type { Agent, ApprovalDecision, ChatSession, WorkspaceFile, Project, ContextUsage, PendingApproval, PendingQuestion, RagHit, Skill, UiBlock, UiMessage, UiUsage } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Empty, Input, ListPane, confirmAction } from '@/components/ui'
import { Markdown } from '@/components/Markdown'
import { ReferenceCard, ToolGroup, ToolTraceCard } from '@/components/ToolTrace'
import { Tooltip } from '@/components/Tooltip'
import { Logo } from '@/components/Logo'
import { ApprovalCard } from '@/components/ApprovalCard'
import { QuestionCard } from '@/components/QuestionCard'
import { latestTodos, PlanPanel } from '@/components/Planning'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { isMobile, useSideBySide } from '@/lib/platform'
import { formatCost, formatTokens } from '@/lib/format'
import { agentCost } from '@/lib/agentCost'
import { ChatsHeader, ProjectDialog, ProjectHeader } from './chat/Projects'
import { ContainerPill } from './chat/ContainerChanges'
import { MAX_ATTACHMENTS, PendingAttachments, readAttachments, SentAttachments, type Pending } from './chat/Attachments'
import { SidePanel, usePanelState } from './chat/SidePanel'
import { showTab, shownTabs } from '@shared/panel-stack'
import { StatusLine } from './chat/StatusLine'
import { agentSlug, invokedSkills, mentionAt, mentionedAgents, SkillText, SkillToken, slashAt, unknownSkills } from './chat/slash'
import { initials } from './Agents'

const SPRING_PRESS = { type: 'spring', stiffness: 700, damping: 14 } as const
const ENTER = { type: 'spring', stiffness: 260, damping: 28 } as const
const COLLAPSED_KEY = 'cloth.projects.collapsed'
/** The collapse key for the chats that belong to no project. */
const LOOSE = 'chats'
const LIST_HIDDEN_KEY = 'cloth.chat.listHidden'

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
  // The chat list folds away (Ctrl+B) so the conversation can take the room; remembered per device.
  const [listHidden, setListHidden] = useState(() => readJson<boolean>(LIST_HIDDEN_KEY, false))
  useEffect(() => writeJson(LIST_HIDDEN_KEY, listHidden), [listHidden])

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
    if (e.type === 'end') {
      setRunning((r) => {
        const n = new Set(r)
        n.delete(e.sessionId)
        return n
      })
      // The list shows each chat's latest line and order by activity.
      void api.chat.list().then(setSessions)
    }
    if (e.type === 'title') setSessions((ss) => ss.map((s) => (s.id === e.sessionId ? { ...s, title: e.title } : s)))
  })

  const create = async (projectId: string | null = null) => {
    const s = await attempt(() => api.chat.create(projectId ? { projectId } : {}))
    if (s) {
      setSessions((ss) => [s, ...ss])
      setActiveId(s.id)
      setOpen(true)
      setCollapsed((c) => toggled(c, projectId ?? LOOSE, false))
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
  const q = filter.trim().toLowerCase()
  const shown = sessions.filter((s) => !q || s.title.toLowerCase().includes(q) || !!s.preview?.toLowerCase().includes(q))

  // Ctrl+N starts a chat (in the current chat's project); Ctrl+K jumps to the chat search.
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'n') {
        e.preventDefault()
        void create(active?.projectId ?? null)
      } else if (k === 'k') {
        e.preventDefault()
        setOpen(false)
        setListHidden(false)
        requestAnimationFrame(() => search.current?.focus())
      } else if (k === 'b' && side) {
        e.preventDefault()
        setListHidden((h) => !h)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const known = new Set(projects.map((p) => p.id))
  const loose = shown.filter((s) => !s.projectId || !known.has(s.projectId))

  const row = (s: ChatSession, nested: boolean) => {
    const on = s.id === activeId
    return (
      <div
        key={s.id}
        role="button"
        tabIndex={0}
        aria-current={on && side ? 'true' : undefined}
        title={s.title}
        onClick={() => (setActiveId(s.id), setOpen(true))}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), setActiveId(s.id), setOpen(true))}
        className={clsx(
          'group relative mx-0.5 my-px flex h-8 cursor-default items-center gap-2 rounded-[8px] pr-1 outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-crimson-line mobile:h-12',
          nested ? 'pl-[30px]' : 'pl-3',
          on && side ? 'bg-elev-2 text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : 'text-muted hover:bg-elev hover:text-fg mobile:text-fg'
        )}
      >
        {running.has(s.id) && <span className="pulse-crimson h-1.5 w-1.5 shrink-0 rounded-full bg-crimson" title="Working" />}
        <span className={clsx('min-w-0 flex-1 truncate text-[12.5px] mobile:text-[14.5px]', on && side && 'font-medium')}>{s.title}</span>
        <button
          onClick={(e) => {
            e.stopPropagation()
            void remove(s.id)
          }}
          title="Delete chat"
          className={clsx(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-hover hover:text-crimson-hi',
            isMobile ? 'opacity-100' : 'hidden group-focus-within:flex group-hover:flex'
          )}
        >
          <Trash size={14} />
        </button>
      </div>
    )
  }

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      {!(side && listHidden) && (
      <ListPane
        header={
          <div className="flex gap-2">
            <div className="relative flex-1">
              <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" />
              <Input ref={search} className="pl-7" placeholder={isMobile ? 'Search chats' : 'Search chats (Ctrl+K)'} aria-label="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setFilter(''), e.currentTarget.blur())} />
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
              title={isMobile ? 'New chat' : 'New chat (Ctrl+N)'}
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
        {projects.length && loose.length ? (
          <div>
            <ChatsHeader
              count={loose.length}
              collapsed={!filter && collapsed.has(LOOSE)}
              running={loose.some((s) => running.has(s.id))}
              onToggle={() => setCollapsed((c) => toggled(c, LOOSE))}
              onNewChat={() => void create(null)}
            />
            <AnimatePresence initial={false}>
              {!(!filter && collapsed.has(LOOSE)) && (
                <motion.div key="chats" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 38 }} className="overflow-hidden">
                  {loose.map((s) => row(s, true))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          loose.map((s) => row(s, false))
        )}
        {loaded && !sessions.length && !projects.length && <div className="p-4 text-center text-[12px] text-dim">No chats yet</div>}
      </ListPane>
      )}

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
            project={projects.find((p) => p.id === active.projectId) ?? null}
            running={running.has(active.id)}
            listHidden={side && listHidden}
            onToggleList={() => setListHidden((h) => !h)}
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

function ChatView({
  session,
  project,
  running,
  listHidden,
  onToggleList,
  onChange
}: {
  session: ChatSession
  project: Project | null
  running: boolean
  listHidden: boolean
  onToggleList(): void
  onChange(s: ChatSession): void
}) {
  const side = useSideBySide()
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [questions, setQuestions] = useState<PendingQuestion[]>([])
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [slash, setSlash] = useState<{ query: string; start: number; end: number } | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [savedAgents, setSavedAgents] = useState<Agent[]>([])
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [attachments, setAttachments] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const collections = useApp((s) => s.collections)
  const providers = useApp((s) => s.providers)
  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [away, setAway] = useState(false)
  const [unseen, setUnseen] = useState(false)
  // Messages present when the chat opened render still; anything after animates in.
  const initialIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    void api.skills.list().then(setSkills).catch(() => undefined)
  }, [])
  const [agent, setAgent] = useState<Agent | null>(null)
  useEffect(() => {
    if (!session.agentId) return setAgent(null)
    void api.agents.list().then((list) => setAgent(list.find((a) => a.id === session.agentId) ?? null), () => undefined)
  }, [session.agentId])
  // Saved agents the message can tag with @name.
  const loadAgents = () => void api.agents.list().then(setSavedAgents, () => undefined)
  useEffect(loadAgents, [])
  useEvent('agents', loadAgents)

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
    if (!stick.current && messages.length) setUnseen(true)
  }, [messages])
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: initialIds.current && initialIds.current.size !== messages.length ? 'smooth' : 'auto' })
  }, [messages])

  // Opening a chat puts the cursor in its message box (not on the phone: that would pop the keyboard).
  useEffect(() => {
    if (!isMobile) textarea.current?.focus()
  }, [session.id])

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

  // Skills are invoked inline: every "/name" in the message that names an installed skill.
  const known = useMemo(() => new Set(skills.map((sk) => sk.name)), [skills])
  const inline = useMemo(() => invokedSkills(draft, known), [draft, known])
  // Agents are tagged inline: every "@slug" that names a saved agent (not the one this chat runs as, nor the plain scout and worker).
  const taggable = useMemo(() => savedAgents.filter((a) => a.id !== session.agentId && a.builtin !== 'scout' && a.builtin !== 'worker'), [savedAgents, session.agentId])
  const agentsBySlug = useMemo(() => new Map(taggable.map((a) => [agentSlug(a.name), a.name] as const)), [taggable])
  const slugs = useMemo(() => new Set(agentsBySlug.keys()), [agentsBySlug])
  const tagged = useMemo(() => mentionedAgents(draft, slugs), [draft, slugs])

  const send = async (text = draft) => {
    const t = text.trim()
    const files = attachments
    const withSkills = invokedSkills(t, known)
    const withAgents = mentionedAgents(t, slugs).map((slug) => agentsBySlug.get(slug)!)
    if ((!t && !files.length) || running) return
    stick.current = true
    setDraft('')
    setSlash(null)
    setMention(null)
    setAttachments([])
    const sent = await attempt(async () => {
      await api.chat.send(session.id, t, withSkills, files.map(({ name, mimeType, data }) => ({ name, mimeType, data })), withAgents)
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
      setPanel(panel.open && shownTabs(panel, isMobile).includes('terminal') ? { open: false } : { open: true, ...showTab(panel, 'terminal', isMobile) })
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
      .filter((sk) => (sk.name === q || !inline.includes(sk.name)) && (!q || sk.name.includes(q) || sk.description.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 8)
  }, [slash, skills, inline])
  // A "/name" that matches no skill goes as plain text; say so (not while the menu is still open for it).
  const unknown = useMemo(() => (slash || !skills.length ? [] : unknownSkills(draft, known)), [slash, skills.length, draft, known])

  const detectSlash = (value: string, caret: number) => {
    detectMention(value, caret)
    const at = slashAt(value, caret)
    if (!at) return setSlash(null)
    if (!slash) void api.skills.list().then(setSkills).catch(() => undefined)
    setSlash(at)
    setSlashIndex(0)
  }

  // Mentions: "@name" at the start of a word opens the agent picker.
  const agentMatches = useMemo(() => {
    if (!mention) return []
    const q = mention.query
    return taggable
      .map((a) => ({ agent: a, slug: agentSlug(a.name) }))
      .filter(({ agent: a, slug }) => (slug === q || !tagged.includes(slug)) && (!q || slug.includes(q) || a.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.slug.startsWith(q)) - Number(a.slug.startsWith(q)) || a.agent.name.localeCompare(b.agent.name))
      .slice(0, 8)
  }, [mention, taggable, tagged])

  const detectMention = (value: string, caret: number) => {
    const at = mentionAt(value, caret)
    if (!at) return setMention(null)
    setMention(at)
    setMentionIndex(0)
  }

  const pickAgent = (slug: string) => {
    if (!mention) return
    const head = `${draft.slice(0, mention.start)}@${slug} `
    setDraft(head + draft.slice(mention.end).replace(/^\s/, ''))
    setMention(null)
    requestAnimationFrame(() => {
      const el = textarea.current
      if (!el) return
      el.focus()
      el.setSelectionRange(head.length, head.length)
    })
  }

  const pickSkill = (sk: Skill) => {
    if (!slash) return
    const head = `${draft.slice(0, slash.start)}/${sk.name} `
    setDraft(head + draft.slice(slash.end).replace(/^\s/, ''))
    setSlash(null)
    requestAnimationFrame(() => {
      const el = textarea.current
      if (!el) return
      el.focus()
      el.setSelectionRange(head.length, head.length)
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
            className="pointer-events-none absolute inset-3 z-40 flex flex-col items-center justify-center gap-2 rounded-[20px] border-2 border-dashed border-crimson-line bg-bg/85 text-[14px] text-fg backdrop-blur-sm"
          >
            <Paperclip size={26} className="text-crimson-hi" />
            Drop files or images to attach
          </motion.div>
        )}
      </AnimatePresence>
      {/* Header floats over the conversation and fades into it */}
      <header className="absolute inset-x-0 top-0 z-10 flex h-14 items-center gap-3 bg-gradient-to-b from-bg from-55% to-transparent px-5 mobile:gap-1.5 mobile:px-3">
        <SplitBack />
        {side && (
          <Tooltip content={listHidden ? 'Show the chat list (Ctrl+B)' : 'Hide the chat list (Ctrl+B)'}>
            <motion.button
              whileTap={{ scale: 0.88 }}
              transition={SPRING_PRESS}
              onClick={onToggleList}
              aria-pressed={!listHidden}
              aria-label="Show the chat list"
              className="-ml-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev-2 hover:text-fg"
            >
              <SidebarSimple size={17} weight={listHidden ? 'regular' : 'fill'} />
            </motion.button>
          </Tooltip>
        )}
        {listHidden && project && (
          <span className="flex min-w-0 max-w-[30%] shrink-0 items-center gap-1.5 text-[13px] text-dim" title={project.folder ?? undefined}>
            <FolderSimple size={14} weight="fill" className="shrink-0" style={{ color: project.color }} />
            <span className="truncate">{project.name}</span>
            <span aria-hidden="true">/</span>
          </span>
        )}
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
        <Tooltip content={panel.open ? 'Hide the side panel' : 'Setup, files, terminal and git'}>
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
          if (away === stick.current) setAway(!stick.current)
          if (stick.current && unseen) setUnseen(false)
        }}
      >
        {/* A chat log: screen readers announce new turns, and wait while a reply is still streaming. */}
        <div role="log" aria-label="Conversation" aria-live="polite" aria-busy={running} className="mx-auto w-[min(740px,calc(100%-64px))] pb-[250px] pt-[84px] mobile:w-[calc(100%-28px)] mobile:pb-[190px] mobile:pt-[64px]">
          {!messages.length && <Welcome onPick={(t) => void send(t)} session={session} project={project} agent={agent} hasKnowledge={collections.length > 0 && session.knowledgeEnabled} />}
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
              <AssistantTurn key={m.id} message={m} invoked={live[i - 1]?.role === 'user' ? live[i - 1].skills : undefined} tagged={live[i - 1]?.role === 'user' ? live[i - 1].agents : undefined} fresh={fresh} streaming={running && i === live.length - 1} onRegenerate={() => void regenerate(m.id)} awaiting={awaiting} onUndo={running ? undefined : undo} />
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

      <AnimatePresence>
        {away && messages.length > 0 && (
          <motion.button
            key="jump"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            onClick={() => {
              stick.current = true
              setUnseen(false)
              scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
            }}
            className="absolute bottom-[170px] left-1/2 z-30 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-panel px-3 text-[12px] text-muted shadow-lg shadow-black/40 hover:text-fg mobile:bottom-[150px]"
          >
            <ArrowDown size={13} />
            {unseen && running ? 'New output' : 'Jump to latest'}
          </motion.button>
        )}
      </AnimatePresence>

      {/* Composer: floats over a gradient fade — no divider line */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-b from-transparent via-bg/90 via-40% to-bg pb-[22px] pt-12 mobile:pb-2.5 mobile:pt-8">
        <AnimatePresence>{showPlan && todos && <PlanPanel key="plan" todos={todos} />}</AnimatePresence>
        <div
          className={clsx(
            'group/composer pointer-events-auto relative mx-auto w-[min(740px,calc(100%-64px))] rounded-[20px] mobile:w-[calc(100%-20px)] border border-line-strong bg-panel shadow-[0_12px_40px_-12px_rgb(0_0_0/0.7)] transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(.32,.72,0,1)]',
            'focus-within:-translate-y-px focus-within:border-crimson-line focus-within:shadow-[0_16px_44px_-14px_rgb(0_0_0/0.8),0_0_0_4px_rgb(220_38_69/0.10)]'
          )}
        >
          <AnimatePresence>
            {slash && <SlashMenu key="slash" skills={matches} total={skills.length} index={slashIndex} query={slash.query} onPick={pickSkill} onHover={setSlashIndex} />}
            {mention && <AgentMenu key="mention" agents={agentMatches} total={taggable.length} index={mentionIndex} query={mention.query} onPick={pickAgent} onHover={setMentionIndex} />}
          </AnimatePresence>
          <PendingAttachments items={attachments} onRemove={unattach} noVision={noVision} />
          <div className="relative">
          {(inline.length > 0 || tagged.length > 0) && (
            <div ref={mirror} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-[18px] pb-1.5 pt-4 text-[14.5px] leading-relaxed text-fg [scrollbar-gutter:stable]">
              <SkillText text={`${draft}\u200b`} known={known} agents={agentsBySlug} />
            </div>
          )}
          <textarea
            ref={textarea}
            onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
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
              if (mention && (el.selectionStart < mention.start || el.selectionStart !== el.selectionEnd)) setMention(null)
            }}
            onBlur={() =>
              setTimeout(() => {
                setSlash(null)
                setMention(null)
              }, 120)
            }
            onKeyDown={(e) => {
              if (mention && agentMatches.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : agentMatches.length - 1)) % agentMatches.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickAgent(agentMatches[Math.min(mentionIndex, agentMatches.length - 1)].slug)
                  return
                }
              }
              if (mention && e.key === 'Escape') {
                e.preventDefault()
                setMention(null)
                return
              }
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
              // Phones: Enter is a newline; the send button sends.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isMobile) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            placeholder={!session.model ? 'Pick a model below to start' : 'Ask anything — / for a skill, @ for an agent'}
            className={clsx(
              'relative block max-h-[220px] w-full resize-none bg-transparent px-[18px] pb-1.5 pt-4 text-[14.5px] leading-relaxed text-fg outline-none [scrollbar-gutter:stable] placeholder:text-dim focus-visible:outline-none',
              (inline.length > 0 || tagged.length > 0) && 'text-transparent caret-fg'
            )}
          />
          </div>
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
            {unknown.length > 0 && (
              <span className="ml-1.5 min-w-0 truncate text-[11.5px] text-dim" role="status">
                No skill called {unknown.join(', ')}. It will be sent as text.
              </span>
            )}
            <div className="flex-1" />
            <SendButton running={running} disabled={!running && ((!draft.trim() && !attachments.length) || !session.model)} onSend={() => void send()} onStop={() => void api.chat.abort(session.id)} />
          </div>
        </div>
        <StatusLine session={session} update={update} usage={usage} compacting={compacting} onCompact={() => void compactNow()} />
      </div>
    </div>
    {panel.open && <SidePanel session={session} update={update} state={panel} set={setPanel} onAttach={(f) => void attachWorkspaceFile(f)} onInsert={insertPath} onPickFolder={() => void pickFolder()} />}
    </div>
  )
}

function SlashMenu({ skills, total, index, query, onPick, onHover }: { skills: Skill[]; total: number; index: number; query: string; onPick(s: Skill): void; onHover(i: number): void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      style={{ transformOrigin: 'bottom left' }}
      className="sheet-glass absolute bottom-full left-0 z-30 mb-2 w-[min(480px,100%)] overflow-hidden rounded-[14px] border border-line-strong"
      onMouseDown={(e) => e.preventDefault()}
    >
      {skills.length ? (
        <LayoutGroup id="slash">
          <div role="listbox" aria-label="Skills" className="max-h-72 overflow-y-auto p-1.5">
            {skills.map((sk, i) => (
              <button
                key={sk.name}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(sk)}
                className="relative grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-3 rounded-[10px] px-2.5 py-2 text-left"
              >
                {i === index && <motion.span layoutId="slash-hl" transition={{ type: 'spring', stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-[10px] bg-elev-2" />}
                <span className="relative font-mono text-[12.5px] text-skill">/{sk.name}</span>
                <span className="relative truncate text-[11.5px] text-dim">{sk.description || 'No description'}</span>
                <span className="relative font-mono text-[10.5px] tabular-nums text-dim" title="Roughly what its instructions add to the request">
                  +{tokensOf(sk)}
                </span>
              </button>
            ))}
          </div>
        </LayoutGroup>
      ) : (
        <div className="px-4 py-4 text-[12px] text-dim">{total ? `No skill matches “/${query}”.` : 'No skills yet — create or import one on the Skills page.'}</div>
      )}
      <div className="flex items-center gap-1 border-t border-line px-3.5 py-1.5 text-[11px] text-dim">
        <Key>↑</Key> <Key>↓</Key> to choose · <Key>Tab</Key> or <Key>Enter</Key> to insert · <Key>Esc</Key> to close
      </div>
    </motion.div>
  )
}

function AgentMenu({ agents, total, index, query, onPick, onHover }: { agents: { agent: Agent; slug: string }[]; total: number; index: number; query: string; onPick(slug: string): void; onHover(i: number): void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      style={{ transformOrigin: 'bottom left' }}
      className="sheet-glass absolute bottom-full left-0 z-30 mb-2 w-[min(480px,100%)] overflow-hidden rounded-[14px] border border-line-strong"
      onMouseDown={(e) => e.preventDefault()}
    >
      {agents.length ? (
        <LayoutGroup id="mention">
          <div className="px-3.5 pb-0.5 pt-2 text-[11px] font-medium text-dim">Agents</div>
          <div role="listbox" aria-label="Agents" className="max-h-72 overflow-y-auto p-1.5 pt-1">
            {agents.map(({ agent: a, slug }, i) => (
              <button
                key={a.id}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(slug)}
                className="relative grid w-full grid-cols-[auto_auto_1fr] items-center gap-3 rounded-[10px] px-2.5 py-2 text-left"
              >
                {i === index && <motion.span layoutId="mention-hl" transition={{ type: 'spring', stiffness: 520, damping: 38 }} className="absolute inset-0 rounded-[10px] bg-elev-2" />}
                <span aria-hidden="true" className="relative flex h-6 w-6 items-center justify-center rounded-[7px] bg-agent-soft text-[10px] font-semibold tracking-tight text-agent">
                  {initials(a.name)}
                </span>
                <span className="relative text-[12.5px] text-agent">{a.name}</span>
                <span className="relative truncate text-[11.5px] text-dim">{a.purpose || 'No purpose given'}</span>
              </button>
            ))}
          </div>
        </LayoutGroup>
      ) : (
        <div className="px-4 py-4 text-[12px] text-dim">{total ? `No agent matches “@${query}”.` : 'No agents yet — make one on the Agents page.'}</div>
      )}
      <div className="flex items-center gap-1 border-t border-line px-3.5 py-1.5 text-[11px] text-dim">
        <Key>↑</Key> <Key>↓</Key> to choose · <Key>Tab</Key> or <Key>Enter</Key> to insert · <Key>Esc</Key> to close
      </div>
    </motion.div>
  )
}

const tokensOf = (sk: Skill) => {
  const n = Math.ceil((sk.description.length + sk.body.length) / 4)
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-b-2 border-line-strong px-1 font-mono text-[10px] text-muted">{children}</kbd>
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
          'relative flex h-[34px] w-[34px] items-center justify-center rounded-[10px] transition-colors duration-200',
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
      className="relative h-9 w-9 overflow-hidden rounded-[10px] bg-crimson text-white transition-colors hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
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

function Welcome({ onPick, session, project, agent, hasKnowledge }: { onPick(t: string): void; session: ChatSession; project: Project | null; agent: Agent | null; hasKnowledge: boolean }) {
  const folder = session.workspace?.split(/[\\/]/).pop()
  const writes = session.fileAccess === 'write' || !!session.container
  const prompts = folder
    ? [
        `Give me a tour of ${folder}: what it does and how it is organised`,
        writes ? `Find a bug or rough edge in ${folder} and fix it` : `Review ${folder} for bugs and risky code`,
        project ? `What should we work on next in ${project.name}?` : hasKnowledge ? 'Search my knowledge base for what relates to this project' : `Suggest three improvements for ${folder}, smallest first`
      ]
    : [
        hasKnowledge ? 'Search my knowledge base and summarise the key ideas' : 'Explain the difference between BM25 and dense retrieval',
        project ? `Help me plan the next step for ${project.name} — ask me questions first` : 'Which skills do I have, and when should I use each?',
        'Draft a TypeScript function that debounces async calls, with tests'
      ]
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={ENTER} className="flex flex-col items-center pt-16 text-center">
      <Logo size={40} />
      <div className="mt-5 text-[20px] font-semibold tracking-tight [text-wrap:balance]">{agent ? agent.name : project ? project.name : folder ? `Working in ${folder}` : 'What are we building?'}</div>
      {agent?.purpose && <div className="mt-1 max-w-md text-[13px] text-muted [text-wrap:balance]">{agent.purpose}</div>}
      <div className="mt-1 text-[13px] text-dim">{folder ? `The agent can ${writes ? 'read and change' : 'read'} files in this folder${session.shell ? ' and run commands' : ''}.` : 'A local agent with traced tools, grounded in your knowledge, skills and the web.'}</div>
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
            <ChatCircleDots size={16} className="shrink-0 text-dim" />
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
  const used = useMemo(() => new Set(message.skills ?? []), [message.skills])
  const agents = useMemo(() => new Map((message.agents ?? []).map((n) => [agentSlug(n), n] as const)), [message.agents])
  // Messages from before skills were written inline carry them only as a list: show those first.
  const leading = (message.skills ?? []).filter((n) => !invokedSkills(text, used).includes(n))
  return (
    <motion.div {...enterProps(fresh)} className="mb-9 flex flex-col items-end gap-1.5">
      {message.attachments?.length ? <SentAttachments items={message.attachments} /> : null}
      {(text.trim() || leading.length > 0) && (
        <div className="selectable max-w-[78%] whitespace-pre-wrap mobile:max-w-[86%] rounded-[20px] rounded-br-md border border-line bg-elev-2 px-4 py-[11px] text-[14px] leading-relaxed">
          {leading.map((n) => (
            <span key={n}>
              <SkillToken name={n} />{' '}
            </span>
          ))}
          <SkillText text={text} known={used} agents={agents} />
        </div>
      )}
    </motion.div>
  )
}

function AssistantTurn({
  message,
  invoked,
  tagged,
  streaming,
  fresh,
  onRegenerate,
  awaiting,
  onUndo
}: {
  message: UiMessage
  /** Skills the user's message invoked with /name. */
  invoked?: string[]
  /** Saved agents the user's message tagged with @name. */
  tagged?: string[]
  streaming: boolean
  fresh: boolean
  onRegenerate(): void
  awaiting: Set<string>
  onUndo?(toolCallId: string): Promise<void>
}) {
  const [showSources, setShowSources] = useState(false)
  const [copied, setCopied] = useState(false)
  const all = useMemo<UiBlock[]>(
    () => [
      ...(invoked ?? []).map((name): UiBlock => ({ type: 'tool', trace: { id: `${message.id}:skill:${name}`, name: 'skill_use', args: { name }, status: 'ok', result: `Loaded with /${name} for this message.`, durationMs: null, references: [] } })),
      ...(tagged ?? []).map((name): UiBlock => ({ type: 'tool', trace: { id: `${message.id}:agent:${name}`, name: 'agent_mention', args: { name }, status: 'ok', result: `Tagged with @${agentSlug(name)}: this message is handed to the ${name} agent.`, durationMs: null, references: [] } })),
      ...message.blocks
    ],
    [invoked, tagged, message.blocks, message.id]
  )
  // Citations [n] refer to the most recent search before each text block.
  const blocks = useMemo(() => {
    let refs: RagHit[] = []
    return all.map((b) => {
      if (b.type === 'tool' && b.trace.references.length) refs = b.trace.references
      return { block: b, refs }
    })
  }, [all])
  const allRefs = useMemo(() => {
    const seen = new Map<string, RagHit>()
    for (const b of message.blocks) if (b.type === 'tool') for (const r of b.trace.references) if (!seen.has(r.chunkId)) seen.set(r.chunkId, r)
    return [...seen.values()]
  }, [message.blocks])
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n')
  const lastTextIdx = all.map((b) => b.type).lastIndexOf('text')
  const lastTodoIdx = all.map((b) => (b.type === 'tool' && b.trace.name === 'todo_write' ? 't' : '')).lastIndexOf('t')
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
    all.forEach((b, i) => {
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
  }, [all, lastTodoIdx])

  const own = message.usage?.cost ?? 0
  const agents = useMemo(() => agentCost(message), [message])

  return (
    <motion.div {...enterProps(fresh)} className="group mb-9 grid grid-cols-[28px_1fr] gap-4 mobile:mb-7 mobile:grid-cols-1">
      <div className="mt-0.5 mobile:hidden">
        <Logo size={28} />
      </div>
      <div className="min-w-0">
        {items.map((item) => {
          if (item.kind === 'group') {
            const traces = item.indices.map((j) => (all[j] as Extract<UiBlock, { type: 'tool' }>).trace)
            return <ToolGroup key={traces[0].id} traces={traces} fresh={fresh} awaiting={awaiting} onUndo={onUndo} />
          }
          const i = item.i
          const { block, refs } = blocks[i]
          if (block.type === 'thinking') return <Thinking key={i} text={block.text} live={streaming && i === all.length - 1} />
          if (block.type === 'tool') return <ToolTraceCard key={block.trace.id} trace={block.trace} fresh={fresh} awaiting={awaiting.has(block.trace.id)} onUndo={onUndo} superseded={block.trace.name === 'todo_write' && i !== lastTodoIdx} />
          return <Markdown key={i} text={block.text} references={refs} streaming={streaming && i === lastTextIdx && i === all.length - 1} className="mb-1" />
        })}
        {message.error && <div className="mt-2 rounded-[10px] border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">{message.error}</div>}
        {!streaming && (
          <motion.div initial={fresh ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="mt-2 flex items-center gap-3 text-[11.5px] text-dim">
            {message.model && <span>{message.model}</span>}
            {message.usage && message.usage.input + message.usage.output > 0 && <TokenCounts usage={message.usage} />}
            {own + agents > 0 && (
              <span title={agents > 0 ? `This reply ${formatCost(own)}, plus ${formatCost(agents)} for agents it handed work to` : 'Cost of this reply'}>{formatCost(own + agents)}</span>
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

/** Tokens read and written by one reply; read counts cached input too. */
function TokenCounts({ usage }: { usage: UiUsage }) {
  const cached = usage.cached ?? 0
  const read = usage.input + cached
  const title = `${read.toLocaleString()} tokens read${cached ? ` (${usage.input.toLocaleString()} new, ${cached.toLocaleString()} cached)` : ''} · ${usage.output.toLocaleString()} written`
  return (
    <span className="tabular-nums" title={title}>
      {formatTokens(read)} in, {formatTokens(usage.output)} out
    </span>
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
