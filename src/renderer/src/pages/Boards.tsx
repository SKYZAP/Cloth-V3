import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  ArrowRight,
  ArrowSquareOut,
  ArrowUUpLeft,
  ArrowsClockwise,
  CaretDoubleUp,
  CaretDown,
  CaretUp,
  Check,
  CircleNotch,
  CloudArrowUp,
  Equals,
  Eye,
  FileText,
  Flask,
  Folder,
  GitMerge,
  GitPullRequest,
  Hammer,
  Kanban,
  Pause,
  Play,
  Plus,
  Robot,
  SlidersHorizontal,
  Tray,
  Wrench,
  X,
  ChatCircleDots,
  CheckCircle,
  Desktop,
  DownloadSimple,
  FolderOpen,
  GitBranch,
  PencilSimple,
  Trash
} from '@phosphor-icons/react'
import { MAPPED_STAGES, STAGES, TRACKER_NAMES, goalOf, stageLabel, type BoardAgents, type BoardOverview, type BoardProjectSettings, type BoardTicket, type GitMode, type MappedStage, type Stage, type TicketPriority, type TrackerKind } from '@shared/boards'
import type { Agent } from '@shared/types'
import { api, useAsync, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { leaveDraft } from '@/lib/drafts'
import { Badge, Button, confirmAction, Empty, Field, IconButton, Input, Modal, PageHeader, PageTitle, Segmented, Select, Spinner, Switch, Textarea } from '@/components/ui'

/*
 * Boards: one tracker's project as columns of agent stages. Each stage moves the ticket to its mapped tracker
 * state; the planner writes requirements back into the ticket, the reviewer comments, the implementer opens a PR.
 */

const STAGE_LOOK: Record<Stage, { icon: ReactNode; color: string }> = {
  new: { icon: <Tray size={15} />, color: 'text-dim' },
  req: { icon: <FileText size={15} />, color: 'text-skill' },
  rev: { icon: <Eye size={15} />, color: 'text-warn' },
  build: { icon: <Hammer size={15} />, color: 'text-agent' },
  pr: { icon: <GitPullRequest size={15} />, color: 'text-ok' }
}

const TRACKER_NAME = TRACKER_NAMES
const TRACKER_KINDS: TrackerKind[] = ['cloth', 'plane', 'jira']
const TRACKER_TAG: Record<TrackerKind, { letter: string; className: string }> = {
  cloth: { letter: 'C', className: 'bg-crimson-soft text-crimson-text' },
  plane: { letter: 'P', className: 'bg-info/15 text-info' },
  jira: { letter: 'J', className: 'bg-agent/15 text-agent' }
}

/** Cloth may change the board's tickets: a Cloth board always, a tracker when the project allows ticket updates. */
const writesTo = (kind: TrackerKind, s: BoardProjectSettings) => kind === 'cloth' || s.trackerUpdates

const GIT_MODES: { value: GitMode; label: string; hint: string }[] = [
  { value: 'none', label: 'No commits', hint: 'The changes stay uncommitted in their own copy of the code. You apply them to your code folder when you are happy, and commit them yourself.' },
  { value: 'commit', label: 'Commit locally', hint: 'The changes are committed to a local branch per ticket. Nothing is pushed.' },
  { value: 'pr', label: 'Commit and open a PR', hint: 'The branch is pushed and a pull request opened through the GitHub CLI. Failing checks get fixed and the PR waits for you.' }
]

/** The ticket's finished changes wait, uncommitted, in their own copy of the code (a worktree or a plain copy). */
const inCopy = (m: string | undefined) => m === 'none' || m === 'copy'

const PRIORITY: Record<TicketPriority, { icon: ReactNode; label: string } | null> = {
  urgent: { icon: <CaretDoubleUp size={13} className="text-danger" />, label: 'Urgent' },
  high: { icon: <CaretUp size={13} className="text-danger" />, label: 'High' },
  medium: { icon: <Equals size={13} className="text-warn" />, label: 'Medium' },
  low: { icon: <CaretDown size={13} className="text-dim" />, label: 'Low' },
  none: null
}

type Filter = 'all' | 'agents' | 'you'

const waitingForYou = (t: BoardTicket) => t.pipeline?.status === 'needsYou' || t.pipeline?.status === 'error'

export function BoardsPage() {
  const toast = useApp((s) => s.toast)
  const { data, loading, setData, reload } = useAsync(() => api.boards.overview(), [])
  const agents = useAsync(() => api.agents.list(), [])
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [modal, setModal] = useState<'new' | 'settings' | 'connect' | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [switchTo, setSwitchTo] = useState<TrackerKind>('cloth')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEvent('boards', () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void reload(), 150)
  })

  const run = async (fn: () => Promise<BoardOverview>, done?: string) => {
    try {
      setData(await fn())
      if (done) toast(done, 'ok')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  if (loading && !data) return <div className="flex h-full items-center justify-center"><Spinner /></div>
  if (!data?.connection)
    return (
      <div className="flex h-full flex-col">
        <PageHeader title={<PageTitle>Boards</PageTitle>} />
        <ConnectForm onConnected={(o) => setData(o)} />
      </div>
    )

  const o = data
  const conn = o.connection!
  const tracker = TRACKER_NAME[conn.kind]
  const project = o.projects.find((p) => p.id === o.projectId) ?? null
  const ticket = o.tickets.find((t) => t.id === selected) ?? null
  const working = o.tickets.filter((t) => t.pipeline?.status === 'running' && t.pipeline.stage !== 'pr').length
  const shown = o.tickets.filter((t) => filter === 'all' || (filter === 'agents' && t.pipeline) || (filter === 'you' && waitingForYou(t)))
  const local = conn.kind === 'cloth'
  const writes = !!o.settings && writesTo(conn.kind, o.settings)

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={<PageTitle>Boards</PageTitle>}
        actions={
          <>
            <TrackerMenu overview={o} onSwitch={(k) => { setSwitchTo(k); setModal('connect') }} onDisconnect={() => run(async () => (await api.boards.disconnect(), api.boards.overview()), local ? 'Closed the Cloth board' : `Disconnected ${tracker}`)} />
            {o.projects.length > 0 && (
              <ProjectMenu overview={o} tracker={tracker} onSelect={(id) => { setSelected(null); void run(() => api.boards.selectProject(id)) }} onCreate={local ? (name) => run(() => api.boards.createProject(name), `Created ${name}`) : undefined} />
            )}
            <Button variant="outline" icon={<SlidersHorizontal size={15} />} onClick={() => setModal('settings')} disabled={!project}>{local ? 'Edit project' : 'Project settings'}</Button>
            <Button variant="primary" icon={<Plus size={15} weight="bold" />} onClick={() => setModal('new')} disabled={!project || !writes} title={project && !writes ? `Ticket updates are off for this project, so Cloth won't create tickets in ${tracker}. Turn them on in Project settings.` : undefined}>New ticket</Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2.5 text-caption text-dim">
            <Segmented<Filter> value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All' }, { value: 'agents', label: 'With agents' }, { value: 'you', label: `Waiting for you${o.tickets.some(waitingForYou) ? ` · ${o.tickets.filter(waitingForYou).length}` : ''}` }]} />
            <span className="ml-auto flex items-center gap-3">
              {local && <Badge tone="dim"><Desktop size={11} />On this PC</Badge>}
              {!local && o.settings && !o.settings.trackerUpdates && <Badge tone="dim" title={`Cloth reads ${tracker} but changes nothing there. Turn on ticket updates in Project settings.`}>Read-only in {tracker}</Badge>}
              {o.settings && o.repoGit === false && <Badge tone="dim" title="The code folder isn't a git repository: agents build in a copy of it, and you apply the changes">No git: builds in a copy</Badge>}
              {o.settings && o.repoGit !== false && o.settings.git !== 'pr' && <Badge tone="dim" title="Project settings → Commits and pull requests">{o.settings.git === 'none' ? 'No commits' : 'Local commits only'}</Badge>}
              {o.settings?.autoMerge && <Badge tone="warn"><Flask size={11} />Auto-merge on</Badge>}
              {working > 0 && <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-agent" />{working} agent{working === 1 ? '' : 's'} working</span>}
              {!local && (
                <>
                  {o.error ? <span className="text-danger-hi" title={o.error}>Sync failed</span> : <span>{o.syncedAt ? `Synced ${ago(o.syncedAt)}` : 'Syncing…'}</span>}
                  <IconButton aria-label="Sync now" title="Sync now" onClick={async () => { setSyncing(true); await run(() => api.boards.sync()); setSyncing(false) }}>
                    <ArrowsClockwise size={14} className={clsx(syncing && 'animate-spin')} />
                  </IconButton>
                </>
              )}
            </span>
          </div>
          {o.error && <div className="border-b border-line bg-danger-soft px-5 py-2 text-caption text-danger-hi">{o.error}</div>}
          {project && o.settings ? (
            <div className="grid min-h-0 flex-1 auto-cols-[minmax(200px,1fr)] grid-flow-col gap-3 overflow-auto px-5 pt-3.5 pb-5">
              {STAGES.map((st) => (
                <Column key={st} stage={st} label={stageLabel(st, o.settings)} tracker={local || !writes ? null : tracker} stateName={o.states.find((s) => s.id === o.settings!.stateMap[st])?.name ?? 'not mapped'} tickets={shown.filter((t) => t.stage === st)} selected={selected} onSelect={setSelected} autoMerge={o.settings!.autoMerge} />
              ))}
            </div>
          ) : (
            <Empty icon={<Kanban size={20} />} title="No project yet">{local ? 'Make a project from the project menu.' : `Create a project in ${tracker}, then sync.`}</Empty>
          )}
        </div>
        {ticket && o.settings && (
          <TicketPanel
            key={ticket.id}
            ticket={ticket}
            tracker={tracker}
            kind={conn.kind}
            settings={o.settings}
            chatProjectId={o.chatProjectId}
            agents={agents.data ?? []}
            onClose={() => setSelected(null)}
            run={run}
          />
        )}
      </div>
      {project && o.settings && (
        <>
          <NewTicketModal open={modal === 'new'} onClose={() => setModal(null)} projectName={project.name} tracker={tracker} local={local} settings={o.settings} repoGit={o.repoGit} agents={agents.data ?? []} onCreate={(input) => run(() => api.boards.createTicket(input), local ? 'Ticket created' : `Created in ${tracker}`)} />
          <SettingsModal
            open={modal === 'settings'}
            onClose={() => setModal(null)}
            overview={o}
            agents={agents.data ?? []}
            onSave={(patch) => run(() => api.boards.saveSettings(project.id, patch))}
            onRename={local ? (name) => run(() => api.boards.renameProject(project.id, name), 'Renamed') : undefined}
            onDelete={
              local
                ? async () => {
                    const n = o.tickets.length
                    if (!(await confirmAction(`${project.name} and its ${n} open ticket${n === 1 ? '' : 's'} are deleted from this PC. Agents working on them stop, and changes waiting to be applied are lost. Your code folder isn't touched.`, { title: `Delete ${project.name}?`, confirmLabel: 'Delete project', danger: true }))) return
                    setModal(null)
                    setSelected(null)
                    await run(() => api.boards.deleteProject(project.id), `Deleted ${project.name}`)
                  }
                : undefined
            }
          />
        </>
      )}
      <Modal open={modal === 'connect'} onClose={() => setModal(null)} title={local ? 'Switch from the Cloth board' : `Switch from ${tracker}`} width={480}>
        <ConnectForm key={switchTo} compact initialKind={switchTo} current={conn.kind} onConnected={(next) => { setData(next); setSelected(null); setModal(null) }} />
      </Modal>
    </div>
  )
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

// ---- Tracker connection ----

/** Open state for a header popover menu: closes on an outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const click = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', click)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', click)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  return { open, setOpen, ref }
}

const MENU_PILL = 'flex h-[30px] items-center gap-1.5 rounded-full border border-line bg-panel pr-2.5 pl-3 text-caption text-muted transition-colors hover:border-line-strong hover:text-fg'
const MENU_PANEL = 'absolute top-9 right-0 z-40 w-72 rounded-[10px] border border-line bg-elev p-1.5 shadow-2xl shadow-black/50'
const MENU_ITEM = 'flex w-full items-center gap-2.5 rounded-md p-2 text-left hover:bg-elev-2'
const MENU_FOOTER = 'mt-1 flex items-center justify-between border-t border-line px-2 pt-2 pb-1 text-caption text-dim'

function ProjectMenu({ overview: o, tracker, onSelect, onCreate }: { overview: BoardOverview; tracker: string; onSelect(id: string): void; onCreate?(name: string): Promise<void> }) {
  const { open, setOpen, ref } = usePopover()
  const current = o.projects.find((p) => p.id === o.projectId)
  const [name, setName] = useState<string | null>(null)
  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name?.trim() || !onCreate) return
    await onCreate(name.trim())
    setName(null)
    setOpen(false)
  }
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label="Project" className={clsx(MENU_PILL, 'max-w-[220px]')}>
        <span className="truncate">{current?.name ?? 'Pick a project'}</span>
        <CaretDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div role="menu" className={MENU_PANEL}>
          <div className="max-h-72 overflow-y-auto">
            {o.projects.map((p) => (
              <button key={p.id} role="menuitemradio" aria-checked={p.id === o.projectId} onClick={() => { setOpen(false); if (p.id !== o.projectId) onSelect(p.id) }} className={MENU_ITEM}>
                <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-md bg-skill-soft px-1 text-micro font-semibold text-skill">{(p.key || p.name).slice(0, 4).toUpperCase()}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-fg">{p.name}</span>
                  <span className="block truncate text-caption text-dim">{p.id === o.projectId ? `${o.tickets.length} ticket${o.tickets.length === 1 ? '' : 's'}` : p.key}</span>
                </span>
                {p.id === o.projectId && <Check size={14} className="shrink-0 text-ok" />}
              </button>
            ))}
          </div>
          {onCreate && name !== null && (
            <form onSubmit={create} className="mt-1 flex items-center gap-1.5 border-t border-line px-1 pt-2">
              <Input id="board-new-project" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" autoFocus aria-label="New project name" />
              <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>Create</Button>
            </form>
          )}
          <div className={MENU_FOOTER}>
            <span>{o.projects.length} project{o.projects.length === 1 ? '' : 's'} {onCreate ? 'on this PC' : `in ${tracker}`}</span>
            {onCreate && name === null && <button className="flex items-center gap-1 hover:text-fg" onClick={() => setName('')}><Plus size={12} />New project</button>}
          </div>
        </div>
      )}
    </div>
  )
}

function TrackerMenu({ overview, onSwitch, onDisconnect }: { overview: BoardOverview; onSwitch(kind: TrackerKind): void; onDisconnect(): void }) {
  const { open, setOpen, ref } = usePopover()
  const conn = overview.connection!
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} className={MENU_PILL}>
        <span className={clsx('h-1.5 w-1.5 rounded-full', overview.error ? 'bg-danger' : 'bg-ok')} />
        {conn.kind === 'cloth' ? 'Cloth board' : TRACKER_NAME[conn.kind]}
        <CaretDown size={12} />
      </button>
      {open && (
        <div role="menu" className={MENU_PANEL}>
          {TRACKER_KINDS.map((k) => (
            <button key={k} role="menuitemradio" aria-checked={k === conn.kind} onClick={() => { setOpen(false); if (k !== conn.kind) onSwitch(k) }} className={MENU_ITEM}>
              <span className={clsx('flex h-[22px] w-[22px] items-center justify-center rounded-md text-micro font-semibold', TRACKER_TAG[k].className)}>{TRACKER_TAG[k].letter}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-fg">{k === 'cloth' ? 'Cloth board' : TRACKER_NAME[k]}</span>
                <span className="block truncate text-caption text-dim">{k === conn.kind ? conn.label : k === 'cloth' ? 'Offline, on this PC' : 'Not connected'}</span>
              </span>
              {k === conn.kind && <Check size={14} className="text-ok" />}
            </button>
          ))}
          <div className={MENU_FOOTER}>
            <span>One board at a time.</span>
            <button className="hover:text-danger-hi" onClick={() => { setOpen(false); onDisconnect() }}>{conn.kind === 'cloth' ? 'Close board' : 'Disconnect'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ConnectForm({ onConnected, compact, initialKind = 'cloth', current }: { onConnected(o: BoardOverview): void; compact?: boolean; initialKind?: TrackerKind; current?: TrackerKind }) {
  const toast = useApp((s) => s.toast)
  const [kind, setKind] = useState<TrackerKind>(initialKind)
  const [baseUrl, setBaseUrl] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const o = await api.boards.connect(kind === 'cloth' ? { kind } : { kind, baseUrl, workspace, email, token })
      toast(kind === 'cloth' ? 'Opened the Cloth board' : `Connected ${TRACKER_NAME[kind]}`, 'ok')
      onConnected(o)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const form = (
    <form onSubmit={submit} className="flex w-full flex-col gap-3.5">
      <Segmented<TrackerKind> value={kind} onChange={(k) => { setKind(k); setError(null) }} items={[{ value: 'cloth', label: 'Cloth board' }, { value: 'plane', label: 'Plane' }, { value: 'jira', label: 'Jira' }]} />
      {kind === 'cloth' ? (
        <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card p-3 text-[12.5px] leading-relaxed text-muted">
          <Desktop size={16} className="mt-0.5 shrink-0 text-dim" />
          <div>
            <div className="font-semibold text-fg">Offline, on this PC</div>
            Projects and tickets live in Cloth, with no account or token. Agents still use the models you pick. By default nothing is committed: the changes stay in their own copy of your code until you apply them.
          </div>
        </div>
      ) : (
        <>
          <Field label={kind === 'plane' ? 'Plane address' : 'Jira site'}>
            <Input id="board-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={kind === 'plane' ? 'https://plane.example.com' : 'https://your-team.atlassian.net'} autoFocus />
          </Field>
          {kind === 'plane' ? (
            <Field label="Workspace" hint="The workspace slug from your Plane links.">
              <Input id="board-ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="my-team" />
            </Field>
          ) : (
            <Field label="Account email">
              <Input id="board-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </Field>
          )}
          <Field label="API token" hint={kind === 'plane' ? 'Make one in Plane under Profile settings → API tokens.' : 'Make one at id.atlassian.com → Security → API tokens.'}>
            <Input id="board-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </Field>
        </>
      )}
      {current && current !== kind && (
        <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-caption text-muted">
          {current === 'cloth'
            ? `Switching closes the Cloth board, and agents working on its tickets stop. Its tickets stay on this PC for when you open it again.`
            : `Switching disconnects ${TRACKER_NAME[current]}, and agents working on ${TRACKER_NAME[current]} tickets stop. The tickets stay in ${TRACKER_NAME[current]}.`}
        </div>
      )}
      {error && <div className="text-caption text-danger-hi">{error}</div>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>{kind === 'cloth' ? 'Use the Cloth board' : `Connect ${TRACKER_NAME[kind]}`}</Button>
      </div>
    </form>
  )
  if (compact) return form
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-8">
      <div className="w-full max-w-md">
        <div className="mb-1 text-section font-semibold">Set up a board</div>
        <p className="mb-5 text-ui text-dim">Tickets show here by agent stage. Agents write requirements, review them against the goal, and build them. Keep the board on this PC, or connect Plane or Jira.</p>
        {form}
      </div>
    </div>
  )
}

// ---- Board ----

/** `tracker` is null when Cloth doesn't move tickets in one (a Cloth board, or ticket updates off). */
function Column({ stage, label, tracker, stateName, tickets, selected, onSelect, autoMerge }: { stage: Stage; label: string; tracker: string | null; stateName: string; tickets: BoardTicket[]; selected: string | null; onSelect(id: string): void; autoMerge: boolean }) {
  const look = STAGE_LOOK[stage]
  return (
    <section aria-label={label} className="flex min-h-0 min-w-0 flex-col rounded-xl border border-line bg-card">
      <div className="border-b border-line px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5 font-semibold">
          <span className={look.color}>{stage === 'pr' && label === 'Ready' ? <CheckCircle size={15} /> : look.icon}</span>
          {label}
          <span className="font-medium text-dim tabular-nums">{tickets.length}</span>
        </div>
        {tracker && <div className="mt-0.5 flex items-center gap-1 text-micro text-dim"><ArrowRight size={11} />{tracker}: {stateName}</div>}
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2">
        {tickets.map((t) => <TicketCard key={t.id} ticket={t} active={t.id === selected} onClick={() => onSelect(t.id)} autoMerge={autoMerge} />)}
        {!tickets.length && <div className="px-1 py-2.5 text-center text-caption text-dim">Nothing here</div>}
      </div>
    </section>
  )
}

const AGENT_TAG: Partial<Record<Stage, { label: string; className: string }>> = {
  req: { label: 'P', className: 'bg-skill-soft text-skill' },
  rev: { label: 'CR', className: 'bg-warn/15 text-warn' },
  build: { label: 'I', className: 'bg-agent-soft text-agent' }
}

function TicketCard({ ticket: t, active, onClick, autoMerge }: { ticket: BoardTicket; active: boolean; onClick(): void; autoMerge: boolean }) {
  const p = t.pipeline
  const pri = PRIORITY[t.priority]
  const tag = p?.status === 'running' ? AGENT_TAG[p.stage] : undefined
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}
      className={clsx(
        'cursor-default rounded-[10px] border p-2.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-crimson-line',
        active ? 'border-line-strong bg-elev-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : 'border-line bg-panel hover:border-line-strong'
      )}
    >
      <div className="flex items-center gap-1.5 font-mono text-micro text-dim">
        {pri && <span title={pri.label}>{pri.icon}</span>}
        {t.key}
        {tag && <span title="Agent working" className={clsx('ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-1 font-sans text-[9px] font-semibold', tag.className)}>{tag.label}</span>}
      </div>
      <div className="mt-1 mb-2 leading-snug font-medium [overflow-wrap:anywhere] text-fg">{t.title}</div>
      <div className="flex flex-wrap items-center gap-1.5"><CardChip ticket={t} autoMerge={autoMerge} /></div>
    </div>
  )
}

function CardChip({ ticket: t, autoMerge }: { ticket: BoardTicket; autoMerge: boolean }) {
  const p = t.pipeline
  if (!p) return <Badge tone="dim">Manual</Badge>
  if (p.status === 'error') return <Badge tone="danger">Stopped</Badge>
  if (p.status === 'paused') return <Badge tone="dim"><Pause size={11} />Paused</Badge>
  if (p.status === 'queued') return <Badge tone="dim"><Robot size={11} />{p.fixing ? 'Queued to fix checks' : 'Queued'}</Badge>
  if (p.pr && p.fixing)
    return (
      <>
        <Badge>#{p.pr.number}</Badge>
        <Badge className="border-agent/30 bg-agent-soft text-agent"><CircleNotch size={11} className="animate-spin" />Fixing checks</Badge>
      </>
    )
  if (p.pr)
    return (
      <>
        <Badge>#{p.pr.number}</Badge>
        {p.pr.checks === 'pass' || p.pr.checks === 'none' ? <Badge tone="ok"><Check size={11} />{p.pr.checks === 'pass' ? 'Checks pass' : 'No checks'}</Badge> : p.pr.checks === 'fail' ? <Badge tone="danger">Checks failed</Badge> : <Badge tone="info"><CircleNotch size={11} className="animate-spin" />Checks running</Badge>}
        {p.pr.merging && autoMerge ? <Badge tone="warn"><Flask size={11} />Merging</Badge> : p.status === 'needsYou' ? <Badge tone="crimson">Your review</Badge> : null}
      </>
    )
  if (p.local && p.status === 'needsYou')
    return (
      <>
        {p.local.mode === 'commit' ? <Badge><GitBranch size={11} />Committed</Badge> : <Badge>{p.files ? `${p.files} file${p.files === 1 ? '' : 's'}` : 'Changes'} uncommitted</Badge>}
        <Badge tone="crimson">Your review</Badge>
      </>
    )
  if (p.status === 'needsYou') return <Badge tone="crimson">Needs you</Badge>
  if (p.stage === 'req' && p.sendBacks > 0) return <Badge tone="warn"><ArrowUUpLeft size={11} />Sent back {p.sendBacks === 1 ? 'once' : `${p.sendBacks}×`}</Badge>
  if (p.stage === 'build' && p.files) return <Badge className="border-agent/30 bg-agent-soft text-agent">{p.files} file{p.files === 1 ? '' : 's'} changed</Badge>
  return <Badge className="border-skill-dot/30 bg-skill-soft text-skill"><CircleNotch size={11} className="animate-spin" /><span className="max-w-[150px] truncate">{p.activity ?? 'Working'}</span></Badge>
}

// ---- Ticket panel ----

/** What a chat opened from a ticket starts with in its message box: the ticket, and where the agents got to. */
export function ticketPrompt(t: BoardTicket, tracker: string): string {
  const p = t.pipeline
  const lines = [`Let's work on ${t.key}: ${t.title}`, ...(t.url ? [`${tracker} ticket: ${t.url}`] : [])]
  const goal = p?.goal || t.description
  if (goal) lines.push('', `Goal: ${goal}`)
  if (p?.requirements.length) lines.push('', 'Requirements:', ...p.requirements.map((r) => `- ${r}`))
  if (p?.outOfScope.length) lines.push('', 'Out of scope:', ...p.outOfScope.map((r) => `- ${r}`))
  if (p?.pr) {
    lines.push('', `Pull request: ${p.pr.url}${p.branch ? ` (branch ${p.branch})` : ''}`)
    if (p.pr.checks === 'fail') lines.push(`Failing checks: ${p.pr.failing?.length ? p.pr.failing.join(', ') : 'see the PR'}`)
  } else if (inCopy(p?.local?.mode) && p?.local?.dir && !p.local.applied) lines.push('', p.local.mode === 'copy' ? `The changes are in ${p.local.dir} (a copy of the code folder).` : `The changes are uncommitted in ${p.local.dir} (a worktree off ${p.local.base}).`)
  else if (p?.branch) lines.push('', `Branch: ${p.branch}${p.local ? ' (local, not pushed)' : ''}`)
  return lines.join('\n')
}

function TicketPanel({ ticket: t, tracker, kind, settings, chatProjectId, agents, onClose, run }: { ticket: BoardTicket; tracker: string; kind: TrackerKind; settings: BoardProjectSettings; chatProjectId: string | null; agents: Agent[]; onClose(): void; run(fn: () => Promise<BoardOverview>, done?: string): Promise<void> }) {
  const p = t.pipeline
  const local = kind === 'cloth'
  const writes = writesTo(kind, settings)
  const busy = p?.status === 'running' || p?.status === 'queued'
  const ready = p?.stage === 'pr' && p.local && p.status === 'needsYou'
  const open = () => void api.app.openExternal(t.url)
  const markDone = async () => {
    if (inCopy(p?.local?.mode) && !(await confirmAction('The uncommitted changes in its copy of the code are deleted. Apply them first to keep them.', { title: `Mark ${t.key} done without applying?`, confirmLabel: 'Mark done', danger: true }))) return
    await run(() => api.boards.finish(t.id), `${t.key} is done`)
    onClose()
  }
  const remove = async () => {
    if (!(await confirmAction(`${t.key} and what the agents did on it are deleted from this board${inCopy(p?.local?.mode) ? ', with its uncommitted changes' : ''}.`, { title: `Delete ${t.key}?`, confirmLabel: 'Delete', danger: true }))) return
    await run(() => api.boards.deleteTicket(t.id), `Deleted ${t.key}`)
    onClose()
  }
  // In the linked chat project when there is one (its folder and settings), else in the board's code folder.
  const openInChat = async () => {
    const chat = await attempt(() => api.chat.create({ title: `${t.key}: ${t.title}`, ...(chatProjectId ? { projectId: chatProjectId } : { workspace: settings.repo }) }))
    if (!chat) return
    leaveDraft(chat.id, ticketPrompt(t, tracker))
    try {
      localStorage.setItem('cloth.chat', chat.id)
    } catch {
      /* storage unavailable */
    }
    useApp.getState().setPage('chat')
  }
  return (
    <aside aria-label={t.key} className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="border-b border-line px-4 pt-3.5 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-caption whitespace-nowrap text-dim">{t.key}</span>
          <span className="min-w-0 truncate">
            <Badge>{local ? t.stateName || '—' : `${tracker}: ${t.stateName || '—'}`}</Badge>
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <IconButton aria-label="Open in chat" title={chatProjectId ? 'Open in chat: a new chat in the linked project, with this ticket in the message box' : 'Open in chat: a new chat in the code folder, with this ticket in the message box'} onClick={() => void openInChat()}><ChatCircleDots size={15} /></IconButton>
            {t.url && <IconButton aria-label={`Open in ${tracker}`} title={`Open in ${tracker}`} onClick={open}><ArrowSquareOut size={15} /></IconButton>}
            <IconButton aria-label="Close" onClick={onClose}><X size={15} /></IconButton>
          </span>
        </div>
        <div className="mt-1.5 mb-2 text-section leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">{t.title}</div>
        {ready && p?.local && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" icon={<DownloadSimple size={14} />} onClick={() => run(() => api.boards.applyChanges(t.id), `Applied ${t.key} to your code folder, uncommitted`)} title={`Copies the changes into ${settings.repo ?? 'the code folder'} as uncommitted changes, then marks the ticket done`}>Apply to code folder</Button>
            {inCopy(p.local.mode) && p.local.dir && <Button size="sm" icon={<FolderOpen size={14} />} onClick={() => void api.app.openPath(p.local!.dir!)}>Open the copy</Button>}
            <Button size="sm" variant="ghost" icon={<CheckCircle size={14} />} onClick={() => void markDone()}>Mark done</Button>
          </div>
        )}
        {p && (
          <div className="flex flex-wrap gap-1.5">
            {busy ? (
              <Button size="sm" icon={<Pause size={14} />} onClick={() => run(() => api.boards.pause(t.id))}>Pause agents</Button>
            ) : p.stage !== 'pr' || p.status === 'error' ? (
              <Button size="sm" icon={<Play size={14} />} onClick={() => run(() => api.boards.resume(t.id))}>{p.stage !== 'pr' ? (p.stage === 'build' && p.status === 'needsYou' && settings.approveRequirements && p.review?.verdict === 'approve' ? 'Approve and build' : 'Resume') : p.fixing ? 'Resume the fix' : 'Watch the PR again'}</Button>
            ) : null}
            {p.pr?.checks === 'fail' && !p.fixing && p.status !== 'running' && p.status !== 'queued' && (
              <Button size="sm" variant="primary" icon={<Wrench size={14} />} onClick={() => run(() => api.boards.fixChecks(t.id), 'An agent is fixing the checks')}>Fix checks</Button>
            )}
            {p.pr && <Button size="sm" variant={p.status === 'needsYou' ? 'primary' : 'outline'} icon={<GitMerge size={14} />} onClick={() => void api.app.openExternal(p.pr!.url)}>{p.pr.merging ? `View PR #${p.pr.number}` : `Review PR #${p.pr.number}`}</Button>}
            {p.status !== 'running' && !ready && <Button size="sm" variant="ghost" onClick={() => run(() => api.boards.stopAgents(t.id), 'Agents are off for this ticket')}>Take agents off</Button>}
            {local && !busy && <Button size="sm" variant="ghost" icon={<Check size={14} />} onClick={async () => { await run(() => api.boards.closeTicket(t.id), `Closed ${t.key}`); onClose() }}>Close ticket</Button>}
            {local && !busy && <IconButton aria-label={`Delete ${t.key}`} title="Delete ticket" onClick={() => void remove()}><Trash size={14} /></IconButton>}
          </div>
        )}
        {!p && local && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="ghost" icon={<Check size={14} />} onClick={async () => { await run(() => api.boards.closeTicket(t.id), `Closed ${t.key}`); onClose() }}>Close ticket</Button>
            <IconButton aria-label={`Delete ${t.key}`} title="Delete ticket" onClick={() => void remove()}><Trash size={14} /></IconButton>
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-3.5 pb-5 [overflow-wrap:anywhere]">
        {!p ? (
          <ManualTicket ticket={t} tracker={tracker} local={local} settings={settings} agents={agents} run={run} />
        ) : (
          <>
            {p.note && <div className={clsx('rounded-md border px-3 py-2 text-caption leading-relaxed', p.status === 'error' ? 'border-danger-line bg-danger-soft text-danger-hi' : 'border-crimson-line bg-crimson-soft text-crimson-text')}>{p.note}</div>}
            <Section label="Goal"><GoalBox ticket={t} editable={!busy} run={run} /></Section>
            <Section label="Progress"><Steps ticket={t} tracker={tracker} kind={kind} settings={settings} /></Section>
            {p.requirements.length > 0 && (
              <Section label="Requirements">
                <div className="rounded-[10px] border border-line bg-card">
                  <ul className="flex list-disc flex-col gap-1.5 py-2.5 pr-3 pl-7 leading-relaxed text-muted">{p.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  {p.outOfScope.length > 0 && (
                    <div className="border-t border-line px-3 py-2 text-caption text-dim">
                      <div className="mb-1 font-medium">Out of scope</div>
                      <ul className="list-disc pl-4">{p.outOfScope.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    </div>
                  )}
                  {!!(p.research?.notes.length || p.research?.assumptions.length) && (
                    <details className="border-t border-line px-3 py-2 text-caption text-dim">
                      <summary className="cursor-pointer font-medium select-none">Research: {p.research!.notes.length} fact{p.research!.notes.length === 1 ? '' : 's'}{p.research!.assumptions.length ? `, ${p.research!.assumptions.length} assumption${p.research!.assumptions.length === 1 ? '' : 's'}` : ''}</summary>
                      {p.research!.notes.length > 0 && <ul className="mt-1.5 list-disc pl-4 leading-relaxed">{p.research!.notes.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                      {p.research!.assumptions.length > 0 && (
                        <>
                          <div className="mt-2 mb-1 font-medium">Assumed</div>
                          <ul className="list-disc pl-4 leading-relaxed">{p.research!.assumptions.map((r, i) => <li key={i}>{r}</li>)}</ul>
                        </>
                      )}
                    </details>
                  )}
                  {!local && (
                    <div className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-caption text-dim">
                      {writes ? <><CloudArrowUp size={13} className="text-ok" />Written to the {tracker} ticket</> : <><Desktop size={13} />Kept in Cloth: ticket updates are off for this project</>}
                    </div>
                  )}
                </div>
              </Section>
            )}
          </>
        )}
        {local && t.comments && t.comments.length > 0 && (
          <Section label="Activity">
            <div className="flex flex-col rounded-[10px] border border-line bg-card">
              {t.comments.map((c, i) => (
                <div key={i} className={clsx('px-3 py-2', i > 0 && 'border-t border-line')}>
                  <div className="text-micro text-dim">{new Date(c.at).toLocaleString()}</div>
                  <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-muted">{c.text}</div>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </aside>
  )
}

/** The ticket's goal, editable while no agent is working on it. */
function GoalBox({ ticket: t, editable, run }: { ticket: BoardTicket; editable: boolean; run(fn: () => Promise<BoardOverview>, done?: string): Promise<void> }) {
  const goal = t.pipeline?.goal ?? goalOf(t.description)
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null)
    return (
      <div className="flex flex-col gap-2">
        <Textarea id={`goal-${t.id}`} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={async () => { await run(() => api.boards.setGoal(t.id, draft)); setDraft(null) }}>Save goal</Button>
        </div>
      </div>
    )
  return (
    <div className="group relative rounded-[10px] border border-line bg-card px-3 py-2.5 pr-9 leading-relaxed whitespace-pre-wrap text-muted">
      {goal || <span className="text-dim">No goal yet</span>}
      {editable && (
        <IconButton aria-label="Edit the goal" title="Edit the goal" className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => setDraft(goal)}>
          <PencilSimple size={13} />
        </IconButton>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-micro font-semibold tracking-wide text-dim uppercase">{label}</div>
      {children}
    </div>
  )
}

type StepState = 'done' | 'now' | 'wait' | 'you' | 'back' | 'merge' | 'stopped'

function Steps({ ticket: t, tracker, kind, settings }: { ticket: BoardTicket; tracker: string; kind: TrackerKind; settings: BoardProjectSettings }) {
  const p = t.pipeline!
  // Where the agents' notes go: "into the Plane ticket", or nowhere outside Cloth.
  const written = writesTo(kind, settings) && kind !== 'cloth'
  const into = written ? ` into the ${tracker} ticket` : ''
  const posted = written ? ` Posted as a comment in ${tracker}.` : ''
  const at = STAGES.indexOf(p.stage)
  const live = p.status === 'running'
  const state = (i: number): StepState => (at > i ? 'done' : at < i ? 'wait' : p.status === 'needsYou' ? 'you' : p.status === 'error' || p.status === 'paused' ? 'stopped' : live ? 'now' : 'wait')
  const worktree = p.branch ? <span className="font-mono text-caption">{p.branch}</span> : null
  const activity = live && p.activity ? ` · ${p.activity}` : ''
  const reqState: StepState = p.stage === 'req' && p.sendBacks > 0 && live ? 'now' : state(1)
  const revState: StepState = p.stage === 'req' && p.review?.verdict === 'revise' ? 'back' : state(2)
  const gitMode = p.local?.mode === 'copy' ? 'none' : (p.local?.mode ?? (p.pr ? 'pr' : settings.git))
  let pr: { body: ReactNode; state: StepState } = {
    body: gitMode === 'none' ? 'Leaves the changes uncommitted in their own copy of the code, for you to apply.' : gitMode === 'commit' ? 'Commits the changes to a local branch. Nothing is pushed.' : 'Pushes the branch and opens a pull request, linked on the ticket.',
    state: 'wait'
  }
  if (p.local) {
    const where = p.local.mode === 'commit' ? <>committed to <span className="font-mono text-caption">{p.local.branch}</span>, not pushed</> : <>uncommitted in its own copy of the code</>
    pr =
      p.status === 'done'
        ? { body: p.local.applied ? 'Applied to your code folder, uncommitted.' : 'Marked done.', state: 'done' }
        : { body: <>The changes are {where}. Apply them to {settings.repo ? <span className="font-mono text-caption">{settings.repo}</span> : 'your code folder'}, or mark the ticket done.</>, state: 'you' }
  } else if (p.pr) {
    const link = <button className="text-info hover:underline" onClick={() => void api.app.openExternal(p.pr!.url)}>PR #{p.pr.number}</button>
    pr =
      p.pr.merging && settings.autoMerge
        ? { body: <>{link} · the code review approved. GitHub merges it once checks pass, and {tracker} moves the ticket to merged.</>, state: 'merge' }
        : p.status === 'needsYou'
          ? { body: <>{link} opened and linked in {tracker}. {p.pr.checks === 'fail' ? 'Checks failed.' : 'Waiting for you to review and merge.'}</>, state: 'you' }
          : { body: <>{link} opened and linked in {tracker}. Checks are {p.pr.checks === 'pending' ? 'running' : p.pr.checks === 'pass' ? 'passing' : 'not set up'}.</>, state: 'now' }
  }
  return (
    <div className="rounded-[10px] border border-line bg-card px-3">
      <Step icon={<FileText size={14} />} color="text-skill" bg="bg-skill-soft" title="Requirements" who={agentName(p.agents, 'planner')} state={reqState}>
        {at > 1 ? `Wrote ${p.requirements.length} acceptance criteria${p.outOfScope.length ? ` and ${p.outOfScope.length} out-of-scope notes` : ''}${into}.` : at === 1 ? `Writing acceptance criteria from the title and goal${activity}.` : 'Starts when the ticket is handed to agents.'}
      </Step>
      <Step icon={<Eye size={14} />} color="text-warn" bg="bg-warn/15" title="Review" who={agentName(p.agents, 'reviewer')} state={revState}>
        {p.review?.verdict === 'revise' && p.stage === 'req' ? `Sent back to the planner: ${p.review.notes || 'no notes'}${posted}` : at > 2 ? `Requirements match the goal. Approved${written ? ` and posted in ${tracker}` : ''}.${settings.approveRequirements && at === 3 && p.status === 'needsYou' ? ' Waiting for you to check them before the build.' : ''}` : at === 2 ? `Checking each criterion against the goal${activity}.` : `Checks the requirements against the goal before any code is written${settings.approveRequirements ? ', then waits for you' : ''}.`}
      </Step>
      <Step icon={<Hammer size={14} />} color="text-agent" bg="bg-agent-soft" title="Build" who={agentName(p.agents, 'implementer')} state={state(3)}>
        {at > 3 ? <>Built{worktree ? <> on {worktree}</> : ' in its own worktree'}{p.files ? `, ${p.files} files changed` : ''}.</> : at === 3 ? <>Working in its own worktree{worktree ? <> on {worktree}</> : ''}{p.files ? ` · ${p.files} files changed` : ''}{activity}.</> : 'Works in its own worktree off your current branch, so your checkout isn\'t touched.'}
      </Step>
      <Step icon={gitMode === 'pr' ? <GitPullRequest size={14} /> : gitMode === 'commit' ? <GitBranch size={14} /> : <CheckCircle size={14} />} color="text-ok" bg="bg-ok/15" title={gitMode === 'pr' ? 'Pull request' : gitMode === 'commit' ? 'Local commit' : 'Your review'} state={pr.state}>{pr.body}</Step>
      {p.pr && (p.fixing || p.pr.checks === 'fail' || (p.pr.fixes ?? 0) > 0) && <FixStep pipeline={p} worktree={worktree} />}
    </div>
  )
}

function FixStep({ pipeline: p, worktree }: { pipeline: NonNullable<BoardTicket['pipeline']>; worktree: ReactNode }) {
  const pr = p.pr!
  const fixes = pr.fixes ?? 0
  const names = pr.failing?.length ? pr.failing.join(', ') : 'the failing checks'
  const pushed = fixes ? `Pushed ${fixes === 1 ? 'one fix' : `${fixes} fixes`} to the PR so far.` : ''
  let state: StepState
  let body: ReactNode
  if (p.fixing) {
    state = p.status === 'running' ? 'now' : p.status === 'paused' || p.status === 'error' ? 'stopped' : 'wait'
    body =
      p.status === 'running' ? <>Reading the logs and fixing {names} in a worktree{worktree ? <> on {worktree}</> : ''}, then pushing to the same PR{p.activity ? ` · ${p.activity}` : ''}.</>
      : p.status === 'queued' ? `Queued to fix ${names}.`
      : `Stopped while fixing ${names}.`
  } else if (pr.checks === 'fail') {
    state = 'you'
    body = `${names} failed. ${pushed} Fix checks has the agent read the logs and try again.`
  } else {
    state = 'done'
    body = pushed
  }
  return (
    <Step icon={<Wrench size={14} />} color="text-warn" bg="bg-warn/15" title="Fix checks" who={agentName(p.agents, 'implementer')} state={state}>
      {body}
    </Step>
  )
}

const agentName = (a: BoardAgents, k: keyof BoardAgents) => (a[k] ? undefined : { planner: 'Planner', reviewer: 'Code reviewer', implementer: 'Implementer' }[k])

function Step({ icon, color, bg, title, who, state, children }: { icon: ReactNode; color: string; bg: string; title: string; who?: string; state: StepState; children: ReactNode }) {
  const badge: Record<StepState, ReactNode> = {
    done: <Badge tone="ok"><Check size={11} />Done</Badge>,
    now: <Badge className={color}><CircleNotch size={11} className="animate-spin" />Working</Badge>,
    wait: <Badge tone="dim">Waiting</Badge>,
    you: <Badge tone="crimson">Your turn</Badge>,
    back: <Badge tone="warn"><ArrowUUpLeft size={11} />Sent back</Badge>,
    merge: <Badge tone="warn"><Flask size={11} />Auto-merge</Badge>,
    stopped: <Badge tone="danger">Stopped</Badge>
  }
  return (
    <div className="flex gap-2.5 border-line py-2.5 [&+&]:border-t">
      <div className={clsx('flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]', bg, color)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 font-semibold">
          {title}
          {who && <span className="font-normal text-dim">{who}</span>}
          <span className="ml-auto">{badge[state]}</span>
        </div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  )
}

function ManualTicket({ ticket: t, tracker, local, settings, agents, run }: { ticket: BoardTicket; tracker: string; local: boolean; settings: BoardProjectSettings; agents: Agent[]; run(fn: () => Promise<BoardOverview>, done?: string): Promise<void> }) {
  const [picks, setPicks] = useState<BoardAgents>(settings.agents)
  return (
    <>
      <div className="rounded-[10px] border border-line bg-card px-3 py-2.5 leading-relaxed text-muted">{local ? "Agents aren't on for this ticket yet." : `Agents aren't on for this ticket, so it stays in ${tracker} as written.`}</div>
      {local ? (
        <Section label="Goal"><GoalBox ticket={t} editable run={run} /></Section>
      ) : (
        t.description && <Section label="Description"><div className="max-h-48 overflow-y-auto rounded-[10px] border border-line bg-card px-3 py-2.5 leading-relaxed whitespace-pre-wrap text-muted">{t.description}</div></Section>
      )}
      <Section label="Agents">
        <AgentPicks value={picks} onChange={setPicks} agents={agents} />
      </Section>
      <div>
        <Button variant="primary" icon={<Robot size={15} />} onClick={() => run(() => api.boards.handToAgents(t.id, picks), 'Handed to agents')}>Hand to agents</Button>
        <div className="mt-1.5 text-caption text-dim">The description is the goal. The planner writes requirements from it and the title, then review and build follow.</div>
      </div>
    </>
  )
}

function AgentPicks({ value, onChange, agents }: { value: BoardAgents; onChange(v: BoardAgents): void; agents: Agent[] }) {
  const rows: [keyof BoardAgents, string, string][] = [
    ['planner', 'Requirements', 'bg-skill-dot'],
    ['reviewer', 'Review', 'bg-warn'],
    ['implementer', 'Build', 'bg-agent-dot']
  ]
  return (
    <div className="grid grid-cols-3 gap-2">
      {rows.map(([k, label, dot]) => (
        <label key={k} className="flex flex-col gap-1 rounded-lg border border-line bg-bg px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-micro text-dim"><span className={clsx('h-1.5 w-1.5 rounded-full', dot)} />{label}</span>
          <select value={value[k] ?? ''} onChange={(e) => onChange({ ...value, [k]: e.target.value || null })} className="w-full appearance-none truncate bg-transparent text-ui font-medium text-fg outline-none">
            <option value="">{{ planner: 'Planner', reviewer: 'Code reviewer', implementer: 'Implementer' }[k]}</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      ))}
    </div>
  )
}

// ---- Modals ----

function NewTicketModal({ open, onClose, projectName, tracker, local, settings, repoGit, agents, onCreate }: { open: boolean; onClose(): void; projectName: string; tracker: string; local: boolean; settings: BoardProjectSettings; repoGit: boolean | null; agents: Agent[]; onCreate(input: { title: string; goal: string; auto: boolean; agents: BoardAgents }): Promise<void> }) {
  const end = repoGit === false ? 'leaves the changes in a copy for you to apply' : settings.git === 'pr' ? 'opens a PR' : settings.git === 'commit' ? 'commits it to a local branch' : 'leaves the changes uncommitted for you to apply'
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [auto, setAuto] = useState(true)
  const [picks, setPicks] = useState<BoardAgents>(settings.agents)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setTitle('')
      setGoal('')
      setAuto(true)
      setPicks(settings.agents)
      setError(null)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (!title.trim()) return setError('Enter a title')
    if (auto && !goal.trim()) return setError('Enter a goal: the planner writes the requirements from it')
    setBusy(true)
    await onCreate({ title, goal, auto, agents: picks })
    setBusy(false)
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} title={`New ticket in ${projectName}`} width={560} footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Create ticket</Button></>}>
      <div className="flex flex-col gap-3.5">
        <Field label="Title"><Input id="nt-title" value={title} onChange={(e) => { setTitle(e.target.value); setError(null) }} placeholder="Show token count in the message box" autoFocus /></Field>
        <Field label="Goal" hint="What should be true when it's done. The planner writes the requirements from this and the title.">
          <Textarea id="nt-goal" rows={3} value={goal} onChange={(e) => { setGoal(e.target.value); setError(null) }} placeholder="People see how big their message is before they send it." />
        </Field>
        <div className="rounded-[10px] border border-line bg-card">
          <div className="flex items-start gap-3 p-3">
            <div className="flex-1">
              <div className="flex items-center gap-1.5 font-semibold"><Robot size={15} className="text-muted" />Hand to agents</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{auto ? `The planner writes requirements${local ? '' : ` into the ${tracker} ticket`}, the reviewer checks them against the goal${settings.approveRequirements ? ' and you approve them' : ''}, then the implementer builds it in its own copy of the code and ${end}.` : `The ticket is created${local ? '' : ` in ${tracker}`} as written. You can hand it to agents later.`}</div>
            </div>
            <Switch checked={auto} onChange={setAuto} ariaLabel="Hand to agents" />
          </div>
          <div className={clsx('px-3 pb-3 transition-opacity', !auto && 'pointer-events-none opacity-40')}><AgentPicks value={picks} onChange={setPicks} agents={agents} /></div>
        </div>
        <div className="flex items-center gap-1.5 text-caption text-dim">
          {repoGit === false || settings.git !== 'pr'
            ? repoGit === false || settings.git === 'none' ? 'Nothing is committed: the finished changes wait for you to apply them.' : 'Commits stay on this PC: nothing is pushed.'
            : settings.autoMerge ? <><Flask size={13} className="text-warn" />Auto-merge is on for this project: the PR merges once checks pass and the code review approves.</> : 'The PR waits for your review. Auto-merge is off for this project.'}
        </div>
        {!settings.repo && auto && <div className="text-caption text-warn">Pick this project's code folder in Project settings before the build step, or the ticket waits there.</div>}
        {error && <div className="text-caption text-danger-hi">{error}</div>}
      </div>
    </Modal>
  )
}

function SettingsModal({ open, onClose, overview: o, agents, onSave, onRename, onDelete }: { open: boolean; onClose(): void; overview: BoardOverview; agents: Agent[]; onSave(patch: Partial<BoardProjectSettings>): Promise<void>; onRename?(name: string): Promise<void>; onDelete?(): Promise<void> }) {
  const s = o.settings!
  const kind = o.connection!.kind
  const local = kind === 'cloth'
  const tracker = TRACKER_NAME[kind]
  const project = o.projects.find((p) => p.id === o.projectId)
  const custom = o.states.some((st) => st.custom)
  const [commands, setCommands] = useState(s.commands.join('\n'))
  const [name, setName] = useState(project?.name ?? '')
  useEffect(() => {
    if (open) {
      setCommands(s.commands.join('\n'))
      setName(project?.name ?? '')
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const noGit = o.repoGit === false
  const renamed = !!onRename && !!name.trim() && name.trim() !== project?.name
  const done = async () => {
    if (renamed) await onRename!(name.trim())
    await onSave({ commands: commands.split('\n') })
    onClose()
  }
  const pickRepo = async () => {
    const [dir] = await api.app.pickPaths({ directory: true, title: 'The code folder for this project' })
    if (dir) await onSave({ repo: dir })
  }
  const shared = useMemo(() => {
    const seen = new Map<string, number>()
    for (const st of MAPPED_STAGES) if (s.stateMap[st]) seen.set(s.stateMap[st]!, (seen.get(s.stateMap[st]!) ?? 0) + 1)
    return seen
  }, [s.stateMap])
  return (
    <Modal open={open} onClose={onClose} title={onRename ? `Edit ${project?.name ?? 'project'}` : `${project?.name ?? 'Project'} settings`} width={600} footer={
        <>
          {onDelete && <Button variant="ghost" className="mr-auto text-danger-hi" icon={<Trash size={14} />} onClick={() => void onDelete()}>Delete project</Button>}
          <Button variant="primary" onClick={() => void done()}>Done</Button>
        </>
      }>
      <div className="flex flex-col gap-5">
        {onRename && (
          <Field label="Name" hint={`Ticket keys stay ${project?.key ?? ''}-1, -2… after a rename.`}>
            <Input id="board-project-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && renamed) void onRename(name.trim()) }} />
          </Field>
        )}
        <Section label="Agents for each step">
          <AgentPicks value={s.agents} onChange={(agents) => void onSave({ agents })} agents={agents} />
          <div className="mt-1.5 text-caption text-dim">Pick any of your agents for a step, or leave Cloth's built-in Planner, Code reviewer and Implementer. New tickets start with these; a ticket can change them before it's handed to agents. The implementer edits files in its own copy of the code whatever the agent's own file access is.</div>
        </Section>
        <Section label="Code">
          <div className="flex items-center gap-2 rounded-[10px] border border-line bg-card p-3">
            <Folder size={16} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className={clsx('truncate font-mono text-caption', s.repo ? 'text-fg' : 'text-dim')}>{s.repo ?? 'No folder yet'}</div>
              <div className="text-caption text-dim">
                {!s.repo
                  ? 'Any folder with your code. Git is optional.'
                  : noGit
                    ? 'Not a git repository: the implementer works in a copy of this folder, and you apply its changes here when you say so.'
                    : `A git repository: the implementer works in a separate worktree.${s.git === 'pr' ? ' Pull requests go to its GitHub remote, through the GitHub CLI.' : ' Finished changes are applied here when you say so.'}`}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={pickRepo}>{s.repo ? 'Change' : 'Choose folder'}</Button>
          </div>
        </Section>
        <Section label="What agents may do">
          <div className="rounded-[10px] border border-line bg-card">
            <div className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">Allow PR creation and commits</div>
                {noGit ? <Badge tone="dim">Needs git</Badge> : <Segmented<GitMode> value={s.git} onChange={(git) => void onSave({ git })} items={GIT_MODES.map((m) => ({ value: m.value, label: m.label }))} />}
              </div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{noGit ? 'The code folder isn’t a git repository, so nothing is committed: finished changes wait in a copy for you to apply. Choose a git repository to commit or open pull requests.' : GIT_MODES.find((m) => m.value === s.git)?.hint}</div>
            </div>
            <SettingRow
              title={local ? 'Ticket sync and updates' : 'Allow ticket sync and updates'}
              hint={local ? 'Always on: a Cloth board is on this PC, so Cloth keeps its tickets up to date and nothing is sent anywhere.' : s.trackerUpdates ? `Cloth creates tickets in ${tracker}, moves them between the mapped states, writes the requirements into them and posts reviews as comments.` : `Cloth only reads ${tracker}. Requirements, reviews and progress stay in Cloth, tickets don't move, and new tickets are made in ${tracker} itself.`}
            >
              <Switch checked={local || s.trackerUpdates} disabled={local} onChange={(v) => void onSave({ trackerUpdates: v })} ariaLabel="Allow ticket sync and updates" />
            </SettingRow>
            <SettingRow title="Approve requirements before building" hint="After the reviewer approves them, the ticket waits for you to read the requirements. Nothing is built until you resume it.">
              <Switch checked={s.approveRequirements} onChange={(v) => void onSave({ approveRequirements: v })} ariaLabel="Approve requirements before building" />
            </SettingRow>
            <SettingRow title="Review rounds before asking you" hint="How many times the reviewer may send the requirements back before the ticket waits for you.">
              <Select className="w-20" value={String(s.reviewRounds)} onChange={(e) => void onSave({ reviewRounds: Number(e.target.value) })} aria-label="Review rounds before asking you">
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </SettingRow>
            {s.git === 'pr' && !noGit && (
              <SettingRow title="Automatic check fixes" hint="When a PR's checks fail, an agent reads the logs and pushes a fix this many times before the PR waits for you. 0 leaves every failure to you.">
                <Select className="w-20" value={String(s.checkFixes)} onChange={(e) => void onSave({ checkFixes: Number(e.target.value) })} aria-label="Automatic check fixes">
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </SettingRow>
            )}
          </div>
        </Section>
        {!local && (
          <Section label={`Stages to ${tracker} states`}>
            <div className="mb-2 text-caption text-dim">{custom ? 'This project has its own states, so the map uses them. Pick the closest state for each stage.' : `This project uses ${tracker}'s default states, so some stages share one. Add custom states in ${tracker} to give each stage its own.`}</div>
            <div className="rounded-[10px] border border-line bg-card">
              {MAPPED_STAGES.map((st: MappedStage, i) => {
                const state = o.states.find((x) => x.id === s.stateMap[st])
                return (
                  <div key={st} className={clsx('flex items-center gap-3 px-3 py-2', i > 0 && 'border-t border-line')}>
                    <span className="w-28 shrink-0">{stageLabel(st, s)}</span>
                    <ArrowRight size={13} className="shrink-0 text-dim" />
                    <Select className="w-48" value={s.stateMap[st] ?? ''} onChange={(e) => void onSave({ stateMap: { ...s.stateMap, [st]: e.target.value || null } })} aria-label={`${tracker} state for ${stageLabel(st, s)}`}>
                      <option value="">Don't move it</option>
                      {o.states.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </Select>
                    {state?.custom && <Badge tone="dim">Custom</Badge>}
                    {state && (shared.get(state.id) ?? 0) > 1 && <Badge tone="dim">Shared</Badge>}
                  </div>
                )
              })}
            </div>
            <div className="mt-1.5 text-caption text-dim">{s.trackerUpdates ? `Moving a ticket in ${tracker} moves it here too. A ticket moved back to the Requirements state waits there for you to resume it.` : `Ticket updates are off, so Cloth doesn't move tickets. The map only places tickets without agents in a column.`}</div>
          </Section>
        )}
        <Section label="Commands the implementer may run">
          <Textarea id="board-commands" rows={4} className="font-mono text-caption" value={commands} onChange={(e) => setCommands(e.target.value)} />
          <div className="mt-1.5 text-caption text-dim">One per line. Each allows that command with any arguments; anything else is refused.</div>
        </Section>
        {s.git === 'pr' && !noGit && (
          <Section label="Merging">
            <div className="flex items-start gap-3 rounded-[10px] border border-line bg-card p-3">
              <div className="flex-1">
                <div className="flex items-center gap-1.5 font-semibold">Auto-merge pull requests <Badge tone="warn"><Flask size={11} />Experimental</Badge></div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">The reviewer checks the PR's code against the requirements. If it approves, GitHub merges the PR once its checks pass. When this is off, every PR waits for you. Applies to this project only.</div>
              </div>
              <Switch checked={s.autoMerge} onChange={(v) => void onSave({ autoMerge: v })} ariaLabel="Auto-merge pull requests" />
            </div>
          </Section>
        )}
      </div>
    </Modal>
  )
}

/** A setting inside a card: title and hint on the left, its control on the right. */
function SettingRow({ title, hint, children }: { title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-t border-line p-3">
      <div className="flex-1">
        <div className="font-semibold">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{hint}</div>
      </div>
      {children}
    </div>
  )
}
