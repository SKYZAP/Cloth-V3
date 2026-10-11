import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Cron } from 'croner'
import { AlertTriangle, ArrowLeft, Box, FolderOpen, Pencil, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { Agent, Automation, AutomationCommands, AutomationDelivery, AutomationWatch, ContainerStatus, McpClientConfig, McpClientStatus, Workflow, WorkflowRun } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { timeAgo } from '@/lib/format'
import { Button, IconButton, Input, Select, Textarea, confirmAction } from '@/components/ui'
import { AccessPicker, KIND, isOnIn, none, toggleIn, useAccessItems, type AccessItem, type Picked } from './Access'

// ─── How often ─────────────────────────────────────────────────────────────────

type Cadence = 'once' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom' | 'change'
const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'once', label: 'Only when I run it' },
  { value: 'change', label: 'When something changes' },
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
    case 'change':
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
    case 'change':
      return 'Runs when something changes'
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
  const [schedule, setSchedule] = useState<Schedule>(() => (a?.watch ? { cadence: 'change', time: '09:00', day: 1, custom: '' } : workflow ? readSchedule(workflow.cron, workflow.cronEnabled) : { cadence: 'weekdays', time: '09:00', day: 1, custom: '' }))
  const [watch, setWatch] = useState<AutomationWatch>(() => a?.watch ?? { kind: 'files' })
  const [commands, setCommands] = useState<AutomationCommands | null>(a?.commands ?? null)
  const [saving, setSaving] = useState(false)

  const [agents, setAgents] = useState<Agent[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [lastChat, setLastChat] = useState<string | null>(null)
  const [checked, setChecked] = useState<{ checkedAt: number | null; error: string | null } | null>(null)
  const [docker, setDocker] = useState<ContainerStatus | null>(null)
  const settings = useApp((s) => s.settings)
  const setPage = useApp((s) => s.setPage)
  const { items, collections, status } = useAccessItems()

  useEffect(() => {
    void api.agents.list().then(setAgents, () => undefined)
  }, [])
  useEffect(() => {
    if (commands?.mode === 'container' && !docker) void api.containers.status().then(setDocker, () => undefined)
  }, [commands?.mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const loadRuns = () => {
    if (!workflow) return
    void api.workflows.runs(workflow.id).then(setRuns, () => undefined)
    if (workflow.automation?.watch && workflow.automation.watch.kind !== 'files') void api.workflows.watchState(workflow.id).then(setChecked, () => undefined)
  }
  useEffect(loadRuns, [workflow?.id, workflow?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('workflow', (e) => {
    if (!workflow) return
    if (e.type === 'run' && e.run.workflowId === workflow.id) setRuns((rs) => [e.run, ...rs.filter((r) => r.id !== e.run.id)].sort((x, y) => y.startedAt - x.startedAt))
    if (e.type === 'automation' && e.workflowId === workflow.id) setLastChat(e.chatId)
  })

  const configs = settings?.mcpClients ?? []
  const isOn = (i: AccessItem) => isOnIn(picked, i)
  const toggle = (i: AccessItem, on = !isOn(i)) => setPicked((p) => toggleIn(p, i, on))

  const cron = cronOf(schedule)
  const upcoming = nextRuns(cron)
  const watching = schedule.cadence === 'change' ? watch : null
  const finalDeliver = commands?.mode === 'container' ? 'chat' : deliver
  const automation: Automation = { prompt, agentId, ...picked, deliver: finalDeliver, collectionId: finalDeliver === 'knowledge' ? collectionId : null, watch: watching, commands }
  const saved = workflow ? JSON.stringify({ n: workflow.name, a: workflow.automation, c: workflow.cronEnabled ? workflow.cron : null, w: workflow.workspace }) : null
  const dirty = saved !== JSON.stringify({ n: name.trim(), a: automation, c: cron, w: workspace })
  const problem = !prompt.trim()
    ? 'Say what should happen first.'
    : !upcoming.ok
      ? 'The custom schedule isn’t a valid cron expression.'
      : watching?.kind === 'files' && !workspace
        ? 'Choose the folder to watch.'
        : watching?.kind === 'url' && !/^https?:\/\/\S+$/i.test(watching.url)
          ? 'Give the address of the page to watch, starting with https://.'
          : watching?.kind === 'mcp' && (!watching.serverId || !watching.tool)
            ? 'Pick the server and tool to check.'
            : commands && !workspace
              ? 'Choose a folder for its commands to run in.'
              : commands?.mode === 'allowlist' && !commands.allow.length
                ? 'List the commands it may run.'
                : finalDeliver === 'knowledge' && !collectionId
                  ? 'Pick the collection to save results to.'
                  : null

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
  const when = schedule.cadence === 'change' ? watchSentence(watch, configs.find((c) => watch.kind === 'mcp' && c.id === watch.serverId)?.name) : describe(schedule)
  const runs_ = commands ? (commands.mode === 'container' ? ' It can run commands in a container, on a copy of its folder.' : ` It can run ${list(commands.allow.map((c) => `“${c}”`))} and nothing else.`) : ''
  const sentence = `${when}. ${agent ? agent.name : 'Cloth'} follows the prompt${names.length ? ` and may use ${list(names)}` : ' with nothing extra'}.${runs_} ${finalDeliver === 'chat' ? (commands?.mode === 'container' ? 'The result arrives as a new chat, with its changes for you to apply.' : 'The result arrives as a new chat you can reply to.') : finalDeliver === 'notify' ? 'You get a notification with the result.' : `The result is saved to ${collections.find((c) => c.id === collectionId)?.name ?? 'a Knowledge collection'}.`}`
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
                {schedule.cadence !== 'change' && <span className={clsx(upcoming.ok ? 'text-fg/80' : 'text-crimson-hi')}>{upcoming.ok ? describe(schedule) : 'That isn’t a valid cron schedule.'}</span>}
              </div>
              {schedule.cadence === 'change' && <WatchPicker value={watch} onChange={setWatch} folder={workspace} configs={configs} status={status} />}
            </Block>

            <div className="border-b border-line py-5">
              <AccessPicker items={items} value={picked} onChange={setPicked} folder={!!workspace} commands={!!commands} />
            </div>

            <Block title="Can it run commands?">
              <CommandsPicker value={commands} onChange={setCommands} folder={!!workspace} docker={docker} />
            </Block>

            <Block title="Where should the result go?" last>
              <div role="radiogroup" aria-label="Where the result goes" className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
                {(
                  [
                    ['chat', 'A new chat I can reply to'],
                    ['notify', 'Just notify me'],
                    ['knowledge', 'Save it to Knowledge']
                  ] as [AutomationDelivery, string][]
                ).map(([v, label]) => (
                  <label key={v} className={clsx('flex min-h-8 items-center gap-2', commands?.mode === 'container' && v !== 'chat' ? 'opacity-50' : 'cursor-pointer')}>
                    <input type="radio" name="deliver" checked={finalDeliver === v} disabled={commands?.mode === 'container' && v !== 'chat'} onChange={() => setDeliver(v)} className="accent-[#dc2645]" />
                    {label}
                  </label>
                ))}
              </div>
              {commands?.mode === 'container' && <p className="text-[12px] text-dim">Runs in a container always go to a chat, where you review and apply what they changed.</p>}
              {finalDeliver === 'knowledge' && (
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
            {watching ? (
              <Card title="Watching">
                <p className="text-[12.5px] leading-relaxed">{watchSentence(watching, configs.find((c) => watching.kind === 'mcp' && c.id === watching.serverId)?.name)}.</p>
                {watching.kind !== 'files' && workflow?.automation?.watch && (
                  <>
                    <p className={clsx('text-[12px]', checked?.error ? 'text-crimson-hi' : 'text-dim')}>{checked?.error ? `Last check failed: ${checked.error}` : checked?.checkedAt ? `Last checked ${timeAgo(checked.checkedAt)}.` : 'Not checked yet.'}</p>
                    <Button size="sm" className="justify-self-start" icon={<RefreshCw size={12} />} onClick={async () => setChecked((await attempt(() => api.workflows.checkNow(workflow.id))) ?? checked)}>
                      Check now
                    </Button>
                  </>
                )}
                {watching.kind === 'files' && <p className="text-[12px] text-dim">Changes to .git, node_modules and build folders, and its own changes while it runs, are ignored.</p>}
              </Card>
            ) : (
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
            )}
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

const EVERY = [5, 15, 30, 60, 180, 720, 1440]
const everyLabel = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? 'hour' : m < 1440 ? `${m / 60} hours` : 'day')

function watchSentence(w: AutomationWatch, server?: string): string {
  if (w.kind === 'files') return 'Runs when a file in its folder changes'
  const every = `checking every ${everyLabel(w.everyMinutes)}`
  if (w.kind === 'url') return `Runs when the page at ${w.url || '…'} changes, ${every}`
  return `Runs when ${server ?? 'the server'}’s ${w.tool || 'tool'} answers differently, ${every}`
}

/** What "something changes" means: files in its folder, a web page, or an MCP tool's answer. */
function WatchPicker({ value, onChange, folder, configs, status }: { value: AutomationWatch; onChange(w: AutomationWatch): void; folder: string | null; configs: McpClientConfig[]; status: McpClientStatus[] }) {
  const every = value.kind === 'files' ? 15 : value.everyMinutes
  const [argsText, setArgsText] = useState(() => (value.kind === 'mcp' && Object.keys(value.args).length ? JSON.stringify(value.args, null, 2) : ''))
  const [argsError, setArgsError] = useState<string | null>(null)
  const server = value.kind === 'mcp' ? status.find((s) => s.id === value.serverId) : undefined
  const kinds: [AutomationWatch['kind'], string][] = [
    ['files', 'A file in its folder'],
    ['url', 'A web page'],
    ['mcp', 'An MCP tool’s answer']
  ]
  return (
    <div className="grid gap-3 rounded-[12px] border border-line bg-panel p-3.5">
      <div role="radiogroup" aria-label="What to watch" className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        {kinds.map(([k, label]) => (
          <label key={k} className="flex min-h-8 cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="watch"
              className="accent-[#dc2645]"
              checked={value.kind === k}
              onChange={() => onChange(k === 'files' ? { kind: 'files' } : k === 'url' ? { kind: 'url', url: '', everyMinutes: every } : { kind: 'mcp', serverId: configs[0]?.id ?? '', tool: '', args: {}, everyMinutes: every })}
            />
            {label}
          </label>
        ))}
      </div>
      {value.kind === 'files' && (
        <p className={clsx('text-[12.5px]', folder ? 'text-muted' : 'text-warn')}>{folder ? `Runs a few seconds after files in ${folder.split(/[\\/]/).filter(Boolean).pop()} change. It’s told which files.` : 'Choose its folder under “What should happen?” first.'}</p>
      )}
      {value.kind === 'url' && (
        <label className="grid gap-1 text-[12.5px] text-muted">
          Page address
          <Input value={value.url} onChange={(e) => onChange({ ...value, url: e.target.value })} placeholder="https://example.com/pricing…" spellCheck={false} autoComplete="off" className="font-mono" />
          <span className="text-[11.5px] text-dim">Only the page’s text counts, so ads and scripts changing don’t trigger it. It’s told what the page says now.</span>
        </label>
      )}
      {value.kind === 'mcp' && (
        <div className="grid gap-2.5">
          {!configs.length ? (
            <p className="text-[12.5px] text-warn">Add an MCP server on the MCP page first.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Server" value={value.serverId} onChange={(e) => onChange({ ...value, serverId: e.target.value, tool: '' })} className="w-48">
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Select aria-label="Tool" value={value.tool} onChange={(e) => onChange({ ...value, tool: e.target.value })} className="min-w-48 flex-1">
                <option value="">{server?.state === 'ready' ? 'Pick a tool…' : 'Start the server to list its tools…'}</option>
                {(server?.tools ?? []).map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
                {value.tool && !server?.tools.some((t) => t.name === value.tool) && <option value={value.tool}>{value.tool}</option>}
              </Select>
              {server?.state !== 'ready' && value.serverId && (
                <Button size="sm" onClick={() => void attempt(() => api.mcp.startClient(value.serverId))}>
                  Start it
                </Button>
              )}
            </div>
          )}
          <label className="grid gap-1 text-[12.5px] text-muted">
            What to ask it (optional, JSON)
            <Textarea
              rows={2}
              className="font-mono text-[11.5px]"
              spellCheck={false}
              value={argsText}
              placeholder='{ "repo": "owner/name", "state": "open" }…'
              onChange={(e) => {
                setArgsText(e.target.value)
                try {
                  const v = e.target.value.trim() ? JSON.parse(e.target.value) : {}
                  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Give an object, like { "repo": "owner/name" }')
                  setArgsError(null)
                  onChange({ ...value, args: v })
                } catch (err) {
                  setArgsError(err instanceof Error ? err.message : 'Not valid JSON')
                }
              }}
            />
            {argsError && <span className="text-[11.5px] text-crimson-hi">{argsError}</span>}
          </label>
        </div>
      )}
      {value.kind !== 'files' && (
        <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          Check every
          <Select aria-label="How often to check" value={String(value.everyMinutes)} onChange={(e) => onChange({ ...value, everyMinutes: Number(e.target.value) })} className="w-32">
            {EVERY.map((m) => (
              <option key={m} value={m}>
                {everyLabel(m)}
              </option>
            ))}
          </Select>
          <span className="text-dim">Checking is cheap: the agent only runs when the answer changes.</span>
        </label>
      )}
    </div>
  )
}

/** Whether the agent may run commands: not at all, in a container on a copy of its folder, or only listed commands. */
function CommandsPicker({ value, onChange, folder, docker }: { value: AutomationCommands | null; onChange(c: AutomationCommands | null): void; folder: boolean; docker: ContainerStatus | null }) {
  const [allowText, setAllowText] = useState(() => (value?.mode === 'allowlist' ? value.allow.join('\n') : ''))
  const mode = value?.mode ?? 'off'
  const options: { v: 'off' | 'container' | 'allowlist'; label: string; sub: string; icon?: typeof Box }[] = [
    { v: 'off', label: 'No', sub: 'It can’t run commands.' },
    { v: 'container', label: 'In a container', sub: 'On a copy of its folder. You apply its changes after.', icon: Box },
    { v: 'allowlist', label: 'Only these commands', sub: 'On this computer, nothing else allowed.', icon: ShieldCheck }
  ]
  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label="Running commands" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        {options.map((o) => (
          <button
            key={o.v}
            role="radio"
            aria-checked={mode === o.v}
            onClick={() => onChange(o.v === 'off' ? null : o.v === 'container' ? { mode: 'container', image: 'node:22', network: true } : { mode: 'allowlist', allow: allowText.split('\n').map((x) => x.trim()).filter(Boolean) })}
            className={clsx('grid content-start gap-0.5 rounded-[11px] border p-3 text-left', mode === o.v ? 'border-crimson-line bg-crimson-soft' : 'border-line hover:border-line-strong')}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-semibold">
              {o.icon && <o.icon size={14} aria-hidden="true" />}
              {o.label}
            </span>
            <span className="text-[12px] text-dim">{o.sub}</span>
          </button>
        ))}
      </div>
      {value && !folder && (
        <p className="flex items-center gap-2 text-[12px] text-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          Commands run in its folder. Choose one under “What should happen?”.
        </p>
      )}
      {value?.mode === 'container' && (
        <div className="grid gap-2.5 rounded-[12px] border border-line bg-panel p-3.5">
          {docker && !docker.available && <p className="text-[12.5px] text-warn">{docker.error ?? 'Docker isn’t available.'} Runs will fail until it is.</p>}
          <label className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            Image
            <Input value={value.image} onChange={(e) => onChange({ ...value, image: e.target.value })} spellCheck={false} autoComplete="off" className="w-44 font-mono" />
            <span className="text-dim">The Linux system it runs in, such as node:22 or python:3.12.</span>
          </label>
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-[12.5px]">
            <input type="checkbox" className="accent-[#dc2645]" checked={value.network} onChange={(e) => onChange({ ...value, network: e.target.checked })} />
            Can reach the internet (to install packages)
          </label>
          <p className="text-[12px] text-dim">Its commands and edits only touch the copy. The result chat lists what changed, for you to apply to the real folder or throw away.</p>
        </div>
      )}
      {value?.mode === 'allowlist' && (
        <label className="grid gap-1 text-[12.5px] text-muted">
          Commands it may run, one per line
          <Textarea
            rows={3}
            className="font-mono text-[12px]"
            spellCheck={false}
            value={allowText}
            placeholder={'git log\nnpm test…'}
            onChange={(e) => {
              setAllowText(e.target.value)
              onChange({ mode: 'allowlist', allow: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })
            }}
          />
          <span className="text-[11.5px] text-dim">Each line is how an allowed command starts: “git log” allows “git log --oneline” too. Anything else, or two commands chained together, is refused and the agent is told why.</span>
        </label>
      )}
    </div>
  )
}
