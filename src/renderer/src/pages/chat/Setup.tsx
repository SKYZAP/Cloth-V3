import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowSquareOut, CaretLeft, CaretRight, Check, FolderSimple, MagnifyingGlass, X } from '@phosphor-icons/react'
import type { Agent, AgentSetup, ChatSession, ChatSetup, McpClientStatus, Project, SkillMode } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Segmented } from './StatusLine'

/** What the capability lists edit: a chat, or a saved agent. */
export type Target = Pick<AgentSetup, 'skillsEnabled' | 'skillsOff' | 'skillsAlways' | 'webEnabled' | 'customTools' | 'subagents' | 'codeIntel' | 'imagesEnabled' | 'knowledgeEnabled' | 'collectionIds' | 'mcpServers' | 'disabledTools'>
export type Update = (p: Partial<AgentSetup>) => Promise<void>
type View = 'overview' | 'agent' | 'skills' | 'servers' | 'tools' | 'knowledge' | 'instructions'

/** The switches a chat takes from its agent; any difference means the chat was changed since. */
export const AGENT_KEYS: (keyof AgentSetup)[] = ['skillsEnabled', 'skillsOff', 'skillsAlways', 'webEnabled', 'customTools', 'subagents', 'codeIntel', 'imagesEnabled', 'knowledgeEnabled', 'collectionIds', 'mcpServers', 'disabledTools']

/** Colours of the four parts of the request budget, shared by the bar and the legend. */
const PART = { servers: '#6b9cf0', builtin: '#a3a3ad', skills: '#c084fc', knowledge: '#3fb97a' }

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
  { id: 'files', label: 'Files', names: ['read', 'ls', 'find', 'grep', 'ast_grep', 'write', 'edit', 'ast_edit', 'read_file', 'list_dir'], note: 'Which of these the chat has follows the folder and access set under the message box.' },
  { id: 'shell', label: 'Commands', names: ['bash', 'powershell'], note: 'Shown when access is Edit + shell.' },
  { id: 'code', label: 'Code intelligence', names: ['lsp'], flag: 'codeIntel' },
  { id: 'web', label: 'Web', names: ['web_search', 'web_fetch'], flag: 'webEnabled' },
  { id: 'agents', label: 'Subagents', names: ['task'], flag: 'subagents' },
  { id: 'images', label: 'Images', names: ['generate_image'], flag: 'imagesEnabled' },
  { id: 'plan', label: 'Planning and questions', names: ['todo_write', 'ask_user'] },
  { id: 'make', label: 'Making skills and tools', names: ['skill_create', 'tool_create'] },
  { id: 'custom', label: 'Custom tools', flag: 'customTools', note: 'Your own tools from the Tools page.' }
]
const KNOWLEDGE_TOOLS = ['rag_search', 'rag_index']
const SKILL_TOOLS = ['skill_list', 'skill_use']
const KNOWN = new Set(GROUPS.flatMap((g) => g.names ?? []))
const groupOf = (name: string) => GROUPS.find((g) => g.names?.includes(name)) ?? GROUPS.find((g) => g.id === 'custom')!
export const k = (n: number) => (n >= 100 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Which tools and skills are on for a chat or agent, what each part costs, and how to switch them. */
export function useCapabilities(target: Target, update: Update, setup: ChatSetup | null) {
  const settings = useApp((s) => s.settings)
  const collections = useApp((s) => s.collections)
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
  const sum = (ts: { tokens: number }[]) => ts.reduce((n, t) => n + t.tokens, 0)
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
}
export type Capabilities = ReturnType<typeof useCapabilities>

/** The Setup tab: what this chat can use, each part with what it adds to every request. */
export function SetupPanel({ session, update }: { session: ChatSession; update: (p: Partial<ChatSession>) => Promise<void> }) {
  const [view, setView] = useState<View>('overview')
  const [setup, setSetup] = useState<ChatSetup | null>(null)
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const setPage = useApp((s) => s.setPage)

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
  useEvent('agents', loadAgents)

  const m = useCapabilities(session, update, setup)
  const { configs, chosen, isOn, builtin, external, skillsOn, selected, parts, total } = m
  const agent = agents.find((a) => a.id === session.agentId) ?? null
  const changed = !!agent && AGENT_KEYS.some((key) => JSON.stringify(agent[key]) !== JSON.stringify(session[key]))

  if (view !== 'overview') {
    const back = () => setView('overview')
    if (view === 'agent')
      return (
        <AgentPicker
          back={back}
          agents={agents}
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
    if (view === 'servers') return <ServersView back={back} target={session} update={update} m={m} status={servers} />
    if (view === 'tools') return <ToolsView back={back} target={session} update={update} m={m} />
    if (view === 'knowledge') return <KnowledgeView back={back} target={session} update={update} total={parts.knowledge} />
    return <InstructionsView back={back} session={session} update={update} />
  }

  const builtinOn = builtin.filter((t) => isOn(t.name)).length
  const externalOn = external.filter((t) => isOn(t.name)).length
  const serversOn = configs.filter((c) => chosen.includes(c.id)).length
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-2.5 mt-3 grid gap-2 rounded-[14px] border border-line bg-panel px-3 pb-3 pt-2.5" role="group" aria-label="Added to each request">
        <div className="flex items-baseline justify-between text-[12px] text-muted">
          <span>Added to each request</span>
          <b className="font-mono text-[12px] font-medium tabular-nums text-fg">{setup ? `${k(total)} tokens` : '…'}</b>
        </div>
        <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-elev-2" aria-hidden="true">
          {(Object.keys(PART) as (keyof typeof PART)[]).map((p) => (total ? <span key={p} style={{ width: `${(parts[p] / total) * 100}%`, background: PART[p] }} className="h-full transition-[width] duration-300" /> : null))}
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-x-2 gap-y-1 text-[11.5px] text-muted">
          {(
            [
              ['servers', 'Servers'],
              ['builtin', 'Built-in'],
              ['skills', 'Skills'],
              ['knowledge', 'Knowledge']
            ] as const
          ).map(([p, label]) => (
            <Legend key={p} color={PART[p]} label={label} value={k(parts[p])} />
          ))}
        </div>
      </div>
      <div className="grid gap-0.5 p-2">
        <SummaryLine label="Agent" onOpen={() => setView('agent')} value={agent ? `${agent.name}${changed ? ' (changed)' : ''}` : 'Default'} />
        <SummaryLine label="Skills" count={skillsOn.length} tokens={parts.skills} onOpen={() => setView('skills')} hint={!session.skillsEnabled ? 'picked by you only' : undefined} />
        {!configs.length ? (
          <SummaryLine label="External servers" onOpen={() => setView('servers')} hint="none set up" />
        ) : !serversOn ? (
          <SummaryLine label="External servers" onOpen={() => setView('servers')} hint="none on" />
        ) : !external.some((t) => isOn(t.name)) ? (
          <SummaryLine label="External servers" onOpen={() => setView('servers')} hint={`${serversOn} start${serversOn === 1 ? 's' : ''} when the chat runs`} />
        ) : (
          <SummaryLine label="External servers" count={externalOn} tokens={parts.servers} onOpen={() => setView('servers')} />
        )}
        <SummaryLine label="Built-in tools" count={builtinOn} tokens={parts.builtin} onOpen={() => setView('tools')} />
        <SummaryLine label="Knowledge" count={selected.length} tokens={parts.knowledge} onOpen={() => setView('knowledge')} />
        {computerSupported && (
          <div className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-fg">Control this computer</div>
              <div className="text-[11px] leading-snug text-dim">Sees your screen and uses the mouse and keyboard. Cloth steps aside while it works.</div>
            </div>
            <Toggle on={session.computerUse} onChange={() => void update({ computerUse: !session.computerUse })} label="Control this computer" />
          </div>
        )}
        <SummaryLine label="Instructions" onOpen={() => setView('instructions')} hint={session.systemPrompt.trim() ? 'this chat has its own' : session.projectId ? 'from the project' : agent ? 'from the agent' : 'none'} />
      </div>
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
      <b className="text-right font-mono text-[10.5px] font-normal tabular-nums text-dim">{value}</b>
    </>
  )
}

function SummaryLine({ label, count, tokens, hint, value, onOpen }: { label: string; count?: number; tokens?: number; hint?: string; value?: string; onOpen(): void }) {
  return (
    <button
      onClick={onOpen}
      aria-label={`${label}${count !== undefined ? `: ${count} on` : ''}${tokens ? `, adds about ${k(tokens)} tokens` : ''}`}
      className="flex h-10 items-center gap-2 rounded-[10px] px-2.5 text-left transition-colors hover:bg-elev"
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{label}</span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-dim">
        {hint && <span className="font-sans text-[11.5px]">{hint}</span>}
        {value && <span className="max-w-[180px] truncate font-sans text-[12px] text-fg">{value}</span>}
        {count !== undefined && <span className="text-fg">{count}</span>}
        {count !== undefined && tokens !== undefined && <span>· +{k(tokens)}</span>}
      </span>
      <CaretRight size={12} className="shrink-0 text-dim" />
    </button>
  )
}

/** A drill-in tab: a back link, the section's title and cost, a search box, and its list. */
function Drill({ title, back, total, search, onSearch, filters, children, head }: { title: string; back?: () => void; total?: number; search?: string; onSearch?(q: string): void; filters?: ReactNode; head?: ReactNode; children: ReactNode }) {
  if (!back)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
        {head}
        {onSearch && <SearchBox title={title} search={search ?? ''} onSearch={onSearch} />}
        {filters}
        <div>{children}</div>
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <div className="grid shrink-0 gap-2 border-b border-line px-2.5 pb-2.5 pt-2">
        <div className="flex items-center gap-1">
          <button onClick={back} className="flex h-7 items-center gap-1 rounded-lg pl-1 pr-2 text-[12px] text-dim hover:bg-elev hover:text-fg">
            <CaretLeft size={12} /> Setup
          </button>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
          {total !== undefined && <span className="font-mono text-[11px] tabular-nums text-dim">+{k(total)} tokens</span>}
        </div>
        {head}
        {onSearch && <SearchBox title={title} search={search ?? ''} onSearch={onSearch} />}
        {filters}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{children}</div>
    </div>
  )
}

function SearchBox({ title, search, onSearch }: { title: string; search: string; onSearch(q: string): void }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-[10px] border border-line bg-bg px-2.5 focus-within:border-crimson-line">
      <MagnifyingGlass size={13} className="shrink-0 text-dim" />
      <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={`Filter ${title.toLowerCase()}`} aria-label={`Filter ${title.toLowerCase()}`} spellCheck={false} className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-dim focus-visible:outline-none" />
      {search && (
        <button onClick={() => onSearch('')} aria-label="Clear the filter" className="text-dim hover:text-fg">
          <X size={12} />
        </button>
      )}
    </div>
  )
}

/** Pick the chat's agent: its setup is applied to the chat, and its instructions come with every request. */
function AgentPicker({ back, agents, current, changed, onPick, onManage }: { back(): void; agents: Agent[]; current: string | null; changed: boolean; onPick(id: string | null): void; onManage(): void }) {
  const [q, setQ] = useState('')
  const shown = agents.filter((a) => matches(q, a.name, a.purpose))
  const option = (id: string | null, name: string, sub: string) => {
    const on = id === current
    return (
      <button key={id ?? 'default'} onClick={() => onPick(id)} aria-pressed={on} className={clsx('flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors', on ? 'bg-elev-2' : 'hover:bg-elev')}>
        <span className="mt-0.5 w-3.5 shrink-0 text-crimson-hi">{on && <Check size={13} weight="bold" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-fg">{name}</span>
          <span className="line-clamp-2 text-[11.5px] text-dim">{sub}</span>
        </span>
      </button>
    )
  }
  return (
    <Drill title="Agent" back={back} search={agents.length > 6 ? q : undefined} onSearch={agents.length > 6 ? setQ : undefined}>
      {option(null, 'Default', "Cloth's assistant with this chat's own setup")}
      {shown.map((a) => option(a.id, a.name, a.purpose || 'No purpose yet'))}
      {changed && <p className="px-2.5 pt-2 text-[11px] text-dim">This chat's setup was changed after the agent was picked. Pick the agent again to go back to its setup.</p>}
      <p className="px-2.5 pb-2 pt-3 text-[11px] leading-relaxed text-dim">Picking an agent sets this chat up with its skills, tools and knowledge, and its model if it has one. Its instructions come with every message.</p>
      <button onClick={onManage} className="mx-2.5 flex items-center gap-1.5 text-[12px] text-muted hover:text-fg">
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
          className={clsx('flex h-6 items-center gap-1 rounded-full border px-2 text-[11.5px] transition-colors', value === i.value ? 'border-line-strong bg-elev-2 text-fg' : 'border-line text-dim hover:text-muted')}
        >
          {i.label} <span className="font-mono text-[10.5px] text-dim">{i.count}</span>
        </button>
      ))}
    </div>
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
      className={clsx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-40', on ? 'bg-crimson' : 'bg-line-strong')}
    >
      <span className={clsx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all', on ? 'left-[16px]' : 'left-[2px]')} />
    </button>
  )
}

function Row({ title, sub, tokens, dim, children, mono }: { title: ReactNode; sub?: ReactNode; tokens?: number; dim?: boolean; children?: ReactNode; mono?: boolean }) {
  return (
    <div className={clsx('flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-elev', dim && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className={clsx('truncate text-[12.5px] text-fg', mono && 'font-mono text-[12px]')}>{title}</div>
        {sub && <div className="truncate text-[11px] text-dim">{sub}</div>}
      </div>
      {tokens !== undefined && <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-dim">+{k(tokens)}</span>}
      {children}
    </div>
  )
}

const matches = (q: string, ...texts: string[]) => !q.trim() || texts.some((t) => t.toLowerCase().includes(q.trim().toLowerCase()))

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
  const shown = skills.filter((s) => (filter === 'all' || s.mode === filter) && matches(q, s.name, s.description))
  const count = (m: SkillMode) => skills.filter((s) => s.mode === m).length
  return (
    <Drill
      title="Skills"
      back={back}
      total={total}
      search={q}
      onSearch={setQ}
      head={
        <label className="flex items-center gap-2 px-1 text-[12px] text-muted">
          <Toggle on={session.skillsEnabled} onChange={() => void update({ skillsEnabled: !session.skillsEnabled })} label="Let the agent pick skills" />
          <span className="min-w-0 flex-1">{session.skillsEnabled ? 'The agent picks Auto skills when they fit' : 'Only Always skills and /name load'}</span>
        </label>
      }
      filters={
        <Chips<'all' | SkillMode>
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All', count: skills.length },
            { value: 'auto', label: 'Auto', count: count('auto') },
            { value: 'always', label: 'Always', count: count('always') },
            { value: 'off', label: 'Off', count: count('off') }
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
      {!shown.length && <Nothing>{skills.length ? 'No skill matches.' : 'No skills yet. Create or import one on the Skills page.'}</Nothing>}
      <p className="px-2 pb-2 pt-3 text-[11px] leading-relaxed text-dim">Auto skills cost one line each until the agent loads one. Always skills send their full instructions with every request. Type /name in the message box to use any skill once, even an Off one.</p>
    </Drill>
  )
}

export function ServersView({ back, target: session, update, m, status }: { back?: () => void; target: Target; update: Update; m: Capabilities; status: McpClientStatus[] }) {
  const { configs, chosen, external: tools, serverOf, isOn, toggleTool } = m
  const total = m.parts.servers
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggleServer = (id: string) => {
    const on = chosen.includes(id)
    const own = tools.filter((t) => serverOf(t.name)?.id === id).map((t) => t.name)
    void update({ mcpServers: on ? chosen.filter((x) => x !== id) : [...chosen, id], ...(on ? {} : { disabledTools: session.disabledTools.filter((n) => !own.includes(n)) }) })
  }
  return (
    <Drill title="External servers" back={back} total={total} search={q} onSearch={setQ}>
      {configs.map((c) => {
        const own = tools.filter((t) => serverOf(t.name)?.id === c.id)
        const st = status.find((s) => s.id === c.id)
        const on = chosen.includes(c.id)
        const onTools = own.filter((t) => isOn(t.name))
        const shown = own.filter((t) => matches(q, t.name, t.description))
        if (q && !shown.length && !matches(q, c.name)) return null
        const expanded = open.has(c.id) || !!q
        return (
          <div key={c.id} className="mb-1 rounded-[12px] border border-line">
            <div className="flex items-center gap-2 px-2.5 py-2">
              <button
                onClick={() => setOpen((s) => (s.has(c.id) ? new Set([...s].filter((x) => x !== c.id)) : new Set([...s, c.id])))}
                aria-expanded={expanded}
                disabled={!own.length}
                className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
              >
                <CaretRight size={11} className={clsx('shrink-0 text-dim transition-transform', expanded && 'rotate-90', !own.length && 'opacity-0')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{c.name}</span>
                  <span className="block truncate text-[11px] text-dim">
                    {st?.state === 'ready'
                      ? `${on ? onTools.length : 0} of ${own.length} tools · ${c.approval === 'ask' ? 'asks first' : 'runs freely'}`
                      : st?.state === 'error'
                        ? 'Failed to start. See Settings → MCP'
                        : st?.state === 'starting'
                          ? 'Starting…'
                          : 'Lists its tools once it starts'}
                  </span>
                </span>
              </button>
              {on && own.length > 0 && <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-dim">+{k(onTools.reduce((n, t) => n + t.tokens, 0))}</span>}
              {st?.state !== 'ready' && st?.state !== 'starting' && (
                <button onClick={() => void api.mcp.startClient(c.id).catch(() => undefined)} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-dim hover:bg-elev-2 hover:text-fg">
                  Start
                </button>
              )}
              <Toggle on={on} onChange={() => toggleServer(c.id)} label={`Use ${c.name} in this chat`} />
            </div>
            {expanded && own.length > 0 && (
              <div className="border-t border-line p-1">
                {shown.map((t) => (
                  <Row key={t.name} mono title={t.name.split('__')[2]} sub={t.description.replace(/ \(external tool from .*\)$/, '')} tokens={t.tokens} dim={!isOn(t.name)}>
                    <Toggle on={isOn(t.name)} onChange={() => toggleTool(t.name)} label={`${t.name.split('__')[2]}`} />
                  </Row>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {!configs.length && <Nothing>No external servers yet. Add one in Settings → MCP.</Nothing>}
    </Drill>
  )
}

export function ToolsView({ back, target: session, update, m, access }: { back?: () => void; target: Target; update: Update; m: Capabilities; /** Shown under Files instead of the note (the agent editor's access controls). */ access?: ReactNode }) {
  const { builtin: tools, isOn, toggleTool } = m
  const total = m.parts.builtin
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all')
  const groups = useMemo(() => GROUPS.map((g) => ({ g, items: tools.filter((t) => (g.names ? g.names.includes(t.name) : !KNOWN.has(t.name))) })).filter((x) => x.items.length), [tools])
  const on = tools.filter((t) => isOn(t.name)).length
  return (
    <Drill
      title="Built-in tools"
      back={back}
      total={total}
      search={q}
      onSearch={setQ}
      filters={
        <Chips<'all' | 'on' | 'off'>
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All', count: tools.length },
            { value: 'on', label: 'On', count: on },
            { value: 'off', label: 'Off', count: tools.length - on }
          ]}
        />
      }
    >
      {groups.map(({ g, items }) => {
        const shown = items.filter((t) => matches(q, t.name, t.description) && (filter === 'all' || (filter === 'on') === isOn(t.name)))
        if (!shown.length) return null
        const groupOn = g.flag ? session[g.flag] : true
        return (
          <section key={g.id} className="mb-2">
            <div className="flex items-center gap-2 px-2 pb-1 pt-2">
              <span className="min-w-0 flex-1 text-[11.5px] font-medium text-dim">{g.label}</span>
              {g.flag && <Toggle on={groupOn} onChange={() => void update({ [g.flag!]: !groupOn, ...(!groupOn ? { disabledTools: session.disabledTools.filter((n) => !items.some((t) => t.name === n)) } : {}) })} label={`${g.label} for this chat`} />}
            </div>
            {g.id === 'files' && access ? <div className="px-2 pb-1.5">{access}</div> : g.note && <div className="px-2 pb-1 text-[11px] text-dim">{g.note}</div>}
            {shown.map((t) => (
              <Row key={t.name} mono title={t.name} sub={t.description.split(/(?<=\.)\s/)[0]} tokens={t.tokens} dim={!isOn(t.name)}>
                <Toggle on={isOn(t.name)} onChange={() => toggleTool(t.name)} label={t.name} />
              </Row>
            ))}
          </section>
        )
      })}
      {!tools.length && <Nothing>Loading…</Nothing>}
    </Drill>
  )
}

export function KnowledgeView({ back, target: session, update, total }: { back?: () => void; target: Target; update: Update; total: number }) {
  const collections = useApp((s) => s.collections)
  const [q, setQ] = useState('')
  const selected = session.knowledgeEnabled ? (session.collectionIds.length ? session.collectionIds.filter((id) => collections.some((c) => c.id === id)) : collections.map((c) => c.id)) : []
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    if (!next.length) return void update({ knowledgeEnabled: false, collectionIds: [] })
    void update({ knowledgeEnabled: true, collectionIds: next.length === collections.length ? [] : next })
  }
  const shown = collections.filter((c) => matches(q, c.name, c.description ?? ''))
  return (
    <Drill title="Knowledge" back={back} total={total} search={collections.length > 6 ? q : undefined} onSearch={collections.length > 6 ? setQ : undefined}>
      {shown.map((c) => (
        <Row key={c.id} title={c.name} sub={`${c.docCount} docs · ${c.embeddingDim ? 'keyword + meaning search' : 'keyword search'}`} dim={!selected.includes(c.id)}>
          <Toggle on={selected.includes(c.id)} onChange={() => toggle(c.id)} label={`Search ${c.name}`} />
        </Row>
      ))}
      {!collections.length && <Nothing>No collections yet. Add knowledge on the Knowledge page.</Nothing>}
      <p className="px-2 pb-2 pt-3 text-[11px] leading-relaxed text-dim">The agent searches the collections that are on with rag_search, and cites what it finds.</p>
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
          <div className="text-[11.5px] text-dim">Project</div>
          <div className="flex flex-wrap gap-1.5">
            {[null, ...projects].map((p) => {
              const on = (p?.id ?? null) === session.projectId
              return (
                <button
                  key={p?.id ?? 'none'}
                  onClick={() => moveTo(p)}
                  aria-pressed={on}
                  className={clsx('flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] transition-colors', on ? 'border-line-strong bg-elev-2 text-fg' : 'border-line text-muted hover:border-line-strong')}
                >
                  {p ? <FolderSimple size={13} weight="fill" style={{ color: p.color }} /> : <X size={11} />}
                  {p?.name ?? 'No project'}
                </button>
              )
            })}
          </div>
          {project && <div className="text-[11px] text-dim">The project's instructions{project.folder ? ' and its folder\'s AGENTS.md' : ''} come first.</div>}
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="chat-instructions" className="text-[11.5px] text-dim">
            This chat
          </label>
          <textarea
            id="chat-instructions"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => text !== session.systemPrompt && void update({ systemPrompt: text })}
            placeholder="e.g. Prefer idiomatic TypeScript; cite the knowledge base."
            className="min-h-[160px] w-full resize-y rounded-[10px] border border-line bg-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-dim focus:border-crimson-line focus-visible:outline-none"
          />
          <div className="text-[11px] text-dim">Added to Cloth's system prompt for this chat. Saved when you click away.</div>
        </div>
      </div>
    </Drill>
  )
}

function Nothing({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-[12px] text-dim">{children}</div>
}

