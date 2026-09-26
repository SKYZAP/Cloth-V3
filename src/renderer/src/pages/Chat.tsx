import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowUp, Brain, ChevronRight, Copy, FolderOpen, Globe, Library, MessageSquarePlus, RotateCcw, Search, SlidersHorizontal, Sparkles, Square, Trash2, Wrench } from 'lucide-react'
import type { ChatSession, RagHit, ThinkingLevel, UiMessage } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { compact, timeAgo } from '@/lib/format'
import { Badge, Button, Empty, Field, IconButton, Input, ListItem, ListPane, Modal, Select, Switch, Textarea } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Markdown } from '@/components/Markdown'
import { ReferenceCard, ToolTraceCard } from '@/components/ToolTrace'
import { Logo } from '@/components/Logo'

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
      /* ignore */
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
              <Search size={13} className="absolute left-2.5 top-2.5 text-dim" />
              <Input className="pl-7" placeholder="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Button variant="primary" onClick={create} icon={<MessageSquarePlus size={14} />} title="New chat" />
          </div>
        }
      >
        {shown.map((s) => (
          <ListItem key={s.id} active={s.id === activeId} onClick={() => setActiveId(s.id)}>
            {running.has(s.id) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-crimson pulse-crimson" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px]">{s.title}</div>
              <div className="truncate text-[11px] text-dim">
                {s.model?.modelId ?? 'no model'} · {timeAgo(s.updatedAt)}
              </div>
            </div>
            <IconButton
              className="hidden group-hover:inline-flex"
              onClick={(e) => {
                e.stopPropagation()
                void remove(s.id)
              }}
              title="Delete chat"
            >
              <Trash2 size={13} />
            </IconButton>
          </ListItem>
        ))}
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
            Chat with any registered model. The agent can search your knowledge base, load skills and read a workspace folder — every tool call is traced.
          </Empty>
        )}
      </div>
    </div>
  )
}

function ChatView({ session, running, onChange }: { session: ChatSession; running: boolean; onChange(s: ChatSession): void }) {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [draft, setDraft] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  const collections = useApp((s) => s.collections)
  const providers = useApp((s) => s.providers)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    void api.chat.messages(session.id).then(setMessages)
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
      if (e.error && e.error !== 'Request was aborted' && !/abort/i.test(e.error)) useApp.getState().toast(e.error, 'error')
    }
  })

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

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
    const rest = await api.chat.rewind(session.id, user.id)
    setMessages(rest)
    const text = user.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    await attempt(() => api.chat.send(session.id, text))
  }

  const provider = providers.find((p) => p.id === session.model?.providerId)
  const modelInfo = provider?.models.find((m) => m.id === session.model?.modelId)
  const scopeCols = session.collectionIds.length ? collections.filter((c) => session.collectionIds.includes(c.id)) : collections

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <input
          key={session.title}
          className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold tracking-tight outline-none"
          defaultValue={session.title}
          onBlur={(e) => e.target.value.trim() && e.target.value !== session.title && void update({ title: e.target.value.trim() })}
        />
        <ModelPicker className="w-72" value={session.model} onChange={(model) => void update({ model })} />
        {modelInfo?.reasoning && (
          <Select className="w-28" value={session.thinking} onChange={(e) => void update({ thinking: e.target.value as ThinkingLevel })} title="Thinking level">
            {['off', 'minimal', 'low', 'medium', 'high'].map((l) => (
              <option key={l} value={l}>
                think: {l}
              </option>
            ))}
          </Select>
        )}
        <IconButton onClick={() => setConfigOpen(true)} title="Chat settings">
          <SlidersHorizontal size={15} />
        </IconButton>
      </div>

      {/* Messages */}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="mx-auto max-w-3xl px-6 py-6">
          {!messages.length && <Welcome onPick={(t) => void send(t)} hasKnowledge={collections.length > 0} />}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} message={m} />
            ) : (
              <AssistantTurn key={m.id} message={m} streaming={running && i === messages.length - 1} onRegenerate={() => void regenerate(m.id)} />
            )
          )}
          {running && messages.at(-1)?.role === 'user' && (
            <div className="flex items-center gap-2 py-3 text-[12px] text-dim">
              <Logo size={18} />
              <span className="animate-pulse">Thinking…</span>
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-line bg-bg px-6 pb-4 pt-3">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-xl border border-line-strong bg-panel focus-within:border-crimson-line focus-within:ring-2 focus-within:ring-crimson-soft">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              placeholder={session.model ? 'Ask anything — Enter to send, Shift+Enter for a newline' : 'Pick a model above to start'}
              className="block w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] leading-relaxed outline-none placeholder:text-dim"
            />
            <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
              <ScopeChip icon={<Library size={12} />} active={scopeCols.length > 0} onClick={() => setConfigOpen(true)}>
                {!scopeCols.length ? 'no knowledge' : session.collectionIds.length ? `${scopeCols.length} collection${scopeCols.length === 1 ? '' : 's'}` : 'all collections'}
              </ScopeChip>
              <ScopeChip icon={<Sparkles size={12} />} active={session.skillsEnabled} onClick={() => void update({ skillsEnabled: !session.skillsEnabled })}>
                skills {session.skillsEnabled ? 'on' : 'off'}
              </ScopeChip>
              <ScopeChip icon={<Globe size={12} />} active={session.webEnabled} onClick={() => void update({ webEnabled: !session.webEnabled })}>
                web {session.webEnabled ? 'on' : 'off'}
              </ScopeChip>
              <ScopeChip icon={<Wrench size={12} />} active={session.customTools} onClick={() => void update({ customTools: !session.customTools })}>
                custom tools {session.customTools ? 'on' : 'off'}
              </ScopeChip>
              <ScopeChip icon={<FolderOpen size={12} />} active={!!session.workspace} onClick={() => setConfigOpen(true)}>
                {session.workspace ? session.workspace.split(/[\\/]/).pop() : 'no workspace'}
              </ScopeChip>
              <div className="flex-1" />
              {running ? (
                <Button size="sm" variant="danger" onClick={() => void api.chat.abort(session.id)} icon={<Square size={11} fill="currentColor" />}>
                  Stop
                </Button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={!draft.trim() || !session.model}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-crimson text-white transition-colors hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
                  title="Send"
                >
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <ChatConfig open={configOpen} onClose={() => setConfigOpen(false)} session={session} onSave={update} />
    </div>
  )
}

function ScopeChip({ icon, active, children, onClick }: { icon: React.ReactNode; active: boolean; children: React.ReactNode; onClick(): void }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors',
        active ? 'border-crimson-line bg-crimson-soft text-crimson-hi' : 'border-line text-dim hover:text-muted'
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function Welcome({ onPick, hasKnowledge }: { onPick(t: string): void; hasKnowledge: boolean }) {
  const prompts = [
    hasKnowledge ? 'Search my knowledge base and summarize the key concepts' : 'Explain the difference between BM25 and dense retrieval',
    'Which skills do I have, and when should I use each?',
    'Draft a TypeScript function that debounces async calls, with tests'
  ]
  return (
    <div className="flex flex-col items-center py-14 text-center">
      <Logo size={36} />
      <div className="mt-4 text-[18px] font-semibold tracking-tight">What are we building?</div>
      <div className="mt-1 text-[12.5px] text-dim">Local agent with traced tools, grounded in your knowledge and skills.</div>
      <div className="mt-6 grid w-full max-w-xl gap-2">
        {prompts.map((p) => (
          <button key={p} onClick={() => onPick(p)} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-left text-[12.5px] text-muted hover:border-crimson-line hover:text-fg">
            <ChevronRight size={13} className="text-crimson" />
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

function UserBubble({ message }: { message: UiMessage }) {
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
  return (
    <div className="mb-5 flex justify-end">
      <div className="selectable max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-line bg-elev-2 px-3.5 py-2.5 text-[13.5px] leading-relaxed">{text}</div>
    </div>
  )
}

function AssistantTurn({ message, streaming, onRegenerate }: { message: UiMessage; streaming: boolean; onRegenerate(): void }) {
  const [showSources, setShowSources] = useState(false)
  // Citations [n] refer to the most recent rag_search before each text block.
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
    <div className="group mb-6 flex gap-3">
      <div className="mt-0.5 shrink-0">
        <Logo size={22} />
      </div>
      <div className="min-w-0 flex-1">
        {blocks.map(({ block, refs }, i) => {
          if (block.type === 'thinking') return <Thinking key={i} text={block.text} />
          if (block.type === 'tool') return <ToolTraceCard key={block.trace.id} trace={block.trace} />
          return <Markdown key={i} text={block.text} references={refs} streaming={streaming && i === lastTextIdx && i === message.blocks.length - 1} className="my-1" />
        })}
        {message.error && <div className="mt-2 rounded-md border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">{message.error}</div>}
        {!streaming && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-dim">
            {message.model && <span className="font-mono">{message.model}</span>}
            {message.usage && message.usage.input + message.usage.output > 0 && (
              <span title="input / output tokens">
                {compact(message.usage.input)} in · {compact(message.usage.output)} out{message.usage.cost > 0 ? ` · $${message.usage.cost.toFixed(4)}` : ''}
              </span>
            )}
            {allRefs.length > 0 && (
              <button onClick={() => setShowSources(!showSources)} className="flex items-center gap-1 text-muted hover:text-fg">
                <Library size={11} /> {allRefs.length} sources
              </button>
            )}
            <div className="flex-1" />
            <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <IconButton title="Copy" onClick={() => void navigator.clipboard.writeText(text)}>
                <Copy size={12} />
              </IconButton>
              <IconButton title="Regenerate" onClick={onRegenerate}>
                <RotateCcw size={12} />
              </IconButton>
            </div>
          </div>
        )}
        {showSources && (
          <div className="mt-2 grid gap-1.5">
            {allRefs.map((r, i) => (
              <ReferenceCard key={r.chunkId} hit={r} n={i + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-[11.5px] text-dim hover:text-muted">
        <Brain size={12} />
        Thinking
        <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="selectable mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3 text-[12px] leading-relaxed text-dim">{text}</div>}
    </div>
  )
}

function ChatConfig({ open, onClose, session, onSave }: { open: boolean; onClose(): void; session: ChatSession; onSave(p: Partial<ChatSession>): Promise<void> }) {
  const collections = useApp((s) => s.collections)
  const [system, setSystem] = useState(session.systemPrompt)
  const [ids, setIds] = useState<string[]>(session.collectionIds)
  const [workspace, setWorkspace] = useState(session.workspace)
  const [skills, setSkills] = useState(session.skillsEnabled)
  const [web, setWeb] = useState(session.webEnabled)
  const [custom, setCustom] = useState(session.customTools)
  useEffect(() => {
    if (open) {
      setSystem(session.systemPrompt)
      setIds(session.collectionIds)
      setWorkspace(session.workspace)
      setSkills(session.skillsEnabled)
      setWeb(session.webEnabled)
      setCustom(session.customTools)
    }
  }, [open, session])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chat settings"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await onSave({ systemPrompt: system, collectionIds: ids, workspace, skillsEnabled: skills, webEnabled: web, customTools: custom })
              onClose()
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Knowledge collections" hint="None selected = the agent can search all collections.">
          <div className="flex flex-wrap gap-1.5">
            {collections.map((c) => {
              const on = ids.includes(c.id)
              return (
                <button
                  key={c.id}
                  onClick={() => setIds(on ? ids.filter((x) => x !== c.id) : [...ids, c.id])}
                  className={clsx('rounded-md border px-2 py-1 text-[12px]', on ? 'border-crimson-line bg-crimson-soft text-crimson-hi' : 'border-line text-muted hover:text-fg')}
                >
                  {c.name} <span className="text-dim">({c.docCount})</span>
                </button>
              )
            })}
            {!collections.length && <span className="text-[12px] text-dim">No collections yet — add some under Knowledge.</span>}
          </div>
        </Field>
        <Switch checked={skills} onChange={setSkills} label="Let the agent list and load skills from the hub" />
        <Switch checked={web} onChange={setWeb} label="Web access — web_search and web_fetch (engine set in Settings)" />
        <Switch checked={custom} onChange={setCustom} label="Custom tools from the Tools page" />
        <Field label="Workspace folder" hint="Grants read-only list_dir / read_file / grep tools inside this folder.">
          <div className="flex gap-2">
            <Input readOnly value={workspace ?? ''} placeholder="None" />
            <Button
              onClick={async () => {
                const [dir] = await api.app.pickPaths({ directory: true, title: 'Choose workspace' })
                if (dir) setWorkspace(dir)
              }}
            >
              Browse
            </Button>
            {workspace && (
              <Button variant="ghost" onClick={() => setWorkspace(null)}>
                Clear
              </Button>
            )}
          </div>
        </Field>
        <Field label="Custom instructions" hint="Appended to Cloth's system prompt for this chat.">
          <Textarea rows={5} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="e.g. You are reviewing a Rust codebase. Prefer idiomatic, allocation-free solutions." />
        </Field>
        <div className="flex gap-2">
          <Badge tone="dim">pi-agent-core runtime</Badge>
          <Badge tone="dim">parallel tool execution</Badge>
        </div>
      </div>
    </Modal>
  )
}
