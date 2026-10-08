import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import cronstrue from 'cronstrue'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node
} from '@xyflow/react'
import { ArrowLeft, ListChecks, MoreHorizontal, Eye, RotateCcw, Wand2, Check, Clock, Copy, ExternalLink, File, FileText, FolderOpen, History, LayoutDashboard, Maximize2, Package, Play, Plus, Save, Sparkles, Square, Trash2, X } from 'lucide-react'
import type { Workflow, WorkflowGraph, WorkflowNodeType, WorkflowOverview, WorkflowRun, WorkflowRunSummary, WorkflowTemplate, WorkflowVersion, WorkflowVersionSource } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { duration, preview, pretty, timeAgo } from '@/lib/format'
import { Badge, Button, Dot, IconButton, Input, ListItem, Modal, Segmented, Switch, Tabs, Textarea, confirmAction } from '@/components/ui'
import { refocus } from '@/components/Inspector'
import { Markdown } from '@/components/Markdown'
import { layeredLayout } from '@shared/layout'
import { Editor } from '@/components/Editor'
import { META, NODE_TYPES, nodeTypes, type FlowNodeData } from './workflow/nodes'
import { Inspector } from './workflow/Inspector'
import { AssembleModal } from './workflow/AssembleModal'
import { ExportModal } from './workflow/ExportModal'
import { BottomSheet } from '@/components/BottomSheet'
import { isMobile } from '@/lib/platform'

type Opened = { id: string; runId?: string; fix?: boolean } | null

const TEMPLATE_CARDS: { id: WorkflowTemplate; label: string; desc: string }[] = [
  { id: 'rag-digest', label: 'Knowledge digest', desc: 'Search your knowledge, then summarise what it finds, or say nothing matched.' },
  { id: 'watch-page', label: 'Watch a web page', desc: 'Fetch a page on a schedule and report what it says about the thing you care about.' },
  { id: 'summarise-folder', label: 'Summarise a folder', desc: "An agent reads the flow's folder and answers your question about it." },
  { id: 'blank', label: 'Start simple', desc: 'Start → one model call → output, to build on.' }
]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const when = (t: number) => {
  const d = new Date(t)
  const today = new Date()
  const tomorrow = new Date(Date.now() + 86_400_000)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  return `${same(d, today) ? 'today' : same(d, tomorrow) ? 'tomorrow' : dayFmt.format(d)} ${clockFmt.format(d)}`
}
const describeCron = (cron: string) => {
  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true, verbose: false })
  } catch {
    return cron
  }
}
const until = (t: number) => {
  const m = Math.round((t - Date.now()) / 60_000)
  if (m < 1) return 'in under a minute'
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  return h < 24 ? `in ${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `on ${when(t)}`
}

/**
 * What runs next and whether it worked: a timeline of scheduled runs, each flow as a card with a picture
 * of its graph and its last ten runs, failures up front with "Fix with AI", and recent runs across flows.
 * Opening a flow shows the canvas editor.
 */
export function WorkflowsPage() {
  const [flows, setFlows] = useState<Workflow[]>([])
  const [overview, setOverview] = useState<WorkflowOverview | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [opened, setOpened] = useState<Opened>(null)
  const [creating, setCreating] = useState<WorkflowTemplate | null>(null)
  const [assembling, setAssembling] = useState(false)

  const load = async (open?: string) => {
    const [list, o] = await Promise.all([api.workflows.list(), api.workflows.overview().catch(() => null)])
    setFlows(list)
    setOverview(o)
    setLoaded(true)
    if (open) setOpened({ id: open })
  }
  useEffect(() => {
    void load()
  }, [])
  useEvent('workflow', (e) => {
    if (e.type === 'schedule') setFlows((fs) => fs.map((f) => (f.id === e.workflowId ? { ...f, nextRunAt: e.nextRunAt } : f)))
    // A run finished somewhere: refresh the history (cheap; only while the overview shows).
    if (e.type === 'run' && e.run.status !== 'running' && !opened) void api.workflows.overview().then(setOverview, () => undefined)
  })

  const active = opened ? flows.find((f) => f.id === opened.id) : undefined
  if (active)
    return (
      <ReactFlowProvider key={active.id}>
        <Editor2
          workflow={active}
          initialRunId={opened?.runId}
          initialFix={opened?.fix}
          onBack={() => {
            const id = active.id
            setOpened(null)
            void load()
            refocus(id)
          }}
          onSaved={(w) => setFlows((fs) => fs.map((f) => (f.id === w.id ? w : f)))}
          onDeleted={() => (setOpened(null), void load())}
          onDuplicated={(id) => void load(id)}
        />
      </ReactFlowProvider>
    )

  const byId = new Map(overview?.flows.map((f) => [f.id, f]) ?? [])
  const scheduled = flows.filter((f) => f.cronEnabled && f.cron)
  const summary = flows.length ? `${plural(flows.length, 'flow')}, ${scheduled.length ? `${scheduled.length} on a schedule` : 'none on a schedule'}` : 'No flows yet'
  // Failing flows first, then the most recently changed.
  const ordered = [...flows].sort((a, b) => Number(byId.get(b.id)?.runs[0]?.status === 'error') - Number(byId.get(a.id)?.runs[0]?.status === 'error') || b.updatedAt - a.updatedAt)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-5 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <h1 className="text-[18px] font-semibold tracking-tight">Flows</h1>
            <p className="mt-0.5 text-[12.5px] text-dim">{loaded ? summary : '…'}</p>
          </div>
          <Button icon={<Sparkles size={13} />} onClick={() => setAssembling(true)}>
            Assemble with AI
          </Button>
          <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating('blank')}>
            New flow
          </Button>
        </div>

        {loaded && !flows.length ? (
          <section aria-label="Start from a template" className="grid gap-3">
            <p className="max-w-[70ch] text-[13px] text-muted">A flow runs steps one after another: model calls, agents, knowledge search, web requests and code, on demand or on a schedule. Start from one of these, or describe what you want and let AI assemble it.</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
              {TEMPLATE_CARDS.map((t) => (
                <button key={t.id} onClick={() => setCreating(t.id)} className="grid content-start gap-1.5 rounded-[12px] border border-line bg-elev p-4 text-left hover:border-line-strong hover:bg-elev-2">
                  <span className="text-[13.5px] font-semibold">{t.label}</span>
                  <span className="text-[12.5px] text-muted">{t.desc}</span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_290px] gap-5 max-[960px]:grid-cols-1">
            <div className="grid min-w-0 content-start gap-5">
              <Upcoming flows={flows} overview={overview} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-dim">
                <span>Last runs, oldest to newest:</span>
                <span className="flex items-end gap-1">
                  <i className="inline-block h-3 w-[7px] rounded-[2px] bg-ok" aria-hidden="true" /> passed
                </span>
                <span className="flex items-end gap-1">
                  <i className="inline-block h-1.5 w-[7px] rounded-[2px] bg-crimson" aria-hidden="true" /> failed (short)
                </span>
                <span className="flex items-end gap-1">
                  <i className="inline-block h-3 w-[7px] rounded-[2px] border-[1.5px] border-info" aria-hidden="true" /> running (hollow)
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
                {ordered.map((f) => (
                  <FlowCard key={f.id} flow={f} info={byId.get(f.id)} onOpen={(o) => setOpened({ id: f.id, ...o })} />
                ))}
              </div>
            </div>
            <RecentRuns runs={overview?.recent ?? []} flows={flows} onOpen={(id, runId) => setOpened({ id, runId })} />
          </div>
        )}
      </div>
      <NewWorkflow template={creating} onClose={() => setCreating(null)} onCreated={(id) => void load(id)} />
      <AssembleModal
        open={assembling}
        mode="new"
        onClose={() => setAssembling(false)}
        onGraph={async (graph) => {
          const wf = await attempt(() => api.workflows.createFromGraph(graph), `Assembled “${graph.name}”`)
          if (wf) await load(wf.id)
        }}
      />
    </div>
  )
}

/** Scheduled runs over the next two days or the week, with a line for now; a dated list on narrow screens and for screen readers. */
function Upcoming({ flows, overview }: { flows: Workflow[]; overview: WorkflowOverview | null }) {
  const [span, setSpan] = useState<'2d' | 'week'>('2d')
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const days = span === '2d' ? 2 : 7
  const end = start.getTime() + days * 86_400_000
  const names = new Map(flows.map((f) => [f.id, f.name]))
  const events = (overview?.flows ?? [])
    .flatMap((f) => f.upcoming.map((at) => ({ at, id: f.id, name: names.get(f.id) ?? 'Flow' })))
    .filter((e) => e.at < end)
    .sort((a, b) => a.at - b.at)
  const pos = (t: number) => ((t - start.getTime()) / (end - start.getTime())) * 100
  const ticks = Array.from({ length: days * (span === '2d' ? 2 : 1) + 1 }, (_, i) => start.getTime() + i * (span === '2d' ? 12 : 24) * 3_600_000)
  return (
    <section aria-label="Coming up" className="rounded-[12px] border border-line bg-elev px-4 pb-4 pt-3">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-semibold">Coming up</h2>
        <span className="text-[12px] text-dim">{span === '2d' ? 'today and tomorrow' : 'this week'}</span>
        <span className="flex-1" />
        <Segmented
          value={span}
          onChange={setSpan}
          items={[
            { value: '2d', label: '2 days' },
            { value: 'week', label: 'Week' }
          ]}
        />
      </div>
      {!events.length ? (
        <p className="mt-3 text-[12.5px] text-dim">Nothing scheduled{span === '2d' ? ' for today or tomorrow' : ' this week'}. Give a flow a schedule in its editor to run it automatically.</p>
      ) : (
        <>
          <div className="relative mt-6 h-[78px] max-[700px]:hidden" aria-hidden="true">
            <span className="absolute inset-x-0 top-[5px] border-t border-line-strong" />
            <span className="absolute top-[-6px] h-[66px] w-px bg-crimson" style={{ left: `${pos(Date.now())}%` }} />
            {events.slice(0, 40).map((e, i) => (
              <span key={`${e.id}-${e.at}`} className="absolute -translate-x-1/2" style={{ left: `${pos(e.at)}%`, top: 0 }} title={`${e.name}, ${when(e.at)}`}>
                <i className="block h-[11px] w-[11px] rounded-full border-2 border-elev bg-muted" />
                <span className={clsx('absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[11.5px] text-muted', i % 2 ? 'top-[34px]' : 'top-[16px]')}>{e.name}</span>
              </span>
            ))}
            {ticks.map((t, i) => (
              <span
                key={t}
                className={clsx('absolute top-[58px] whitespace-nowrap text-[11.5px] tabular-nums text-dim', i === 0 ? '' : i === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2')}
                style={{ left: `${pos(t)}%` }}
              >
                {span === '2d' ? (i % 2 ? '12:00' : dayFmt.format(new Date(t))) : dayFmt.format(new Date(t))}
              </span>
            ))}
          </div>
          <ol className="sr-only max-[700px]:not-sr-only max-[700px]:mt-3 max-[700px]:grid max-[700px]:gap-1">
            {events.slice(0, 12).map((e) => (
              <li key={`${e.id}-${e.at}`} className="text-[12.5px]">
                <span className="tabular-nums text-dim">{when(e.at)}</span> {e.name}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

/** A small picture of the flow's graph, fitted to the card. */
function GraphThumb({ flow }: { flow: Workflow }) {
  if (!flow.nodes.length) return <div className="h-[74px]" />
  const W = 240
  const H = 74
  const xs = flow.nodes.map((n) => n.position.x)
  const ys = flow.nodes.map((n) => n.position.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(1, Math.max(...xs) - minX)
  const spanY = Math.max(1, Math.max(...ys) - minY)
  const bw = Math.min(40, (W - 24) / Math.max(1, flow.nodes.length) + 8)
  const bh = 14
  const sx = (W - 24 - bw) / spanX
  const sy = (H - 20 - bh) / spanY
  const s = Math.min(sx, spanY > 1 ? sy * 3 : sx)
  const at = new Map(flow.nodes.map((n) => [n.id, { x: 12 + (n.position.x - minX) * sx, y: spanY > 1 ? 10 + (n.position.y - minY) * Math.min(sy, s) : (H - bh) / 2 }]))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[74px] w-full" aria-hidden="true">
      {flow.edges.map((e) => {
        const a = at.get(e.source)
        const b = at.get(e.target)
        if (!a || !b) return null
        return <path key={e.id} d={`M${a.x + bw} ${a.y + bh / 2} C${(a.x + bw + b.x) / 2} ${a.y + bh / 2} ${(a.x + bw + b.x) / 2} ${b.y + bh / 2} ${b.x} ${b.y + bh / 2}`} fill="none" stroke="var(--color-info)" strokeOpacity="0.6" strokeWidth="1.2" />
      })}
      {flow.nodes.map((n) => {
        const p = at.get(n.id)!
        return <rect key={n.id} x={p.x} y={p.y} width={bw} height={bh} rx="4" fill="var(--color-elev-2)" stroke="var(--color-line-strong)" />
      })}
    </svg>
  )
}

function RunBars({ runs }: { runs: WorkflowRunSummary[] }) {
  const ordered = [...runs].reverse()
  const passed = runs.filter((r) => r.status === 'ok').length
  const failed = runs.filter((r) => r.status === 'error').length
  const running = runs.filter((r) => r.status === 'running').length
  const label = runs.length ? `Last ${plural(runs.length, 'run')}: ${[passed && `${passed} passed`, failed && `${failed} failed`, running && `${running} running`].filter(Boolean).join(', ')}${runs[0]?.status === 'error' ? ', including the latest' : ''}` : 'No runs yet'
  if (!runs.length) return <span className="text-[12px] text-dim">No runs yet</span>
  return (
    <span role="img" aria-label={label} className="flex h-4 items-end gap-[3px]">
      {ordered.map((r) => (
        <i key={r.id} className={clsx('inline-block w-2 rounded-[2px]', r.status === 'ok' ? 'h-4 bg-ok' : r.status === 'error' ? 'h-[7px] bg-crimson' : 'h-4 border-[1.5px] border-info')} title={`${r.status === 'ok' ? 'Passed' : r.status === 'error' ? 'Failed' : 'Running'}, ${when(r.startedAt)}`} />
      ))}
    </span>
  )
}

function FlowCard({ flow, info, onOpen }: { flow: Workflow; info?: WorkflowOverview['flows'][number]; onOpen(o?: { runId?: string; fix?: boolean }): void }) {
  const last = info?.runs[0]
  const failing = last?.status === 'error'
  return (
    <div className={clsx('grid min-w-0 grid-cols-[minmax(0,1fr)] content-start overflow-hidden rounded-[12px] border bg-elev', failing ? 'border-crimson-line' : 'border-line')}>
      <button data-focus-key={flow.id} onClick={() => onOpen()} className="grid min-w-0 grid-cols-[minmax(0,1fr)] text-left hover:bg-elev-2 focus-visible:ring-2 focus-visible:ring-crimson-line">
        <span className="border-b border-line bg-panel">
          <GraphThumb flow={flow} />
        </span>
        <span className="grid gap-1.5 px-3.5 py-3">
          <span className="line-clamp-2 text-[13.5px] font-semibold">{flow.name}</span>
          <span className="text-[12px] text-dim">
            {flow.cronEnabled && flow.cron ? (
              <>
                {describeCron(flow.cron)}
                <br />
                {flow.nextRunAt ? `Next: ${until(flow.nextRunAt)}` : 'Not scheduled yet'}
              </>
            ) : (
              <>
                On demand
                <br />
                {last ? `Last run: ${timeAgo(last.startedAt)}` : 'Never run'}
              </>
            )}
          </span>
          <RunBars runs={info?.runs ?? []} />
        </span>
      </button>
      {failing && (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate text-crimson-hi" title={last.error ?? undefined}>
            Failed{last.failedStep ? ` at ${last.failedStep}` : ''}: {last.error ?? 'see the run'}
          </span>
          <Button size="sm" icon={<Wand2 size={12} />} onClick={() => onOpen({ runId: last.id, fix: true })}>
            Fix with AI
          </Button>
        </div>
      )}
    </div>
  )
}

function RecentRuns({ runs, flows, onOpen }: { runs: WorkflowRunSummary[]; flows: Workflow[]; onOpen(id: string, runId: string): void }) {
  const names = new Map(flows.map((f) => [f.id, f.name]))
  return (
    <section aria-label="Recent runs" className="grid content-start gap-1 self-start rounded-[12px] border border-line bg-elev py-2">
      <h2 className="px-3.5 pb-1 pt-1 text-[13px] font-semibold">Recent runs</h2>
      {runs.map((r) => (
        <button key={r.id} onClick={() => onOpen(r.workflowId, r.id)} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-3.5 py-1.5 text-left text-[12.5px] hover:bg-elev-2">
          <span className={clsx('mt-[5px] h-2 w-2 rounded-full', r.status === 'ok' ? 'bg-ok' : r.status === 'error' ? 'bg-crimson' : 'bg-info')} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate">{names.get(r.workflowId) ?? 'Deleted flow'}</span>
            <span className={clsx('block truncate text-[12px]', r.status === 'error' ? 'text-crimson-hi' : 'text-dim')}>
              {r.status === 'error' ? `Failed${r.failedStep ? ` at ${r.failedStep}` : ''}` : r.status === 'running' ? 'Running' : `Passed, ${plural(r.steps, 'step')}${r.durationMs !== null ? ` in ${duration(r.durationMs)}` : ''}`}
            </span>
          </span>
          <span className="text-[12px] tabular-nums text-dim">{timeAgo(r.startedAt)}</span>
        </button>
      ))}
      {!runs.length && <p className="px-3.5 py-2 text-[12.5px] text-dim">No runs yet. Run a flow from its editor, or give it a schedule.</p>}
    </section>
  )
}

function NewWorkflow({ template, onClose, onCreated }: { template: WorkflowTemplate | null; onClose(): void; onCreated(id: string): void }) {
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<WorkflowTemplate>('blank')
  useEffect(() => {
    if (template) {
      setChosen(template)
      setName(TEMPLATE_CARDS.find((t) => t.id === template && t.id !== 'blank')?.label ?? '')
    }
  }, [template])
  const create = async () => {
    const w = await attempt(() => api.workflows.create({ name, template: chosen }))
    if (w) {
      onCreated(w.id)
      onClose()
      setName('')
    }
  }
  return (
    <Modal
      open={!!template}
      onClose={onClose}
      title="New flow"
      footer={
        <Button variant="primary" disabled={!name.trim()} onClick={() => void create()}>
          Create flow
        </Button>
      }
    >
      <div className="space-y-3">
        <label className="grid gap-1.5">
          <span className="text-[12px] font-medium text-muted">Name</span>
          <Input autoFocus placeholder="Nightly docs digest" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
        </label>
        <div className="grid grid-cols-2 gap-2 mobile:grid-cols-1" role="radiogroup" aria-label="Start from">
          {TEMPLATE_CARDS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={chosen === t.id}
              onClick={() => setChosen(t.id)}
              className={clsx('rounded-lg border p-3 text-left', chosen === t.id ? 'border-crimson-line bg-crimson-soft' : 'border-line hover:border-line-strong')}
            >
              <div className="text-[12.5px] font-semibold">{t.label}</div>
              <div className="text-[12px] text-dim">{t.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

type RFNode = Node<FlowNodeData>

function Editor2({ workflow, initialRunId, initialFix, onBack, onSaved, onDeleted, onDuplicated }: { workflow: Workflow; initialRunId?: string; initialFix?: boolean; onBack(): void; onSaved(w: Workflow): void; onDeleted(): void; onDuplicated(id: string): void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(workflow.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData })))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(workflow.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined })))
  const [name, setName] = useState(workflow.name)
  const [cron, setCron] = useState(workflow.cron ?? '')
  const [cronEnabled, setCronEnabled] = useState(workflow.cronEnabled)
  const [workspace, setWorkspace] = useState<string | null>(workflow.workspace)
  const [selected, setSelected] = useState<string | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [runOpen, setRunOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  // History: the side panel, and a version shown read-only on the canvas.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [preview, setPreview] = useState<WorkflowVersion | null>(null)
  // Fix with AI: the failed run it works from.
  const [fixRun, setFixRun] = useState<WorkflowRun | null>(null)
  // Where unsaved changes came from, recorded with the next save.
  const [pendingSource, setPendingSource] = useState<{ source: WorkflowVersionSource; note?: string } | null>(null)
  // Phone: the palette and run history open as sheets over the canvas.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [runsOpen, setRunsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot(workflow.nodes, workflow.edges, workflow.name, workflow.cron ?? '', workflow.cronEnabled, workflow.workspace))
  const flow = useReactFlow()
  const nodesReady = useNodesInitialized()
  // Phones: fitting a whole flow makes nodes unreadable, so frame its first two steps instead (pan for the rest).
  const fitOptions = (extra: { duration?: number } = {}) => {
    const all = flow.getNodes()
    if (isMobile && all.length > 2 && !window.matchMedia('(min-width: 700px)').matches) return { padding: 0.2, maxZoom: 1, nodes: [...all].sort((a, b) => a.position.x - b.position.x).slice(0, 2).map((n) => ({ id: n.id })), ...extra }
    return { padding: 0.12, maxZoom: 1.1, minZoom: 0.2, ...extra }
  }
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => {
    if (nodesReady) void flow.fitView(fitOptions())
    // Only on first measurement — later edits shouldn't yank the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesReady])

  const current = snapshot(
    nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: stripRuntime(n.data) })),
    edges,
    name,
    cron,
    cronEnabled,
    workspace
  )
  const dirty = current !== savedSnapshot

  useEffect(() => {
    void api.workflows.runs(workflow.id).then((r) => {
      setRuns(r)
      // Opened from the overview on a particular run (and maybe straight into fixing it).
      const wanted = initialRunId ? r.find((x) => x.id === initialRunId) : undefined
      setRunId(wanted?.id ?? r[0]?.id ?? null)
      if (wanted && initialFix) setFixRun(wanted)
    })
  }, [workflow.id])

  useEvent('workflow', (e) => {
    if (e.type !== 'run' || e.run.workflowId !== workflow.id) return
    setRuns((rs) => {
      const i = rs.findIndex((r) => r.id === e.run.id)
      if (i < 0) return [e.run, ...rs]
      const next = rs.slice()
      next[i] = e.run
      return next
    })
  })

  const activeRun = runs.find((r) => r.id === runId) ?? null
  // Overlay the selected run's node statuses on the canvas (or show a version being previewed).
  const displayNodes = useMemo(() => {
    if (preview?.snapshot) return preview.snapshot.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData, draggable: false, selectable: false }))
    if (!activeRun) return nodes
    const byId = new Map(activeRun.nodes.map((t) => [t.nodeId, t]))
    return nodes.map((n) => {
      const t = byId.get(n.id)
      return t ? { ...n, data: { ...n.data, __status: t.status, __ms: t.durationMs, __iter: t.iterations } } : n
    })
  }, [nodes, activeRun, preview])
  const displayEdges = useMemo(() => {
    if (preview?.snapshot) return preview.snapshot.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined, style: e.targetHandle === 'next' ? LOOP_BACK_STYLE : e.sourceHandle === 'body' ? LOOP_BODY_STYLE : undefined }))
    const running = activeRun?.status === 'running' ? new Set(activeRun.nodes.filter((t) => t.status === 'running').map((t) => t.nodeId)) : null
    return edges.map((e) => {
      const loopBack = e.targetHandle === 'next'
      const body = e.sourceHandle === 'body'
      const style = loopBack ? LOOP_BACK_STYLE : body ? LOOP_BODY_STYLE : undefined
      return { ...e, ...(style ? { style } : {}), ...(loopBack ? { type: 'smoothstep' } : {}), animated: loopBack || !!running?.has(e.target) }
    })
  }, [edges, activeRun, preview])

  // Auto-arrange: layered layout from the measured node sizes, eased into place.
  const [arranging, setArranging] = useState(false)
  const arrange = () => {
    const target = layeredLayout(
      nodes.map((n) => ({ id: n.id, width: n.measured?.width ?? 230, height: n.measured?.height ?? 70, position: n.position })),
      edges,
      { gapX: 80, gapY: 40 }
    )
    const from = new Map(nodes.map((n) => [n.id, n.position]))
    const started = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    setArranging(true)
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 420)
      const k = ease(t)
      setNodes((ns) =>
        ns.map((n) => {
          const a = from.get(n.id)
          const b = target.get(n.id)
          return a && b ? { ...n, position: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k } } : n
        })
      )
      if (t < 1) requestAnimationFrame(step)
      else {
        setArranging(false)
        void flow.fitView(fitOptions({ duration: 380 }))
      }
    }
    requestAnimationFrame(step)
  }

  /** Load an AI-made graph into the editor unsaved, so it can be reviewed (or discarded by switching away). */
  const loadDraft = (graph: WorkflowGraph) => {
    setPreview(null)
    setNodes(graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData })))
    setEdges(graph.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined })))
    if (graph.name) setName(graph.name)
    setSelected(null)
    setTimeout(() => void flow.fitView(fitOptions()), 80)
  }

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: `e_${Date.now().toString(36)}` }, es)), [setEdges])

  const keys = nodes.map((n) => n.data.key)
  const addNode = (type: WorkflowNodeType, position?: { x: number; y: number }) => {
    if (type === 'trigger' && nodes.some((n) => n.type === 'trigger')) return
    const meta = META[type]
    let i = 1
    while (keys.includes(`${type}_${i}`)) i++
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const id = `n_${Date.now().toString(36)}`
    setNodes((ns) => [
      ...ns,
      { id, type, position: position ?? { x: center.x - 115 + Math.random() * 40, y: center.y - 40 + Math.random() * 40 }, data: { key: `${type}_${i}`, label: meta.label, ...structuredClone(meta.defaults) } }
    ])
    setSelected(id)
  }

  /** Put a saved workflow into the editor (after a restore). */
  const loadSaved = (w: Workflow) => {
    setNodes(w.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData })))
    setEdges(w.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined })))
    setName(w.name)
    setWorkspace(w.workspace)
    setSavedSnapshot(snapshot(w.nodes, w.edges, w.name, w.cron ?? '', w.cronEnabled, w.workspace))
    setPendingSource(null)
    setSelected(null)
    onSaved(w)
    setTimeout(() => void flow.fitView(fitOptions({ duration: 300 })), 60)
  }

  const restore = async (v: WorkflowVersion) => {
    if (dirty && !(await confirmAction('Your unsaved changes will be replaced by this version. The current saved state stays in the history.', { title: 'Restore this version?', confirmLabel: 'Restore', danger: true }))) return
    const w = await attempt(() => api.workflows.restore(workflow.id, v.id), 'Version restored')
    if (w) {
      setPreview(null)
      loadSaved(w)
    }
  }

  const save = async (): Promise<boolean> => {
    setSaving(true)
    const meta = pendingSource ?? undefined
    const w = await attempt(() =>
      api.workflows.save(workflow.id, {
        name,
        cron: cron.trim() || null,
        cronEnabled,
        workspace,
        nodes: nodes.map((n) => ({ id: n.id, type: n.type as WorkflowNodeType, position: n.position, data: stripRuntime(n.data) })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null }))
      }, meta)
    )
    setSaving(false)
    if (w) {
      setPendingSource(null)
      setSavedSnapshot(snapshot(w.nodes, w.edges, w.name, w.cron ?? '', w.cronEnabled, w.workspace))
      onSaved(w)
    }
    return !!w
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const cronText = useMemo(() => {
    if (!cron.trim()) return 'Manual only'
    try {
      return cronstrue.toString(cron, { use24HourTimeFormat: true })
    } catch {
      return 'Invalid expression'
    }
  }, [cron])

  const sel = nodes.find((n) => n.id === selected)
  const running = activeRun?.status === 'running'

  const duplicate = async () => {
    const w = await attempt(() => api.workflows.duplicate(workflow.id))
    if (w) onDuplicated(w.id)
  }
  const remove = async () => {
    if (!(await confirmAction(`“${workflow.name}”, its schedule and its run history will be deleted.`, { title: 'Delete flow?', confirmLabel: 'Delete', danger: true }))) return
    await attempt(() => api.workflows.remove(workflow.id))
    onDeleted()
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 mobile:flex-wrap mobile:gap-1.5 mobile:px-2">
        <button onClick={onBack} className="flex h-8 shrink-0 items-center gap-1 rounded-lg pl-1 pr-2 text-[12.5px] text-dim hover:bg-elev-2 hover:text-fg" aria-label="All flows">
          <ArrowLeft size={14} /> <span className="mobile:hidden">Flows</span>
        </button>
        <input className="w-56 min-w-0 bg-transparent text-[14px] font-semibold tracking-tight outline-none mobile:w-auto mobile:flex-1" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex flex-1 items-center gap-2 mobile:order-last mobile:basis-full mobile:flex-wrap mobile:px-1 mobile:pb-0.5">
          <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel pl-2">
            <Clock size={13} className={cronEnabled && cron ? 'text-crimson-hi' : 'text-dim'} />
            <input className="h-7 w-32 bg-transparent font-mono text-[12px] outline-none placeholder:text-dim" placeholder="*/30 * * * *" value={cron} onChange={(e) => setCron(e.target.value)} />
          </div>
          <span className={clsx('truncate text-[11.5px]', cronText === 'Invalid expression' ? 'text-crimson-hi' : 'text-dim')}>{cronText}</span>
          <Switch checked={cronEnabled} onChange={setCronEnabled} disabled={!cron.trim()} label="Scheduled" />
          {workflow.cronEnabled && workflow.nextRunAt && !dirty && <Badge tone="crimson">next {timeAgo(workflow.nextRunAt)}</Badge>}
          <div className="ml-auto flex min-w-0 items-center rounded-md border border-line bg-panel mobile:ml-0">
            <button
              className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[12px] text-muted hover:text-fg"
              title={workspace ? `Workspace: ${workspace}\nAgents and JavaScript tools can create files here. Click to change.` : 'Pick a folder the flow can create files in'}
              onClick={async () => {
                const [d] = await api.app.pickPaths({ directory: true, title: 'Workspace for this flow' })
                if (d) setWorkspace(d)
              }}
            >
              <FolderOpen size={13} className={workspace ? 'text-crimson-hi' : 'text-dim'} />
              <span className="max-w-40 truncate">{workspace ? baseName(workspace) : 'No workspace'}</span>
            </button>
            {workspace && (
              <button className="flex h-7 w-6 items-center justify-center text-dim hover:text-fg" title="Remove the workspace" aria-label="Remove the workspace" onClick={() => setWorkspace(null)}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <Button icon={<Sparkles size={13} />} onClick={() => setAiOpen(true)} title="Describe a change and let an agent apply it">
          <span className="mobile:hidden">AI edit</span>
        </Button>
        {!isMobile && (
          <IconButton title="Export as an app" onClick={() => setExportOpen(true)}>
            <Package size={14} />
          </IconButton>
        )}
        <IconButton
          title="Change history"
          aria-pressed={historyOpen}
          className={historyOpen ? '!text-crimson-hi' : undefined}
          onClick={() => {
            setHistoryOpen((o) => !o)
            setPreview(null)
            setSelected(null)
          }}
        >
          <History size={14} />
        </IconButton>
        {isMobile ? (
          <IconButton title="More actions" aria-label="More actions" onClick={() => setMoreOpen(true)}>
            <MoreHorizontal size={16} />
          </IconButton>
        ) : (
          <>
            <IconButton title="Duplicate" onClick={() => void duplicate()}>
              <Copy size={14} />
            </IconButton>
            <IconButton title="Delete flow" onClick={() => void remove()}>
              <Trash2 size={14} />
            </IconButton>
          </>
        )}
        <Button icon={<Save size={13} />} disabled={!dirty} loading={saving} onClick={() => void save()}>
          <span className="mobile:hidden">Save</span>
        </Button>
        {running ? (
          <Button variant="danger" icon={<Square size={11} fill="currentColor" />} onClick={() => activeRun && void api.workflows.cancel(activeRun.id)}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" icon={<Play size={12} fill="currentColor" />} onClick={() => setRunOpen(true)}>
            Run
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        {!isMobile && (
        <div className="w-44 shrink-0 space-y-1 overflow-y-auto border-r border-line bg-panel p-2">
          <div className="px-1 pb-1 text-[12px] font-medium text-dim">Nodes</div>
          {NODE_TYPES.map((m) => (
            <div
              key={m.type}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/cloth-node', m.type)}
              onClick={() => addNode(m.type)}
              title={m.description}
              className="flex cursor-grab items-center gap-2 rounded-md border border-line bg-elev px-2 py-1.5 text-[12px] hover:border-line-strong"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded" style={{ background: `${m.color}22`, color: m.color }}>
                <m.icon size={12} />
              </span>
              {m.label}
            </div>
          ))}
          <div className="px-1 pt-3 text-[10.5px] leading-relaxed text-dim">
            Drag or click to add. Reference outputs with <span className="font-mono text-muted">{'{{key}}'}</span>, <span className="font-mono text-muted">{'{{prev}}'}</span>, <span className="font-mono text-muted">{'{{input.x}}'}</span>.
          </div>
        </div>
        )}

        {/* Canvas */}
        <div
          className="relative min-w-0 flex-1"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(e) => {
            const type = e.dataTransfer.getData('application/cloth-node') as WorkflowNodeType
            if (!type) return
            e.preventDefault()
            const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
            addNode(type, { x: p.x - 115, y: p.y - 30 })
          }}
        >
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={preview ? undefined : onNodesChange}
            onEdgesChange={preview ? undefined : onEdgesChange}
            onConnect={preview ? undefined : onConnect}
            nodesConnectable={!preview}
            deleteKeyCode={preview ? null : ['Delete', 'Backspace']}
            onNodeClick={(_, n) => !preview && setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            colorMode="dark"
            fitView
            minZoom={0.2}
            fitViewOptions={{ padding: 0.12, maxZoom: 1.1, minZoom: 0.2 }}
            defaultEdgeOptions={{ style: { strokeWidth: 1.6 } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#26262c" />
            <Controls showInteractive={false} />
            {preview && (
              <Panel position="top-center" className="!mt-3">
                <div className="flex items-center gap-2 rounded-[10px] border border-crimson-line bg-panel/95 py-1.5 pl-3 pr-1.5 shadow-lg shadow-black/40 backdrop-blur">
                  <Eye size={13} className="shrink-0 text-crimson-hi" />
                  <span className="text-[12px]">
                    Previewing the version from <b className="font-semibold">{timeAgo(preview.createdAt)}</b>
                  </span>
                  <Button size="sm" variant="ghost" icon={<ArrowLeft size={12} />} onClick={() => setPreview(null)}>
                    Back to current
                  </Button>
                  <Button size="sm" variant="primary" icon={<RotateCcw size={12} />} onClick={() => void restore(preview)}>
                    Restore
                  </Button>
                </div>
              </Panel>
            )}
            <Panel position="top-right">
              <Button size="sm" icon={<LayoutDashboard size={13} />} disabled={arranging || nodes.length < 2} onClick={arrange} title="Auto-arrange nodes left to right in run order">
                Arrange
              </Button>
            </Panel>
            {isMobile && (
              <Panel position="bottom-right" className="!m-3 flex flex-col gap-2">
                <button onClick={() => setRunsOpen(true)} aria-label="Runs" className="flex h-12 w-12 items-center justify-center rounded-[14px] border border-line-strong bg-elev text-muted shadow-lg shadow-black/50">
                  <ListChecks size={20} />
                </button>
                <button onClick={() => setPaletteOpen(true)} aria-label="Add node" className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-crimson text-white shadow-[0_8px_24px_-6px_rgb(220_38_69/0.7)]">
                  <Plus size={22} />
                </button>
              </Panel>
            )}
            {!isMobile && <MiniMap pannable zoomable nodeColor={(n) => META[n.type as WorkflowNodeType]?.color ?? '#555'} maskColor="rgb(9 9 10 / 0.7)" />}
          </ReactFlow>
        </div>

        {/* Inspector */}
        {!isMobile && (
        <div className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel">
          {historyOpen ? (
            <HistoryPanel
              workflowId={workflow.id}
              refreshKey={workflow.updatedAt}
              previewId={preview?.id ?? null}
              onPreview={async (v) => {
                if (!v) return setPreview(null)
                const full = await attempt(() => api.workflows.version(v.id))
                if (full) setPreview(full)
              }}
              onRestore={(v) => void restore(v)}
              onClose={() => (setHistoryOpen(false), setPreview(null))}
            />
          ) : sel ? (
            <Inspector
              key={sel.id}
              type={sel.type as WorkflowNodeType}
              data={sel.data}
              keys={keys}
              onChange={(patch) => setNodes((ns) => ns.map((n) => (n.id === sel.id ? { ...n, data: { ...n.data, ...patch } } : n)))}
              onDelete={() => {
                setNodes((ns) => ns.filter((n) => n.id !== sel.id))
                setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id))
                setSelected(null)
              }}
            />
          ) : (
            <RunPanel runs={runs} runId={runId} onSelect={setRunId} workflow={workflow} onFix={setFixRun} />
          )}
        </div>
        )}
      </div>

      {isMobile && (
        <>
          <BottomSheet open={paletteOpen} onClose={() => setPaletteOpen(false)} title="Add a node" description="Tap to drop it in the middle of the canvas." snapPoints={[0.7]}>
            <div className="grid grid-cols-2 gap-2 pb-4">
              {NODE_TYPES.map((m) => (
                <button
                  key={m.type}
                  onClick={() => {
                    addNode(m.type)
                    setPaletteOpen(false)
                  }}
                  className="flex items-start gap-2.5 rounded-[14px] border border-line bg-elev px-3 py-3 text-left active:border-line-strong"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]" style={{ background: `${m.color}22`, color: m.color }}>
                    <m.icon size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{m.label}</span>
                    <span className="line-clamp-2 block text-[11px] leading-snug text-dim">{m.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </BottomSheet>
          <BottomSheet open={!!sel} onClose={() => setSelected(null)} title={sel ? (META[sel.type as WorkflowNodeType]?.label ?? 'Node') : 'Node'} snapPoints={[0.55, 0.92]}>
            {sel && (
              <div className="-mx-4 -mt-2">
                <Inspector
                  key={sel.id}
                  type={sel.type as WorkflowNodeType}
                  data={sel.data}
                  keys={keys}
                  onChange={(patch) => setNodes((ns) => ns.map((n) => (n.id === sel.id ? { ...n, data: { ...n.data, ...patch } } : n)))}
                  onDelete={() => {
                    setNodes((ns) => ns.filter((n) => n.id !== sel.id))
                    setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id))
                    setSelected(null)
                  }}
                />
              </div>
            )}
          </BottomSheet>
          <BottomSheet open={runsOpen && !sel} onClose={() => setRunsOpen(false)} title="Runs" snapPoints={[0.6, 0.92]}>
            <div className="-mx-4 -mt-2 h-[70vh]">
              <RunPanel runs={runs} runId={runId} onSelect={setRunId} workflow={workflow} onFix={setFixRun} inSheet />
            </div>
          </BottomSheet>
          <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title={name || 'Flow'} snapPoints={[0.3]}>
            <div className="space-y-2 pb-4">
              <button onClick={() => (setMoreOpen(false), void duplicate())} className="flex h-12 w-full items-center gap-3 rounded-[14px] border border-line bg-elev px-4 text-[13.5px] active:border-line-strong">
                <Copy size={17} className="text-muted" /> Duplicate
              </button>
              <button onClick={() => (setMoreOpen(false), void remove())} className="flex h-12 w-full items-center gap-3 rounded-[14px] border border-crimson-line bg-crimson-soft px-4 text-[13.5px] text-crimson-hi">
                <Trash2 size={17} /> Delete flow
              </button>
            </div>
          </BottomSheet>
        </>
      )}

      <AssembleModal
        open={aiOpen}
        mode="modify"
        workflowId={workflow.id}
        workflowName={workflow.name}
        onClose={() => setAiOpen(false)}
        onGraph={(graph: WorkflowGraph, request) => {
          loadDraft(graph)
          setPendingSource({ source: 'ai-edit', note: request.slice(0, 300) })
          useApp.getState().toast('AI changes loaded — review them, then Save', 'info')
        }}
      />
      <AssembleModal
        open={!!fixRun}
        mode="fix"
        fixRun={fixRun ?? undefined}
        workflowId={workflow.id}
        workflowName={workflow.name}
        onClose={() => setFixRun(null)}
        onGraph={(graph: WorkflowGraph) => {
          loadDraft(graph)
          setPendingSource({ source: 'ai-fix', note: (fixRun?.error ?? '').slice(0, 300) })
          setHistoryOpen(false)
          useApp.getState().toast('Fix loaded — review it, then Save and run again', 'info')
        }}
      />
      <ExportModal open={exportOpen} workflow={workflow} onClose={() => setExportOpen(false)} beforeExport={async () => !dirty || (await save())} />
      <RunModal
        open={runOpen}
        onClose={() => setRunOpen(false)}
        defaultInput={String(nodes.find((n) => n.type === 'trigger')?.data.defaultInput ?? '{}')}
        onRun={async (input) => {
          if (dirty && !(await save())) return
          const r = await attempt(() => api.workflows.run(workflow.id, input))
          if (r) {
            setRunId(r.id)
            setSelected(null)
            if (isMobile) setRunsOpen(true)
          }
          setRunOpen(false)
        }}
      />
    </div>
  )
}

function RunModal({ open, onClose, defaultInput, onRun }: { open: boolean; onClose(): void; defaultInput: string; onRun(input: unknown): Promise<void> }) {
  const [text, setText] = useState(defaultInput)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setText(defaultInput)
      setError(null)
    }
  }, [open, defaultInput])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run workflow"
      footer={
        <Button
          variant="primary"
          icon={<Play size={12} fill="currentColor" />}
          onClick={() => {
            try {
              void onRun(text.trim() ? JSON.parse(text) : {})
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          Run
        </Button>
      }
    >
      <div className="mb-1.5 text-[12px] text-dim">Input (JSON) — available as {'{{input}}'}</div>
      <div className="h-48 overflow-hidden rounded-md border border-line bg-bg">
        <Editor value={text} onChange={setText} lang="json" />
      </div>
      {error && <div className="mt-2 text-[12px] text-crimson-hi">{error}</div>}
    </Modal>
  )
}

/** `inSheet`: shown in the phone's Runs sheet, which has its own title. */
function RunPanel({ runs, runId, onSelect, workflow, onFix, inSheet }: { runs: WorkflowRun[]; runId: string | null; onSelect(id: string): void; workflow: Workflow; onFix(run: WorkflowRun): void; inSheet?: boolean }) {
  const run = runs.find((r) => r.id === runId)
  const [openNode, setOpenNode] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ title: string; value: unknown } | null>(null)
  return (
    <div className="flex h-full flex-col">
      {!inSheet && <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">Runs</div>}
      <div className="max-h-56 shrink-0 overflow-y-auto border-b border-line p-1.5">
        {!runs.length && <div className="p-3 text-[12px] text-dim">{inSheet ? 'No runs yet — tap Run to try the flow.' : 'No runs yet. Select a node to edit it.'}</div>}
        {runs.map((r) => (
          <ListItem key={r.id} active={r.id === runId} onClick={() => onSelect(r.id)}>
            <Dot tone={r.status === 'ok' ? 'ok' : r.status === 'error' ? 'crimson' : 'info'} pulse={r.status === 'running'} />
            <span className="flex-1 text-[12px]">{timeAgo(r.startedAt)}</span>
            <Badge tone="dim">{r.trigger}</Badge>
            <span className="font-mono text-[10.5px] text-dim">{r.finishedAt ? duration(r.finishedAt - r.startedAt) : '…'}</span>
          </ListItem>
        ))}
      </div>
      {run && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {run.error && (
            <div className="space-y-2 rounded-md border border-crimson-line bg-crimson-soft p-2.5">
              <div className="selectable text-[11.5px] text-crimson-hi">{run.error}</div>
              {run.status === 'error' && (
                <Button size="sm" variant="primary" icon={<Wand2 size={12} />} onClick={() => onFix(run)}>
                  Fix with AI
                </Button>
              )}
            </div>
          )}
          {!!run.files?.length && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-dim">Files ({run.files.length})</div>
              <div className="space-y-1">
                {run.files.map((f) => (
                  <div key={f} className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5" title={f}>
                    <File size={13} className="shrink-0 text-crimson-hi" />
                    <span className="min-w-0 flex-1 truncate text-[12px]">{run.workspace && f.startsWith(run.workspace) ? f.slice(run.workspace.length + 1) : baseName(f)}</span>
                    {!isMobile && (
                      <IconButton title="Open file" onClick={() => void attempt(() => api.app.openPath(f))}>
                        <ExternalLink size={12} />
                      </IconButton>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {run.status === 'ok' && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-dim">Output</div>
              <button
                onClick={() => setViewing({ title: `${workflow.name} · output`, value: run.output })}
                className="group flex w-full items-center gap-2.5 rounded-md border border-line bg-bg px-2.5 py-2 text-left transition-colors hover:border-crimson-line hover:bg-crimson-soft"
              >
                <FileText size={15} className="shrink-0 text-crimson-hi" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-fg">View output</div>
                  <div className="truncate font-mono text-[10.5px] text-dim">{outputSummary(run.output)}</div>
                </div>
                <Maximize2 size={13} className="shrink-0 text-dim group-hover:text-crimson-hi" />
              </button>
            </div>
          )}
          <div className="text-[12px] font-medium text-dim">Node trace</div>
          {run.nodes.map((t) => {
            const label = workflow.nodes.find((n) => n.id === t.nodeId)?.data.label ?? t.key
            const open = openNode === t.nodeId
            return (
              <div key={t.nodeId} className="rounded-md border border-line bg-bg">
                <button onClick={() => setOpenNode(open ? null : t.nodeId)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
                  <Dot tone={t.status === 'ok' ? 'ok' : t.status === 'error' ? 'crimson' : t.status === 'running' ? 'info' : 'dim'} pulse={t.status === 'running'} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{label}</span>
                  {t.iterations ? <span className="rounded bg-elev-2 px-1 font-mono text-[10px] text-[#fb923c]" title={t.type === 'loop' ? 'iterations' : 'runs across loop iterations'}>×{t.iterations}</span> : null}
                  <span className="font-mono text-[10px] text-dim">{t.status === 'skipped' ? 'skipped' : duration(t.durationMs)}</span>
                </button>
                {!open && t.output !== undefined && <div className="truncate px-2.5 pb-1.5 font-mono text-[10.5px] text-dim">{preview(t.output, 90)}</div>}
                {open && (
                  <div className="space-y-1.5 border-t border-line p-2">
                    {t.error && <div className="text-[11px] text-crimson-hi">{t.error}</div>}
                    <Textarea readOnly rows={4} className="font-mono text-[10.5px]" value={`input:\n${pretty(t.input)}`} />
                    <Textarea readOnly rows={6} className="font-mono text-[10.5px]" value={`output:\n${pretty(t.output)}`} />
                    {t.output !== undefined && (
                      <Button size="sm" variant="ghost" icon={<Maximize2 size={12} />} onClick={() => setViewing({ title: `${label} · output`, value: t.output })}>
                        Open output
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <OutputModal view={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

/** Text we can render as markdown: plain strings, or an object's single string field (e.g. { text }). */
function outputText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const strings = Object.values(value).filter((v): v is string => typeof v === 'string')
    if (strings.length === 1 && Object.keys(value).length === 1) return strings[0]
  }
  return null
}

function outputSummary(value: unknown): string {
  const text = outputText(value)
  if (text !== null) {
    const words = text.trim().split(/\s+/).filter(Boolean).length
    const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]
    return `${heading ? heading + ' · ' : ''}${words.toLocaleString()} words`
  }
  return preview(value, 60)
}

function OutputModal({ view, onClose }: { view: { title: string; value: unknown } | null; onClose(): void }) {
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setMode('rendered')
    setCopied(false)
  }, [view])
  if (!view) return null
  const text = outputText(view.value)
  const raw = pretty(view.value)
  const markdown = text ?? '```json\n' + raw + '\n```'
  return (
    <Modal
      open
      onClose={onClose}
      width={860}
      title={
        <span className="flex items-center gap-2">
          <FileText size={15} className="text-crimson-hi" />
          {view.title}
        </span>
      }
      footer={
        <Button
          size="sm"
          icon={copied ? <Check size={12} /> : <Copy size={12} />}
          onClick={() => {
            void navigator.clipboard.writeText(raw)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      }
    >
      <Tabs
        className="-mx-4 -mt-4 mb-4 px-3"
        value={mode}
        onChange={setMode}
        items={[
          { value: 'rendered', label: 'Rendered' },
          { value: 'raw', label: 'Raw' }
        ]}
      />
      {mode === 'rendered' ? (
        <div className="selectable min-h-[40vh] px-1">
          <Markdown text={markdown} />
        </div>
      ) : (
        <pre className="selectable min-h-[40vh] whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-[11.5px] text-fg">{raw}</pre>
      )}
    </Modal>
  )
}

const SOURCE_LABEL: Record<WorkflowVersionSource, { label: string; tone: 'crimson' | 'info' | 'ok' | 'dim' | 'warn' }> = {
  original: { label: 'Before history', tone: 'dim' },
  created: { label: 'Created', tone: 'dim' },
  edit: { label: 'Edited', tone: 'dim' },
  'ai-build': { label: 'Built with AI', tone: 'info' },
  'ai-edit': { label: 'AI edit', tone: 'info' },
  'ai-fix': { label: 'AI fix', tone: 'crimson' },
  restore: { label: 'Restored', tone: 'warn' }
}

/** Saved versions of the flow, newest first: preview any of them on the canvas, or restore it. */
function HistoryPanel({
  workflowId,
  refreshKey,
  previewId,
  onPreview,
  onRestore,
  onClose
}: {
  workflowId: string
  refreshKey: number
  previewId: string | null
  onPreview(v: WorkflowVersion | null): void
  onRestore(v: WorkflowVersion): void
  onClose(): void
}) {
  const [versions, setVersions] = useState<WorkflowVersion[] | null>(null)
  useEffect(() => {
    void api.workflows.versions(workflowId).then(setVersions)
  }, [workflowId, refreshKey])
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <History size={14} className="text-crimson-hi" />
        <span className="flex-1 text-[12.5px] font-semibold">Change history</span>
        <IconButton title="Close history" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {versions === null && <div className="p-3 text-[12px] text-dim">Loading…</div>}
        {versions?.length === 0 && <div className="p-3 text-[12px] leading-relaxed text-dim">No saved versions yet. Every save from now on is kept here, so you can go back to it.</div>}
        {versions?.map((v, i) => {
          const tag = SOURCE_LABEL[v.source] ?? SOURCE_LABEL.edit
          const current = i === 0
          const previewing = v.id === previewId
          return (
            <div
              key={v.id}
              className={clsx(
                'group relative mb-1 rounded-lg border px-2.5 py-2 transition-colors',
                previewing ? 'border-crimson-line bg-crimson-soft' : 'border-transparent hover:border-line hover:bg-elev'
              )}
            >
              {/* Timeline rail */}
              {i < versions.length - 1 && <span className="absolute bottom-[-6px] left-[15px] top-[26px] w-px bg-line" />}
              <div className="flex items-center gap-2">
                <span className={clsx('relative z-[1] h-2.5 w-2.5 shrink-0 rounded-full border-2', current ? 'border-crimson bg-crimson' : 'border-line-strong bg-panel')} />
                <span className="text-[12px] text-fg" title={new Date(v.createdAt).toLocaleString()}>
                  {timeAgo(v.createdAt)}
                </span>
                <Badge tone={tag.tone}>{tag.label}</Badge>
                {current && <span className="ml-auto text-[10.5px] text-dim">current</span>}
              </div>
              <div className="ml-[18px] mt-1 text-[11.5px] leading-snug text-muted">{v.summary || 'No visible changes'}</div>
              {v.note && <div className="ml-[18px] mt-0.5 line-clamp-2 text-[11px] text-dim" title={v.note}>{v.note}</div>}
              {!current && (
                <div className="ml-[18px] mt-1.5 flex gap-1.5">
                  <Button size="sm" variant="ghost" icon={<Eye size={12} />} onClick={() => onPreview(previewing ? null : v)}>
                    {previewing ? 'Hide preview' : 'Preview'}
                  </Button>
                  <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => onRestore(v)}>
                    Restore
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const LOOP_BODY_STYLE = { stroke: '#fb923c', strokeWidth: 1.6 }
const LOOP_BACK_STYLE = { stroke: '#fb923c', strokeWidth: 1.6, strokeDasharray: '6 4' }

function stripRuntime(d: FlowNodeData): FlowNodeData & { key: string } {
  const { __status, __ms, __summary, __iter, ...rest } = d
  void __iter
  void __status
  void __ms
  void __summary
  return rest as FlowNodeData & { key: string }
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function snapshot(
  nodes: { id: string; type?: string; position: { x: number; y: number }; data: unknown }[],
  edges: { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
  name: string,
  cron: string,
  enabled: boolean,
  workspace: string | null
): string {
  return JSON.stringify({
    workspace,
    n: nodes.map((n) => [n.id, n.type, Math.round(n.position.x), Math.round(n.position.y), n.data]),
    e: edges.map((e) => [e.source, e.target, e.sourceHandle ?? null, e.targetHandle ?? null]),
    name,
    cron: cron.trim(),
    enabled
  })
}
