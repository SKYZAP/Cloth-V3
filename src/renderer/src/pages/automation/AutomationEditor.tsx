import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Cron } from 'croner'
import { AlertTriangle, ArrowLeft, BookOpen, Check, ChevronDown, Code2, FileText, FolderOpen, Globe, Link2, MessageSquareText, Minus, Pencil, Plug, Plus, Search, Sparkles, SquareTerminal, Trash2, X } from 'lucide-react'
import type { Agent, Automation, AutomationDelivery, BuiltinToolInfo, Collection, CustomTool, McpClientStatus, Skill, Workflow, WorkflowRun } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { timeAgo } from '@/lib/format'
import { Button, IconButton, Input, Select, confirmAction } from '@/components/ui'

type Kind = 'tools' | 'mcp' | 'knowledge' | 'skills'
type Icon = typeof Globe

interface AccessItem {
  kind: Kind
  /** Tool name, server id, collection id or skill name. */
  id: string
  label: string
  desc: string
  meta: string
  warn?: string
  icon: Icon
  /** An external server's tools, for picking some of them. */
  serverTools?: string[]
}

const KIND: Record<Kind, { label: string; one: string; tile: string; dot: string; on: string }> = {
  tools: { label: 'Tools', one: 'Tool', tile: 'bg-crimson-soft text-crimson-hi', dot: 'bg-crimson', on: 'border-transparent bg-crimson-soft text-crimson-hi' },
  mcp: { label: 'MCP servers', one: 'MCP server', tile: 'bg-info/15 text-info', dot: 'bg-info', on: 'border-transparent bg-info/15 text-info' },
  knowledge: { label: 'Knowledge', one: 'Knowledge', tile: 'bg-ok/15 text-ok', dot: 'bg-ok', on: 'border-transparent bg-ok/15 text-ok' },
  skills: { label: 'Skills', one: 'Skill', tile: 'bg-skill-soft text-skill', dot: 'bg-skill-dot', on: 'border-transparent bg-skill-soft text-skill' }
}
const KINDS: Kind[] = ['tools', 'mcp', 'knowledge', 'skills']

const READS = ['read', 'ls', 'find', 'grep', 'ast_grep']
const WRITES = ['write', 'edit', 'ast_edit']
const WEB = ['web_search', 'web_fetch']

const CUSTOM_ICON: Record<CustomTool['kind'], Icon> = { http: Link2, javascript: Code2, command: SquareTerminal, prompt: MessageSquareText }

const PRESETS: { label: string; does: string; pick(items: AccessItem[]): Picked }[] = [
  {
    label: 'Read-only',
    does: 'reads files, searches the web and all your Knowledge',
    pick: (items) => ({ ...none(), tools: [...READS, ...WEB].filter((n) => items.some((i) => i.kind === 'tools' && i.id === n)), collectionIds: items.filter((i) => i.kind === 'knowledge').map((i) => i.id) })
  },
  {
    label: 'Research',
    does: 'searches the web and all your Knowledge',
    pick: (items) => ({ ...none(), tools: WEB.filter((n) => items.some((i) => i.id === n)), collectionIds: items.filter((i) => i.kind === 'knowledge').map((i) => i.id) })
  },
  {
    label: 'Hands-on',
    does: 'reads and changes files in its folder and searches the web',
    pick: (items) => ({ ...none(), tools: [...READS, ...WRITES, ...WEB].filter((n) => items.some((i) => i.kind === 'tools' && i.id === n)) })
  }
]

interface Picked {
  tools: string[]
  servers: Automation['servers']
  collectionIds: string[]
  skills: string[]
}
const none = (): Picked => ({ tools: [], servers: [], collectionIds: [], skills: [] })

// ─── How often ─────────────────────────────────────────────────────────────────

type Cadence = 'once' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'
const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'once', label: 'Only when I run it' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
  { value: 'custom', label: 'Custom' }
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Schedule {
  cadence: Cadence
  time: string
  day: number
  custom: string
}

function readSchedule(cron: string | null, enabled: boolean): Schedule {
  const base: Schedule = { cadence: 'once', time: '09:00', day: 1, custom: cron ?? '' }
  if (!cron || !enabled) return base
  const m = cron.trim().match(/^(\d{1,2}) (\d{1,2}|\*) \* \* (\*|1-5|[0-6])$/)
  if (m) {
    const time = m[2] === '*' ? '09:00' : `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`
    if (m[2] === '*' && m[3] === '*' && m[1] === '0') return { ...base, cadence: 'hourly' }
    if (m[2] !== '*' && m[3] === '*') return { ...base, cadence: 'daily', time }
    if (m[2] !== '*' && m[3] === '1-5') return { ...base, cadence: 'weekdays', time }
    if (m[2] !== '*' && /^[0-6]$/.test(m[3])) return { ...base, cadence: 'weekly', time, day: Number(m[3]) }
  }
  return { ...base, cadence: 'custom', custom: cron }
}

function cronOf(s: Schedule): string | null {
  const [h, m] = s.time.split(':').map((x) => Number(x) || 0)
  switch (s.cadence) {
    case 'once':
      return null
    case 'hourly':
      return '0 * * * *'
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'weekly':
      return `${m} ${h} * * ${s.day}`
    case 'custom':
      return s.custom.trim() || null
  }
}

function describe(s: Schedule): string {
  switch (s.cadence) {
    case 'once':
      return 'Runs when you press Run now'
    case 'hourly':
      return 'Runs every hour, on the hour'
    case 'daily':
      return `Runs every day at ${s.time}`
    case 'weekdays':
      return `Runs Monday to Friday at ${s.time}`
    case 'weekly':
      return `Runs every ${DAYS[s.day]} at ${s.time}`
    case 'custom':
      return s.custom.trim() ? `Runs on the schedule ${s.custom.trim()}` : 'Write a cron schedule'
  }
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

function nextRuns(cron: string | null): { ok: boolean; runs: Date[] } {
  if (!cron) return { ok: true, runs: [] }
  try {
    const c = new Cron(cron, { paused: true })
    const runs = c.nextRuns(3)
    c.stop()
    return { ok: true, runs }
  } catch {
    return { ok: false, runs: [] }
  }
}

const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? ''))

/**
 * An automation, Cursor style: say what should happen, pick how often, choose exactly what it may use,
 * and where the result goes. Saved as a one-step flow; "Edit as steps" hands it to the flow editor.
 */
export function AutomationEditor({ workflow, onBack, onSaved, onDeleted, onConverted }: { workflow: Workflow | null; onBack(): void; onSaved(w: Workflow): void; onDeleted(): void; onConverted(w: Workflow): void }) {
  const a = workflow?.automation
  const [name, setName] = useState(workflow?.name ?? 'New automation')
  const [prompt, setPrompt] = useState(a?.prompt ?? '')
  const [agentId, setAgentId] = useState<string | null>(a?.agentId ?? null)
  const [workspace, setWorkspace] = useState<string | null>(workflow?.workspace ?? null)
  const [picked, setPicked] = useState<Picked>(() => (a ? { tools: a.tools, servers: a.servers, collectionIds: a.collectionIds, skills: a.skills } : none()))
  const [deliver, setDeliver] = useState<AutomationDelivery>(a?.deliver ?? 'chat')
  const [collectionId, setCollectionId] = useState<string | null>(a?.collectionId ?? null)
  const [schedule, setSchedule] = useState<Schedule>(() => (workflow ? readSchedule(workflow.cron, workflow.cronEnabled) : { cadence: 'weekdays', time: '09:00', day: 1, custom: '' }))
  const [saving, setSaving] = useState(false)
  const [preset, setPreset] = useState<string | null>(null)

  const [builtins, setBuiltins] = useState<BuiltinToolInfo[]>([])
  const [custom, setCustom] = useState<CustomTool[]>([])
  const [status, setStatus] = useState<McpClientStatus[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [lastChat, setLastChat] = useState<string | null>(null)
  const settings = useApp((s) => s.settings)
  const setPage = useApp((s) => s.setPage)

  useEffect(() => {
    void Promise.all([api.tools.builtins(), api.tools.list(), api.mcp.clients().catch(() => []), api.rag.collections().catch(() => []), api.skills.list().catch(() => []), api.agents.list().catch(() => [])]).then(([b, c, m, k, s, ag]) => {
      setBuiltins(b)
      setCustom(c)
      setStatus(m)
      setCollections(k)
      setSkills(s)
      setAgents(ag)
    })
  }, [])
  useEvent('mcpClients', () => void api.mcp.clients().then(setStatus, () => undefined))
  const loadRuns = () => {
    if (workflow) void api.workflows.runs(workflow.id).then(setRuns, () => undefined)
  }
  useEffect(loadRuns, [workflow?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('workflow', (e) => {
    if (!workflow) return
    if (e.type === 'run' && e.run.workflowId === workflow.id) setRuns((rs) => [e.run, ...rs.filter((r) => r.id !== e.run.id)].sort((x, y) => y.startedAt - x.startedAt))
    if (e.type === 'automation' && e.workflowId === workflow.id) setLastChat(e.chatId)
  })

  const configs = settings?.mcpClients ?? []
  const items: AccessItem[] = useMemo(() => {
    const out: AccessItem[] = []
    for (const b of builtins) {
      // Only what an automation's agent can actually call: files and the web.
      if (!b.where.flows || (b.group !== 'workspace' && b.group !== 'web')) continue
      out.push({
        kind: 'tools',
        id: b.name,
        label: b.label,
        desc: b.description.split(/(?<=\.)\s/)[0],
        meta: 'Built in',
        warn: WRITES.includes(b.name) ? 'Can change files in its folder' : undefined,
        icon: b.group === 'web' ? Globe : FileText
      })
    }
    for (const t of custom)
      out.push({
        kind: 'tools',
        id: t.name,
        label: t.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        desc: t.description,
        meta: t.enabled ? 'Made by you' : 'Waiting for your OK on the Tools page',
        warn: t.kind === 'command' || t.kind === 'javascript' ? 'Runs on your computer' : undefined,
        icon: CUSTOM_ICON[t.kind]
      })
    for (const c of configs) {
      const st = status.find((s) => s.id === c.id)
      const tools = st?.state === 'ready' ? st.tools.map((t) => t.name) : undefined
      out.push({ kind: 'mcp', id: c.id, label: c.name, desc: `Tools from the ${c.name} server.`, meta: tools ? `${tools.length} tools` : c.enabled ? 'Starts when it runs' : 'Turned off on the MCP page', icon: Plug, serverTools: tools })
    }
    for (const k of collections) out.push({ kind: 'knowledge', id: k.id, label: k.name, desc: k.description || 'A Knowledge collection.', meta: `${k.docCount} document${k.docCount === 1 ? '' : 's'}`, icon: BookOpen })
    for (const s of skills) out.push({ kind: 'skills', id: s.name, label: s.name, desc: s.description, meta: 'Skill', icon: Sparkles })
    return out
  }, [builtins, custom, configs, status, collections, skills])

  const isOn = (i: AccessItem) =>
    i.kind === 'tools' ? picked.tools.includes(i.id) : i.kind === 'mcp' ? picked.servers.some((s) => s.id === i.id) : i.kind === 'knowledge' ? picked.collectionIds.includes(i.id) : picked.skills.includes(i.id)
  const toggle = (i: AccessItem, on = !isOn(i)) => {
    setPreset(null)
    setPicked((p) => {
      const flip = (arr: string[]) => (on ? [...new Set([...arr, i.id])] : arr.filter((x) => x !== i.id))
      if (i.kind === 'tools') return { ...p, tools: flip(p.tools) }
      if (i.kind === 'knowledge') return { ...p, collectionIds: flip(p.collectionIds) }
      if (i.kind === 'skills') return { ...p, skills: flip(p.skills) }
      return { ...p, servers: on ? (p.servers.some((s) => s.id === i.id) ? p.servers : [...p.servers, { id: i.id, tools: null }]) : p.servers.filter((s) => s.id !== i.id) }
    })
  }

  const cron = cronOf(schedule)
  const upcoming = nextRuns(cron)
  const automation: Automation = { prompt, agentId, ...picked, deliver, collectionId: deliver === 'knowledge' ? collectionId : null }
  const saved = workflow ? JSON.stringify({ n: workflow.name, a: workflow.automation, c: workflow.cronEnabled ? workflow.cron : null, w: workflow.workspace }) : null
  const dirty = saved !== JSON.stringify({ n: name.trim(), a: automation, c: cron, w: workspace })
  const problem = !prompt.trim() ? 'Say what should happen first.' : !upcoming.ok ? 'The custom schedule isn’t a valid cron expression.' : deliver === 'knowledge' && !collectionId ? 'Pick the collection to save results to.' : null

  const save = async (): Promise<Workflow | null> => {
    if (problem) {
      useApp.getState().toast(problem, 'error')
      return null
    }
    setSaving(true)
    const input = { name: name.trim() || 'New automation', automation, cron, cronEnabled: !!cron, workspace }
    const w = await attempt(() => (workflow ? api.workflows.saveAutomation(workflow.id, input) : api.workflows.createAutomation(input)), workflow ? 'Automation saved' : cron ? 'Automation saved and on' : 'Automation saved')
    setSaving(false)
    if (w) onSaved(w)
    return w ?? null
  }
  const runNow = async () => {
    const w = dirty || !workflow ? await save() : workflow
    if (!w) return
    setLastChat(null)
    void attempt(() => api.workflows.run(w.id))
  }
  const back = async () => {
    if (dirty && !(await confirmAction('Your changes to this automation will be lost.', { title: 'Leave without saving?', confirmLabel: 'Leave' }))) return
    onBack()
  }
  const openChat = (id: string) => {
    try {
      localStorage.setItem('cloth.chat', id)
    } catch {
      /* storage unavailable */
    }
    setPage('chat')
  }

  const pickedItems = items.filter(isOn)
  const names = pickedItems.map((i) => i.label)
  const agent = agents.find((x) => x.id === agentId)
  const runsCode = custom.some((t) => picked.tools.includes(t.name) && (t.kind === 'command' || t.kind === 'javascript'))
  const sentence = `${describe(schedule)}. ${agent ? agent.name : 'Cloth'} follows the prompt${names.length ? ` and may use ${list(names)}` : ' with nothing extra'}. ${deliver === 'chat' ? 'The result arrives as a new chat you can reply to.' : deliver === 'notify' ? 'You get a notification with the result.' : `The result is saved to ${collections.find((c) => c.id === collectionId)?.name ?? 'a Knowledge collection'}.`}`
  const lastRun = runs[0]

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-5 py-5 mobile:w-[calc(100%-24px)]">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => void back()} className="flex h-9 items-center gap-1.5 rounded-lg px-1.5 text-[13px] text-muted hover:text-fg">
            <ArrowLeft size={15} aria-hidden="true" />
            Flows
          </button>
          <span className="text-line-strong" aria-hidden="true">
            /
          </span>
          <label className="min-w-[200px] flex-1">
            <span className="sr-only">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-transparent py-1 text-[19px] font-semibold outline-none" />
          </label>
          {workflow && (
            <>
              <Button
                variant="ghost"
                icon={<Pencil size={13} />}
                onClick={async () => {
                  if (!(await confirmAction('It becomes a flow you change step by step, with the same steps it has now. The automation screen won’t open it any more.', { title: 'Edit as steps?', confirmLabel: 'Edit as steps' }))) return
                  const w = await attempt(() => api.workflows.toFlow(workflow.id))
                  if (w) onConverted(w)
                }}
              >
                Edit as steps
              </Button>
              <IconButton
                aria-label="Delete automation"
                title="Delete automation"
                onClick={async () => {
                  if (!(await confirmAction('Its schedule stops and its run history goes too.', { title: `Delete “${workflow.name}”?`, confirmLabel: 'Delete', danger: true }))) return
                  if (await attempt(() => api.workflows.remove(workflow.id).then(() => true))) onDeleted()
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            </>
          )}
          <Button onClick={() => void runNow()}>Run now</Button>
          <Button variant="primary" loading={saving} disabled={!!workflow && !dirty} onClick={() => void save()}>
            {cron && !workflow?.cronEnabled ? 'Save and turn on' : 'Save'}
          </Button>
        </div>

        <div className="grid items-start gap-6 min-[1040px]:grid-cols-[minmax(0,1fr)_300px]">
          <div className="grid min-w-0">
            <Block title="What should happen?">
              <PromptBox value={prompt} onChange={setPrompt} items={items} onMention={(i) => toggle(i, true)} />
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                <span>Works in</span>
                <Button
                  size="sm"
                  icon={<FolderOpen size={13} />}
                  onClick={async () => {
                    const [dir] = await api.app.pickPaths({ directory: true, title: 'Folder the automation works in' })
                    if (dir) setWorkspace(dir)
                  }}
                >
                  {workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : 'Choose a folder'}
                </Button>
                {workspace && (
                  <button onClick={() => setWorkspace(null)} className="text-[12px] text-dim underline-offset-2 hover:text-fg hover:underline">
                    No folder
                  </button>
                )}
                <span className="text-dim">{workspace ? 'File tools work here.' : 'Optional; file tools need one.'}</span>
              </div>
            </Block>

            <Block title="How often?">
              <div role="radiogroup" aria-label="How often" className="flex flex-wrap gap-1.5">
                {CADENCES.map((c) => (
                  <button
                    key={c.value}
                    role="radio"
                    aria-checked={schedule.cadence === c.value}
                    onClick={() => setSchedule((s) => ({ ...s, cadence: c.value }))}
                    className={clsx('h-9 rounded-[9px] border px-3 text-[13px]', schedule.cadence === c.value ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line-strong text-muted hover:text-fg')}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2.5 text-[12.5px] text-muted">
                {schedule.cadence === 'weekly' && (
                  <label className="flex items-center gap-2">
                    on
                    <Select value={String(schedule.day)} onChange={(e) => setSchedule((s) => ({ ...s, day: Number(e.target.value) }))} className="w-36">
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                {['daily', 'weekdays', 'weekly'].includes(schedule.cadence) && (
                  <label className="flex items-center gap-2">
                    at
                    <Input type="time" value={schedule.time} onChange={(e) => setSchedule((s) => ({ ...s, time: e.target.value || '09:00' }))} className="w-32" />
                  </label>
                )}
                {schedule.cadence === 'custom' && (
                  <label className="flex items-center gap-2">
                    <span className="sr-only">Cron schedule</span>
                    <Input value={schedule.custom} onChange={(e) => setSchedule((s) => ({ ...s, custom: e.target.value }))} placeholder="0 9 * * 1-5…" spellCheck={false} autoComplete="off" className="w-44 font-mono" />
                  </label>
                )}
                <span className={clsx(upcoming.ok ? 'text-fg/80' : 'text-crimson-hi')}>{upcoming.ok ? describe(schedule) : 'That isn’t a valid cron schedule.'}</span>
              </div>
            </Block>

            <AccessPicker items={items} picked={picked} setPicked={setPicked} isOn={isOn} toggle={toggle} preset={preset} setPreset={setPreset} folder={!!workspace} runsCode={runsCode} />

            <Block title="Where should the result go?" last>
              <div role="radiogroup" aria-label="Where the result goes" className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                {(
                  [
                    ['chat', 'A new chat I can reply to'],
                    ['notify', 'Just notify me'],
                    ['knowledge', 'Save it to Knowledge']
                  ] as [AutomationDelivery, string][]
                ).map(([v, label]) => (
                  <label key={v} className="flex min-h-8 cursor-pointer items-center gap-2">
                    <input type="radio" name="deliver" checked={deliver === v} onChange={() => setDeliver(v)} className="accent-[#dc2645]" />
                    {label}
                  </label>
                ))}
              </div>
              {deliver === 'knowledge' && (
                <Select aria-label="Collection to save to" value={collectionId ?? ''} onChange={(e) => setCollectionId(e.target.value || null)} className="max-w-xs">
                  <option value="">Pick a collection…</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
              <p className="text-[12px] text-dim">You always get a notification when a run fails.</p>
            </Block>
          </div>

          <aside aria-label="Summary" className="grid gap-3 min-[1040px]:sticky min-[1040px]:top-4">
            <Card title="In plain words">
              <p className="text-[13px] leading-relaxed text-fg/85">{sentence}</p>
            </Card>
            <Card title="Next runs">
              {upcoming.runs.length ? (
                upcoming.runs.map((d) => (
                  <div key={d.getTime()} className="flex justify-between text-[12.5px]">
                    <span>{dayFmt.format(d)}</span>
                    <span className="font-mono text-[12px] text-dim">{timeFmt.format(d)}</span>
                  </div>
                ))
              ) : (
                <p className="text-[12.5px] text-dim">{schedule.cadence === 'once' ? 'Only when you press Run now.' : 'None scheduled.'}</p>
              )}
            </Card>
            <Card title="Runs as">
              <Select aria-label="Runs as" value={agentId ?? ''} onChange={(e) => setAgentId(e.target.value || null)}>
                <option value="">Cloth</option>
                {agents.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
              <p className="text-[12px] text-dim">{agent ? `Uses ${agent.name}’s instructions and model, with only what you pick here.` : 'The default assistant, with only what you pick here.'}</p>
            </Card>
            {lastRun && (
              <Card title="Last run">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span aria-hidden="true" className={clsx('h-2 w-2 rounded-full', lastRun.status === 'ok' ? 'bg-ok' : lastRun.status === 'error' ? 'bg-crimson' : 'bg-info')} />
                  <span>{lastRun.status === 'running' ? 'Running…' : lastRun.status === 'ok' ? 'Worked' : 'Failed'}</span>
                  <span className="text-dim">{timeAgo(lastRun.startedAt)}</span>
                </div>
                {lastRun.status === 'error' && lastRun.error && <p className="line-clamp-3 text-[12px] text-crimson-hi">{lastRun.error}</p>}
                {lastRun.status === 'ok' && lastChat && (
                  <Button size="sm" className="justify-self-start" onClick={() => openChat(lastChat)}>
                    Open the result
                  </Button>
                )}
              </Card>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

function Block({ title, last, children }: { title: string; last?: boolean; children: ReactNode }) {
  return (
    <section aria-label={title} className={clsx('grid gap-3 py-5 first:pt-1', !last && 'border-b border-line')}>
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-2.5 rounded-[14px] border border-line bg-panel p-4">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/** The prompt, with @ to mention something it may use (which switches it on). */
function PromptBox({ value, onChange, items, onMention }: { value: string; onChange(v: string): void; items: AccessItem[]; onMention(i: AccessItem): void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const matches = query === null ? [] : items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
  const sync = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart)
    const m = before.match(/(?:^|\s)@([\w .-]{0,30})$/)
    setQuery(m ? m[1] : null)
    setActive(0)
  }
  const pick = (i: AccessItem) => {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const before = value.slice(0, caret).replace(/@([\w .-]{0,30})$/, `@${i.label} `)
    onChange(before + value.slice(caret))
    onMention(i)
    setQuery(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(before.length, before.length)
    })
  }
  return (
    <div className="relative grid gap-1.5">
      <textarea
        ref={ref}
        rows={4}
        aria-label="What should happen"
        value={value}
        placeholder="Look at what changed in my project since yesterday and write me a short brief: what moved, what’s blocked, and the three things to do first today…"
        className="w-full resize-y rounded-md border border-line bg-panel px-3 py-2.5 text-[14px] leading-relaxed text-fg transition-colors placeholder:text-dim focus:border-crimson-line focus:outline-none focus:ring-2 focus:ring-crimson-soft"
        onChange={(e) => {
          onChange(e.target.value)
          sync(e.target)
        }}
        onClick={(e) => sync(e.currentTarget)}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        onKeyDown={(e) => {
          if (!matches.length) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((n) => (n + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            pick(matches[active])
          } else if (e.key === 'Escape') setQuery(null)
        }}
      />
      {matches.length > 0 && (
        <ul role="listbox" aria-label="Mention" className="absolute left-2 top-full z-10 mt-1 grid w-[min(360px,100%)] gap-0.5 rounded-[12px] border border-line-strong bg-elev p-1 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.8)]">
          {matches.map((i, n) => (
            <li key={`${i.kind}:${i.id}`} role="option" aria-selected={n === active}>
              <button onMouseDown={(e) => (e.preventDefault(), pick(i))} className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[12.5px]', n === active ? 'bg-elev-2' : 'hover:bg-elev-2')}>
                <span aria-hidden="true" className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', KIND[i.kind].tile)}>
                  <i.icon size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className="text-[11px] text-dim">{KIND[i.kind].one}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-dim">Type @ to mention a tool, server, collection or skill. Mentions add it to what it may use.</p>
    </div>
  )
}

/**
 * What the automation may use: a line of plain abilities ("It can read your files"), what's allowed
 * so far grouped by kind, and a searchable list to add more. External servers can be narrowed to some tools.
 */
function AccessPicker({
  items,
  picked,
  setPicked,
  isOn,
  toggle,
  preset,
  setPreset,
  folder,
  runsCode
}: {
  items: AccessItem[]
  picked: Picked
  setPicked(p: Picked | ((p: Picked) => Picked)): void
  isOn(i: AccessItem): boolean
  toggle(i: AccessItem, on?: boolean): void
  preset: string | null
  setPreset(p: string | null): void
  folder: boolean
  runsCode: boolean
}) {
  const [kind, setKind] = useState<'all' | Kind>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const has = (n: string[]) => n.some((x) => picked.tools.includes(x))
  const abilities: { label: string; on: boolean; risky?: boolean }[] = [
    { label: 'Read your files', on: has(READS) },
    { label: 'Search the internet', on: has(WEB) },
    { label: 'Use other apps', on: picked.servers.length > 0 },
    { label: 'Look things up in Knowledge', on: picked.collectionIds.length > 0 },
    { label: 'Change files', on: has(WRITES), risky: true },
    { label: 'Run programs', on: runsCode, risky: true }
  ]
  const allowed = items.filter(isOn)
  const query = q.trim().toLowerCase()
  const visible = items.filter((i) => (kind === 'all' || i.kind === kind) && (!query || `${i.label} ${i.desc}`.toLowerCase().includes(query)))
  const pre = PRESETS.find((p) => p.label === preset)

  const serverPick = (id: string) => picked.servers.find((s) => s.id === id)
  const setServerTools = (id: string, tools: string[] | null) => setPicked((p) => ({ ...p, servers: p.servers.map((s) => (s.id === id ? { ...s, tools } : s)) }))

  return (
    <section aria-label="What it may use" className="grid gap-3.5 border-b border-line py-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="flex-1 text-[14px] font-semibold">What it may use</h2>
        <span className="text-[12px] text-dim">Start from</span>
        <div role="group" aria-label="Start from a preset" className="inline-flex rounded-[10px] border border-line bg-panel p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              aria-pressed={preset === p.label}
              onClick={() => {
                setPicked(p.pick(items))
                setPreset(p.label)
              }}
              className={clsx('h-[30px] rounded-lg px-3 text-[12.5px]', preset === p.label ? 'bg-elev-2 font-medium text-fg' : 'text-muted hover:text-fg')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {pre && (
        <p className="-mt-1.5 text-[12px] text-dim" aria-live="polite">
          {pre.label}: {pre.does}. Change anything below.
        </p>
      )}

      <div role="list" aria-label="What this lets it do" className="flex flex-wrap items-center gap-1.5 rounded-[14px] border border-line bg-panel p-2.5">
        <span className="px-1.5 text-[12px] text-muted">It can</span>
        {abilities.map((ab) => (
          <span
            key={ab.label}
            role="listitem"
            className={clsx(
              'inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors motion-reduce:transition-none',
              ab.on ? (ab.risky ? 'border-warn/45 bg-warn/10 text-warn' : 'border-ok/40 bg-ok/10 text-ok') : 'border-line text-dim'
            )}
          >
            {ab.on ? <Check size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
            {ab.label}
            <span className="sr-only">{ab.on ? ': yes' : ': no'}</span>
          </span>
        ))}
      </div>
      {has([...READS, ...WRITES]) && !folder && (
        <p className="-mt-1 flex items-center gap-2 text-[12px] text-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          File tools need a folder. Choose one under “What should happen?”.
        </p>
      )}

      <div className="flex flex-wrap overflow-hidden rounded-[16px] border border-line bg-panel">
        <div className="grid min-w-0 flex-[1_1_270px] content-start gap-3 border-r border-line bg-bg/40 p-3.5 mobile:border-b mobile:border-r-0">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold">Allowed</h3>
            <span className="text-[12px] tabular-nums text-dim">{allowed.length}</span>
          </div>
          {!allowed.length && <p className="py-4 text-[12.5px] text-dim">Nothing yet. It can only read the prompt and write an answer. Add things from the list.</p>}
          {KINDS.map((k) => {
            const group = allowed.filter((i) => i.kind === k)
            if (!group.length) return null
            return (
              <div key={k} className="grid gap-0.5">
                <div className="flex items-center gap-1.5 px-1 pb-0.5 text-[11.5px] text-dim">
                  <span aria-hidden="true" className={clsx('h-[7px] w-[7px] rounded-full', KIND[k].dot)} />
                  {KIND[k].label}
                </div>
                {group.map((i) => {
                  const sp = i.kind === 'mcp' ? serverPick(i.id) : undefined
                  const all = i.serverTools ?? []
                  const chosen = sp?.tools ?? all
                  const isOpen = !!open[i.id]
                  return (
                    <div key={`${i.kind}:${i.id}`} className="grid">
                      <div className="flex min-h-10 items-center gap-2 rounded-[9px] py-0.5 pl-1.5 pr-1 hover:bg-elev">
                        <span aria-hidden="true" className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', KIND[i.kind].tile)}>
                          <i.icon size={14} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{i.label}</span>
                        {i.kind === 'mcp' && all.length > 0 && (
                          <button aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [i.id]: !isOpen }))} className="flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-line-strong px-2 text-[11.5px] text-info">
                            {sp?.tools === null || chosen.length === all.length ? 'All tools' : `${chosen.length} of ${all.length} tools`}
                            <ChevronDown size={11} aria-hidden="true" className={clsx('transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} />
                          </button>
                        )}
                        <button aria-label={`Remove ${i.label}`} title="Remove" onClick={() => toggle(i, false)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg">
                          <X size={12} />
                        </button>
                      </div>
                      {isOpen && (
                        <div className="mb-1.5 ml-10 grid gap-0.5 border-l-2 border-info/35 py-1 pl-2.5">
                          {all.map((t) => (
                            <label key={t} className="flex min-h-[30px] cursor-pointer items-center gap-2 text-[12.5px]">
                              <input
                                type="checkbox"
                                className="h-[15px] w-[15px] accent-[#6b9cf0]"
                                checked={sp?.tools === null || chosen.includes(t)}
                                onChange={(e) => {
                                  const cur = sp?.tools ?? all
                                  const next = e.target.checked ? [...new Set([...cur, t])] : cur.filter((x) => x !== t)
                                  setServerTools(i.id, next.length === all.length ? null : next)
                                }}
                              />
                              <span className="truncate font-mono text-[12px]" translate="no">
                                {t}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="grid min-w-0 flex-[999_1_340px] content-start gap-2.5 p-3.5">
          <h3 className="text-[13px] font-semibold">Add more</h3>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
            <Input className="pl-8" aria-label="Search tools, servers, Knowledge and skills" placeholder="Search tools, servers, Knowledge and skills…" spellCheck={false} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div role="tablist" aria-label="Kind" className="flex flex-wrap gap-1">
            {(['all', ...KINDS] as ('all' | Kind)[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
                className={clsx('flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px]', kind === k ? 'border-line-strong bg-elev-2 font-medium text-fg' : 'border-transparent text-muted hover:bg-elev hover:text-fg')}
              >
                <span aria-hidden="true" className={clsx('h-[7px] w-[7px] rounded-full', k === 'all' ? 'bg-muted' : KIND[k].dot)} />
                {k === 'all' ? 'Everything' : KIND[k].label}
                <span className="text-[11px] tabular-nums text-dim">{items.filter((i) => k === 'all' || i.kind === k).length}</span>
              </button>
            ))}
          </div>
          <div className="-mx-1 grid max-h-[340px] gap-0.5 overflow-y-auto px-1">
            {visible.map((i) => {
              const on = isOn(i)
              return (
                <div key={`${i.kind}:${i.id}`} className="flex min-h-14 items-center gap-3 rounded-[11px] py-1.5 pl-2 pr-1.5 hover:bg-elev/60">
                  <span aria-hidden="true" className={clsx('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]', KIND[i.kind].tile)}>
                    <i.icon size={16} />
                  </span>
                  <span className="grid min-w-0 flex-1 gap-px">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[13.5px] font-semibold">{i.label}</span>
                      <span className="text-[11.5px] text-dim">{kind === 'all' ? `${KIND[i.kind].one}, ${i.meta.charAt(0).toLowerCase()}${i.meta.slice(1)}` : i.meta}</span>
                    </span>
                    <span className="line-clamp-2 text-[12px] text-dim">
                      {i.desc}
                      {i.warn && <span className="text-warn"> {i.warn}.</span>}
                    </span>
                  </span>
                  <button
                    aria-pressed={on}
                    aria-label={`${on ? 'Remove' : 'Add'} ${i.label}`}
                    onClick={() => toggle(i)}
                    className={clsx('flex h-8 min-w-[84px] shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] transition-colors motion-reduce:transition-none', on ? KIND[i.kind].on : 'border-line-strong bg-elev hover:border-muted/40')}
                  >
                    {on ? <Check size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
                    {on ? 'Added' : 'Add'}
                  </button>
                </div>
              )
            })}
            {!visible.length && (
              <p className="px-1 py-4 text-[12.5px] text-dim">
                {query ? `Nothing matches “${q.trim()}”.` : 'Nothing of this kind yet.'} Make tools on the Tools page and add servers on the MCP page.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}


