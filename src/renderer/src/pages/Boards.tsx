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
  X
} from '@phosphor-icons/react'
import { MAPPED_STAGES, STAGES, STAGE_LABELS, type BoardAgents, type BoardOverview, type BoardProjectSettings, type BoardTicket, type MappedStage, type Stage, type TicketPriority, type TrackerKind } from '@shared/boards'
import type { Agent } from '@shared/types'
import { api, useAsync, useEvent } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Badge, Button, Empty, Field, IconButton, Input, Modal, PageHeader, PageTitle, Segmented, Select, Spinner, Switch, Textarea } from '@/components/ui'

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

const TRACKER_NAME: Record<TrackerKind, string> = { plane: 'Plane', jira: 'Jira' }

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

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={<PageTitle>Boards</PageTitle>}
        actions={
          <>
            <TrackerMenu overview={o} onSwitch={() => setModal('connect')} onDisconnect={() => run(async () => (await api.boards.disconnect(), api.boards.overview()), `Disconnected ${tracker}`)} />
            {o.projects.length > 0 && (
              <ProjectMenu overview={o} tracker={tracker} onSelect={(id) => { setSelected(null); void run(() => api.boards.selectProject(id)) }} />
            )}
            <Button variant="outline" icon={<SlidersHorizontal size={15} />} onClick={() => setModal('settings')} disabled={!project}>Project settings</Button>
            <Button variant="primary" icon={<Plus size={15} weight="bold" />} onClick={() => setModal('new')} disabled={!project}>New ticket</Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2.5 text-caption text-dim">
            <Segmented<Filter> value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All' }, { value: 'agents', label: 'With agents' }, { value: 'you', label: `Waiting for you${o.tickets.some(waitingForYou) ? ` · ${o.tickets.filter(waitingForYou).length}` : ''}` }]} />
            <span className="ml-auto flex items-center gap-3">
              {o.settings?.autoMerge && <Badge tone="warn"><Flask size={11} />Auto-merge on</Badge>}
              {working > 0 && <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-agent" />{working} agent{working === 1 ? '' : 's'} working</span>}
              {o.error ? <span className="text-danger-hi" title={o.error}>Sync failed</span> : <span>{o.syncedAt ? `Synced ${ago(o.syncedAt)}` : 'Syncing…'}</span>}
              <IconButton aria-label="Sync now" title="Sync now" onClick={async () => { setSyncing(true); await run(() => api.boards.sync()); setSyncing(false) }}>
                <ArrowsClockwise size={14} className={clsx(syncing && 'animate-spin')} />
              </IconButton>
            </span>
          </div>
          {o.error && <div className="border-b border-line bg-danger-soft px-5 py-2 text-caption text-danger-hi">{o.error}</div>}
          {project && o.settings ? (
            <div className="grid min-h-0 flex-1 auto-cols-[minmax(200px,1fr)] grid-flow-col gap-3 overflow-auto px-5 pt-3.5 pb-5">
              {STAGES.map((st) => (
                <Column key={st} stage={st} tracker={tracker} stateName={o.states.find((s) => s.id === o.settings!.stateMap[st])?.name ?? 'not mapped'} tickets={shown.filter((t) => t.stage === st)} selected={selected} onSelect={setSelected} autoMerge={o.settings!.autoMerge} />
              ))}
            </div>
          ) : (
            <Empty icon={<Kanban size={20} />} title="No project yet">Create a project in {tracker}, then sync.</Empty>
          )}
        </div>
        {ticket && o.settings && (
          <TicketPanel
            key={ticket.id}
            ticket={ticket}
            tracker={tracker}
            settings={o.settings}
            agents={agents.data ?? []}
            onClose={() => setSelected(null)}
            run={run}
          />
        )}
      </div>
      {project && o.settings && (
        <>
          <NewTicketModal open={modal === 'new'} onClose={() => setModal(null)} projectName={project.name} tracker={tracker} settings={o.settings} agents={agents.data ?? []} onCreate={(input) => run(() => api.boards.createTicket(input), `Created in ${tracker}`)} />
          <SettingsModal open={modal === 'settings'} onClose={() => setModal(null)} overview={o} agents={agents.data ?? []} onSave={(patch) => run(() => api.boards.saveSettings(project.id, patch))} />
        </>
      )}
      <Modal open={modal === 'connect'} onClose={() => setModal(null)} title={`Switch from ${tracker}`} width={480}>
        <ConnectForm compact initialKind={conn.kind === 'plane' ? 'jira' : 'plane'} current={tracker} onConnected={(next) => { setData(next); setSelected(null); setModal(null) }} />
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

function ProjectMenu({ overview: o, tracker, onSelect }: { overview: BoardOverview; tracker: string; onSelect(id: string): void }) {
  const { open, setOpen, ref } = usePopover()
  const current = o.projects.find((p) => p.id === o.projectId)
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
          <div className={MENU_FOOTER}>
            <span>{o.projects.length} project{o.projects.length === 1 ? '' : 's'} in {tracker}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function TrackerMenu({ overview, onSwitch, onDisconnect }: { overview: BoardOverview; onSwitch(): void; onDisconnect(): void }) {
  const { open, setOpen, ref } = usePopover()
  const conn = overview.connection!
  const other: TrackerKind = conn.kind === 'plane' ? 'jira' : 'plane'
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} className={MENU_PILL}>
        <span className={clsx('h-1.5 w-1.5 rounded-full', overview.error ? 'bg-danger' : 'bg-ok')} />
        {TRACKER_NAME[conn.kind]}
        <CaretDown size={12} />
      </button>
      {open && (
        <div role="menu" className={MENU_PANEL}>
          {(['plane', 'jira'] as TrackerKind[]).map((k) => (
            <button key={k} role="menuitemradio" aria-checked={k === conn.kind} onClick={() => { setOpen(false); if (k !== conn.kind) onSwitch() }} className={MENU_ITEM}>
              <span className={clsx('flex h-[22px] w-[22px] items-center justify-center rounded-md text-micro font-semibold', k === 'plane' ? 'bg-info/15 text-info' : 'bg-agent/15 text-agent')}>{k === 'plane' ? 'P' : 'J'}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-fg">{TRACKER_NAME[k]}</span>
                <span className="block truncate text-caption text-dim">{k === conn.kind ? conn.label : 'Not connected'}</span>
              </span>
              {k === conn.kind && <Check size={14} className="text-ok" />}
            </button>
          ))}
          <div className={MENU_FOOTER}>
            <span>One tracker at a time.</span>
            <button className="hover:text-danger-hi" onClick={() => { setOpen(false); onDisconnect() }}>Disconnect</button>
          </div>
          <span className="sr-only">Switch to {TRACKER_NAME[other]}</span>
        </div>
      )}
    </div>
  )
}

function ConnectForm({ onConnected, compact, initialKind = 'plane', current }: { onConnected(o: BoardOverview): void; compact?: boolean; initialKind?: TrackerKind; current?: string }) {
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
      const o = await api.boards.connect({ kind, baseUrl, workspace, email, token })
      toast(`Connected ${TRACKER_NAME[kind]}`, 'ok')
      onConnected(o)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const form = (
    <form onSubmit={submit} className="flex w-full flex-col gap-3.5">
      <Segmented<TrackerKind> value={kind} onChange={(k) => { setKind(k); setError(null) }} items={[{ value: 'plane', label: 'Plane' }, { value: 'jira', label: 'Jira' }]} />
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
      {current && <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-caption text-muted">Connecting {TRACKER_NAME[kind]} disconnects {current}, and agents working on {current} tickets stop. The tickets stay in {current}.</div>}
      {error && <div className="text-caption text-danger-hi">{error}</div>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy}>Connect {TRACKER_NAME[kind]}</Button>
      </div>
    </form>
  )
  if (compact) return form
  return (
    <div className="flex flex-1 items-start justify-center overflow-y-auto p-8">
      <div className="w-full max-w-md">
        <div className="mb-1 text-section font-semibold">Connect a tracker</div>
        <p className="mb-5 text-ui text-dim">Pick a project and its tickets show here by agent stage. Agents write requirements into tickets, review them against the goal, and build them into pull requests.</p>
        {form}
      </div>
    </div>
  )
}

// ---- Board ----

function Column({ stage, tracker, stateName, tickets, selected, onSelect, autoMerge }: { stage: Stage; tracker: string; stateName: string; tickets: BoardTicket[]; selected: string | null; onSelect(id: string): void; autoMerge: boolean }) {
  const look = STAGE_LOOK[stage]
  return (
    <section aria-label={STAGE_LABELS[stage]} className="flex min-h-0 min-w-0 flex-col rounded-xl border border-line bg-card">
      <div className="border-b border-line px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5 font-semibold">
          <span className={look.color}>{look.icon}</span>
          {STAGE_LABELS[stage]}
          <span className="font-medium text-dim tabular-nums">{tickets.length}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-micro text-dim"><ArrowRight size={11} />{tracker}: {stateName}</div>
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
  if (p.status === 'queued') return <Badge tone="dim"><Robot size={11} />Queued</Badge>
  if (p.pr)
    return (
      <>
        <Badge>#{p.pr.number}</Badge>
        {p.pr.checks === 'pass' || p.pr.checks === 'none' ? <Badge tone="ok"><Check size={11} />{p.pr.checks === 'pass' ? 'Checks pass' : 'No checks'}</Badge> : p.pr.checks === 'fail' ? <Badge tone="danger">Checks failed</Badge> : <Badge tone="info"><CircleNotch size={11} className="animate-spin" />Checks running</Badge>}
        {p.pr.merging && autoMerge ? <Badge tone="warn"><Flask size={11} />Merging</Badge> : p.status === 'needsYou' ? <Badge tone="crimson">Your review</Badge> : null}
      </>
    )
  if (p.status === 'needsYou') return <Badge tone="crimson">Needs you</Badge>
  if (p.stage === 'req' && p.sendBacks > 0) return <Badge tone="warn"><ArrowUUpLeft size={11} />Sent back {p.sendBacks === 1 ? 'once' : `${p.sendBacks}×`}</Badge>
  if (p.stage === 'build' && p.files) return <Badge className="border-agent/30 bg-agent-soft text-agent">{p.files} file{p.files === 1 ? '' : 's'} changed</Badge>
  return <Badge className="border-skill-dot/30 bg-skill-soft text-skill"><CircleNotch size={11} className="animate-spin" /><span className="max-w-[150px] truncate">{p.activity ?? 'Working'}</span></Badge>
}

// ---- Ticket panel ----

function TicketPanel({ ticket: t, tracker, settings, agents, onClose, run }: { ticket: BoardTicket; tracker: string; settings: BoardProjectSettings; agents: Agent[]; onClose(): void; run(fn: () => Promise<BoardOverview>, done?: string): Promise<void> }) {
  const p = t.pipeline
  const open = () => void api.app.openExternal(t.url)
  return (
    <aside aria-label={t.key} className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="border-b border-line px-4 pt-3.5 pb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-caption text-dim">{t.key}</span>
          <Badge>{tracker}: {t.stateName || '—'}</Badge>
          <span className="ml-auto flex items-center gap-0.5">
            <Button size="sm" variant="ghost" icon={<ArrowSquareOut size={14} />} onClick={open}>Open in {tracker}</Button>
            <IconButton aria-label="Close" onClick={onClose}><X size={15} /></IconButton>
          </span>
        </div>
        <div className="mt-1.5 mb-2 text-section leading-snug font-semibold tracking-tight [overflow-wrap:anywhere]">{t.title}</div>
        {p && (
          <div className="flex flex-wrap gap-1.5">
            {p.status === 'running' || p.status === 'queued' ? (
              <Button size="sm" icon={<Pause size={14} />} onClick={() => run(() => api.boards.pause(t.id))}>Pause agents</Button>
            ) : p.stage !== 'pr' || p.status === 'error' ? (
              <Button size="sm" icon={<Play size={14} />} onClick={() => run(() => api.boards.resume(t.id))}>{p.stage === 'pr' ? 'Watch the PR again' : 'Resume'}</Button>
            ) : null}
            {p.pr && <Button size="sm" variant={p.status === 'needsYou' ? 'primary' : 'outline'} icon={<GitMerge size={14} />} onClick={() => void api.app.openExternal(p.pr!.url)}>{p.pr.merging ? `View PR #${p.pr.number}` : `Review PR #${p.pr.number}`}</Button>}
            {p.status !== 'running' && <Button size="sm" variant="ghost" onClick={() => run(() => api.boards.stopAgents(t.id), 'Agents are off for this ticket')}>Take agents off</Button>}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-3.5 pb-5 [overflow-wrap:anywhere]">
        {!p ? (
          <ManualTicket ticket={t} tracker={tracker} settings={settings} agents={agents} run={run} />
        ) : (
          <>
            {p.note && <div className={clsx('rounded-md border px-3 py-2 text-caption leading-relaxed', p.status === 'error' ? 'border-danger-line bg-danger-soft text-danger-hi' : 'border-crimson-line bg-crimson-soft text-crimson-text')}>{p.note}</div>}
            <Section label="Goal"><div className="rounded-[10px] border border-line bg-card px-3 py-2.5 leading-relaxed text-muted">{p.goal}</div></Section>
            <Section label="Progress"><Steps ticket={t} tracker={tracker} settings={settings} /></Section>
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
                  <div className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-caption text-dim"><CloudArrowUp size={13} className="text-ok" />Written to the {tracker} ticket</div>
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
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

function Steps({ ticket: t, tracker, settings }: { ticket: BoardTicket; tracker: string; settings: BoardProjectSettings }) {
  const p = t.pipeline!
  const at = STAGES.indexOf(p.stage)
  const live = p.status === 'running'
  const state = (i: number): StepState => (at > i ? 'done' : at < i ? 'wait' : p.status === 'needsYou' ? 'you' : p.status === 'error' || p.status === 'paused' ? 'stopped' : live ? 'now' : 'wait')
  const worktree = p.branch ? <span className="font-mono text-caption">{p.branch}</span> : null
  const activity = live && p.activity ? ` · ${p.activity}` : ''
  const reqState: StepState = p.stage === 'req' && p.sendBacks > 0 && live ? 'now' : state(1)
  const revState: StepState = p.stage === 'req' && p.review?.verdict === 'revise' ? 'back' : state(2)
  let pr: { body: ReactNode; state: StepState } = { body: 'Pushes the branch and opens a pull request, linked on the ticket.', state: 'wait' }
  if (p.pr) {
    const link = <button className="text-info hover:underline" onClick={() => void api.app.openExternal(p.pr!.url)}>PR #{p.pr.number}</button>
    pr =
      p.pr.merging && settings.autoMerge
        ? { body: <>{link} · the code review approved. GitHub merges it once checks pass, and {tracker} moves the ticket to {STAGE_LABELS.merged.toLowerCase()}.</>, state: 'merge' }
        : p.status === 'needsYou'
          ? { body: <>{link} opened and linked in {tracker}. {p.pr.checks === 'fail' ? 'Checks failed.' : 'Waiting for you to review and merge.'}</>, state: 'you' }
          : { body: <>{link} opened and linked in {tracker}. Checks are {p.pr.checks === 'pending' ? 'running' : p.pr.checks === 'pass' ? 'passing' : 'not set up'}.</>, state: 'now' }
  }
  return (
    <div className="rounded-[10px] border border-line bg-card px-3">
      <Step icon={<FileText size={14} />} color="text-skill" bg="bg-skill-soft" title="Requirements" who={agentName(p.agents, 'planner')} state={reqState}>
        {at > 1 ? `Wrote ${p.requirements.length} acceptance criteria${p.outOfScope.length ? ` and ${p.outOfScope.length} out-of-scope notes` : ''} into the ${tracker} ticket.` : at === 1 ? `Writing acceptance criteria from the title and goal${activity}.` : 'Starts when the ticket is handed to agents.'}
      </Step>
      <Step icon={<Eye size={14} />} color="text-warn" bg="bg-warn/15" title="Review" who={agentName(p.agents, 'reviewer')} state={revState}>
        {p.review?.verdict === 'revise' && p.stage === 'req' ? `Sent back to the planner: ${p.review.notes || 'no notes'} Posted as a comment in ${tracker}.` : at > 2 ? `Requirements match the goal. Approved and posted in ${tracker}.` : at === 2 ? `Checking each criterion against the goal${activity}.` : 'Checks the requirements against the goal before any code is written.'}
      </Step>
      <Step icon={<Hammer size={14} />} color="text-agent" bg="bg-agent-soft" title="Build" who={agentName(p.agents, 'implementer')} state={state(3)}>
        {at > 3 ? <>Built on {worktree}{p.files ? `, ${p.files} files changed` : ''}.</> : at === 3 ? <>Working in its own worktree{worktree ? <> on {worktree}</> : ''}{p.files ? ` · ${p.files} files changed` : ''}{activity}.</> : 'Works in its own worktree off your current branch, so your checkout isn\'t touched.'}
      </Step>
      <Step icon={<GitPullRequest size={14} />} color="text-ok" bg="bg-ok/15" title="Pull request" state={pr.state}>{pr.body}</Step>
    </div>
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

function ManualTicket({ ticket: t, tracker, settings, agents, run }: { ticket: BoardTicket; tracker: string; settings: BoardProjectSettings; agents: Agent[]; run(fn: () => Promise<BoardOverview>, done?: string): Promise<void> }) {
  const [picks, setPicks] = useState<BoardAgents>(settings.agents)
  return (
    <>
      <div className="rounded-[10px] border border-line bg-card px-3 py-2.5 leading-relaxed text-muted">Agents aren't on for this ticket, so it stays in {tracker} as written.</div>
      {t.description && <Section label="Description"><div className="max-h-48 overflow-y-auto rounded-[10px] border border-line bg-card px-3 py-2.5 leading-relaxed whitespace-pre-wrap text-muted">{t.description}</div></Section>}
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
    ['implementer', 'Build and PR', 'bg-agent-dot']
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

function NewTicketModal({ open, onClose, projectName, tracker, settings, agents, onCreate }: { open: boolean; onClose(): void; projectName: string; tracker: string; settings: BoardProjectSettings; agents: Agent[]; onCreate(input: { title: string; goal: string; auto: boolean; agents: BoardAgents }): Promise<void> }) {
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
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{auto ? `The planner writes requirements into the ${tracker} ticket, the reviewer checks them against the goal, then the implementer builds it in a worktree and opens a PR.` : `The ticket is created in ${tracker} as written. You can hand it to agents later.`}</div>
            </div>
            <Switch checked={auto} onChange={setAuto} ariaLabel="Hand to agents" />
          </div>
          <div className={clsx('px-3 pb-3 transition-opacity', !auto && 'pointer-events-none opacity-40')}><AgentPicks value={picks} onChange={setPicks} agents={agents} /></div>
        </div>
        <div className="flex items-center gap-1.5 text-caption text-dim">
          {settings.autoMerge ? <><Flask size={13} className="text-warn" />Auto-merge is on for this project: the PR merges once checks pass and the code review approves.</> : 'The PR waits for your review. Auto-merge is off for this project.'}
        </div>
        {!settings.repo && auto && <div className="text-caption text-warn">Pick this project's code folder in Project settings before the build step, or the ticket waits there.</div>}
        {error && <div className="text-caption text-danger-hi">{error}</div>}
      </div>
    </Modal>
  )
}

function SettingsModal({ open, onClose, overview: o, agents, onSave }: { open: boolean; onClose(): void; overview: BoardOverview; agents: Agent[]; onSave(patch: Partial<BoardProjectSettings>): Promise<void> }) {
  const s = o.settings!
  const tracker = TRACKER_NAME[o.connection!.kind]
  const project = o.projects.find((p) => p.id === o.projectId)
  const custom = o.states.some((st) => st.custom)
  const [commands, setCommands] = useState(s.commands.join('\n'))
  useEffect(() => {
    if (open) setCommands(s.commands.join('\n'))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
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
    <Modal open={open} onClose={onClose} title={`${project?.name ?? 'Project'} settings`} width={600} footer={<Button variant="primary" onClick={async () => { await onSave({ commands: commands.split('\n') }); onClose() }}>Done</Button>}>
      <div className="flex flex-col gap-5">
        <Section label="Code">
          <div className="flex items-center gap-2 rounded-[10px] border border-line bg-card p-3">
            <Folder size={16} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className={clsx('truncate font-mono text-caption', s.repo ? 'text-fg' : 'text-dim')}>{s.repo ?? 'No folder yet'}</div>
              <div className="text-caption text-dim">The git checkout the implementer branches from. Pull requests go to its GitHub remote, through the GitHub CLI.</div>
            </div>
            <Button size="sm" variant="outline" onClick={pickRepo}>{s.repo ? 'Change' : 'Choose folder'}</Button>
          </div>
        </Section>
        <Section label={`Stages to ${tracker} states`}>
          <div className="mb-2 text-caption text-dim">{custom ? 'This project has its own states, so the map uses them. Pick the closest state for each stage.' : `This project uses ${tracker}'s default states, so some stages share one. Add custom states in ${tracker} to give each stage its own.`}</div>
          <div className="rounded-[10px] border border-line bg-card">
            {MAPPED_STAGES.map((st: MappedStage, i) => {
              const state = o.states.find((x) => x.id === s.stateMap[st])
              return (
                <div key={st} className={clsx('flex items-center gap-3 px-3 py-2', i > 0 && 'border-t border-line')}>
                  <span className="w-28 shrink-0">{STAGE_LABELS[st]}</span>
                  <ArrowRight size={13} className="shrink-0 text-dim" />
                  <Select className="w-48" value={s.stateMap[st] ?? ''} onChange={(e) => void onSave({ stateMap: { ...s.stateMap, [st]: e.target.value || null } })} aria-label={`${tracker} state for ${STAGE_LABELS[st]}`}>
                    <option value="">Don't move it</option>
                    {o.states.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                  {state?.custom && <Badge tone="dim">Custom</Badge>}
                  {state && (shared.get(state.id) ?? 0) > 1 && <Badge tone="dim">Shared</Badge>}
                </div>
              )
            })}
          </div>
          <div className="mt-1.5 text-caption text-dim">Moving a ticket in {tracker} moves it here too. A ticket moved back to the Requirements state starts again there.</div>
        </Section>
        <Section label="Default agents">
          <AgentPicks value={s.agents} onChange={(agents) => void onSave({ agents })} agents={agents} />
          <div className="mt-1.5 text-caption text-dim">Planner, Code reviewer and Implementer are Cloth's built-in instructions; pick a saved agent to use its own. The implementer edits files in its own worktree whatever the agent's own file access is.</div>
        </Section>
        <Section label="Commands the implementer may run">
          <Textarea id="board-commands" rows={4} className="font-mono text-caption" value={commands} onChange={(e) => setCommands(e.target.value)} />
          <div className="mt-1.5 text-caption text-dim">One per line. Each allows that command with any arguments; anything else is refused.</div>
        </Section>
        <Section label="Merging">
          <div className="flex items-start gap-3 rounded-[10px] border border-line bg-card p-3">
            <div className="flex-1">
              <div className="flex items-center gap-1.5 font-semibold">Auto-merge pull requests <Badge tone="warn"><Flask size={11} />Experimental</Badge></div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">The reviewer checks the PR's code against the requirements. If it approves, GitHub merges the PR once its checks pass. When this is off, every PR waits for you. Applies to this project only.</div>
            </div>
            <Switch checked={s.autoMerge} onChange={(v) => void onSave({ autoMerge: v })} ariaLabel="Auto-merge pull requests" />
          </div>
        </Section>
      </div>
    </Modal>
  )
}
