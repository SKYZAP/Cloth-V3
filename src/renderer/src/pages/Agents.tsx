import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowCounterClockwise, CaretRight, ChatCircleDots, Copy, MagnifyingGlass, Plus, Sparkle, Trash, X } from '@phosphor-icons/react'
import { AGENT_TEMPLATES, type Agent, type AgentInput, type AgentSetup, type ChatSetup, type McpClientStatus, type ModelRef, type ThinkingLevel } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Inspector, refocus } from '@/components/Inspector'
import { Button, Input, Modal, PageHeader, Spinner, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Segmented } from './chat/StatusLine'
import { KnowledgeView, ServersView, SkillsView, ToolsView, k, useCapabilities } from './chat/Setup'

/** Two letters for an agent's tile. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?'

type Activity = Record<string, { jobs: number; failed: number; lastAt: number }>

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The team: Cloth on top, the agents it hands work to below, and the agents you pick for a chat.
 * Each card says what the agent may touch; the editor opens beside the team rather than replacing it.
 */
export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [activity, setActivity] = useState<Activity>({})
  const [chatsUsing, setChatsUsing] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)

  const load = async () => {
    const [list, act, chats] = await Promise.all([api.agents.list(), api.agents.activity().catch(() => ({})), api.chat.list().catch(() => [])])
    setAgents(list)
    setActivity(act)
    const using: Record<string, number> = {}
    for (const c of chats) if (c.agentId) using[c.agentId] = (using[c.agentId] ?? 0) + 1
    setChatsUsing(using)
    setLoaded(true)
    setOpenId((cur) => (cur && list.some((a) => a.id === cur) ? cur : null))
  }
  useEffect(() => {
    void load()
  }, [])
  useEvent('agents', () => void load())

  const q = filter.trim().toLowerCase()
  const shown = agents.filter((a) => !q || a.name.toLowerCase().includes(q) || a.purpose.toLowerCase().includes(q))
  const subagents = shown.filter((a) => a.asSubagent)
  const chatAgents = shown.filter((a) => a.asChat)
  const idle = shown.filter((a) => !a.asSubagent && !a.asChat)
  const open = agents.find((a) => a.id === openId) ?? null
  // Templates you haven't added yet fill the chat-agent lane until it has a few of its own.
  const templates = AGENT_TEMPLATES.filter((t) => !agents.some((a) => a.name.toLowerCase() === t.agent.name?.toLowerCase())).slice(0, q ? 0 : Math.max(0, 2 - chatAgents.length))

  const fromTemplate = async (template: string) => {
    const a = await attempt(() => api.agents.create({ template }))
    if (a) void load().then(() => setOpenId(a.id))
  }
  const close = () => {
    const id = openId
    setOpenId(null)
    // Focus goes back to the card that opened the editor.
    refocus(id)
  }

  const card = (a: Agent, lane: 'sub' | 'chat') => (
    <AgentCard key={`${lane}-${a.id}`} agent={a} lane={lane} activity={activity[a.id]} chats={chatsUsing[a.id] ?? 0} selected={a.id === openId} onOpen={() => setOpenId(a.id)} />
  )
  const counts = [plural(agents.filter((a) => a.asSubagent).length, 'subagent'), agents.some((a) => a.asChat) ? plural(agents.filter((a) => a.asChat).length, 'chat agent') : 'no chat agents yet'].join(', ')

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[min(1120px,calc(100%-40px))] gap-6 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <h1 className="text-[18px] font-semibold tracking-tight">Agents</h1>
              <p className="mt-0.5 text-[12.5px] text-dim">{loaded ? counts : '…'}</p>
            </div>
            <div className="relative w-[220px] mobile:w-full mobile:flex-1">
              <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
              <Input className="pl-7" placeholder="Filter agents" aria-label="Filter agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
              New agent
            </Button>
          </div>

          <div className="grid justify-items-center gap-0">
            <div className="flex max-w-[640px] items-center gap-3 rounded-[14px] border border-crimson-line bg-crimson-soft px-4 py-3">
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-crimson text-[13px] font-semibold text-white">
                C
              </span>
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold">Cloth</div>
                <div className="text-[12px] text-muted">The main agent in every chat. It hands jobs to the subagents below when they fit.</div>
              </div>
            </div>
            <svg aria-hidden="true" className="h-6 w-full mobile:hidden max-[760px]:hidden" viewBox="0 0 900 24" preserveAspectRatio="none">
              <path d="M450 0 V10 H150 V24 M450 10 H750 V24 M450 10 V24" fill="none" stroke="var(--color-line-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>

          <Lane title="Subagents" hint="Cloth hands them work by name">
            {subagents.map((a) => card(a, 'sub'))}
            {!subagents.length && <LaneEmpty>{q ? 'No subagent matches.' : 'No subagents. Turn on "Subagent" in an agent to let Cloth hand it work.'}</LaneEmpty>}
          </Lane>

          <Lane title="Chat agents" hint="Pick one as a chat's agent in its Setup tab">
            {chatAgents.map((a) => card(a, 'chat'))}
            {templates.map((t) => (
              <div key={t.id} className="grid content-start gap-1.5 rounded-[12px] border border-dashed border-line-strong p-3.5">
                <span className="text-[13px] font-semibold">{t.name}</span>
                <span className="text-[12px] text-muted">{t.summary}</span>
                <Button size="sm" className="mt-1 justify-self-start" onClick={() => void fromTemplate(t.id)}>
                  Add {t.name}
                </Button>
              </div>
            ))}
            {!q && (
              <div className="grid content-start gap-1.5 rounded-[12px] border border-dashed border-line-strong p-3.5">
                <span className="text-[13px] font-semibold">Describe your own</span>
                <span className="text-[12px] text-muted">Say what it's for; Cloth drafts the name, purpose and instructions.</span>
                <Button size="sm" className="mt-1 justify-self-start" icon={<Sparkle size={13} />} onClick={() => setCreating(true)}>
                  Describe an agent
                </Button>
              </div>
            )}
            {q && !chatAgents.length && <LaneEmpty>No chat agent matches.</LaneEmpty>}
          </Lane>

          {idle.length > 0 && (
            <Lane title="Not in use" hint="Neither a chat agent nor a subagent; turn one on in its editor">
              {idle.map((a) => card(a, 'chat'))}
            </Lane>
          )}
        </div>
      </div>

      <Inspector open={!!open} label={open ? `Edit ${open.name}` : ''} onClose={close}>
        {open && (
          <AgentEditor
            key={open.id}
            agent={open}
            onClose={close}
            onSaved={(a) => setAgents((list) => list.map((x) => (x.id === a.id ? a : x)))}
            onRemoved={() => (setOpenId(null), void load())}
            onDuplicated={(a) => void load().then(() => setOpenId(a.id))}
          />
        )}
      </Inspector>

      <NewAgentDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(a) => {
          setCreating(false)
          void load().then(() => setOpenId(a.id))
        }}
      />
    </div>
  )
}

function Lane({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="grid gap-2.5" aria-label={title}>
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] font-semibold">
        {title} <span className="text-[12px] font-normal text-dim">{hint}</span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">{children}</div>
    </section>
  )
}

function LaneEmpty({ children }: { children: ReactNode }) {
  return <p className="col-span-full rounded-[12px] border border-dashed border-line px-4 py-5 text-[12.5px] text-dim">{children}</p>
}

const TILE: Record<string, string> = {
  designer: 'bg-skill-soft text-skill',
  scout: 'bg-info/15 text-info',
  worker: 'bg-warn/15 text-warn'
}

function Tile({ name, builtin, size = 'sm' }: { name: string; builtin?: string | null; size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex shrink-0 items-center justify-center font-semibold tracking-tight',
        size === 'lg' ? 'h-10 w-10 rounded-[10px] text-[14px]' : 'h-9 w-9 rounded-[9px] text-[12px]',
        (builtin && TILE[builtin]) || 'bg-crimson-soft text-crimson-hi'
      )}
    >
      {initials(name)}
    </span>
  )
}

/** What the agent may touch, in words. */
function access(a: Agent): string {
  if (a.fileAccess !== 'write') return 'Reads files'
  return a.shell ? 'Edits files, runs commands' : 'Edits files'
}

function AgentCard({ agent: a, lane, activity, chats, selected, onOpen }: { agent: Agent; lane: 'sub' | 'chat'; activity?: { jobs: number; failed: number }; chats: number; selected: boolean; onOpen(): void }) {
  const always = a.skillsEnabled || a.skillsAlways.length ? a.skillsAlways : []
  const extra = lane === 'sub' ? (a.asChat ? 'also a chat agent' : null) : a.asSubagent ? 'also a subagent' : null
  const use =
    lane === 'sub'
      ? activity?.jobs
        ? `${plural(activity.jobs, 'job')} this week${activity.failed ? `, ${activity.failed} failed` : ''}`
        : 'No jobs this week'
      : chats
        ? `Used in ${plural(chats, 'chat')}`
        : 'Not used in a chat yet'
  return (
    <button
      data-agent={a.id}
      data-focus-key={a.id}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={selected}
      className={clsx('grid content-start gap-2.5 rounded-[12px] border bg-elev p-3.5 text-left transition-colors hover:border-line-strong hover:bg-elev-2 focus-visible:ring-2 focus-visible:ring-crimson-line', selected ? 'border-crimson-line' : 'border-line')}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Tile name={a.name} builtin={a.builtin} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold" title={a.name}>
            {a.name}
          </span>
          {extra && <span className="block text-[11.5px] text-dim">{extra}</span>}
        </span>
        {a.builtin && <span className="shrink-0 rounded-full border border-line-strong px-2 py-px text-[11.5px] text-muted">built in</span>}
      </span>
      <span className="line-clamp-2 text-[12.5px] text-muted">{a.purpose || 'No purpose yet. Open it to say what it is for.'}</span>
      <span className="flex flex-wrap gap-1.5">
        <Cap>{access(a)}</Cap>
        {a.webEnabled && <Cap>Web</Cap>}
        {a.knowledgeEnabled && <Cap>Knowledge</Cap>}
        {!!a.mcpServers?.length && <Cap>{plural(a.mcpServers.length, 'server')}</Cap>}
        {always.slice(0, 3).map((s) => (
          <span key={s} className="rounded-full border border-skill/30 px-2 py-px text-[11.5px] text-skill" title={`${s} is always on`} translate="no">
            {s}
          </span>
        ))}
        {always.length > 3 && <Cap>+{always.length - 3} skills</Cap>}
      </span>
      <span className="flex items-center justify-between gap-2 border-t border-line pt-2 text-[11.5px] text-dim">
        <span className="min-w-0 truncate">{a.model ? a.model.modelId : "Chat's model"}</span>
        <span className="shrink-0 tabular-nums">{use}</span>
      </span>
    </button>
  )
}

function Cap({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-line-strong px-2 py-px text-[11.5px] text-muted">{children}</span>
}

const EFFORT: { value: ThinkingLevel | 'chat'; label: string }[] = [
  { value: 'chat', label: "Chat's" },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

function AgentEditor({ agent, onClose, onSaved, onRemoved, onDuplicated }: { agent: Agent; onClose(): void; onSaved(a: Agent): void; onRemoved(): void; onDuplicated(a: Agent): void }) {
  const [name, setName] = useState(agent.name)
  const [purpose, setPurpose] = useState(agent.purpose)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [setup, setSetup] = useState<ChatSetup | null>(null)
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const setPage = useApp((s) => s.setPage)
  useEffect(() => setName(agent.name), [agent.name])
  useEffect(() => setPurpose(agent.purpose), [agent.purpose])
  useEffect(() => setInstructions(agent.instructions), [agent.instructions])

  const loadSetup = () => {
    void api.agents.setup(agent.id).then(setSetup, () => undefined)
    void api.mcp.clients().then(setServers, () => undefined)
  }
  useEffect(loadSetup, [agent.id, agent.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('mcpClients', loadSetup)

  const save = async (patch: AgentInput) => {
    const a = await attempt(() => api.agents.update(agent.id, patch))
    if (a) onSaved(a)
  }
  const update = (p: Partial<AgentSetup>) => save(p)
  const m = useCapabilities(agent, update, setup)

  const useInChat = async () => {
    const s = await attempt(async () => {
      const chat = await api.chat.create({})
      return api.chat.useAgent(chat.id, agent.id)
    })
    if (!s) return
    try {
      localStorage.setItem('cloth.chat', s.id)
    } catch {
      /* storage unavailable */
    }
    setPage('chat')
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Tile name={agent.name} builtin={agent.builtin} />
            {agent.name}
          </span>
        }
        subtitle={agent.builtin ? 'Built in: the main agent hands it work as a subagent' : undefined}
        actions={
          <>
            {agent.asChat && (
              <Button size="sm" icon={<ChatCircleDots size={14} />} onClick={() => void useInChat()}>
                New chat with it
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={async () => {
              const a = await attempt(() => api.agents.duplicate(agent.id))
              if (a) onDuplicated(a)
            }}>
              Duplicate
            </Button>
            {!agent.builtin && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash size={14} />}
                aria-label="Delete agent"
                onClick={async () => {
                  if (!(await confirmAction(`Chats set up from ${agent.name} keep their setup.`, { title: `Delete ${agent.name}?`, confirmLabel: 'Delete', danger: true }))) return
                  if (await attempt(() => api.agents.remove(agent.id).then(() => true))) onRemoved()
                }}
              />
            )}
            <Button size="sm" variant="ghost" icon={<X size={15} />} aria-label="Close" title="Close (Esc)" onClick={onClose} />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-[min(760px,calc(100%-40px))] grid-cols-[minmax(0,1fr)] gap-6 py-6">
          {!agent.builtin && (
            <Section title="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== agent.name && void save({ name })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} aria-label="Name" />
            </Section>
          )}
          <Section title="Purpose" hint="How other agents decide to hand work to it, and what you see when picking it.">
            <Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} onBlur={() => purpose !== agent.purpose && void save({ purpose })} aria-label="Purpose" placeholder="e.g. Reviews and fixes interfaces against the project's design system." />
          </Section>
          <Section title="Model">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 mobile:grid-cols-1">
              <ModelPicker value={agent.model} onChange={(model) => void save({ model })} allowNone noneLabel="The chat's model" />
              <div className="w-[300px] mobile:w-full">
                <Segmented size="sm" label="Reasoning effort" value={agent.thinking ?? 'chat'} onChange={(v) => void save({ thinking: v === 'chat' ? null : v })} options={EFFORT} />
              </div>
            </div>
          </Section>
          <InstructionsEditor agent={agent} value={instructions} onChange={setInstructions} onSave={(text) => void save({ instructions: text })} />

          <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold">What it can use</h3>
              <span className="font-mono text-[11px] tabular-nums text-dim">{setup ? `about ${k(m.total)} tokens per request` : '…'}</span>
            </div>
            <Collapsible title="Skills" meta={`${m.skillsOn.length} · +${k(m.parts.skills)}`} defaultOpen>
              <SkillsView target={agent} update={update} m={m} />
            </Collapsible>
            <Collapsible title="External servers" meta={m.configs.length ? `${m.external.filter((t) => m.isOn(t.name)).length} tools · +${k(m.parts.servers)}` : 'none set up'}>
              <ServersView target={agent} update={update} m={m} status={servers} />
            </Collapsible>
            <Collapsible title="Built-in tools" meta={`${m.builtin.filter((t) => m.isOn(t.name)).length} · +${k(m.parts.builtin)}`}>
              <ToolsView
                target={agent}
                update={update}
                m={m}
                access={
                  agent.builtin ? (
                    <span className="text-[11px] text-dim">{agent.builtin === 'scout' ? 'Read-only: a scout never changes files.' : 'Can edit files when the chat it works for can.'}</span>
                  ) : (
                    <div className="grid gap-1.5">
                      <Segmented
                        size="sm"
                        label="Folder access"
                        value={agent.fileAccess === 'write' ? (agent.shell ? 'shell' : 'edit') : 'read'}
                        onChange={(v) => void save({ fileAccess: v === 'read' ? 'read' : 'write', shell: v === 'shell' })}
                        options={[
                          { value: 'read', label: 'Read' },
                          { value: 'edit', label: 'Edit' },
                          { value: 'shell', label: 'Edit + shell' }
                        ]}
                      />
                      <span className="text-[11px] text-dim">The most it may do in a chat's folder; a chat with less access keeps its own.</span>
                    </div>
                  )
                }
              />
            </Collapsible>
            <Collapsible title="Knowledge" meta={`${m.selected.length} · +${k(m.parts.knowledge)}`}>
              <KnowledgeView target={agent} update={update} total={m.parts.knowledge} />
            </Collapsible>
          </div>

          <Section title="Works as">
            <div className="flex flex-wrap gap-4">
              <Check label="Chat agent" sub="Pick it in a chat's Setup tab" on={agent.asChat} disabled={!!agent.builtin} onChange={(asChat) => void save({ asChat })} />
              <Check label="Subagent" sub="Other agents can hand it work by name" on={agent.asSubagent} disabled={!!agent.builtin} onChange={(asSubagent) => void save({ asSubagent })} />
            </div>
          </Section>
          {!agent.builtin && (
            <Section title="Approvals" hint="Used when a chat is set up from this agent.">
              <Segmented
                label="Approvals"
                value={agent.autoApprove}
                onChange={(autoApprove) => void save({ autoApprove })}
                options={[
                  { value: 'none', label: 'Ask first' },
                  { value: 'edits', label: 'Allow edits' },
                  { value: 'all', label: 'Allow all' }
                ]}
              />
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="text-[12px] font-medium text-muted">{title}</div>
      {children}
      {hint && <div className="text-[11px] text-dim">{hint}</div>}
    </div>
  )
}

function Collapsible({ title, meta, defaultOpen, children }: { title: string; meta: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="min-w-0 rounded-[12px] border border-line bg-panel">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <CaretRight size={11} className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 text-[12.5px] font-medium">{title}</span>
        <span className="font-mono text-[11px] tabular-nums text-dim">{meta}</span>
      </button>
      {open && <div className="border-t border-line p-2">{children}</div>}
    </div>
  )
}

function Check({ label, sub, on, disabled, onChange }: { label: string; sub: string; on: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className={clsx('flex items-start gap-2', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-crimson" />
      <span>
        <span className="block text-[12.5px] text-fg">{label}</span>
        <span className="block text-[11px] text-dim">{sub}</span>
      </span>
    </label>
  )
}

/** The agent's instructions, with a way to have AI apply a change to them. */
function InstructionsEditor({ agent, value, onChange, onSave }: { agent: Agent; value: string; onChange(v: string): void; onSave(v: string): void }) {
  const settings = useApp((s) => s.settings)
  const [asking, setAsking] = useState(false)
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [previous, setPrevious] = useState<string | null>(null)
  const model = agent.model ?? settings?.defaultModel ?? null
  const rewrite = async () => {
    setBusy(true)
    const next = await attempt(() => api.agents.rewrite(value, request, model))
    setBusy(false)
    if (next === undefined || next === null) return
    setPrevious(value)
    onChange(next)
    onSave(next)
    setAsking(false)
    setRequest('')
  }
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12px] font-medium text-muted">Instructions</span>
        {previous !== null && (
          <Button size="sm" variant="ghost" icon={<ArrowCounterClockwise size={13} />} onClick={() => (onChange(previous), onSave(previous), setPrevious(null))}>
            Undo rewrite
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<Sparkle size={13} />} onClick={() => setAsking(!asking)} aria-expanded={asking}>
          Rewrite with AI
        </Button>
      </div>
      {asking && (
        <div className="flex gap-2 rounded-[10px] border border-line bg-panel p-2">
          <Input
            autoFocus
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && request.trim() && !busy && void rewrite()}
            placeholder="What should change? e.g. be stricter about mobile layouts"
            aria-label="What should change"
          />
          <Button variant="primary" loading={busy} disabled={!request.trim() || !model} onClick={() => void rewrite()}>
            Rewrite
          </Button>
        </div>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => value !== agent.instructions && onSave(value)}
        rows={10}
        aria-label="Instructions"
        placeholder="What it should do first, how to work, what to check before finishing, and what never to do."
      />
      <div className="text-[11px] text-dim">Added to Cloth's system prompt wherever the agent works. Saved when you click away.</div>
    </div>
  )
}

/** Describe → check the drafted name and purpose → Generate writes the agent and opens it. */
function NewAgentDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(a: Agent): void }) {
  const settings = useApp((s) => s.settings)
  const [description, setDescription] = useState('')
  const [model, setModel] = useState<ModelRef | null>(null)
  const [draft, setDraft] = useState<{ name: string; purpose: string } | null>(null)
  const [busy, setBusy] = useState<'draft' | 'generate' | null>(null)
  useEffect(() => {
    if (open) {
      setDescription('')
      setDraft(null)
      setModel(settings?.defaultModel ?? null)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const step = useMemo(() => (draft ? 2 : 1), [draft])

  const makeDraft = async () => {
    setBusy('draft')
    const d = await attempt(() => api.agents.draft(description, model))
    setBusy(null)
    if (d) setDraft(d)
  }
  const generate = async () => {
    if (!draft) return
    setBusy('generate')
    const a = await attempt(() => api.agents.generate({ description, name: draft.name, purpose: draft.purpose, model }))
    setBusy(null)
    if (a) onCreated(a)
  }
  const fromTemplate = async (template: string | undefined) => {
    const a = await attempt(() => api.agents.create(template ? { template } : {}))
    if (a) onCreated(a)
  }

  return (
    <Modal open={open} onClose={onClose} title="New agent" width={860}>
      <ol className="mb-4 flex items-center gap-2 text-[11.5px] text-dim" aria-label="Steps">
        {['Describe', 'Check the draft', 'Edit'].map((s, i) => (
          <li key={s} className={clsx('flex items-center gap-2', i + 1 === step && 'text-fg')} aria-current={i + 1 === step ? 'step' : undefined}>
            {i > 0 && <CaretRight size={10} aria-hidden="true" />}
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-5 mobile:grid-cols-1">
        <div className="grid content-start gap-3">
          <label htmlFor="agent-description" className="text-[12px] font-medium text-muted">
            What should this agent do?
          </label>
          <Textarea
            id="agent-description"
            autoFocus
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Check my web pages for design problems against the project's design system and fix them. It should look at the page in a real browser on phone and desktop, in both themes, before saying it's done."
          />
          <div className="grid gap-1">
            <span className="text-[11.5px] text-dim">Write with</span>
            <ModelPicker value={model} onChange={(m) => setModel(m)} />
          </div>
          <div className="flex justify-end">
            <Button variant={draft ? 'secondary' : 'primary'} icon={<Sparkle size={13} />} loading={busy === 'draft'} disabled={!description.trim() || !model || !!busy} onClick={() => void makeDraft()}>
              {draft ? 'Draft again' : 'Draft agent'}
            </Button>
          </div>
          <div className="grid gap-1.5 border-t border-line pt-3">
            <span className="text-[11.5px] text-dim">Or start from</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_TEMPLATES.map((t) => (
                <button key={t.id} onClick={() => void fromTemplate(t.id)} title={t.summary} className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:border-line-strong hover:text-fg">
                  {t.name}
                </button>
              ))}
              <button onClick={() => void fromTemplate(undefined)} className="rounded-lg px-2.5 py-1 text-[12px] text-dim hover:text-fg">
                Blank agent
              </button>
            </div>
          </div>
        </div>
        <div className={clsx('grid content-start gap-3 rounded-[12px] border p-3.5', draft ? 'border-line-strong bg-elev' : 'border-dashed border-line')}>
          <div className="text-[12px] font-medium text-muted">Draft</div>
          {busy === 'draft' ? (
            <div className="flex items-center gap-2 py-6 text-[12px] text-dim">
              <Spinner /> Drafting a name and purpose…
            </div>
          ) : draft ? (
            <>
              <label className="grid gap-1">
                <span className="text-[11.5px] text-dim">Name</span>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="grid gap-1">
                <span className="text-[11.5px] text-dim">Purpose</span>
                <Textarea rows={4} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} />
              </label>
              <div className="flex justify-end">
                <Button variant="primary" icon={<Sparkle size={13} weight="fill" />} loading={busy === 'generate'} disabled={!draft.name.trim() || !!busy} onClick={() => void generate()}>
                  Generate
                </Button>
              </div>
              <p className="text-[11px] text-dim">Generate writes its instructions and opens it, where you choose what it can use.</p>
            </>
          ) : (
            <p className="py-6 text-[12px] text-dim">Describe the agent and draft it: you'll check its name and purpose here before it's written.</p>
          )}
        </div>
      </div>
    </Modal>
  )
}
