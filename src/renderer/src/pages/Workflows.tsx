import { useEffect, useState } from 'react'
import clsx from 'clsx'
import cronstrue from 'cronstrue'
import { Clock, Play } from 'lucide-react'
import type { Workflow, WorkflowOverview, WorkflowRunSummary } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { duration, timeAgo } from '@/lib/format'
import { Button, Segmented, Switch } from '@/components/ui'
import { refocus } from '@/components/Inspector'
import { AutomationEditor } from './automation/AutomationEditor'

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
 * Automations: a prompt, a schedule and what it may use; the agent decides what to do and how to report.
 * A timeline of scheduled runs, each automation as a card (next run, last runs, on/off, Run now), and recent
 * runs across them. Opening one shows its editor.
 */
export function WorkflowsPage() {
  const [flows, setFlows] = useState<Workflow[]>([])
  const [overview, setOverview] = useState<WorkflowOverview | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)
  const [newAutomation, setNewAutomation] = useState(false)

  const refreshOverview = () => void api.workflows.overview().then(setOverview, () => undefined)
  const load = async () => {
    const [list, o] = await Promise.all([api.workflows.list(), api.workflows.overview().catch(() => null)])
    setFlows(list)
    setOverview(o)
    setLoaded(true)
  }
  useEffect(() => {
    void load()
  }, [])
  useEvent('workflow', (e) => {
    if (e.type === 'schedule') setFlows((fs) => fs.map((f) => (f.id === e.workflowId ? { ...f, nextRunAt: e.nextRunAt } : f)))
    // A run finished somewhere: refresh the history (cheap; only while the overview shows).
    if (e.type === 'run' && e.run.status !== 'running' && !opened) refreshOverview()
  })

  const upsert = (w: Workflow) => setFlows((fs) => (fs.some((f) => f.id === w.id) ? fs.map((f) => (f.id === w.id ? w : f)) : [w, ...fs]))
  const active = opened ? flows.find((f) => f.id === opened && f.automation) : undefined
  if (newAutomation || active)
    return (
      <AutomationEditor
        key={active?.id ?? 'new'}
        workflow={newAutomation ? null : (active ?? null)}
        onBack={() => {
          const id = active?.id ?? null
          setNewAutomation(false)
          setOpened(null)
          void load()
          refocus(id)
        }}
        onSaved={(w) => {
          upsert(w)
          if (newAutomation) {
            setNewAutomation(false)
            setOpened(w.id)
          }
        }}
        onDeleted={() => (setOpened(null), void load())}
      />
    )

  // Only automations are listed; a flow whose conversion failed stays out of the way.
  const automations = flows.filter((f) => f.automation)
  const byId = new Map(overview?.flows.map((f) => [f.id, f]) ?? [])
  // Failing ones first, then the most recently changed.
  const ordered = [...automations].sort((a, b) => Number(byId.get(b.id)?.runs[0]?.status === 'error') - Number(byId.get(a.id)?.runs[0]?.status === 'error') || b.updatedAt - a.updatedAt)
  const setOn = async (f: Workflow, on: boolean) => {
    const w = await attempt(() => api.workflows.saveAutomation(f.id, { cronEnabled: on }), on ? 'Automation on' : 'Automation paused')
    if (w) {
      upsert(w)
      refreshOverview()
    }
  }
  const runNow = async (f: Workflow) => {
    if (await attempt(() => api.workflows.run(f.id), `Running “${f.name}”`)) refreshOverview()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-5 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <h1 className="text-[18px] font-semibold tracking-tight">Automations</h1>
            <p className="mt-0.5 text-[12.5px] text-dim">A prompt, a schedule and what it may use. It decides what to do and how to report.</p>
          </div>
          <Button variant="primary" icon={<Clock size={13} />} onClick={() => setNewAutomation(true)}>
            New automation
          </Button>
        </div>

        {loaded && !automations.length ? (
          <section aria-label="No automations yet" className="grid justify-items-start gap-3 rounded-[12px] border border-line bg-elev p-5">
            <p className="max-w-[70ch] text-[13px] text-muted">Write what should happen and when. Cloth works it out and reports back.</p>
            <Button variant="primary" icon={<Clock size={13} />} onClick={() => setNewAutomation(true)}>
              New automation
            </Button>
          </section>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_290px] gap-5 max-[960px]:grid-cols-1">
            <div className="grid min-w-0 content-start gap-5">
              <Upcoming flows={automations} overview={overview} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-dim">
                <span>Last runs, oldest to newest:</span>
                <span className="flex items-end gap-1">
                  <i className="inline-block h-3 w-[7px] rounded-[2px] bg-ok" aria-hidden="true" /> worked
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
                  <AutomationCard key={f.id} flow={f} info={byId.get(f.id)} onOpen={() => setOpened(f.id)} onToggle={(on) => void setOn(f, on)} onRun={() => void runNow(f)} />
                ))}
              </div>
            </div>
            <RecentRuns runs={overview?.recent ?? []} flows={automations} onOpen={(id) => setOpened(id)} />
          </div>
        )}
      </div>
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
        <p className="mt-3 text-[12.5px] text-dim">Nothing scheduled{span === '2d' ? ' for today or tomorrow' : ' this week'}. Give an automation a schedule to run it on its own.</p>
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

function RunBars({ runs }: { runs: WorkflowRunSummary[] }) {
  const ordered = [...runs].reverse()
  const passed = runs.filter((r) => r.status === 'ok').length
  const failed = runs.filter((r) => r.status === 'error').length
  const running = runs.filter((r) => r.status === 'running').length
  const label = runs.length ? `Last ${plural(runs.length, 'run')}: ${[passed && `${passed} worked`, failed && `${failed} failed`, running && `${running} running`].filter(Boolean).join(', ')}${runs[0]?.status === 'error' ? ', including the latest' : ''}` : 'No runs yet'
  if (!runs.length) return <span className="text-[12px] text-dim">No runs yet</span>
  return (
    <span role="img" aria-label={label} className="flex h-4 items-end gap-[3px]">
      {ordered.map((r) => (
        <i key={r.id} className={clsx('inline-block w-2 rounded-[2px]', r.status === 'ok' ? 'h-4 bg-ok' : r.status === 'error' ? 'h-[7px] bg-crimson' : 'h-4 border-[1.5px] border-info')} title={`${r.status === 'ok' ? 'Worked' : r.status === 'error' ? 'Failed' : 'Running'}, ${when(r.startedAt)}`} />
      ))}
    </span>
  )
}

function AutomationCard({ flow, info, onOpen, onToggle, onRun }: { flow: Workflow; info?: WorkflowOverview['flows'][number]; onOpen(): void; onToggle(on: boolean): void; onRun(): void }) {
  const last = info?.runs[0]
  const failing = last?.status === 'error'
  const lastRun = !last ? 'Never run' : last.status === 'running' ? 'Running now' : `Last run ${timeAgo(last.startedAt)}: ${last.status === 'ok' ? 'worked' : 'failed'}`
  return (
    <div className={clsx('grid min-w-0 grid-cols-[minmax(0,1fr)] content-start overflow-hidden rounded-[12px] border bg-elev', failing ? 'border-crimson-line' : 'border-line')}>
      <button data-focus-key={flow.id} onClick={onOpen} className="grid min-w-0 grid-cols-[minmax(0,1fr)] text-left hover:bg-elev-2 focus-visible:ring-2 focus-visible:ring-crimson-line">
        <span className="border-b border-line bg-panel">
          <span className="grid h-[74px] content-start px-3.5 py-2.5">
            <span className="line-clamp-3 text-[12px] text-muted">{flow.automation?.prompt}</span>
          </span>
        </span>
        <span className="grid gap-1.5 px-3.5 py-3">
          <span className="line-clamp-2 text-[13.5px] font-semibold">{flow.name}</span>
          <span className="text-[12px] text-dim">
            {flow.cron ? (
              <>
                {describeCron(flow.cron)}
                <br />
                {!flow.cronEnabled ? 'Paused' : flow.nextRunAt ? `Next: ${until(flow.nextRunAt)}` : 'Not scheduled yet'}
              </>
            ) : flow.automation?.watch ? (
              'When something changes'
            ) : (
              'Only when you run it'
            )}
            <br />
            {lastRun}
          </span>
          <RunBars runs={info?.runs ?? []} />
        </span>
      </button>
      {failing && (
        <div className="border-t border-line px-3.5 py-2 text-[12px]">
          <span className="block truncate text-crimson-hi" title={last.error ?? undefined}>
            Failed: {last.error ?? 'see the run'}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-line px-3.5 py-2">
        {flow.cron && <Switch checked={flow.cronEnabled} onChange={onToggle} label={flow.cronEnabled ? 'On' : 'Paused'} />}
        <span className="flex-1" />
        <Button size="sm" icon={<Play size={11} fill="currentColor" />} onClick={onRun}>
          Run now
        </Button>
      </div>
    </div>
  )
}

function RecentRuns({ runs, flows, onOpen }: { runs: WorkflowRunSummary[]; flows: Workflow[]; onOpen(id: string): void }) {
  const names = new Map(flows.map((f) => [f.id, f.name]))
  return (
    <section aria-label="Recent runs" className="grid content-start gap-1 self-start rounded-[12px] border border-line bg-elev py-2">
      <h2 className="px-3.5 pb-1 pt-1 text-[13px] font-semibold">Recent runs</h2>
      {runs.map((r) => (
        <button key={r.id} onClick={() => onOpen(r.workflowId)} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-3.5 py-1.5 text-left text-[12.5px] hover:bg-elev-2">
          <span className={clsx('mt-[5px] h-2 w-2 rounded-full', r.status === 'ok' ? 'bg-ok' : r.status === 'error' ? 'bg-crimson' : 'bg-info')} aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate">{names.get(r.workflowId) ?? 'Deleted automation'}</span>
            <span className={clsx('block truncate text-[12px]', r.status === 'error' ? 'text-crimson-hi' : 'text-dim')}>
              {r.status === 'error' ? 'Failed' : r.status === 'running' ? 'Running' : `Worked${r.durationMs !== null ? ` in ${duration(r.durationMs)}` : ''}`}
            </span>
          </span>
          <span className="text-[12px] tabular-nums text-dim">{timeAgo(r.startedAt)}</span>
        </button>
      ))}
      {!runs.length && <p className="px-3.5 py-2 text-[12.5px] text-dim">No runs yet. Run an automation, or give it a schedule.</p>}
    </section>
  )
}
