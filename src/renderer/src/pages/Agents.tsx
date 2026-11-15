import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowCounterClockwise, Books, Brain, CaretRight, ChatCircleDots, Copy, Cpu, FileText, LockSimple, MagnifyingGlass, PlugsConnected, Plus, ShieldCheck, Sparkle, Trash, Wrench } from '@phosphor-icons/react'
import { AGENT_TEMPLATES, type Agent, type AgentActivity, type AgentInput, type AgentSetup, type ChatSetup, type McpClientStatus, type ModelRef } from '@shared/types'
import { EFFORT_OPTIONS, effortLabel, normalizeEffortOrNull, type Effort } from '@shared/effort'
import { ACCESS_LEVELS, accessCaps, accessLabel, accessOf } from '@shared/access'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { useSideBySide } from '@/lib/platform'
import { Button, Input, Modal, Spinner, Textarea, confirmAction, PageTitle } from '@/components/ui'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { ModelPicker } from '@/components/ModelPicker'
import { FOCUS } from './automation/AutomationDetail'
import { Segmented } from './chat/StatusLine'
import { KnowledgeView, ServersView, SkillsView, ToolsView, k, useCapabilities } from './chat/Setup'
import { Tile } from './agents/Tile'
import { useTeamLive, type Live } from './agents/Orbit'
import { CompareTable, WeekStrip, alwaysSkills } from './agents/Compare'

export { initials } from './agents/Tile'

type Activity = Record<string, AgentActivity>
/** What the detail side shows: an agent, or the team (Cloth and every agent side by side). */
const TEAM = 'team'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const NO_WEEK = [0, 0, 0, 0, 0, 0, 0]

/**
 * The team, laid out like Models and Automations: the agents listed on the left (Cloth, the built-in ones, then
 * yours) and the selected one edited in place on the right. Cloth's row opens the team view, every agent side by side.
 */
export function AgentsPage() {
  const side = useSideBySide()
  const [agents, setAgents] = useState<Agent[]>([])
  const [activity, setActivity] = useState<Activity>({})
  const [chatsUsing, setChatsUsing] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    const [list, act, chats] = await Promise.all([api.agents.list(), api.agents.activity().catch(() => ({})), api.chat.list().catch(() => [])])
    setAgents(list)
    setActivity(act)
    const using: Record<string, number> = {}
    for (const c of chats) if (c.agentId) using[c.agentId] = (using[c.agentId] ?? 0) + 1
    setChatsUsing(using)
    setLoaded(true)
  }
  useEffect(() => {
    void load()
  }, [])
  // A finished job changes this week's counts; a started one only changes who is working.
  useEvent('agents', (e) => (e.type === 'changed' || e.state !== 'start') && void load())
  const team = useTeamLive(activity)

  // Side by side, something is always selected: the first agent, or the team when there are none.
  useEffect(() => {
    if (!loaded) return
    if (selected === TEAM || agents.some((a) => a.id === selected)) return
    setSelected(side ? (agents[0]?.id ?? TEAM) : null)
  }, [loaded, agents, selected, side])

  const q = filter.trim().toLowerCase()
  const shown = agents.filter((a) => !q || a.name.toLowerCase().includes(q) || a.purpose.toLowerCase().includes(q))
  const builtin = shown.filter((a) => a.builtin)
  const yours = shown.filter((a) => !a.builtin)
  const current = agents.find((a) => a.id === selected) ?? null
  const select = (id: string) => {
    setSelected(id)
    setOpen(true)
  }
  const order = [TEAM, ...builtin.map((a) => a.id), ...yours.map((a) => a.id)]
  const move = (dir: 1 | -1) => {
    const i = order.indexOf(selected ?? '')
    const next = order[Math.min(order.length - 1, Math.max(0, i + dir))]
    select(next)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(next)}"]`)?.focus())
  }

  const week = Object.values(activity)
  const jobs = week.reduce((n, a) => n + (a.jobs ?? 0), 0)
  const failed = week.reduce((n, a) => n + (a.failed ?? 0), 0)
  const busiest = agents.reduce<Agent | null>((best, a) => ((activity[a.id]?.jobs ?? 0) > (best ? (activity[best.id]?.jobs ?? 0) : 0) ? a : best), null)
  const working = agents.filter((a) => team.live[a.id]?.state === 'working').length

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <aside aria-label="Agents" className={clsx('flex h-full shrink-0 flex-col', side ? 'w-[300px] border-r border-line' : 'w-full')}>
        <div className="flex items-center gap-2.5 px-4 pb-2.5 pt-[18px]">
          <PageTitle className="flex-1">Agents</PageTitle>
          <Button variant="primary" className={FOCUS} icon={<Plus size={13} aria-hidden="true" />} onClick={() => setCreating(true)}>
            New
          </Button>
        </div>
        <div className="relative mx-3 mb-1.5">
          <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
          <Input className="pl-7" placeholder="Filter agents" aria-label="Filter agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          onKeyDown={(e) => {
            if (!side || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
            e.preventDefault()
            move(e.key === 'ArrowDown' ? 1 : -1)
          }}
        >
          {!q && (
            <Row id={TEAM} selected={side && selected === TEAM} onSelect={() => select(TEAM)} tile={<ClothTile />} name="Cloth" sub={working ? `Main agent · ${working} working` : 'Main agent in every chat'} />
          )}
          {builtin.length > 0 && <Group label="Built in" />}
          {builtin.map((a) => (
            <AgentRow key={a.id} agent={a} activity={activity[a.id]} live={team.live[a.id]} selected={side && a.id === selected} onSelect={() => select(a.id)} />
          ))}
          {(yours.length > 0 || !q) && <Group label="Yours" />}
          {yours.map((a) => (
            <AgentRow key={a.id} agent={a} activity={activity[a.id]} live={team.live[a.id]} selected={side && a.id === selected} onSelect={() => select(a.id)} />
          ))}
          {!q && (
            <button type="button" onClick={() => setCreating(true)} className={clsx('mt-0.5 flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-ui text-muted hover:bg-panel hover:text-fg', FOCUS)}>
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-dashed border-line-strong">
                <Sparkle size={14} />
              </span>
              Describe an agent
            </button>
          )}
          {q && !shown.length && <p className="px-2.5 py-2 text-ui text-dim">No agent matches “{filter.trim()}”.</p>}
        </div>

        {loaded && (
          <div className="border-t border-line px-5 pb-4 pt-3 mobile:hidden">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-caption font-semibold text-muted">This week</span>
              <button type="button" onClick={() => select(TEAM)} className={clsx('rounded px-1 text-caption text-dim hover:text-fg', FOCUS)}>
                Compare all
              </button>
            </div>
            <Stat label="Jobs" value={String(jobs)} />
            <Stat label="Failed" value={String(failed)} tone={failed ? 'text-danger-hi' : undefined} />
            <Stat label="Busiest" value={busiest ? busiest.name : 'None yet'} />
          </div>
        )}
      </aside>

      <SplitDetail>
        <div className="@container h-full overflow-y-auto">
          {!loaded ? null : selected === TEAM || !current ? (
            <TeamView agents={agents} activity={activity} working={working} jobs={jobs} onOpen={select} />
          ) : (
            <AgentDetail
              key={current.id}
              agent={current}
              activity={activity[current.id]}
              live={team.live[current.id]}
              chats={chatsUsing[current.id] ?? 0}
              onSaved={(a) => setAgents((list) => list.map((x) => (x.id === a.id ? a : x)))}
              onRemoved={() => {
                setSelected(null)
                setOpen(false)
                void load()
              }}
              onDuplicated={(a) => void load().then(() => select(a.id))}
            />
          )}
        </div>
      </SplitDetail>

      <NewAgentDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(a) => {
          setCreating(false)
          void load().then(() => select(a.id))
        }}
      />
    </SplitRoot>
  )
}

function Group({ label }: { label: string }) {
  return <div className="px-2 pb-1 pt-2.5 text-caption text-dim">{label}</div>
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-caption">
      <span className="text-dim">{label}</span>
      <span className={clsx('truncate tabular-nums', tone ?? 'text-fg')}>{value}</span>
    </div>
  )
}

function ClothTile({ large }: { large?: boolean }) {
  return (
    <span aria-hidden="true" className={clsx('flex shrink-0 items-center justify-center bg-crimson font-semibold text-white', large ? 'h-10 w-10 rounded-[10px] text-body' : 'h-9 w-9 rounded-[9px] text-caption')}>
      C
    </span>
  )
}

function Row({ id, selected, onSelect, tile, name, sub, subTone, busy }: { id: string; selected: boolean; onSelect(): void; tile: ReactNode; name: string; sub: string; subTone?: string; busy?: boolean }) {
  return (
    <button
      type="button"
      data-id={id}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={clsx('grid w-full grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-left mobile:min-h-[56px]', selected ? 'bg-elev' : 'hover:bg-panel', FOCUS)}
    >
      {tile}
      <span className="min-w-0">
        <span className="block truncate text-ui font-semibold" title={name}>
          {name}
        </span>
        <span className={clsx('block truncate text-caption', subTone ?? 'text-dim')} title={sub}>
          {sub}
        </span>
      </span>
      {busy ? <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-info motion-reduce:animate-none" /> : <span />}
    </button>
  )
}

/** What an agent is up to in a few words: working, just finished, or its access and how much it's used. */
function status(a: Agent, activity: AgentActivity | undefined, live: Live | undefined): { text: string; tone?: string } {
  if (live?.state === 'working') return { text: live.text ? `Working: ${live.text}` : 'Working', tone: 'text-info' }
  if (live?.state === 'done') return { text: 'Done just now', tone: 'text-ok' }
  if (live?.state === 'failed') return { text: 'Failed just now', tone: 'text-danger-hi' }
  const used = activity?.jobs ? `${plural(activity.jobs, 'job')} this week` : 'not used yet'
  return { text: `${accessLabel(accessOf(a))} · ${used}` }
}

function AgentRow({ agent: a, activity, live, selected, onSelect }: { agent: Agent; activity?: AgentActivity; live?: Live; selected: boolean; onSelect(): void }) {
  const s = status(a, activity, live)
  return <Row id={a.id} selected={selected} onSelect={onSelect} tile={<Tile name={a.name} builtin={a.builtin} />} name={a.name} sub={s.text} subTone={s.tone} busy={live?.state === 'working'} />
}

// ─── The team (Cloth) ────────────────────────────────────────────────────────

function TeamView({ agents, activity, working, jobs, onOpen }: { agents: Agent[]; activity: Activity; working: number; jobs: number; onOpen(id: string): void }) {
  return (
    <div className="mx-auto max-w-[1100px] px-8 pb-16 pt-[22px] @max-[620px]:px-4 mobile:px-4">
      <div className="flex items-center gap-3">
        <SplitBack />
        <ClothTile large />
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-semibold">Cloth</h1>
          <p className="text-ui text-dim">The main agent in every chat. It hands jobs to the team and checks what comes back.</p>
        </div>
      </div>
      <p className="mt-3 text-ui text-muted">
        {working ? `${plural(working, 'agent')} working now. ` : ''}
        {plural(jobs, 'job')} handed out this week. Mention an agent with @ in a chat to hand it a message yourself.
      </p>
      <Section title="The team side by side">
        {agents.length ? <CompareTable agents={agents} activity={activity} selected={null} onOpen={onOpen} /> : <p className="text-ui text-dim">No agents yet.</p>}
      </Section>
    </div>
  )
}

// ─── One agent ───────────────────────────────────────────────────────────────

const EFFORT: { value: Effort | 'chat'; label: string }[] = [...EFFORT_OPTIONS, { value: 'chat', label: 'As chat' }]
const ACCESS_TONE = { reader: 'text-info', writer: 'text-warn', operator: 'text-danger-hi' } as const
type Open = 'instructions' | 'skills' | 'servers' | 'tools' | 'knowledge' | null

function AgentDetail({
  agent,
  activity,
  live,
  chats,
  onSaved,
  onRemoved,
  onDuplicated
}: {
  agent: Agent
  activity?: AgentActivity
  live?: Live
  chats: number
  onSaved(a: Agent): void
  onRemoved(): void
  onDuplicated(a: Agent): void
}) {
  const [name, setName] = useState(agent.name)
  const [purpose, setPurpose] = useState(agent.purpose)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [setup, setSetup] = useState<ChatSetup | null>(null)
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const [open, setOpen] = useState<Open>(null)
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
  const duplicate = async () => {
    const a = await attempt(() => api.agents.duplicate(agent.id))
    if (a) onDuplicated(a)
  }
  const remove = async () => {
    if (!(await confirmAction(`Chats set up from ${agent.name} keep their setup.`, { title: `Delete ${agent.name}?`, confirmLabel: 'Delete', danger: true }))) return
    if (await attempt(() => api.agents.remove(agent.id).then(() => true))) onRemoved()
  }

  const level = accessOf(agent)
  const effort = normalizeEffortOrNull(agent.thinking ?? tier?.thinking)
  const always = alwaysSkills(agent)
  const serversOn = m.external.filter((t) => m.isOn(t.name)).length
  const builtinOn = m.builtin.filter((t) => m.isOn(t.name)).length
  const used = [chats ? plural(chats, 'chat') : '', activity?.jobs ? `${plural(activity.jobs, 'job')} this week${activity.failed ? `, ${activity.failed} failed` : ''}` : ''].filter(Boolean).join(' · ') || 'Not used yet'
  const instructionLine = instructions.trim().split('\n').find((l) => l.trim())?.trim() ?? ''

  return (
    <div className="mx-auto max-w-[760px] px-8 pb-16 pt-[22px] @max-[620px]:px-4 mobile:px-4">
      <div className="flex flex-wrap items-center gap-3">
        <SplitBack />
        <Tile name={agent.name} builtin={agent.builtin} size="lg" />
        <div className="min-w-[180px] flex-1">
          {agent.builtin ? (
            <h1 className="truncate text-title font-semibold">{agent.name}</h1>
          ) : (
            <input
              aria-label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => (name.trim() && name !== agent.name ? void save({ name }) : setName(agent.name))}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              spellCheck={false}
              className="w-full truncate border-b border-transparent bg-transparent py-0.5 text-title font-semibold outline-none hover:border-line-strong focus:border-crimson-line focus-visible:outline-none"
            />
          )}
          <p className="text-ui text-dim">
            {agent.builtin ? 'Built in · ' : ''}
            <span className={ACCESS_TONE[level]}>{accessLabel(level)}</span> · {effort ? `${effortLabel(effort)} reasoning` : 'Chat’s reasoning'}
          </p>
        </div>
        <Button className={FOCUS} icon={<ChatCircleDots size={14} aria-hidden="true" />} onClick={() => void useInChat()}>
          New chat with it
        </Button>
      </div>

      {live?.state === 'working' && (
        <div role="status" className="mt-4 flex items-center gap-2.5 rounded-[12px] border border-crimson-line bg-crimson-soft/40 px-3.5 py-2.5 text-ui">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none" />
          <span className="min-w-0 flex-1 truncate" title={live.text}>
            {live.text ? `Working: ${live.text}` : 'Working on a job'}
          </span>
        </div>
      )}

      <Section title="What it does">
        <Textarea
          rows={2}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          onBlur={() => purpose !== agent.purpose && void save({ purpose })}
          aria-label="What it does"
          placeholder="Reviews and fixes interfaces against the project's design system."
        />
        <p className="mt-1.5 text-caption text-dim">Cloth reads this to decide which jobs to hand it.</p>
      </Section>

      <Section title="How it works">
        <div className="overflow-hidden rounded-[12px] border border-line">
          <FixedRow icon={LockSimple} label="Access">
            <div className="w-[300px] max-w-full">
              <Segmented size="sm" label="Access" value={level} onChange={(v) => void save(accessCaps(v))} disabled={fixedRead ? ['writer', 'operator'] : []} options={ACCESS_LEVELS.map((l) => ({ value: l.value, label: l.label }))} />
            </div>
          </FixedRow>
          <FixedRow icon={Brain} label="Reasoning">
            <div className="w-[440px] max-w-full">
              <Segmented size="sm" label="Reasoning" value={effort ?? 'chat'} onChange={(v) => void save({ thinking: v === 'chat' ? null : v, tier: null, ...(tier?.model && !agent.model ? { model: tier.model } : {}) })} options={EFFORT} />
            </div>
          </FixedRow>
          <FixedRow icon={Cpu} label="Model">
            <div className="w-[320px] max-w-full">
              <ModelPicker value={agent.model ?? tier?.model ?? null} onChange={(model) => void save({ model, tier: null, ...(tier && agent.thinking === null ? { thinking: tier.thinking } : {}) })} allowNone noneLabel="The chat's model" />
            </div>
          </FixedRow>
          {!agent.builtin && (
            <FixedRow icon={ShieldCheck} label="Approvals">
              <div className="w-[300px] max-w-full">
                <Segmented
                  size="sm"
                  label="Approvals"
                  value={agent.autoApprove}
                  onChange={(autoApprove) => void save({ autoApprove })}
                  options={[
                    { value: 'none', label: 'Ask first' },
                    { value: 'edits', label: 'Allow edits' },
                    { value: 'all', label: 'Allow all' }
                  ]}
                />
              </div>
            </FixedRow>
          )}
          <UseRow id="instructions" icon={FileText} label="Instructions" open={open} setOpen={setOpen} action="Edit" value={<span className="truncate text-ui text-muted">{instructionLine || 'None yet'}</span>}>
            <InstructionsEditor agent={agent} value={instructions} onChange={setInstructions} onSave={(text) => void save({ instructions: text })} />
          </UseRow>
        </div>
        <p className="mt-2 text-caption text-dim">
          {fixedRead ? 'Built in as a Reader: it never changes anything.' : `${ACCESS_LEVELS.find((l) => l.value === level)!.sub}.`} The chat it works for can only lower this: in Plan mode it is a Reader.
        </p>
      </Section>

      <Section title="What it can use" hint={setup ? `about ${k(m.total)} tokens per request` : undefined}>
        <div className="overflow-hidden rounded-[12px] border border-line">
          <UseRow
            id="skills"
            icon={Sparkle}
            label="Skills"
            open={open}
            setOpen={setOpen}
            value={
              <>
                {always.slice(0, 3).map((s) => (
                  <Tag key={s} tone="skill">
                    {s}
                  </Tag>
                ))}
                {always.length > 3 && <span className="text-ui text-muted">+{always.length - 3} more</span>}
                {!always.length && <span className={clsx('text-ui', m.skillsOn.length ? 'text-muted' : 'text-dim')}>{m.skillsOn.length ? plural(m.skillsOn.length, 'skill') : 'None'}</span>}
              </>
            }
          >
            <SkillsView target={agent} update={update} m={m} />
          </UseRow>
          <UseRow id="tools" icon={Wrench} label="Built-in tools" open={open} setOpen={setOpen} value={<span className="text-ui text-muted">{builtinOn ? plural(builtinOn, 'tool') : 'None'}</span>}>
            <ToolsView target={agent} update={update} m={m} />
          </UseRow>
          <UseRow id="servers" icon={PlugsConnected} label="Servers" open={open} setOpen={setOpen} value={<span className={clsx('text-ui', serversOn ? 'text-muted' : 'text-dim')}>{m.configs.length ? (serversOn ? `${plural(serversOn, 'tool')} from your servers` : 'No server tools') : 'No servers set up'}</span>}>
            <ServersView target={agent} update={update} m={m} status={servers} />
          </UseRow>
          <UseRow id="knowledge" icon={Books} label="Knowledge" open={open} setOpen={setOpen} value={<span className={clsx('text-ui', m.selected.length ? 'text-muted' : 'text-dim')}>{m.selected.length ? plural(m.selected.length, 'collection') : 'None'}</span>}>
            <KnowledgeView target={agent} update={update} total={m.parts.knowledge} />
          </UseRow>
        </div>
      </Section>

      <Section title="This week" hint={used}>
        <div className="rounded-[12px] border border-line px-3.5 py-3">
          <WeekStrip days={activity?.days ?? NO_WEEK} max={Math.max(1, ...(activity?.days ?? [0]))} />
          <div className="mt-2 flex justify-between gap-3 text-caption text-dim">
            <span>{agent.model ? agent.model.modelId : "Runs on the chat's model"}</span>
            <span>{activity?.lastAt ? `Last job ${new Date(activity.lastAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'No jobs yet'}</span>
          </div>
        </div>
      </Section>

      <div className="mt-[30px] flex flex-wrap items-center gap-2.5 border-t border-line pt-4 text-caption text-dim">
        <FooterButton icon={Copy} onClick={() => void duplicate()}>
          Duplicate
        </FooterButton>
        {!agent.builtin && (
          <>
            <span aria-hidden="true">·</span>
            <FooterButton danger icon={Trash} onClick={() => void remove()}>
              Delete agent…
            </FooterButton>
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-[26px]">
      <h2 className="mb-2 flex items-baseline gap-2 text-ui font-semibold">
        {title}
        {hint && <small className="truncate text-caption font-normal tabular-nums text-dim">{hint}</small>}
      </h2>
      {children}
    </section>
  )
}

function RowTile({ icon: Icon }: { icon: typeof Wrench }) {
  return (
    <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-elev-2 text-muted">
      <Icon size={14} />
    </span>
  )
}

/** A row whose control sits in the row itself. */
function FixedRow({ icon, label, children }: { icon: typeof Wrench; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_120px_minmax(0,1fr)] items-center gap-2.5 border-line px-3.5 py-2 @max-[620px]:grid-cols-[28px_minmax(0,1fr)] mobile:grid-cols-[28px_minmax(0,1fr)] [&+*]:border-t">
      <RowTile icon={icon} />
      <span className="text-ui text-muted @max-[620px]:sr-only mobile:sr-only">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** A row showing what's set, with Change (or Edit) opening its editor below; one at a time. */
function UseRow({ id, icon, label, value, open, setOpen, action = 'Change', children }: { id: Exclude<Open, null>; icon: typeof Wrench; label: string; value: ReactNode; open: Open; setOpen(o: Open): void; action?: string; children: ReactNode }) {
  const expanded = open === id
  const panel = `agent-${id}`
  return (
    <div className="border-line [&+*]:border-t">
      <div className="grid grid-cols-[28px_120px_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-2 @max-[620px]:grid-cols-[28px_minmax(0,1fr)_auto] mobile:grid-cols-[28px_minmax(0,1fr)_auto]">
        <RowTile icon={icon} />
        <span className="text-ui text-muted @max-[620px]:sr-only mobile:sr-only">{label}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-[5px]">{value}</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panel}
          aria-label={`${expanded ? 'Close' : action} ${label.toLowerCase()}`}
          onClick={() => setOpen(expanded ? null : id)}
          className={clsx('h-8 rounded px-2 text-caption', expanded ? 'text-fg' : 'text-dim hover:text-fg', FOCUS)}
        >
          {expanded ? 'Done' : action}
        </button>
      </div>
      {expanded && (
        <div id={panel} className="border-t border-line bg-panel/60 p-3">
          {children}
        </div>
      )}
    </div>
  )
}

function Tag({ tone, children }: { tone?: 'skill'; children: ReactNode }) {
  return (
    <span translate="no" className={clsx('max-w-full truncate rounded-md border px-[7px] py-px text-caption', tone === 'skill' ? 'border-skill/30 text-skill' : 'border-line')}>
      {children}
    </span>
  )
}

function FooterButton({ danger, icon: Icon, onClick, children }: { danger?: boolean; icon: typeof Wrench; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={clsx('inline-flex h-8 items-center gap-1.5 rounded px-1 text-ui text-dim', danger ? 'hover:text-danger-hi' : 'hover:text-fg', FOCUS)}>
      <Icon size={13} aria-hidden="true" />
      {children}
    </button>
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
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-caption text-dim">What it should do first, how to work, what to check before finishing, and what never to do.</span>
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
            placeholder="Be stricter about mobile layouts"
            aria-label="What should change"
          />
          <Button variant="primary" loading={busy} disabled={!request.trim() || !model} onClick={() => void rewrite()}>
            Rewrite
          </Button>
        </div>
      )}
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} onBlur={() => value !== agent.instructions && onSave(value)} rows={12} aria-label="Instructions" />
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
            placeholder="Check my web pages for design problems against the project's design system and fix them. It should look at the page in a real browser on phone and desktop, in both themes, before saying it's done."
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
