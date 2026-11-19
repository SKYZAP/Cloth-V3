import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Bell, BookOpen, Bot, Box, CircleAlert, CircleCheck, CircleMinus, Eye, FolderOpen, Loader2, Play, RefreshCw, ShieldCheck, SquareTerminal, Wrench } from 'lucide-react'
import type { Agent, Automation, AutomationCommands, AutomationWatch, ContainerStatus, Workflow, WorkflowRun } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { effortLabel } from '@shared/effort'
import { attempt, useApp } from '@/lib/store'
import { timeAgo } from '@/lib/format'
import { Button, Input, Select, Switch, confirmAction } from '@/components/ui'
import { SplitBack } from '@/components/SplitView'
import { AccessPicker, isOnIn, none, toggleIn, useAccessItems, type AccessItem, type Picked } from './Access'
import { ExportModal } from './ExportModal'
import { CommandsPicker, PromptBox, WatchPicker, newWatch } from './Pickers'
import { CADENCES, DAYS, OUTCOME_WORD, cronOf, formatDuration, nextRuns, readSchedule, relativeIn, runChat, runOutcome, runSummary, runWhen, runsInLast30Days, shortWhen, watchWhen, type Cadence, type RunOutcome, type Schedule } from './schedule'

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line'

/** The current time, ticking every `ms` (for "in 18 min" and a running run's elapsed time). */
export function useNow(ms: number, active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms, active])
  return now
}

/** Opens a chat on the Chat page (an automation's runs report in the Automation project). */
export function openChat(id: string | null): void {
  if (id) {
    try {
      localStorage.setItem('cloth.chat', id)
    } catch {
      /* storage unavailable */
    }
  }
  useApp.getState().setPage('chat')
}

const SAVE_DELAY = 600
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; text: string }
type Row = 'agent' | 'tools' | 'knowledge' | 'folder' | 'commands'

const OUTCOME_TEXT: Record<RunOutcome, string> = { running: 'text-muted', ok: 'text-ok', partial: 'text-warn', failed: 'text-danger-hi' }

function OutcomeIcon({ outcome }: { outcome: RunOutcome }) {
  if (outcome === 'running') return <Loader2 size={14} aria-hidden="true" className="animate-spin text-warn motion-reduce:animate-none" />
  const Icon = outcome === 'ok' ? CircleCheck : outcome === 'partial' ? CircleAlert : CircleMinus
  return <Icon size={14} aria-hidden="true" className={OUTCOME_TEXT[outcome]} />
}

const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * One automation, edited in place: what it does, when it runs, what it can use, and its recent runs.
 * Every change saves itself a moment later (or when a field loses focus).
 */
export function AutomationDetail({
  workflow,
  drafted,
  onSaved,
  onDeleted,
  onDuplicated
}: {
  workflow: Workflow
  /** Just drafted from a description: the sub-line asks to check it before turning it on. */
  drafted: boolean
  onSaved(w: Workflow): void
  onDeleted(): void
  onDuplicated(w: Workflow): void
}) {
  const a = workflow.automation
  const [name, setName] = useState(workflow.name)
  const [prompt, setPrompt] = useState(a?.prompt ?? '')
  const [agentId, setAgentId] = useState<string | null>(a?.agentId ?? null)
  const [workspace, setWorkspace] = useState<string | null>(workflow.workspace)
  const [picked, setPicked] = useState<Picked>(() => (a ? { tools: a.tools, servers: a.servers, collectionIds: a.collectionIds, skills: a.skills } : none()))
  const [schedule, setSchedule] = useState<Schedule>(() => readSchedule(workflow.cron))
  const [watch, setWatch] = useState<AutomationWatch | null>(a?.watch ?? null)
  const [commands, setCommands] = useState<AutomationCommands | null>(a?.commands ?? null)
  const [on, setOn] = useState(workflow.cronEnabled)
  const [open, setOpen] = useState<Row | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })

  const [agents, setAgents] = useState<Agent[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [starting, setStarting] = useState(false)
  const [checked, setChecked] = useState<{ checkedAt: number | null; error: string | null } | null>(null)
  const [docker, setDocker] = useState<ContainerStatus | null>(null)
  const settings = useApp((s) => s.settings)
  const providers = useApp((s) => s.providers)
  const { items, status } = useAccessItems()
  const configs = settings?.mcpClients ?? []

  useEffect(() => {
    void api.agents.list().then(setAgents, () => undefined)
    void api.workflows.runs(workflow.id).then(setRuns, () => undefined)
  }, [workflow.id])
  const savedWatch = workflow.automation?.watch
  useEffect(() => {
    if (savedWatch && savedWatch.kind !== 'files') void api.workflows.watchState(workflow.id).then(setChecked, () => undefined)
    else setChecked(null)
  }, [workflow.id, savedWatch?.kind]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (commands?.mode === 'container' && !docker) void api.containers.status().then(setDocker, () => undefined)
  }, [commands?.mode]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('workflow', (e) => {
    if (e.type !== 'run' || e.run.workflowId !== workflow.id) return
    setRuns((rs) => [e.run, ...rs.filter((r) => r.id !== e.run.id)].sort((x, y) => y.startedAt - x.startedAt))
    setStarting(false)
  })

  // ─── What gets saved ───────────────────────────────────────────────────────
  const cron = cronOf(schedule)
  const upcoming = nextRuns(cron)
  const automation: Automation = { prompt, agentId, ...picked, watch, commands }
  /** It works in an empty folder of its own inside a container (Cloth makes the folder when it's saved). */
  const emptyBox = commands?.mode === 'container' && !!commands.empty
  const snapshot = JSON.stringify({ n: name.trim(), a: automation, c: cron, w: workspace, on })
  const savedSnapshot = useRef<string | null>(null)
  if (savedSnapshot.current === null) savedSnapshot.current = snapshot
  const dirty = snapshot !== savedSnapshot.current
  const problem = !prompt.trim()
    ? 'Say what it should do first.'
    : !upcoming.ok
      ? 'The custom schedule isn’t a valid cron expression.'
      : watch?.kind === 'files' && !workspace && !emptyBox
        ? 'Choose the folder to watch.'
        : watch?.kind === 'url' && !/^https?:\/\/\S+$/i.test(watch.url)
          ? 'Give the address of the page to watch, starting with https://.'
          : watch?.kind === 'mcp' && (!watch.serverId || !watch.tool)
            ? 'Pick the server and tool to check.'
            : commands && !workspace && !emptyBox
              ? 'Choose a folder for its commands to run in.'
              : commands?.mode === 'allowlist' && !commands.allow.length
                ? 'List the commands it may run.'
                : null

  // Saves run one after another; each saves the latest state.
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const latest = useRef({ snapshot, problem, input: { name: name.trim() || workflow.name, automation, cron, cronEnabled: on, workspace } })
  latest.current = { snapshot, problem, input: { name: name.trim() || workflow.name, automation, cron, cronEnabled: on, workspace } }
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Saves now if anything changed; false when it can't be saved (a problem, or the save failed). */
  const flush = (): Promise<boolean> => {
    const next = chain.current.then(async () => {
      const { snapshot: snap, problem: why, input } = latest.current
      if (snap === savedSnapshot.current) return true
      if (why) {
        if (mounted.current) setSaveState({ kind: 'error', text: `Not saved: ${why}` })
        return false
      }
      if (mounted.current) setSaveState({ kind: 'saving' })
      try {
        const w = await api.workflows.saveAutomation(workflow.id, input)
        savedSnapshot.current = snap
        onSavedRef.current(w)
        if (mounted.current) setSaveState({ kind: 'saved' })
        return true
      } catch (err) {
        if (mounted.current) setSaveState({ kind: 'error', text: `Not saved: ${err instanceof Error ? err.message : String(err)}` })
        return false
      }
    })
    chain.current = next
    return next
  }
  const flushRef = useRef(flush)
  flushRef.current = flush

  // Autosave a moment after the last change; a toggle saves straight away.
  const immediate = useRef(false)
  useEffect(() => {
    if (!dirty) {
      setSaveState((st) => (st.kind === 'error' ? { kind: 'idle' } : st))
      return
    }
    if (problem) {
      setSaveState({ kind: 'error', text: `Not saved: ${problem}` })
      return
    }
    const t = setTimeout(() => void flushRef.current(), immediate.current ? 0 : SAVE_DELAY)
    immediate.current = false
    return () => clearTimeout(t)
  }, [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving this automation (another one selected, or the page closed) saves what's pending.
  useEffect(() => () => void flushRef.current(), [])

  const isOn = (i: AccessItem) => isOnIn(picked, i)
  const mention = (i: AccessItem) => setPicked((p) => toggleIn(p, i, true))

  // ─── Runs ──────────────────────────────────────────────────────────────────
  const running = runs.find((r) => r.status === 'running') ?? null
  const now = useNow(running ? 1000 : 30_000)
  const lastDone = runs.find((r) => r.status !== 'running')
  const runNow = async () => {
    if (!(await flush())) {
      if (latest.current.problem) useApp.getState().toast(latest.current.problem, 'error')
      return
    }
    setStarting(true)
    await attempt(() => api.workflows.run(workflow.id))
    setStarting(false)
  }
  const busy = !!running || starting

  // ─── Sub-line ──────────────────────────────────────────────────────────────
  // On/Paused covers the schedule and the watch alike; with neither there's nothing to turn on.
  const canTurnOn = !!cron || !!watch
  const active = on && canTurnOn
  const scheduledOn = active && !!cron && upcoming.ok
  const nextAt = scheduledOn ? (workflow.nextRunAt && workflow.nextRunAt > now ? workflow.nextRunAt : (upcoming.runs[0]?.getTime() ?? null)) : null
  const first = drafted && !on ? 'Check it, then turn it on.' : nextAt ? `Next run ${shortWhen(nextAt, now)} (${relativeIn(nextAt, now)}).` : cron && !upcoming.ok ? 'It won’t run on its schedule until the schedule is fixed.' : canTurnOn && !on ? 'Paused: it won’t run until you turn it on.' : watch ? `Runs when ${watchWhen(watch.kind)}.` : 'Runs only when you run it.'

  // ─── What it can use ──────────────────────────────────────────────────────
  const agent = agents.find((x) => x.id === agentId)
  const model = agent?.model ?? settings?.defaultModel ?? null
  const modelName = model ? (providers.find((p) => p.id === model.providerId)?.models.find((m) => m.id === model.modelId)?.name ?? model.modelId) : null
  const effortText = agent?.thinking ? effortLabel(agent.thinking) : 'Chat default'
  const pickedItems = items.filter(isOn)
  const toolItems = pickedItems.filter((i) => i.kind !== 'knowledge')
  const knowledgeItems = pickedItems.filter((i) => i.kind === 'knowledge')
  const commandsLabel = !commands ? null : commands.mode === 'container' ? `In a container (${commands.image})` : `Only: ${commands.allow.join(', ')}`
  const pickFolder = async () => {
    const [dir] = await api.app.pickPaths({ directory: true, title: 'Folder the automation works in' })
    if (!dir) return
    setWorkspace(dir)
    // Leaving the empty container folder: commands go on in a container, on a copy of the folder picked.
    if (emptyBox && commands?.mode === 'container') setCommands({ mode: 'container', image: commands.image, network: commands.network })
  }
  const where: 'none' | 'folder' | 'empty' = emptyBox ? 'empty' : workspace ? 'folder' : 'none'
  const setWhere = (next: 'none' | 'folder' | 'empty') => {
    if (next === 'folder') return void pickFolder()
    if (next === 'none') {
      setWorkspace(null)
      if (commands) setCommands(null)
      if (watch?.kind === 'files') setWatch(null)
      return
    }
    setWorkspace(null)
    setCommands({ mode: 'container', image: commands?.mode === 'container' ? commands.image : 'node:22', network: commands?.mode === 'container' ? commands.network : true, empty: true })
  }

  const remove = async () => {
    if (!(await confirmAction('Its schedule stops and its run history goes too.', { title: `Delete “${workflow.name}”?`, confirmLabel: 'Delete automation', danger: true }))) return
    savedSnapshot.current = latest.current.snapshot // nothing left to save
    if (await attempt(() => api.workflows.remove(workflow.id).then(() => true))) onDeleted()
  }
  const duplicate = async () => {
    const w = await attempt(() => api.workflows.createAutomation({ name: `Copy of ${name.trim() || workflow.name}`, automation, cron, cronEnabled: false, workspace }), 'Duplicated, paused')
    if (w) onDuplicated(w)
  }

  const recent = runs.slice(0, 10)
  const reported = runs.map(runChat).find(Boolean) ?? null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-8 pb-16 pt-[22px] max-[700px]:px-4 mobile:px-4">
        <div className="flex flex-wrap items-center gap-3">
          <SplitBack />
          <input
            aria-label="Name"
            value={name}
            title={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (!name.trim()) setName(workflow.name)
              void flush()
            }}
            spellCheck={false}
            className="min-w-[200px] flex-1 truncate border-b border-transparent bg-transparent py-0.5 text-title font-semibold outline-none hover:border-line-strong focus:border-crimson-line focus-visible:outline-none"
          />
          <span title={canTurnOn ? undefined : 'Add a schedule or a trigger first'}>
            <Switch
              checked={active}
              disabled={!canTurnOn}
              onChange={(v) => {
                immediate.current = true
                setOn(v)
              }}
              label={active ? 'On' : 'Paused'}
            />
          </span>
          {running && (
            <Button variant="ghost" className={FOCUS} onClick={() => void attempt(() => api.workflows.cancel(running.id))}>
              Cancel run
            </Button>
          )}
          <Button variant="primary" className={clsx('min-w-[96px]', FOCUS)} disabled={busy} icon={busy ? undefined : <Play size={11} fill="currentColor" aria-hidden="true" />} onClick={() => void runNow()}>
            {busy ? 'Running…' : 'Run now'}
          </Button>
        </div>
        <div className="mt-1 flex min-h-5 items-start gap-3 text-ui">
          <p className="min-w-0 flex-1 text-dim">
            {first}
            {lastDone && (
              <>
                {' '}
                Last run: <span className={clsx('font-semibold', OUTCOME_TEXT[runOutcome(lastDone)])}>{OUTCOME_WORD[runOutcome(lastDone)]}</span>, {runWhen(lastDone.startedAt, now)}.
              </>
            )}
          </p>
          <span aria-live="polite" className={clsx('max-w-[45%] shrink-0 text-right text-caption', saveState.kind === 'error' ? 'text-danger-hi' : 'text-dim')}>
            {saveState.kind === 'saving' ? 'Saving…' : saveState.kind === 'saved' ? 'Saved' : saveState.kind === 'error' ? saveState.text : ''}
          </span>
        </div>

        <Section title="What it does">
          <PromptBox value={prompt} onChange={setPrompt} items={items} onMention={mention} onBlur={() => void flush()} />
        </Section>

        <Section title="When it runs">
          <ScheduleSentence schedule={schedule} onChange={setSchedule} ok={upcoming.ok} />
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-ui text-dim">
            <span className="mr-0.5">Also when</span>
            {(
              [
                ['files', FolderOpen, 'files in its folder change'],
                ['url', Eye, 'a web page changes'],
                ['mcp', Wrench, 'an MCP check changes']
              ] as const
            ).map(([kind, Icon, label]) => {
              const pressed = watch?.kind === kind
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => setWatch(pressed ? null : newWatch(kind, configs, watch && watch.kind !== 'files' ? watch.everyMinutes : 15))}
                  className={clsx('inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-ui transition-colors motion-reduce:transition-none', FOCUS, pressed ? 'border-crimson-line bg-elev-2 text-fg' : 'border-line-strong text-muted hover:text-fg')}
                >
                  <Icon size={13} aria-hidden="true" />
                  {label}
                </button>
              )
            })}
          </div>
          {watch && (
            <div className="mt-2 grid gap-2">
              <WatchPicker key={watch.kind} value={watch} onChange={setWatch} folder={workspace} configs={configs} status={status} />
              {watch.kind !== 'files' && savedWatch && savedWatch.kind === watch.kind && (
                <div className="flex flex-wrap items-center gap-2 text-caption">
                  <span className={checked?.error ? 'text-danger-hi' : 'text-dim'}>{checked?.error ? `Last check failed: ${checked.error}` : checked?.checkedAt ? `Last checked ${timeAgo(checked.checkedAt)}.` : 'Not checked yet.'}</span>
                  <Button size="sm" variant="ghost" className={FOCUS} icon={<RefreshCw size={12} aria-hidden="true" />} onClick={async () => setChecked((await attempt(() => api.workflows.checkNow(workflow.id))) ?? checked)}>
                    Check now
                  </Button>
                </div>
              )}
            </div>
          )}
          {scheduledOn && upcoming.runs.length > 0 && (
            <p className="mt-2 text-caption tabular-nums text-dim">
              Coming up: <span className="font-medium text-muted">{shortWhen(upcoming.runs[0].getTime(), now)}</span>
              {upcoming.runs.slice(1).map((d) => `, ${shortWhen(d.getTime(), now)}`)}
            </p>
          )}
        </Section>

        <Section title="What it can use">
          <div className="overflow-hidden rounded-[12px] border border-line">
            <UseRow id="agent" icon={Bot} label="Runs as" open={open} setOpen={setOpen} value={
              <>
                <Tag tone={agent ? 'agent' : undefined}>{agent?.name ?? 'Cloth'}</Tag>
                {modelName && <Tag title={model?.modelId}>{`${modelName} · ${effortText}`}</Tag>}
              </>
            }>
              <label className="grid gap-1.5 text-ui text-muted">
                Agent
                <Select value={agentId ?? ''} onChange={(e) => setAgentId(e.target.value || null)} className="max-w-[320px]">
                  <option value="">Cloth</option>
                  {agents.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </label>
            </UseRow>
            <UseRow id="tools" icon={Wrench} label="Tools" open={open} setOpen={setOpen} value={<Tags items={toolItems.map((i) => i.label)} />}>
              <AccessPicker items={items} value={picked} onChange={setPicked} folder={!!workspace} commands={!!commands} title="Tools, servers and skills" />
            </UseRow>
            <UseRow id="knowledge" icon={BookOpen} label="Knowledge" open={open} setOpen={setOpen} value={<Tags items={knowledgeItems.map((i) => i.label)} />}>
              <AccessPicker items={items} value={picked} onChange={setPicked} folder={!!workspace} commands={!!commands} title="Knowledge" />
            </UseRow>
            <UseRow id="folder" icon={FolderOpen} label="Folder" open={open} setOpen={setOpen} value={emptyBox ? <Tag>Empty folder in a container</Tag> : workspace ? <Tag mono title={workspace}>{workspace}</Tag> : <None />}>
              <div className="grid gap-2.5">
                <div role="radiogroup" aria-label="Where it works" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
                  {(
                    [
                      { v: 'none', label: 'No folder', sub: 'It works only through its tools, servers and knowledge.', icon: CircleMinus },
                      { v: 'folder', label: workspace && !emptyBox ? `Folder: ${folderName(workspace)}` : 'A folder on this PC', sub: workspace && !emptyBox ? 'Click to choose another.' : 'Pick one. It reads and edits the files there.', icon: FolderOpen },
                      { v: 'empty', label: 'An empty folder in a container', sub: 'Starts with nothing; files you keep from a run are there next time. Needs Docker.', icon: Box }
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.v}
                      role="radio"
                      aria-checked={where === o.v}
                      onClick={() => setWhere(o.v)}
                      className={clsx(FOCUS, 'grid content-start gap-0.5 rounded-[11px] border p-3 text-left', where === o.v ? 'border-crimson-line bg-elev-2' : 'border-line hover:border-line-strong')}
                    >
                      <span className="flex min-w-0 items-center gap-1.5 text-ui font-semibold">
                        <o.icon size={14} aria-hidden="true" className="shrink-0" />
                        <span className={o.v === 'folder' ? 'truncate' : undefined}>{o.label}</span>
                      </span>
                      <span className="text-caption text-dim">{o.sub}</span>
                    </button>
                  ))}
                </div>
                {emptyBox && docker && !docker.available && <p className="text-caption text-warn">{docker.error ?? 'Docker isn’t available.'} Runs will fail until it is.</p>}
                {emptyBox && workspace && (
                  <button className={clsx(FOCUS, 'justify-self-start text-caption text-info hover:underline')} onClick={() => void api.app.openPath(workspace)}>
                    Open its folder
                  </button>
                )}
              </div>
            </UseRow>
            <UseRow id="commands" icon={SquareTerminal} label="Commands" open={open} setOpen={setOpen} value={commandsLabel ? <Tag mono title={commandsLabel}>{commandsLabel}</Tag> : <None />}>
              <CommandsPicker value={commands} onChange={setCommands} folder={!!workspace || emptyBox} docker={docker} />
            </UseRow>
            <div className="grid grid-cols-[28px_120px_minmax(0,1fr)] items-center gap-2.5 border-t border-line px-3.5 py-2.5 max-[700px]:grid-cols-[28px_minmax(0,1fr)] mobile:grid-cols-[28px_minmax(0,1fr)]">
              <Tile icon={Bell} />
              <span className="text-ui text-muted max-[700px]:sr-only mobile:sr-only">Reports</span>
              <span className="text-ui text-muted">A chat, a notification or a knowledge note</span>
            </div>
          </div>
          <p className="mt-2 flex items-start gap-2 text-caption text-dim">
            <ShieldCheck size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>Risky actions are refused: nobody is there to approve them.</span>
          </p>
        </Section>

        <Section title="Recent runs" hint={`${runsInLast30Days(runs, now)} in the last 30 days`}>
          {recent.length ? (
            <ul className="overflow-hidden rounded-[12px] border border-line">
              {recent.map((r) => {
                const outcome = runOutcome(r)
                const chat = r.status === 'running' ? null : runChat(r)
                const summary = runSummary(r)
                const body = (
                  <>
                    <OutcomeIcon outcome={outcome} />
                    <span className="sr-only">{OUTCOME_WORD[outcome]}:</span>
                    <span className="truncate text-ui tabular-nums text-muted">{r.status === 'running' ? 'Now' : cap(runWhen(r.startedAt, now))}</span>
                    <span className={clsx('truncate text-ui max-[700px]:hidden mobile:hidden', outcome === 'failed' ? 'text-danger-hi' : 'text-dim')} title={summary}>
                      {summary}
                    </span>
                    <span className="whitespace-nowrap text-right font-mono text-caption tabular-nums text-dim">{formatDuration((r.finishedAt ?? now) - r.startedAt)}</span>
                  </>
                )
                const cls = 'grid min-h-10 w-full grid-cols-[14px_150px_minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-2 text-left max-[700px]:grid-cols-[14px_minmax(0,1fr)_auto] mobile:grid-cols-[14px_minmax(0,1fr)_auto]'
                return (
                  <li key={r.id} className="border-line [&+&]:border-t">
                    {chat ? (
                      <button type="button" title="Open the chat it reported in" onClick={() => openChat(chat)} className={clsx(cls, 'hover:bg-panel', FOCUS)}>
                        {body}
                      </button>
                    ) : (
                      <div className={cls}>{body}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-ui text-dim">No runs yet.</p>
          )}
          <button type="button" onClick={() => openChat(reported)} className={clsx('mt-1 inline-flex h-8 items-center rounded text-caption text-dim underline-offset-2 hover:text-fg hover:underline', FOCUS)}>
            Open all runs in the Automation project
          </button>
        </Section>

        <div className="mt-[30px] flex flex-wrap items-center gap-2.5 border-t border-line pt-4 text-caption text-dim">
          <FooterButton onClick={() => void duplicate()}>Duplicate</FooterButton>
          <span aria-hidden="true">·</span>
          <FooterButton onClick={async () => (await flush()) && setExportOpen(true)}>Export as app</FooterButton>
          <span aria-hidden="true">·</span>
          <FooterButton danger onClick={() => void remove()}>
            Delete automation…
          </FooterButton>
        </div>
      </div>
      <ExportModal open={exportOpen} workflow={workflow} onClose={() => setExportOpen(false)} beforeExport={flush} />
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-[26px]">
      <h2 className="mb-2 flex items-baseline gap-2 text-ui font-semibold">
        {title}
        {hint && <small className="text-caption font-normal tabular-nums text-dim">{hint}</small>}
      </h2>
      {children}
    </section>
  )
}

function FooterButton({ danger, onClick, children }: { danger?: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={clsx('h-8 rounded px-1 text-ui text-dim', danger ? 'hover:text-danger-hi' : 'hover:text-fg', FOCUS)}>
      {children}
    </button>
  )
}

function Tile({ icon: Icon }: { icon: typeof Bot }) {
  return (
    <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-elev-2 text-muted">
      <Icon size={14} />
    </span>
  )
}

function Tag({ tone, mono, title, children }: { tone?: 'agent'; mono?: boolean; title?: string; children: ReactNode }) {
  return (
    <span title={title ?? (typeof children === 'string' ? children : undefined)} className={clsx('max-w-full truncate rounded-md border px-[7px] py-px text-caption', tone === 'agent' ? 'border-transparent bg-agent-soft text-agent' : 'border-line', mono && 'font-mono text-caption')}>
      {children}
    </span>
  )
}

const None = () => <span className="text-ui text-dim">None</span>

function Tags({ items }: { items: string[] }) {
  if (!items.length) return <None />
  const shown = items.slice(0, 4)
  return (
    <>
      {shown.map((t) => (
        <Tag key={t}>{t}</Tag>
      ))}
      {items.length > shown.length && <Tag title={items.slice(4).join(', ')}>{`+${items.length - shown.length} more`}</Tag>}
    </>
  )
}

/** A row of "What it can use": icon, label, what's set, and Change (expands its picker below; one at a time). */
function UseRow({ id, icon, label, value, open, setOpen, children }: { id: Row; icon: typeof Bot; label: string; value: ReactNode; open: Row | null; setOpen(r: Row | null): void; children: ReactNode }) {
  const expanded = open === id
  const panel = `use-${id}`
  return (
    <div className="border-line [&+&]:border-t">
      <div className="grid grid-cols-[28px_120px_minmax(0,1fr)_auto] items-center gap-2.5 px-3.5 py-2 max-[700px]:grid-cols-[28px_minmax(0,1fr)_auto] mobile:grid-cols-[28px_minmax(0,1fr)_auto]">
        <Tile icon={icon} />
        <span className="text-ui text-muted max-[700px]:sr-only mobile:sr-only">{label}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-[5px]">
          {value}
        </span>
        <button type="button" aria-expanded={expanded} aria-controls={panel} aria-label={`${expanded ? 'Close' : 'Change'} ${label.toLowerCase()}`} onClick={() => setOpen(expanded ? null : id)} className={clsx('h-8 rounded px-2 text-caption', expanded ? 'text-fg' : 'text-dim hover:text-fg', FOCUS)}>
          {expanded ? 'Done' : 'Change'}
        </button>
      </div>
      {expanded && (
        <div id={panel} className="border-t border-line bg-panel/60 p-3.5">
          {children}
        </div>
      )}
    </div>
  )
}

const pickClass = clsx('inline-flex h-8 rounded-lg border border-line-strong bg-elev-2 px-2.5 align-middle text-ui hover:border-crimson-line', FOCUS)

/** "Every weekday at 8:30", with the cadence, day and time as inline pickers. */
function ScheduleSentence({ schedule, onChange, ok }: { schedule: Schedule; onChange(s: Schedule): void; ok: boolean }) {
  const timed = schedule.cadence === 'daily' || schedule.cadence === 'weekdays' || schedule.cadence === 'weekly'
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-[12px] border border-line bg-panel px-3.5 py-3 text-body">
        <Select aria-label="How often" value={schedule.cadence} onChange={(e) => onChange({ ...schedule, cadence: e.target.value as Cadence })} className={clsx(pickClass, 'w-auto pr-8')}>
          {CADENCES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
        {schedule.cadence === 'weekly' && (
          <>
            <span>on</span>
            <Select aria-label="Day" value={String(schedule.day)} onChange={(e) => onChange({ ...schedule, day: Number(e.target.value) })} className={clsx(pickClass, 'w-auto pr-8')}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </>
        )}
        {timed && (
          <>
            <span>at</span>
            <Input type="time" aria-label="Time" value={schedule.time} onChange={(e) => onChange({ ...schedule, time: e.target.value || '09:00' })} className={clsx(pickClass, 'w-[112px] tabular-nums')} />
          </>
        )}
        {schedule.cadence === 'custom' && (
          <Input
            aria-label="Cron schedule"
            aria-invalid={!ok}
            aria-describedby={ok ? 'cron-hint' : 'cron-error'}
            value={schedule.custom}
            onChange={(e) => onChange({ ...schedule, custom: e.target.value })}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            autoComplete="off"
            className={clsx(pickClass, 'w-48 font-mono', !ok && 'border-danger-line')}
          />
        )}
      </div>
      {schedule.cadence === 'custom' && ok && (
        <p id="cron-hint" className="mt-1.5 text-caption text-dim">
          Five fields: minute hour day month weekday
        </p>
      )}
      {!ok && (
        <p id="cron-error" className="mt-1.5 text-caption text-danger-hi">
          That isn’t a valid cron schedule. Five fields: minute, hour, day of month, month, day of week (like 0 9 * * 1-5).
        </p>
      )}
    </div>
  )
}
