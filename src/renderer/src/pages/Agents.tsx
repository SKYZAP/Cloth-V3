import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { LayoutGroup } from 'motion/react'
import { ArrowCounterClockwise, CaretRight, ChatCircleDots, Copy, MagnifyingGlass, Plus, Sparkle, Trash, X } from '@phosphor-icons/react'
import { AGENT_TEMPLATES, type Agent, type AgentActivity, type AgentInput, type AgentSetup, type ChatSetup, type McpClientStatus, type ModelRef } from '@shared/types'
import { EFFORT_OPTIONS, effortLabel, normalizeEffortOrNull, type Effort } from '@shared/effort'
import { ACCESS_LEVELS, accessCaps, accessLabel, accessOf } from '@shared/access'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Inspector, refocus } from '@/components/Inspector'
import { Button, Input, Modal, PageHeader, Spinner, Textarea, confirmAction, PageTitle } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Segmented } from './chat/StatusLine'
import { KnowledgeView, ServersView, SkillsView, ToolsView, k, useCapabilities } from './chat/Setup'
import { Tile } from './agents/Tile'
import { TeamOrbit, useTeamLive, type Live } from './agents/Orbit'
import { CompareTable, WeekStrip, alwaysSkills } from './agents/Compare'

export { initials } from './agents/Tile'

type Activity = Record<string, AgentActivity>
type View = 'cards' | 'compare'
const VIEW_KEY = 'cloth.agents.view'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The team: Cloth in the middle with every agent around it, and the agents below as cards or side by side.
 * Jobs Cloth hands out show live on the map and the cards; the editor opens beside the team rather than replacing it.
 */
export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [activity, setActivity] = useState<Activity>({})
  const [chatsUsing, setChatsUsing] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'compare' ? 'compare' : 'cards'
    } catch {
      return 'cards'
    }
  })
  const changeView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* storage unavailable */
    }
  }

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
  // A finished job changes this week's counts; a started one only moves things on the map.
  useEvent('agents', (e) => (e.type === 'changed' || e.state !== 'start') && void load())
  const team = useTeamLive(activity)

  const q = filter.trim().toLowerCase()
  const match = (a: Agent) => !q || a.name.toLowerCase().includes(q) || a.purpose.toLowerCase().includes(q)
  const shown = agents.filter(match)
  const open = agents.find((a) => a.id === openId) ?? null
  const close = () => {
    const id = openId
    setOpenId(null)
    // Focus goes back to the card that opened the editor.
    refocus(id)
  }
  // One scale for every card's week strip, so a busy week looks busier than a quiet one.
  const busiest = Math.max(1, ...Object.values(activity).flatMap((a) => a.days ?? []))

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[calc(100%-48px)] max-w-[2200px] gap-5 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <PageTitle>Agents</PageTitle>
            </div>
            <div className="relative w-[220px] mobile:w-full mobile:flex-1">
              <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
              <Input className="pl-7" placeholder="Filter agents" aria-label="Filter agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
              New agent
            </Button>
          </div>

          {/* The map needs room to breathe; on a narrow window Cloth sits above the cards instead. */}
          {loaded && (
            <div className="max-[760px]:hidden">
              <TeamOrbit agents={agents} activity={activity} team={team} match={match} selected={openId} onOpen={setOpenId} />
            </div>
          )}
          <div className="hidden max-[760px]:flex items-center gap-3 rounded-[14px] border border-line bg-elev px-4 py-3">
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-crimson text-ui font-semibold text-white">
              C
            </span>
            <div className="min-w-0">
              <div className="text-body font-semibold">Cloth</div>
              <div className="text-caption text-muted">The main agent in every chat. It hands work to the team below.</div>
            </div>
          </div>

          <LayoutGroup>
            <Lane
              title="Team"
              action={
                <div className="w-[176px]">
                  <Segmented
                    size="sm"
                    label="Show the team as"
                    value={view}
                    onChange={changeView}
                    options={[
                      { value: 'cards', label: 'Cards' },
                      { value: 'compare', label: 'Compare' }
                    ]}
                  />
                </div>
              }
            >
              {view === 'compare' && shown.length > 0 ? (
                <CompareTable agents={shown} activity={activity} selected={openId} onOpen={setOpenId} />
              ) : (
                shown.map((a) => (
                  <AgentCard key={a.id} agent={a} activity={activity[a.id]} live={team.live[a.id]} busiest={busiest} chats={chatsUsing[a.id] ?? 0} selected={a.id === openId} onOpen={() => setOpenId(a.id)} />
                ))
              )}
              {!q && view === 'cards' && (
                <div className="grid content-start gap-2 rounded-[12px] border border-dashed border-line-strong p-3.5">
                  <span className="text-ui font-semibold">Describe your own</span>
                  <span className="text-ui text-muted">Say what it's for in a sentence, like "Writes vitest suites for changed files and runs them". Cloth drafts the name and instructions.</span>
                  <Button size="sm" className="mt-1 justify-self-start" icon={<Sparkle size={13} />} onClick={() => setCreating(true)}>
                    Describe an agent
                  </Button>
                </div>
              )}
              {q && !shown.length && <LaneEmpty>No agent matches “{filter.trim()}”.</LaneEmpty>}
            </Lane>
          </LayoutGroup>
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

function Lane({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2.5" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-body font-semibold">{title}</h2>
        {action}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(max(280px,calc((100%_-_36px)/4)),1fr))] gap-3">{children}</div>
    </section>
  )
}

function LaneEmpty({ children }: { children: ReactNode }) {
  return <p className="col-span-full rounded-[12px] border border-dashed border-line px-4 py-5 text-ui text-dim">{children}</p>
}

const ACCESS_TONE = { reader: 'border-info/35 bg-info/10 text-info', writer: 'border-warn/35 bg-warn/[0.08] text-warn', operator: 'border-danger-line bg-danger-soft text-danger' } as const

/** The agent's access level as a coloured chip: Reader, Writer or Operator. */
function AccessChip({ agent }: { agent: Agent }) {
  const level = accessOf(agent)
  return (
    <span className={clsx('rounded-full border px-2 py-px text-caption font-semibold', ACCESS_TONE[level])} title={ACCESS_LEVELS.find((l) => l.value === level)!.sub}>
      {accessLabel(level)}
    </span>
  )
}

function AgentCard({
  agent: a,
  activity,
  live,
  busiest,
  chats,
  selected,
  onOpen
}: {
  agent: Agent
  activity?: AgentActivity
  live?: Live
  busiest: number
  chats: number
  selected: boolean
  onOpen(): void
}) {
  const always = alwaysSkills(a)
  // Chats it runs and jobs other agents handed it, together.
  const parts = [chats ? plural(chats, 'chat') : '', activity?.jobs ? `${plural(activity.jobs, 'job')} this week${activity.failed ? ` (${activity.failed} failed)` : ''}` : ''].filter(Boolean)
  const use = parts.length ? parts.join(', ') : 'Not used yet'
  const working = live?.state === 'working'
  return (
    <button
      data-agent={a.id}
      data-focus-key={a.id}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={selected}
      className={clsx(
        'grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2.5 rounded-[12px] border bg-elev p-3.5 text-left transition-colors hover:border-line-strong hover:bg-elev-2 focus-visible:ring-2 focus-visible:ring-crimson-line',
        selected || working ? 'border-crimson-line' : 'border-line'
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Tile name={a.name} builtin={a.builtin} layoutId={`agent-tile-${a.id}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-semibold" title={a.name}>
            {a.name}
          </span>
        </span>
        {working && <span className="animate-pulse h-2 w-2 shrink-0 rounded-full bg-info" aria-hidden="true" />}
        {a.builtin && <span className="shrink-0 rounded-full border border-line-strong px-2 py-px text-caption text-muted">built in</span>}
      </span>
      <span className="line-clamp-2 text-ui text-muted">{a.purpose || 'No purpose yet. Open it to say what it is for.'}</span>
      <span className="flex flex-wrap gap-1.5">
        <AccessChip agent={a} />
        <Cap>{a.thinking ? `${effortLabel(a.thinking)} reasoning` : a.tier ? 'Tier reasoning' : 'Chat’s reasoning'}</Cap>
        {a.webEnabled && <Cap>Web</Cap>}
        {a.knowledgeEnabled && <Cap>Knowledge</Cap>}
        {!!a.mcpServers?.length && <Cap>{plural(a.mcpServers.length, 'server')}</Cap>}
        {always.slice(0, 3).map((s) => (
          <span key={s} className="rounded-full border border-skill/30 px-2 py-px text-caption text-skill" title={`${s} is always on`} translate="no">
            {s}
          </span>
        ))}
        {always.length > 3 && <Cap>+{always.length - 3} skills</Cap>}
      </span>
      <span className="grid grid-cols-[minmax(0,1fr)] gap-2 border-t border-line pt-2">
        <WeekStrip days={activity?.days ?? [0, 0, 0, 0, 0, 0, 0]} max={busiest} />
        <span className="flex items-center justify-between gap-2 text-caption text-dim">
          <span className={clsx('min-w-0 truncate', working && 'max-w-[40%] shrink-0')}>{a.model ? a.model.modelId : "Chat's model"}</span>
          {working ? (
            <span className="min-w-0 truncate text-info" title={live.text}>
              Working{live.text ? `: ${live.text}` : ''}
            </span>
          ) : live?.state === 'done' ? (
            <span className="shrink-0 text-ok">Done just now</span>
          ) : live?.state === 'failed' ? (
            <span className="shrink-0 text-danger-hi">Failed just now</span>
          ) : (
            <span className="shrink-0 tabular-nums">{use}</span>
          )}
        </span>
      </span>
    </button>
  )
}

function Cap({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-line-strong px-2 py-px text-caption text-muted">{children}</span>
}

const EFFORT: { value: Effort | 'chat'; label: string }[] = [...EFFORT_OPTIONS, { value: 'chat', label: 'Same as chat' }]

function AgentEditor({ agent, onClose, onSaved, onRemoved, onDuplicated }: { agent: Agent; onClose(): void; onSaved(a: Agent): void; onRemoved(): void; onDuplicated(a: Agent): void }) {
  const [name, setName] = useState(agent.name)
  const [purpose, setPurpose] = useState(agent.purpose)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [setup, setSetup] = useState<ChatSetup | null>(null)
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const setPage = useApp((s) => s.setPage)
  const tiers = useApp((s) => s.settings?.agentTiers) ?? []
  // Agents set to a tier before Access and Reasoning: it shows as their own level until they are changed here.
  const tier = agent.tier ? (tiers.find((t) => t.id === agent.tier) ?? null) : null
  // Researcher and Code reviewer are Readers by design.
  const fixedRead = agent.builtin === 'researcher' || agent.builtin === 'reviewer'
  const settingsLoaded = useApp((s) => !!s.settings)
  useEffect(() => {
    if (!settingsLoaded) void useApp.getState().loadSettings()
  }, [settingsLoaded])
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
        subtitle={agent.builtin ? 'Built in' : undefined}
        actions={
          <>
            <Button size="sm" icon={<ChatCircleDots size={14} />} onClick={() => void useInChat()}>
              New chat with it
            </Button>
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
          <Section title="Purpose">
            <Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} onBlur={() => purpose !== agent.purpose && void save({ purpose })} aria-label="Purpose" placeholder="e.g. Reviews and fixes interfaces against the project's design system." />
          </Section>
          <Section title="Access">
            <div className="w-[360px] mobile:w-full">
              <Segmented
                size="sm"
                label="Access"
                value={accessOf(agent)}
                onChange={(v) => void save(accessCaps(v))}
                disabled={fixedRead ? ['writer', 'operator'] : []}
                options={ACCESS_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
              />
            </div>
            <p className="text-caption text-dim">
              {fixedRead ? 'Built in as a Reader: it never changes anything.' : ACCESS_LEVELS.find((l) => l.value === accessOf(agent))!.sub}. The chat it works for can only lower this: in Plan mode it is a Reader.
            </p>
          </Section>
          <Section title="Reasoning">
            <div className="w-[360px] mobile:w-full">
              <Segmented size="sm" label="Reasoning" value={normalizeEffortOrNull(agent.thinking ?? tier?.thinking) ?? 'chat'} onChange={(v) => void save({ thinking: v === 'chat' ? null : v, tier: null, ...(tier?.model && !agent.model ? { model: tier.model } : {}) })} options={EFFORT} />
            </div>
            <div className="grid gap-1.5">
              <span className="text-caption text-dim">Model</span>
              <ModelPicker value={agent.model ?? tier?.model ?? null} onChange={(model) => void save({ model, tier: null, ...(tier && agent.thinking === null ? { thinking: tier.thinking } : {}) })} allowNone noneLabel="The chat's model" />
            </div>
          </Section>
          <InstructionsEditor agent={agent} value={instructions} onChange={setInstructions} onSave={(text) => void save({ instructions: text })} />

          <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-ui font-semibold">What it can use</h3>
              <span className="font-mono text-caption tabular-nums text-dim">{setup ? `about ${k(m.total)} tokens per request` : '…'}</span>
            </div>
            <Collapsible title="Skills" meta={`${m.skillsOn.length} · +${k(m.parts.skills)}`} defaultOpen>
              <SkillsView target={agent} update={update} m={m} />
            </Collapsible>
            <Collapsible title="External servers" meta={m.configs.length ? `${m.external.filter((t) => m.isOn(t.name)).length} tools · +${k(m.parts.servers)}` : 'none set up'}>
              <ServersView target={agent} update={update} m={m} status={servers} />
            </Collapsible>
            <Collapsible title="Built-in tools" meta={`${m.builtin.filter((t) => m.isOn(t.name)).length} · +${k(m.parts.builtin)}`}>
              <ToolsView target={agent} update={update} m={m} />
            </Collapsible>
            <Collapsible title="Knowledge" meta={`${m.selected.length} · +${k(m.parts.knowledge)}`}>
              <KnowledgeView target={agent} update={update} total={m.parts.knowledge} />
            </Collapsible>
          </div>

          {!agent.builtin && (
            <Section title="Approvals">
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
      <div className="text-caption font-medium text-muted">{title}</div>
      {children}
      {hint && <div className="text-caption text-dim">{hint}</div>}
    </div>
  )
}

function Collapsible({ title, meta, defaultOpen, children }: { title: string; meta: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="min-w-0 rounded-[12px] border border-line bg-panel">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <CaretRight size={11} className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 text-ui font-medium">{title}</span>
        <span className="font-mono text-caption tabular-nums text-dim">{meta}</span>
      </button>
      {open && <div className="border-t border-line p-2">{children}</div>}
    </div>
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
        <span className="flex-1 text-caption font-medium text-muted">Instructions</span>
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
      <ol className="mb-4 flex items-center gap-2 text-caption text-dim" aria-label="Steps">
        {['Describe', 'Check the draft', 'Edit'].map((s, i) => (
          <li key={s} className={clsx('flex items-center gap-2', i + 1 === step && 'text-fg')} aria-current={i + 1 === step ? 'step' : undefined}>
            {i > 0 && <CaretRight size={10} aria-hidden="true" />}
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-5 mobile:grid-cols-1">
        <div className="grid content-start gap-3">
          <label htmlFor="agent-description" className="text-caption font-medium text-muted">
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
            <span className="text-caption text-dim">Write with</span>
            <ModelPicker value={model} onChange={(m) => setModel(m)} />
          </div>
          <div className="flex justify-end">
            <Button variant={draft ? 'secondary' : 'primary'} icon={<Sparkle size={13} />} loading={busy === 'draft'} disabled={!description.trim() || !model || !!busy} onClick={() => void makeDraft()}>
              {draft ? 'Draft again' : 'Draft agent'}
            </Button>
          </div>
          <div className="grid gap-1.5 border-t border-line pt-3">
            <span className="text-caption text-dim">Or start from</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_TEMPLATES.map((t) => (
                <button key={t.id} onClick={() => void fromTemplate(t.id)} title={t.summary} className="rounded-lg border border-line px-2.5 py-1 text-caption text-muted hover:border-line-strong hover:text-fg">
                  {t.name}
                </button>
              ))}
              <button onClick={() => void fromTemplate(undefined)} className="rounded-lg px-2.5 py-1 text-caption text-dim hover:text-fg">
                Blank agent
              </button>
            </div>
          </div>
        </div>
        <div className={clsx('grid content-start gap-3 rounded-[12px] border p-3.5', draft ? 'border-line-strong bg-elev' : 'border-dashed border-line')}>
          <div className="text-caption font-medium text-muted">Draft</div>
          {busy === 'draft' ? (
            <div className="flex items-center gap-2 py-6 text-caption text-dim">
              <Spinner /> Drafting a name and purpose…
            </div>
          ) : draft ? (
            <>
              <label className="grid gap-1">
                <span className="text-caption text-dim">Name</span>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="grid gap-1">
                <span className="text-caption text-dim">Purpose</span>
                <Textarea rows={4} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} />
              </label>
              <div className="flex justify-end">
                <Button variant="primary" icon={<Sparkle size={13} weight="fill" />} loading={busy === 'generate'} disabled={!draft.name.trim() || !!busy} onClick={() => void generate()}>
                  Generate
                </Button>
              </div>
            </>
          ) : (
            <p className="py-6 text-caption text-dim">Describe the agent and draft it: you'll check its name and purpose here before it's written.</p>
          )}
        </div>
      </div>
    </Modal>
  )
}
