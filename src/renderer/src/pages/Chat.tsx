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
  FolderDashed,
  FolderSimple,
  GlobeHemisphereWest,
  GraduationCap,
  MagnifyingGlass,
  NotePencil,
  Plus,
  SlidersHorizontal,
  Sparkle,
  Stack,
  Stop,
  ToggleRight,
  Trash,
  Wrench,
  type Icon
} from '@phosphor-icons/react'
import type { ChatSession, Collection, RagHit, ThinkingLevel, UiMessage } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { compact, timeAgo } from '@/lib/format'
import { Button, Empty, Input, ListPane } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Markdown } from '@/components/Markdown'
import { ReferenceCard, ToolTraceCard } from '@/components/ToolTrace'
import { BottomSheet } from '@/components/BottomSheet'
import { Tooltip } from '@/components/Tooltip'
import { Logo } from '@/components/Logo'

const SPRING_PRESS = { type: 'spring', stiffness: 700, damping: 14 } as const
const ENTER = { type: 'spring', stiffness: 260, damping: 28 } as const
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']

export function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem('cloth.chat') || null)
  const [running, setRunning] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')

  const load = async () => {
    const list = await api.chat.list()
    setSessions(list)
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

  const create = async () => {
    const s = await attempt(() => api.chat.create())
    if (s) {
      setSessions((ss) => [s, ...ss])
      setActiveId(s.id)
    }
  }

  const remove = async (id: string) => {
    await attempt(() => api.chat.remove(id))
    const rest = sessions.filter((s) => s.id !== id)
    setSessions(rest)
    if (activeId === id) setActiveId(rest[0]?.id ?? null)
  }

  const active = sessions.find((s) => s.id === activeId) ?? null
  const shown = sessions.filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="flex h-full">
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
              onClick={create}
              title="New chat"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crimson text-white hover:bg-crimson-hi"
            >
              <Plus size={16} weight="bold" />
            </motion.button>
          </div>
        }
      >
        {shown.map((s) => {
          const on = s.id === activeId
          return (
            <div
              key={s.id}
              onClick={() => setActiveId(s.id)}
              className={clsx(
                'group mx-0.5 my-1 flex cursor-default items-center gap-2 rounded-[10px] border py-[11px] pl-3.5 pr-2 transition-colors duration-200',
                on ? 'border-crimson bg-elev-2' : 'border-transparent hover:bg-elev'
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {running.has(s.id) && <span className="pulse-crimson h-1.5 w-1.5 shrink-0 rounded-full bg-crimson" />}
                  <span className={clsx('truncate text-[12.5px] font-semibold', on ? 'text-fg' : 'text-fg/90')}>{s.title}</span>
                </div>
                <div className="mt-px truncate text-[11px] text-dim">
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
                  'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-dim transition-all hover:bg-hover hover:text-crimson-hi',
                  on ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                )}
              >
                <Trash size={15} />
              </button>
            </div>
          )
        })}
        {!sessions.length && <div className="p-4 text-center text-[12px] text-dim">No chats yet</div>}
      </ListPane>

      <div className="min-w-0 flex-1">
        {active ? (
          <ChatView
            key={active.id}
            session={active}
            running={running.has(active.id)}
            onChange={(s) => setSessions((ss) => ss.map((x) => (x.id === s.id ? s : x)))}
          />
        ) : (
          <Empty icon={<Logo size={22} />} title="Start a conversation" action={<Button variant="primary" onClick={create}>New chat</Button>}>
            Chat with any registered model. The agent can search your knowledge base and the web, load skills, call your tools and read a workspace folder — every tool call is traced.
          </Empty>
        )}
      </div>
    </div>
  )
}

type SheetSection = 'knowledge' | 'workspace' | 'thinking' | null

function ChatView({ session, running, onChange }: { session: ChatSession; running: boolean; onChange(s: ChatSession): void }) {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sheet, setSheet] = useState<{ open: boolean; section: SheetSection }>({ open: false, section: null })
  const collections = useApp((s) => s.collections)
  const providers = useApp((s) => s.providers)
  const scroller = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  // Messages present when the chat opened render still; anything after animates in.
  const initialIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    void api.chat.messages(session.id).then((ms) => {
      initialIds.current = new Set(ms.map((m) => m.id))
      setMessages(ms)
    })
  }, [session.id])

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
    if (e.type === 'end') {
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

  const update = async (patch: Partial<ChatSession>) => {
    const s = await attempt(() => api.chat.update(session.id, patch))
    if (s) onChange(s)
  }

  const send = async (text = draft) => {
    const t = text.trim()
    if (!t || running) return
    stick.current = true
    setDraft('')
    await attempt(() => api.chat.send(session.id, t))
  }

  const regenerate = async (assistantId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantId)
    const user = [...messages.slice(0, idx)].reverse().find((m) => m.role === 'user')
    if (!user) return
    setMessages(await api.chat.rewind(session.id, user.id))
    await attempt(() => api.chat.send(session.id, user.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')))
  }

  const provider = providers.find((p) => p.id === session.model?.providerId)
  const reasoning = !!provider?.models.find((m) => m.id === session.model?.modelId)?.reasoning
  const selected = session.knowledgeEnabled ? (session.collectionIds.length ? session.collectionIds.filter((id) => collections.some((c) => c.id === id)) : collections.map((c) => c.id)) : []
  const openSheet = (section: SheetSection) => setSheet({ open: true, section })
  const waiting = running && messages.at(-1)?.role === 'user'

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Header floats over the conversation and fades into it */}
      <header className="absolute inset-x-0 top-0 z-10 flex h-14 items-center gap-3 bg-gradient-to-b from-bg from-55% to-transparent px-5">
        <input
          key={session.title}
          className="min-w-0 flex-1 truncate bg-transparent text-[14px] font-semibold tracking-tight outline-none focus-visible:outline-none"
          defaultValue={session.title}
          onBlur={(e) => e.target.value.trim() && e.target.value !== session.title && void update({ title: e.target.value.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <ModelPicker pill className="w-64" value={session.model} onChange={(model) => void update({ model })} />
        <Tooltip content="Chat context">
          <motion.button
            whileTap={{ scale: 0.88 }}
            transition={SPRING_PRESS}
            onClick={() => openSheet(null)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev-2 hover:text-fg"
          >
            <SlidersHorizontal size={17} />
          </motion.button>
        </Tooltip>
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        }}
      >
        <div className="mx-auto w-[min(740px,calc(100%-64px))] pb-[220px] pt-[84px]">
          {!messages.length && <Welcome onPick={(t) => void send(t)} hasKnowledge={collections.length > 0} />}
          {messages.map((m, i) => {
            const fresh = !!initialIds.current && !initialIds.current.has(m.id)
            return m.role === 'user' ? (
              <UserBubble key={m.id} message={m} fresh={fresh} />
            ) : (
              <AssistantTurn key={m.id} message={m} fresh={fresh} streaming={running && i === messages.length - 1} onRegenerate={() => void regenerate(m.id)} />
            )
          })}
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
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-b from-transparent via-bg/90 via-40% to-bg pb-[22px] pt-12">
        <div
          className={clsx(
            'group/composer pointer-events-auto mx-auto w-[min(740px,calc(100%-64px))] rounded-[22px] border border-line-strong bg-panel shadow-[0_12px_40px_-12px_rgb(0_0_0/0.7)] transition-[border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(.32,.72,0,1)]',
            'focus-within:-translate-y-px focus-within:border-crimson-line focus-within:shadow-[0_16px_44px_-14px_rgb(0_0_0/0.8),0_0_0_4px_rgb(220_38_69/0.10)]'
          )}
        >
          <textarea
            ref={textarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            placeholder={session.model ? 'Ask anything…' : 'Pick a model above to start'}
            className="block max-h-[220px] w-full resize-none bg-transparent px-[18px] pb-1.5 pt-4 text-[14.5px] leading-relaxed text-fg outline-none placeholder:text-dim focus-visible:outline-none"
          />
          <div className="flex items-center gap-0.5 pb-2 pl-2.5 pr-2 pt-1.5">
            <ComposerToggle
              icon={Books}
              label="Knowledge"
              active={selected.length > 0}
              state={!collections.length ? 'No collections' : !selected.length ? 'Off' : selected.length === collections.length ? 'All collections' : `${selected.length} collection${selected.length > 1 ? 's' : ''}`}
              count={selected.length || undefined}
              onClick={() => openSheet('knowledge')}
            />
            <ComposerToggle icon={Sparkle} label="Skills" active={session.skillsEnabled} onClick={() => void update({ skillsEnabled: !session.skillsEnabled })} />
            <ComposerToggle icon={GlobeHemisphereWest} label="Web search" active={session.webEnabled} onClick={() => void update({ webEnabled: !session.webEnabled })} />
            <ComposerToggle icon={Wrench} label="Custom tools" active={session.customTools} onClick={() => void update({ customTools: !session.customTools })} />
            <ComposerToggle icon={FolderSimple} label="Workspace" active={!!session.workspace} state={session.workspace ? session.workspace.split(/[\\/]/).pop()! : 'None'} onClick={() => openSheet('workspace')} />
            <div className="mx-1.5 h-[18px] w-px bg-line-strong" />
            <ComposerToggle
              icon={Brain}
              label="Thinking"
              active={reasoning && session.thinking !== 'off'}
              state={reasoning ? session.thinking : 'Not supported by this model'}
              onClick={() => openSheet('thinking')}
            />
            <div className="flex-1" />
            <span className="mr-2.5 text-[11px] text-dim opacity-0 transition-opacity duration-300 group-focus-within/composer:opacity-100">
              <Key>Enter</Key> send · <Key>⇧ Enter</Key> newline
            </span>
            <SendButton running={running} disabled={!running && (!draft.trim() || !session.model)} onSend={() => void send()} onStop={() => void api.chat.abort(session.id)} />
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
  )
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
      title={running ? 'Stop' : 'Send'}
      className="relative h-9 w-9 overflow-hidden rounded-xl bg-crimson text-white transition-colors hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={running ? 'stop' : 'send'}
          initial={{ opacity: 0, scale: 0.6, y: running ? 8 : -8, filter: 'blur(6px)' }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.6, y: running ? -8 : 8, filter: 'blur(6px)' }}
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

  const toggleCollection = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    if (!next.length) return void update({ knowledgeEnabled: false, collectionIds: [] })
    void update({ knowledgeEnabled: true, collectionIds: next.length === collections.length ? [] : next })
  }

  return (
    <div className="space-y-[22px]">
      <SheetSection id="sheet-knowledge" icon={Books} title="Knowledge">
        {collections.length ? (
          <div className="grid grid-cols-3 gap-2">
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

      <SheetSection icon={ToggleRight} title="Capabilities">
        <div className="grid grid-cols-3 gap-2">
          <Capability icon={Sparkle} title="Skills" sub="skill_list · skill_use" on={session.skillsEnabled} onToggle={() => void update({ skillsEnabled: !session.skillsEnabled })} />
          <Capability icon={GlobeHemisphereWest} title="Web" sub="web_search · web_fetch" on={session.webEnabled} onToggle={() => void update({ webEnabled: !session.webEnabled })} />
          <Capability icon={Wrench} title="Custom tools" sub="From the Tools page" on={session.customTools} onToggle={() => void update({ customTools: !session.customTools })} />
        </div>
      </SheetSection>

      <SheetSection id="sheet-thinking" icon={Brain} title="Thinking">
        {reasoning ? (
          <LayoutGroup id={`thinking-${session.id}`}>
            <div className="inline-flex rounded-xl border border-line bg-bg p-[3px]">
              {THINKING_LEVELS.map((l) => (
                <button key={l} onClick={() => void update({ thinking: l })} className={clsx('relative h-[30px] rounded-[9px] px-3.5 text-[12px] capitalize transition-colors', session.thinking === l ? 'text-fg' : 'text-dim hover:text-muted')}>
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
        <div className={clsx('flex items-center gap-2.5 rounded-[14px] border px-3 py-2.5', session.workspace ? 'border-line bg-elev' : 'border-dashed border-line-strong')}>
          {session.workspace ? <FolderSimple size={18} weight="fill" className="text-crimson-hi" /> : <FolderDashed size={18} className="text-dim" />}
          <span className={clsx('min-w-0 flex-1 truncate font-mono text-[12px]', session.workspace ? 'text-fg' : 'text-dim')}>{session.workspace ?? "No folder — the agent can't read files"}</span>
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
        <div className="mt-1.5 text-[11px] text-dim">Read-only: list_dir, read_file and grep inside this folder.</div>
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

function Capability({ icon: I, title, sub, on, onToggle }: { icon: Icon; title: string; sub: string; on: boolean; onToggle(): void }) {
  return (
    <motion.button whileTap={{ scale: 0.98 }} onClick={onToggle} aria-pressed={on} className="flex items-center gap-3 rounded-[14px] border border-line bg-elev p-3 text-left">
      <div className={clsx('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px] transition-all duration-300', on ? 'bg-crimson-soft text-crimson-hi shadow-[0_0_20px_-4px_rgb(220_38_69/0.4)]' : 'bg-elev-2 text-dim')}>
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
    <motion.div {...enterProps(fresh)} className="mb-9 flex justify-end">
      <div className="selectable max-w-[78%] whitespace-pre-wrap rounded-[20px] rounded-br-md border border-line bg-elev-2 px-4 py-[11px] text-[14px] leading-relaxed">{text}</div>
    </motion.div>
  )
}

function AssistantTurn({ message, streaming, fresh, onRegenerate }: { message: UiMessage; streaming: boolean; fresh: boolean; onRegenerate(): void }) {
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

  return (
    <motion.div {...enterProps(fresh)} className="group mb-9 grid grid-cols-[28px_1fr] gap-4">
      <div className="mt-0.5">
        <Logo size={28} />
      </div>
      <div className="min-w-0">
        {blocks.map(({ block, refs }, i) => {
          if (block.type === 'thinking') return <Thinking key={i} text={block.text} live={streaming && i === message.blocks.length - 1} />
          if (block.type === 'tool') return <ToolTraceCard key={block.trace.id} trace={block.trace} fresh={fresh} />
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
            <div className="ml-auto flex gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
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
