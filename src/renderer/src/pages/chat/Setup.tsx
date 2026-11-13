import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowSquareOut, Books, CaretLeft, CaretRight, FolderSimple, Gauge, MagnifyingGlass, Monitor, NotePencil, PlugsConnected, Robot, Sparkle, Wrench, X, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { contextIsGuess, type Agent, type AgentSetup, type ChatSession, type ChatSetup, type McpClientStatus, type Project, type SkillMode } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Segmented } from './StatusLine'
import { filterOnOff, firstSentence, matches, nothingMatches, onOffCounts, serverMatches, type OnOff } from './setupFilter'
import { takeSetupSection, useSetupNav, type SetupSection } from './setupNav'
import { ContextSlider } from '@/components/ContextSlider'

/** What the capability lists edit: a chat, or a saved agent. */
export type Target = Pick<AgentSetup, 'skillsEnabled' | 'skillsOff' | 'skillsAlways' | 'webEnabled' | 'customTools' | 'subagents' | 'codeIntel' | 'imagesEnabled' | 'knowledgeEnabled' | 'collectionIds' | 'mcpServers' | 'disabledTools'>
export type Update = (p: Partial<AgentSetup>) => Promise<void>
type View = 'overview' | SetupSection

/** The switches a chat takes from its agent; any difference means the chat was changed since. */
export const AGENT_KEYS: (keyof AgentSetup)[] = ['skillsEnabled', 'skillsOff', 'skillsAlways', 'webEnabled', 'customTools', 'subagents', 'codeIntel', 'imagesEnabled', 'knowledgeEnabled', 'collectionIds', 'mcpServers', 'disabledTools']

/** Colours of the four parts of the request budget, shared by the bar and the legend. */
const PART = { servers: '#6cb2ec', builtin: '#bdbdc5', skills: '#c9a3f5', knowledge: '#5ccb89' }

type FlagKey = 'webEnabled' | 'subagents' | 'imagesEnabled' | 'codeIntel' | 'customTools'
interface Group {
  id: string
  label: string
  names?: string[]
  /** The chat setting that switches the whole group. */
  flag?: FlagKey
  note?: string
}
/** Built-in tools by what they're for. Tools not listed here are custom tools (from the Tools page). */
const GROUPS: Group[] = [
  { id: 'files', label: 'Files', names: ['read', 'ls', 'find', 'grep', 'ast_grep', 'write', 'edit', 'ast_edit', 'read_file', 'list_dir'] },
  { id: 'shell', label: 'Commands', names: ['bash', 'powershell'] },
  { id: 'code', label: 'Code intelligence', names: ['lsp'], flag: 'codeIntel' },
  { id: 'web', label: 'Web', names: ['web_search', 'web_fetch'], flag: 'webEnabled' },
  { id: 'agents', label: 'Subagents', names: ['task'], flag: 'subagents' },
  { id: 'images', label: 'Images', names: ['generate_image'], flag: 'imagesEnabled' },
  { id: 'plan', label: 'Planning and questions', names: ['todo_write', 'ask_user'] },
  { id: 'make', label: 'Making skills and tools', names: ['skill_create', 'tool_create'] },
  { id: 'custom', label: 'Custom tools', flag: 'customTools' }
]
const KNOWLEDGE_TOOLS = ['rag_search', 'rag_index']
const SKILL_TOOLS = ['skill_list', 'skill_use']
const KNOWN = new Set(GROUPS.flatMap((g) => g.names ?? []))
const groupOf = (name: string) => GROUPS.find((g) => g.names?.includes(name)) ?? GROUPS.find((g) => g.id === 'custom')!
export const k = (n: number) => (n >= 100 ? `${(n / 1000).toFixed(1)}k` : String(n))
const sum = (ts: { tokens: number }[]) => ts.reduce((n, t) => n + t.tokens, 0)

/** Which tools and skills are on for a chat or agent, what each part costs, and how to switch them. */
export function useCapabilities(target: Target, update: Update, setup: ChatSetup | null) {
  const settings = useApp((s) => s.settings)
  const collections = useApp((s) => s.collections)
  // The lists below are memoised on the data; the latest update function is read when a switch is used.
  const updateRef = useRef(update)
  updateRef.current = update
  return useMemo(() => {
    const configs = (settings?.mcpClients ?? []).filter((c) => c.enabled)
    const chosen = target.mcpServers ?? configs.filter((c) => c.defaultOn).map((c) => c.id)
    const off = new Set(target.disabledTools)
    const tools = setup?.tools ?? []
    const serverOf = (name: string) => configs.find((c) => name.startsWith(`mcp__${c.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}__`))

    const isOn = (name: string): boolean => {
      if (off.has(name)) return false
      if (name.startsWith('mcp__')) {
        const c = serverOf(name)
        return !!c && chosen.includes(c.id)
      }
      if (KNOWLEDGE_TOOLS.includes(name)) return target.knowledgeEnabled
      if (SKILL_TOOLS.includes(name)) return target.skillsEnabled
      const g = groupOf(name)
      return g.flag ? target[g.flag] : true
    }

    const builtin = tools.filter((t) => !t.name.startsWith('mcp__') && !KNOWLEDGE_TOOLS.includes(t.name) && !SKILL_TOOLS.includes(t.name))
    const external = tools.filter((t) => t.name.startsWith('mcp__'))
    const skills = setup?.skills ?? []
    const skillCost = (s: ChatSetup['skills'][number]) => (s.mode === 'always' ? s.fullTokens : s.mode === 'auto' && target.skillsEnabled ? s.listedTokens : 0)
    const skillsOn = skills.filter((s) => s.mode === 'always' || (s.mode === 'auto' && target.skillsEnabled))
    const selected = target.knowledgeEnabled ? (target.collectionIds.length ? collections.filter((c) => target.collectionIds.includes(c.id)) : collections) : []

    const parts = {
      servers: sum(external.filter((t) => isOn(t.name))),
      builtin: sum(builtin.filter((t) => isOn(t.name))),
      skills: skills.reduce((n, s) => n + skillCost(s), 0) + sum(tools.filter((t) => SKILL_TOOLS.includes(t.name) && isOn(t.name))),
      knowledge: (setup?.knowledgeTokens ?? 0) + sum(tools.filter((t) => KNOWLEDGE_TOOLS.includes(t.name) && isOn(t.name)))
    }
    const total = parts.servers + parts.builtin + parts.skills + parts.knowledge

    const toggleTool = (name: string) => {
      const update = updateRef.current
      const nextOff = new Set(off)
      if (isOn(name)) return void update({ disabledTools: [...nextOff.add(name)] })
      nextOff.delete(name)
      const patch: Partial<AgentSetup> = {}
      // Switching on one tool of a switched-off group turns the group on with just that tool.
      const g = name.startsWith('mcp__') ? null : groupOf(name)
      if (g?.flag && !target[g.flag]) {
        patch[g.flag] = true
        for (const t of builtin) if (t.name !== name && groupOf(t.name) === g) nextOff.add(t.name)
      }
      const c = name.startsWith('mcp__') ? serverOf(name) : null
      if (c && !chosen.includes(c.id)) {
        patch.mcpServers = [...chosen, c.id]
        for (const t of external) if (t.name !== name && serverOf(t.name) === c) nextOff.add(t.name)
      }
      void update({ ...patch, disabledTools: [...nextOff] })
    }
    return { configs, chosen, serverOf, isOn, builtin, external, skills, skillCost, skillsOn, selected, parts, total, toggleTool, setup }
  }, [target, setup, settings, collections])
}
export type Capabilities = ReturnType<typeof useCapabilities>

/** The Setup tab: what this chat can use, each part with what it adds to every request. */
export function SetupPanel({ session, update }: { session: ChatSession; update: (p: Partial<ChatSession>) => Promise<void> }) {
  const [view, setView] = useState<View>('overview')
  const [setup, setSetup] = useState<ChatSetup | null>(null)
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const setPage = useApp((s) => s.setPage)
  const tiers = useApp((s) => s.settings?.agentTiers)

  const load = () => {
    void api.chat.setup(session.id).then(setSetup, () => undefined)
    void api.mcp.clients().then(setServers, () => undefined)
  }
  // Reload whenever the chat's settings change (any update bumps updatedAt).
  useEffect(load, [session.id, session.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('mcpClients', load)
  useEffect(() => setView('overview'), [session.id])
  const loadAgents = () => void api.agents.list().then(setAgents, () => undefined)
  useEffect(loadAgents, [])
  // Computer use runs on Windows and macOS only.
  const computerSupported = window.cloth.platform === 'win32' || window.cloth.platform === 'darwin'
  useEvent('agents', (e) => e.type === 'changed' && loadAgents())

  // openSetupSection(): show the section afresh and focus its Filter box (the instructions' text on that page).
  const pending = useSetupNav((s) => s.pending)
  const [opened, setOpened] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pending) return
    setView(pending.section)
    setOpened(pending.seq)
    takeSetupSection(pending.seq)
  }, [pending])
  useEffect(() => {
    if (!opened) return
    const t = window.setTimeout(() => root.current?.querySelector<HTMLElement>('[data-setup-filter], textarea')?.focus({ preventScroll: true }), 30)
    return () => window.clearTimeout(t)
  }, [opened])

  const m = useCapabilities(session, update, setup)
  const modelWindow = useModelWindow(session)
  const { configs, chosen, isOn, builtin, external, skillsOn, selected, parts, total } = m
  const agent = agents.find((a) => a.id === session.agentId) ?? null
  const changed = !!agent && AGENT_KEYS.some((key) => JSON.stringify(agent[key]) !== JSON.stringify(session[key]))

  const page = (): ReactNode => {
    const back = () => setView('overview')
    if (view === 'agent')
      return (
        <AgentPicker
          back={back}
          agents={agents}
          tiers={tiers ?? []}
          current={session.agentId}
          changed={changed}
          onPick={async (id) => {
            const s = await attempt(() => api.chat.useAgent(session.id, id))
            // useAgent saves the chat itself: hand the new state to the page through a no-op update.
            if (s) await update({})
            back()
          }}
          onManage={() => setPage('agents')}
        />
      )
    if (view === 'skills') return <SkillsView back={back} target={session} update={update} m={m} />
    if (view === 'mcp') return <ServersView back={back} target={session} update={update} m={m} status={servers} />
    if (view === 'tools') return <ToolsView back={back} target={session} update={update} m={m} />
    if (view === 'knowledge') return <KnowledgeView back={back} target={session} update={update} total={parts.knowledge} />
    if (view === 'context') return <ContextView back={back} session={session} update={update} />
    return <InstructionsView back={back} session={session} update={update} />
  }
  if (view !== 'overview')
    return (
      // A request to open a section starts it afresh (its filter cleared, a server page closed).
      <div ref={root} key={`${view}:${opened}`} className="h-full">
        {page()}
      </div>
    )

  const builtinOn = builtin.filter((t) => isOn(t.name)).length
  const externalOn = external.filter((t) => isOn(t.name)).length
  const serversOn = configs.filter((c) => chosen.includes(c.id)).length
  const cost = (n: number) => (n ? `+${k(n)}` : undefined)
  const mcpSub = !configs.length
    ? 'None set up'
    : !serversOn
      ? 'None on'
      : !external.some((t) => isOn(t.name))
        ? `${serversOn} start${serversOn === 1 ? 's' : ''} when the chat runs`
        : `${externalOn} tool${externalOn === 1 ? '' : 's'} from ${serversOn} server${serversOn === 1 ? '' : 's'}`
  const instructions = session.systemPrompt.trim().split('\n')[0]
  const contextValue = session.contextLimit ? `${tokensLabel(session.contextLimit)}, set for all chats` : modelWindow ? `${tokensLabel(modelWindow)}, the model’s` : 'The model’s'
  return (
    <div ref={root} className="h-full overflow-y-auto">
      <div className="grid gap-3 p-3">
        <button
          onClick={() => setView('agent')}
          aria-label={`Agent: ${agent ? agent.name : 'Default'}${changed ? ', changed in this chat' : ''}`}
          className="flex items-center gap-2.5 rounded-xl border border-line p-2.5 text-left transition-colors hover:border-line-strong hover:bg-elev"
        >
          {agent ? (
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-agent-soft text-caption font-semibold text-agent">
              {agentInitials(agent.name)}
            </span>
          ) : (
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-crimson-soft text-crimson-text">
              <Robot size={16} weight="fill" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-semibold text-fg">{agent ? agent.name : 'Default'}</span>
            <span className="block truncate text-caption text-dim">{agent ? (changed ? 'Changed in this chat' : agent.purpose || 'Saved agent') : 'Cloth’s assistant with this chat’s own setup'}</span>
          </span>
          <CaretRight size={12} className="shrink-0 text-dim" />
        </button>

        <Group>
          <SetupRow icon={NotePencil} label="Instructions" sub={instructions || 'None'} onOpen={() => setView('instructions')} />
          <SetupRow icon={Gauge} label="Context window" sub={contextValue} onOpen={() => setView('context')} />
        </Group>

        <Caption>What the chat can use</Caption>
        <Group>
          <SetupRow icon={Books} label="Knowledge" sub={selected.length ? `${selected.length} collection${selected.length === 1 ? '' : 's'} on` : 'Off'} meta={cost(parts.knowledge)} on={selected.length > 0} onOpen={() => setView('knowledge')} />
          <SetupRow icon={Sparkle} label="Skills" sub={`${skillsOn.length} on · ${session.skillsEnabled ? 'the agent picks Auto skills' : 'picked by you only'}`} meta={cost(parts.skills)} on={skillsOn.length > 0} onOpen={() => setView('skills')} />
          <SetupRow icon={Wrench} label="Tools" sub={`${builtinOn} of ${builtin.length} on`} meta={cost(parts.builtin)} on={builtinOn > 0} onOpen={() => setView('tools')} />
          <SetupRow icon={PlugsConnected} label="MCP" sub={mcpSub} meta={cost(parts.servers)} on={serversOn > 0} onOpen={() => setView('mcp')} />
          {computerSupported && <SetupToggle icon={Monitor} label="Computer Use" sub="Screen, mouse and keyboard" on={session.computerUse} onChange={() => void update({ computerUse: !session.computerUse })} />}
          <SetupToggle icon={Robot} label="Automatic reasoning levels" sub="Each subagent job gets the reasoning level it needs" on={session.autoTiers} onChange={() => void update({ autoTiers: !session.autoTiers })} />
        </Group>

        <div className="grid gap-2" role="group" aria-label="Added to each request">
          <Caption aside={setup ? `${k(total)} tokens` : '…'}>Added to each request</Caption>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-elev-2" aria-hidden="true">
            {(Object.keys(PART) as (keyof typeof PART)[]).map((p) => (total ? <span key={p} style={{ width: `${(parts[p] / total) * 100}%`, background: PART[p] }} className="h-full transition-[width] duration-300" /> : null))}
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-3 gap-y-1 text-caption text-muted">
            {(
              [
                ['servers', 'MCP servers'],
                ['builtin', 'Built-in tools'],
                ['skills', 'Skills'],
                ['knowledge', 'Knowledge']
              ] as const
            ).map(([p, label]) => (
              <Legend key={p} color={PART[p]} label={label} value={k(parts[p])} />
            ))}
          </div>
        </div>
        <p className="text-caption leading-relaxed text-dim">{session.agentId ? 'Set up from an agent: changes stay in this chat.' : 'Shared by all chats, except Instructions.'}</p>
      </div>
    </div>
  )
}

const agentInitials = (name: string) =>
  name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

/** A bordered list of setup rows, divided by hairlines. */
function Group({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border border-line [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
}

function Caption({ children, aside }: { children: ReactNode; aside?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-0.5 text-micro font-semibold uppercase tracking-[0.07em] text-dim">
      <span>{children}</span>
      {aside && <b className="font-mono text-caption font-medium normal-case tracking-normal tabular-nums text-muted">{aside}</b>}
    </div>
  )
}

/** An overview row that opens its section: icon, name, what it's set to, and what it adds to each request. */
function SetupRow({ icon: Icon, label, sub, meta, on, onOpen }: { icon: PhosphorIcon; label: string; sub: string; meta?: string; on?: boolean; onOpen(): void }) {
  return (
    <button onClick={onOpen} aria-label={`${label}: ${sub}${meta ? `, adds about ${meta.slice(1)} tokens` : ''}`} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-elev">
      <Icon size={16} className={clsx('shrink-0', on ? 'text-muted' : 'text-dim')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-fg">{label}</span>
        <span className="block truncate text-caption text-dim">{sub}</span>
      </span>
      {meta && <span className="shrink-0 font-mono text-caption tabular-nums text-muted">{meta}</span>}
      <CaretRight size={12} className="shrink-0 text-dim" />
    </button>
  )
}

/** An overview row with a switch instead of a section. */
function SetupToggle({ icon: Icon, label, sub, on, onChange }: { icon: PhosphorIcon; label: string; sub: string; on: boolean; onChange(): void }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <Icon size={16} className={clsx('shrink-0', on ? 'text-muted' : 'text-dim')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-fg">{label}</span>
        <span className="block truncate text-caption text-dim">{sub}</span>
      </span>
      <Toggle on={on} onChange={onChange} label={label} />
    </div>
  )
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        <i className="h-[7px] w-[7px] shrink-0 rounded-[2px]" style={{ background: color }} />
        {label}
      </span>
      <b className="text-right font-mono text-micro font-normal tabular-nums text-dim">{value}</b>
    </>
  )
}

/** A drill-in tab: a back link, the section's title and cost, a search box, and its list. */
function Drill({
  title,
  titleMono,
  back,
  backLabel = 'Setup',
  total,
  search,
  onSearch,
  placeholder,
  filters,
  children,
  head
}: {
  title: string
  titleMono?: boolean
  back?: () => void
  backLabel?: string
  total?: number
  search?: string
  onSearch?(q: string): void
  placeholder?: string
  filters?: ReactNode
  head?: ReactNode
  children: ReactNode
}) {
  const box = onSearch && <SearchBox placeholder={placeholder ?? `Filter ${title.toLowerCase()}`} search={search ?? ''} onSearch={onSearch} />
  if (!back)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
        {head}
        {box}
        {filters}
        <div>{children}</div>
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <div className="grid shrink-0 gap-2.5 px-3 pb-2.5 pt-3">
        <div className="flex items-center gap-1.5">
          <button onClick={back} className="-ml-1 flex h-7 items-center gap-1 rounded-lg pl-1 pr-2 text-caption text-muted hover:bg-elev-2 hover:text-fg">
            <CaretLeft size={12} /> {backLabel}
          </button>
          <span className={clsx('min-w-0 flex-1 truncate text-ui font-semibold', titleMono && 'font-mono text-ui font-medium')}>{title}</span>
          {total !== undefined && <span className="font-mono text-caption tabular-nums text-dim">+{k(total)} tokens</span>}
        </div>
        {head}
        {box}
        {filters}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="rounded-xl border border-line p-1">{children}</div>
      </div>
    </div>
  )
}

function SearchBox({ placeholder, search, onSearch }: { placeholder: string; search: string; onSearch(q: string): void }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-[10px] border border-line bg-bg px-2.5 focus-within:border-crimson-line">
      <MagnifyingGlass size={13} className="shrink-0 text-dim" />
      <input data-setup-filter value={search} onChange={(e) => onSearch(e.target.value)} placeholder={placeholder} aria-label={placeholder} spellCheck={false} className="h-full min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-dim focus-visible:outline-none" />
      {search && (
        <button onClick={() => onSearch('')} aria-label="Clear the filter" className="text-dim hover:text-fg">
          <X size={12} />
        </button>
      )}
    </div>
  )
}

/** A drill-in page's master switch, above its filter. */
function Master({ on, onChange, label, children }: { on: boolean; onChange(): void; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 text-caption text-muted">
      <Toggle on={on} onChange={onChange} label={label} />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** Pick the chat's agent: its setup is applied to the chat, and its instructions come with every request. */
function AgentPicker({ back, agents, tiers, current, changed, onPick, onManage }: { back(): void; agents: Agent[]; tiers: { id: string; name: string }[]; current: string | null; changed: boolean; onPick(id: string | null): void; onManage(): void }) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => agents.filter((a) => matches(q, a.name, a.purpose)), [agents, q])
  const showDefault = matches(q, 'Default', "Cloth's assistant with this chat's own setup")
  const runsOn = (a: Agent) => (a.model ? a.model.modelId : a.tier ? `${tiers.find((t) => t.id === a.tier)?.name ?? a.tier} tier` : "chat's model")
  const option = (id: string | null, name: string, sub: string, meta: string) => {
    const on = id === current
    return (
      <Row key={id ?? 'default'} title={name} sub={sub} meta={meta} onClick={() => onPick(id)} role="radio" checked={on} selected={on}>
        <span aria-hidden="true" className={clsx('grid h-4 w-4 shrink-0 place-items-center rounded-full border-2', on ? 'border-crimson' : 'border-line-strong')}>
          {on && <span className="h-[7px] w-[7px] rounded-full bg-crimson" />}
        </span>
      </Row>
    )
  }
  return (
    <Drill title="Agent" back={back} search={q} onSearch={setQ} placeholder="Filter agents">
      <div role="radiogroup" aria-label="Agent that answers in this chat">
        {showDefault && option(null, 'Default', "Cloth's assistant with this chat's own setup", "chat's model")}
        {shown.map((a) => option(a.id, a.name, a.purpose || 'No purpose yet', runsOn(a)))}
      </div>
      {!showDefault && !shown.length && <Nothing>{nothingMatches(q)}</Nothing>}
      {changed && <p className="px-2.5 pt-2 text-caption text-dim">This chat's setup was changed after the agent was picked. Pick the agent again to go back to its setup.</p>}
      <button onClick={onManage} className="mx-2.5 flex items-center gap-1.5 text-caption text-muted hover:text-fg">
        Manage agents <ArrowSquareOut size={12} />
      </button>
    </Drill>
  )
}

function Chips<T extends string>({ value, onChange, items }: { value: T; onChange(v: T): void; items: { value: NoInfer<T>; label: string; count: number }[] }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
      {items.map((i) => (
        <button
          key={i.value}
          aria-pressed={value === i.value}
          onClick={() => onChange(i.value)}
          className={clsx('flex h-6 items-center gap-1 rounded-full border px-2 text-caption transition-colors', value === i.value ? 'border-line-strong bg-elev-2 text-fg' : 'border-line text-dim hover:text-muted')}
        >
          {i.label} <span className="font-mono text-micro text-dim">{i.count}</span>
        </button>
      ))}
    </div>
  )
}

/** All / On / Off chips with their counts. */
function OnOffChips({ value, onChange, counts }: { value: OnOff; onChange(v: OnOff): void; counts: Record<OnOff, number> }) {
  return (
    <Chips<OnOff>
      value={value}
      onChange={onChange}
      items={[
        { value: 'all', label: 'All', count: counts.all },
        { value: 'on', label: 'On', count: counts.on },
        { value: 'off', label: 'Off', count: counts.off }
      ]}
    />
  )
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange(): void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={clsx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-40', on ? 'bg-crimson' : 'bg-line-strong')}
    >
      <span className={clsx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all', on ? 'left-[16px]' : 'left-[2px]')} />
    </button>
  )
}

/** A list row: name, a one-line description, its cost and its control. With onClick the whole row opens or picks. */
function Row({
  title,
  sub,
  tokens,
  meta,
  dim,
  children,
  mono,
  tooltip,
  onClick,
  role,
  checked,
  selected
}: {
  title: ReactNode
  sub?: ReactNode
  tokens?: number
  /** Text in the normal font where the cost would be. */
  meta?: ReactNode
  dim?: boolean
  children?: ReactNode
  mono?: boolean
  tooltip?: string
  onClick?: () => void
  role?: 'button' | 'radio'
  checked?: boolean
  selected?: boolean
}) {
  const press = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    onClick?.()
  }
  return (
    <div
      title={tooltip}
      {...(onClick ? { role: role ?? 'button', tabIndex: 0, onClick, onKeyDown: press, 'aria-checked': role === 'radio' ? checked : undefined } : {})}
      className={clsx('flex items-center gap-2.5 rounded-[10px] px-2 py-1.5', selected ? 'bg-elev-2' : 'hover:bg-elev', onClick && 'cursor-pointer', dim && 'opacity-60')}
    >
      <div className="min-w-0 flex-1">
        <div className={clsx('truncate text-ui text-fg', mono && 'font-mono text-caption')}>{title}</div>
        {sub && <div className="truncate text-caption text-dim">{sub}</div>}
      </div>
      {meta && <span className="max-w-[40%] shrink-0 truncate text-caption text-dim">{meta}</span>}
      {tokens !== undefined && <span className="shrink-0 font-mono text-micro tabular-nums text-dim">+{k(tokens)}</span>}
      {children}
    </div>
  )
}

export function SkillsView({ back, target: session, update, m }: { back?: () => void; target: Target; update: Update; m: Capabilities }) {
  const { skills, skillCost: cost } = m
  const total = m.parts.skills
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | SkillMode>('all')
  const setMode = (name: string, mode: SkillMode) =>
    void update({
      skillsOff: mode === 'off' ? [...new Set([...session.skillsOff, name])] : session.skillsOff.filter((n) => n !== name),
      skillsAlways: mode === 'always' ? [...new Set([...session.skillsAlways, name])] : session.skillsAlways.filter((n) => n !== name)
    })
  const shown = useMemo(() => skills.filter((s) => (filter === 'all' || s.mode === filter) && matches(q, s.name, s.description)), [skills, filter, q])
  const counts = useMemo(() => {
    const c: Record<SkillMode, number> = { off: 0, auto: 0, always: 0 }
    for (const s of skills) c[s.mode]++
    return c
  }, [skills])
  return (
    <Drill
      title="Skills"
      back={back}
      total={total}
      search={q}
      onSearch={setQ}
      head={
        <Master on={session.skillsEnabled} onChange={() => void update({ skillsEnabled: !session.skillsEnabled })} label="Let the agent pick skills">
          {session.skillsEnabled ? 'The agent picks Auto skills when they fit' : 'Only Always skills and /name load'}
        </Master>
      }
      filters={
        <Chips<'all' | SkillMode>
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All', count: skills.length },
            { value: 'auto', label: 'Auto', count: counts.auto },
            { value: 'always', label: 'Always', count: counts.always },
            { value: 'off', label: 'Off', count: counts.off }
          ]}
        />
      }
    >
      {shown.map((s) => (
        <Row key={s.name} mono title={<span className="text-skill">{s.name}</span>} sub={s.description} tokens={cost(s)} dim={s.mode === 'off'}>
          <div className="w-[164px] shrink-0">
            <Segmented
              size="sm"
              value={s.mode}
              onChange={(m) => setMode(s.name, m)}
              label={`${s.name}: when to load`}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'auto', label: 'Auto' },
                { value: 'always', label: 'Always' }
              ]}
            />
          </div>
        </Row>
      ))}
      {!shown.length && <Nothing>{skills.length ? nothingMatches(q) : 'No skills yet. Create or import one on the Skills page.'}</Nothing>}
    </Drill>
  )
}

/** The MCP page: one row per server (its switch turns all its tools on or off); a row opens the server's tools. */
export function ServersView({ back, target: session, update, m, status }: { back?: () => void; target: Target; update: Update; m: Capabilities; status: McpClientStatus[] }) {
  const { configs, chosen, external, serverOf, isOn } = m
  const total = m.parts.servers
  const [q, setQ] = useState('')
  const [chip, setChip] = useState<OnOff>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const rows = useMemo(
    () =>
      configs.map((c) => {
        const own = external.filter((t) => serverOf(t.name)?.id === c.id)
        const onTools = own.filter((t) => isOn(t.name))
        const st = status.find((s) => s.id === c.id)
        const on = chosen.includes(c.id)
        const desc =
          st?.state === 'ready'
            ? `${on ? `${onTools.length} of ${own.length} tools on` : `${own.length} tools`} · ${c.approval === 'ask' ? 'asks first' : 'runs freely'}`
            : st?.state === 'error'
              ? 'Failed to start. See Settings → MCP'
              : st?.state === 'starting'
                ? 'Starting…'
                : 'Lists its tools once it starts'
        return { c, own, onTools, st, on, desc, tokens: sum(onTools), toolNames: own.map((t) => t.name.split('__')[2] ?? t.name) }
      }),
    [configs, external, serverOf, isOn, status, chosen]
  )
  const counts = useMemo(() => onOffCounts(rows, (r) => r.on), [rows])
  const shown = useMemo(() => rows.filter((r) => (chip === 'all' || (chip === 'on') === r.on) && serverMatches(q, r.c.name, r.desc, r.toolNames)), [rows, chip, q])
  /** All of a server's tools on (the server joins the chat), or the server off. */
  const setServer = (id: string, on: boolean) => {
    const own = rows.find((r) => r.c.id === id)?.own.map((t) => t.name) ?? []
    void update(on ? { mcpServers: [...new Set([...chosen, id])], disabledTools: session.disabledTools.filter((n) => !own.includes(n)) } : { mcpServers: chosen.filter((x) => x !== id) })
  }
  const open = rows.find((r) => r.c.id === openId)
  if (open) return <ServerPage row={open} m={m} initialQuery={q} back={() => setOpenId(null)} setServer={(on) => setServer(open.c.id, on)} />
  return (
    <Drill title="MCP" back={back} total={total} search={q} onSearch={setQ} placeholder="Filter MCP servers" filters={configs.length ? <OnOffChips value={chip} onChange={setChip} counts={counts} /> : undefined}>
      {shown.map((r) => (
        <Row key={r.c.id} mono title={r.c.name} sub={r.desc} tokens={r.on && r.own.length ? r.tokens : undefined} dim={!r.on} onClick={() => setOpenId(r.c.id)}>
          {r.st?.state !== 'ready' && r.st?.state !== 'starting' && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                void api.mcp.startClient(r.c.id).catch(() => undefined)
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-caption text-dim hover:bg-elev-2 hover:text-fg"
            >
              Start
            </button>
          )}
          <Toggle on={r.on} onChange={() => setServer(r.c.id, !r.on)} label={`Use ${r.c.name} in this chat`} />
          <CaretRight size={12} className="shrink-0 text-dim" />
        </Row>
      ))}
      {configs.length > 0 && !shown.length && <Nothing>{nothingMatches(q)}</Nothing>}
      {!configs.length && <Nothing>No external servers yet. Add one in Settings → MCP.</Nothing>}
    </Drill>
  )
}

type ServerRow = { c: Capabilities['configs'][number]; own: ChatSetup['tools']; onTools: ChatSetup['tools']; st?: McpClientStatus; on: boolean; desc: string; tokens: number }

/** One server's tools, each with its switch and approval rule. */
function ServerPage({ row, m, initialQuery, back, setServer }: { row: ServerRow; m: Capabilities; initialQuery: string; back(): void; setServer(on: boolean): void }) {
  const { c, own, onTools, on, tokens } = row
  const { isOn, toggleTool } = m
  const [q, setQ] = useState(initialQuery)
  const short = (name: string) => name.split('__')[2] ?? name
  const shown = useMemo(() => own.filter((t) => matches(q, short(t.name), t.description)), [own, q])
  const allOn = on && own.length > 0 && onTools.length === own.length
  const approval = `Approval: ${c.approval === 'ask' ? 'asks first' : 'automatic'}`
  return (
    <Drill
      title={c.name}
      titleMono
      back={back}
      backLabel="MCP"
      total={on ? tokens : 0}
      search={own.length ? q : undefined}
      onSearch={own.length ? setQ : undefined}
      placeholder="Filter tools"
      head={
        <Master on={own.length ? allOn : on} onChange={() => setServer(own.length ? !allOn : !on)} label={own.length ? `All ${c.name} tools` : `Use ${c.name} in this chat`}>
          {own.length ? `${allOn ? 'All' : onTools.length} of ${own.length} tools on` : `Use ${c.name} in this chat`}
        </Master>
      }
    >
      {shown.map((t) => (
        <Row key={t.name} mono title={short(t.name)} sub={approval} tooltip={t.description.replace(/ \(external tool from .*\)$/, '')} tokens={t.tokens} dim={!isOn(t.name)}>
          <Toggle on={isOn(t.name)} onChange={() => toggleTool(t.name)} label={short(t.name)} />
        </Row>
      ))}
      {own.length > 0 && !shown.length && <Nothing>{nothingMatches(q)}</Nothing>}
      {!own.length && (
        <Nothing>
          {row.desc}
          {row.st?.state !== 'ready' && row.st?.state !== 'starting' && (
            <button onClick={() => void api.mcp.startClient(c.id).catch(() => undefined)} className="ml-2 rounded-md px-1.5 py-0.5 text-caption text-muted hover:bg-elev-2 hover:text-fg">
              Start
            </button>
          )}
        </Nothing>
      )}
    </Drill>
  )
}

interface ToolItem {
  id: string
  name: string
  desc: string
  tokens: number
  on: boolean
  mono: boolean
  toggle(): void
}

/** The Tools page: switched groups (Subagents, Images, …), single built-in tools and custom tools; web is the master switch. */
export function ToolsView({ back, target: session, update, m, access }: { back?: () => void; target: Target; update: Update; m: Capabilities; /** Shown above the filter (the agent editor's access controls). */ access?: ReactNode }) {
  const { builtin: tools, isOn, toggleTool } = m
  const total = m.parts.builtin
  const [q, setQ] = useState('')
  const [chip, setChip] = useState<OnOff>('all')
  const items = useMemo(() => {
    const switchGroup = (flag: FlagKey, members: { name: string }[]) => {
      const on = session[flag]
      void update({ [flag]: !on, ...(!on ? { disabledTools: session.disabledTools.filter((n) => !members.some((t) => t.name === n)) } : {}) })
    }
    const groups = GROUPS.map((g) => ({ g, members: tools.filter((t) => (g.names ? g.names.includes(t.name) : !KNOWN.has(t.name))) })).filter((x) => x.members.length)
    const tool = (t: ChatSetup['tools'][number], desc: string): ToolItem => ({ id: t.name, name: t.name, desc, tokens: t.tokens, on: isOn(t.name), mono: true, toggle: () => toggleTool(t.name) })
    const out: ToolItem[] = []
    for (const { g, members } of groups)
      if (g.flag && g.id !== 'custom') out.push({ id: `group:${g.id}`, name: g.label, desc: members.map((t) => t.name).join(', '), tokens: sum(members), on: session[g.flag], mono: false, toggle: () => switchGroup(g.flag!, members) })
    for (const { g, members } of groups) if (!g.flag) for (const t of members) out.push(tool(t, firstSentence(t.description)))
    for (const { g, members } of groups) if (g.id === 'custom') for (const t of members) out.push(tool(t, `Custom · ${firstSentence(t.description)}`))
    return out
  }, [tools, session, update, isOn, toggleTool])
  const counts = useMemo(() => onOffCounts(items, (i) => i.on), [items])
  const shown = useMemo(() => filterOnOff(items, q, chip, (i) => i.on, (i) => [i.name, i.desc]), [items, q, chip])
  return (
    <Drill
      title="Tools"
      back={back}
      total={total}
      search={q}
      onSearch={setQ}
      head={access && <div className="px-1">{access}</div>}
      filters={<OnOffChips value={chip} onChange={setChip} counts={counts} />}
    >
      {shown.map((i) => (
        <Row key={i.id} mono={i.mono} title={i.name} sub={i.desc} tokens={i.tokens} dim={!i.on}>
          <Toggle on={i.on} onChange={i.toggle} label={i.mono ? i.name : `${i.name} for this chat`} />
        </Row>
      ))}
      {!tools.length ? <Nothing>Loading…</Nothing> : !shown.length && <Nothing>{nothingMatches(q)}</Nothing>}
    </Drill>
  )
}

export function KnowledgeView({ back, target: session, update, total }: { back?: () => void; target: Target; update: Update; total: number }) {
  const collections = useApp((s) => s.collections)
  const [q, setQ] = useState('')
  const [chip, setChip] = useState<OnOff>('all')
  const selected = useMemo(
    () => (session.knowledgeEnabled ? (session.collectionIds.length ? session.collectionIds.filter((id) => collections.some((c) => c.id === id)) : collections.map((c) => c.id)) : []),
    [session.knowledgeEnabled, session.collectionIds, collections]
  )
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    if (!next.length) return void update({ knowledgeEnabled: false, collectionIds: [] })
    void update({ knowledgeEnabled: true, collectionIds: next.length === collections.length ? [] : next })
  }
  const isOn = useMemo(() => {
    const set = new Set(selected)
    return (c: { id: string }) => set.has(c.id)
  }, [selected])
  const counts = useMemo(() => onOffCounts(collections, isOn), [collections, isOn])
  const shown = useMemo(() => filterOnOff(collections, q, chip, isOn, (c) => [c.name, c.description]), [collections, q, chip, isOn])
  return (
    <Drill title="Knowledge" back={back} total={total} search={q} onSearch={setQ} filters={collections.length ? <OnOffChips value={chip} onChange={setChip} counts={counts} /> : undefined}>
      {shown.map((c) => (
        <Row key={c.id} title={c.name} sub={`${c.docCount} docs · ${c.embeddingDim ? 'keyword + meaning search' : 'keyword search'}`} dim={!isOn(c)}>
          <Toggle on={isOn(c)} onChange={() => toggle(c.id)} label={`Search ${c.name}`} />
        </Row>
      ))}
      {collections.length > 0 && !shown.length && <Nothing>{nothingMatches(q)}</Nothing>}
      {!collections.length && <Nothing>No collections yet. Add knowledge on the Knowledge page.</Nothing>}
    </Drill>
  )
}

/** 131072 → "128K", 1_000_000 → "1M". */
export function tokensLabel(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  return `${Math.round(n / 1024)}K`
}

/** The chat model's own context window (null when it isn't known), and whether that size is a guess. */
function useModelWindow(session: ChatSession): number | null {
  const providers = useApp((s) => s.providers)
  const m = session.model && providers.find((p) => p.id === session.model!.providerId)?.models.find((x) => x.id === session.model!.modelId)
  return m ? m.contextWindow : null
}

/** The context window override: a slider (as on the Run page) from 4K up to the model's size, or any exact number. */
function ContextView({ back, session, update }: { back(): void; session: ChatSession; update: (p: Partial<ChatSession>) => Promise<void> }) {
  const providers = useApp((s) => s.providers)
  const model = session.model && providers.find((p) => p.id === session.model!.providerId)?.models.find((x) => x.id === session.model!.modelId)
  const own = model?.contextWindow ?? null
  const guessed = !!model && contextIsGuess(model)
  const limit = session.contextLimit
  const shown = limit ?? own ?? 32_768
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  // The model's own size means no override.
  const save = async (n: number) => {
    await update({ contextLimit: own !== null && n === own ? null : n })
    return true
  }
  return (
    <Drill title="Context window" back={back}>
      <div className="grid gap-4 p-1.5">
        <ContextSlider id={`chat-ctx-${session.id}`} label="Limit" hint={limit ? 'Set for all chats' : 'The model’s own'} value={draft} saved={shown} max={guessed ? null : own} onDraft={setDraft} onCommit={save}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-caption text-dim">
            <span className="min-w-0 flex-1">{own ? `${model?.name ?? 'This model'} takes ${tokensLabel(own)}${guessed ? ', a guess: its provider doesn’t say' : ''}.` : 'This model’s size isn’t known.'}</span>
            {!!limit && (
              <button onClick={() => void update({ contextLimit: null })} className="rounded text-caption text-muted underline decoration-line-strong underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line">
                Use the model’s
              </button>
            )}
          </div>
        </ContextSlider>
        {!!limit && own !== null && limit > own && !guessed && <p className="text-caption text-warn">More than the model takes ({tokensLabel(own)}): long chats may fail before Cloth summarises.</p>}
      </div>
    </Drill>
  )
}

function InstructionsView({ back, session, update }: { back(): void; session: ChatSession; update: (p: Partial<ChatSession>) => Promise<void> }) {
  const [text, setText] = useState(session.systemPrompt)
  useEffect(() => setText(session.systemPrompt), [session.systemPrompt])
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    void api.projects.list().then(setProjects, () => undefined)
  }, [])
  const project = projects.find((p) => p.id === session.projectId)
  const moveTo = (p: Project | null) => void update({ projectId: p?.id ?? null, ...(p?.folder && !session.workspace ? { workspace: p.folder } : {}) })
  return (
    <Drill title="Instructions" back={back}>
      <div className="grid gap-4 p-1.5">
        <div className="grid gap-1.5">
          <div className="text-caption text-dim">Project</div>
          <div className="flex flex-wrap gap-1.5">
            {[null, ...projects].map((p) => {
              const on = (p?.id ?? null) === session.projectId
              return (
                <button
                  key={p?.id ?? 'none'}
                  onClick={() => moveTo(p)}
                  aria-pressed={on}
                  className={clsx('flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-caption transition-colors', on ? 'border-line-strong bg-elev-2 text-fg' : 'border-line text-muted hover:border-line-strong')}
                >
                  {p ? <FolderSimple size={13} weight="fill" style={{ color: p.color }} /> : <X size={11} />}
                  {p?.name ?? 'No project'}
                </button>
              )
            })}
          </div>
          {project && <div className="text-caption text-dim">The project's instructions{project.folder ? " and its folder's AGENTS.md" : ''} come first.</div>}
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="chat-instructions" className="text-caption text-dim">
            This chat
          </label>
          <textarea
            id="chat-instructions"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== session.systemPrompt && void update({ systemPrompt: text })}
            placeholder="e.g. Prefer idiomatic TypeScript; cite the knowledge base."
            className="min-h-[160px] w-full resize-y rounded-[10px] border border-line bg-bg px-3 py-2.5 text-ui leading-relaxed text-fg outline-none placeholder:text-dim focus:border-crimson-line focus-visible:outline-none"
          />
        </div>
      </div>
    </Drill>
  )
}

function Nothing({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-caption text-dim">{children}</div>
}
