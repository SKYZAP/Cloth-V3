import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Plus } from 'lucide-react'
import type { Workflow, WorkflowOverview, WorkflowRun } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { useSideBySide } from '@/lib/platform'
import { Button } from '@/components/ui'
import { SplitDetail, SplitRoot } from '@/components/SplitView'
import { AutomationDetail, FOCUS, useNow } from './automation/AutomationDetail'
import { Compose } from './automation/Compose'
import { daySlots, nextUp, relativeIn, scheduleSentence, shortWhen } from './automation/schedule'

/** On: it runs by itself (a schedule that's on, or a watch, which has no pause). */
/** On: its switch (`cronEnabled`) is on and it has a schedule or a watch to act on. */
const isActive = (w: Workflow) => w.cronEnabled && (!!w.cron || !!w.automation?.watch)

/**
 * Automations: a list (what's on, what's paused, and the next scheduled run) beside the selected automation,
 * edited in place. "New" drafts one from a description.
 */
export function WorkflowsPage() {
  const [flows, setFlows] = useState<Workflow[]>([])
  const [overview, setOverview] = useState<WorkflowOverview | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  // Phone: whether the detail (or New) shows over the list.
  const [open, setOpen] = useState(false)
  const [drafted, setDrafted] = useState<Set<string>>(new Set())
  // The latest run status per automation, from run events (the overview is a snapshot).
  const [live, setLive] = useState<Record<string, WorkflowRun['status']>>({})
  const side = useSideBySide()
  const listRef = useRef<HTMLDivElement>(null)
  const now = useNow(30_000)

  const refreshOverview = () => void api.workflows.overview().then(setOverview, () => undefined)
  useEffect(() => {
    void Promise.all([api.workflows.list(), api.workflows.overview().catch(() => null)]).then(([list, o]) => {
      setFlows(list.filter((f) => f.automation))
      setOverview(o)
      setLoaded(true)
    })
  }, [])
  useEvent('workflow', (e) => {
    if (e.type === 'schedule') setFlows((fs) => fs.map((f) => (f.id === e.workflowId ? { ...f, nextRunAt: e.nextRunAt } : f)))
    if (e.type === 'run') {
      setLive((l) => ({ ...l, [e.run.workflowId]: e.run.status }))
      if (e.run.status !== 'running') refreshOverview()
    }
  })

  // Newest first; stable while editing (saving doesn't reorder).
  const ordered = useMemo(() => [...flows].sort((a, b) => b.createdAt - a.createdAt), [flows])
  const onList = ordered.filter(isActive)
  const pausedList = ordered.filter((f) => !isActive(f))
  const visual = [...onList, ...pausedList]
  const info = new Map(overview?.flows.map((f) => [f.id, f]) ?? [])
  const lastStatus = (id: string) => live[id] ?? info.get(id)?.runs[0]?.status

  // Side by side, something is always selected (or New shows when there's nothing yet).
  const current = flows.find((f) => f.id === selected) ?? null
  useEffect(() => {
    if (!loaded || !side || composing) return
    if (!current && visual.length) setSelected(visual[0].id)
  }, [loaded, side, composing, current, visual.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const upsert = (w: Workflow) => setFlows((fs) => (fs.some((f) => f.id === w.id) ? fs.map((f) => (f.id === w.id ? w : f)) : [w, ...fs]))
  const select = (id: string) => {
    setSelected(id)
    setComposing(false)
    setOpen(true)
  }
  const startNew = () => {
    setComposing(true)
    setOpen(true)
  }

  // Next up: the soonest scheduled run, and today's hours with a run.
  const scheduled = flows.filter((f) => f.cron && f.cronEnabled).map((f) => ({ id: f.id, name: f.name, times: [...(info.get(f.id)?.upcoming ?? []), ...(f.nextRunAt ? [f.nextRunAt] : [])] }))
  const next = nextUp(scheduled, now)
  const { slots, nowHour } = daySlots(
    scheduled.flatMap((s) => s.times),
    now
  )

  const move = (dir: 1 | -1) => {
    if (!visual.length) return
    const i = visual.findIndex((f) => f.id === selected)
    const target = visual[Math.min(visual.length - 1, Math.max(0, i + dir))]
    select(target.id)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(target.id)}"]`)?.focus())
  }

  const empty = loaded && !flows.length
  const showCompose = composing || empty

  return (
    <SplitRoot
      open={open}
      onBack={() => {
        setOpen(false)
        setComposing(false)
      }}
    >
      <aside aria-label="Automations" className={clsx('flex h-full shrink-0 flex-col', side ? 'w-[340px] border-r border-line' : 'w-full')}>
        <div className="flex items-center gap-2.5 px-4 pb-2.5 pt-[18px]">
          <h1 className="flex-1 text-[17px] font-semibold">Automations</h1>
          <Button variant="primary" className={FOCUS} icon={<Plus size={13} aria-hidden="true" />} onClick={startNew}>
            New
          </Button>
        </div>

        {next && (
          <div className="mx-3 mb-2.5 rounded-[12px] border border-line bg-panel px-3 py-2.5">
            <div className="text-[11.5px] text-dim">Next up</div>
            <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
              <span className="truncate font-semibold" title={next.name}>
                {next.name}
              </span>
              <span className="shrink-0 text-[12px] tabular-nums text-muted">
                {shortWhen(next.at, now)} · {relativeIn(next.at, now)}
              </span>
            </div>
            <div className="mt-[9px] flex h-[18px] items-end gap-[2px]" aria-hidden="true">
              {slots.flatMap((on, h) => [
                ...(h === nowHour ? [<i key="now" className="h-[18px] w-[2px] shrink-0 rounded-[1px] bg-fg" />] : []),
                <i key={h} className={clsx('flex-1 rounded-[2px]', on ? 'h-3 bg-crimson-line' : 'h-1 bg-line')} />
              ])}
            </div>
            <span className="sr-only">{`${slots.filter(Boolean).length} hours today with a scheduled run.`}</span>
            <div className="mt-[3px] flex justify-between text-[11px] tabular-nums text-dim" aria-hidden="true">
              <span>00:00</span>
              <span>today</span>
              <span>24:00</span>
            </div>
          </div>
        )}

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
          onKeyDown={(e) => {
            if (!side || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
            e.preventDefault()
            move(e.key === 'ArrowDown' ? 1 : -1)
          }}
        >
          {empty && <p className="px-2 py-2.5 text-[12.5px] text-dim">No automations yet.</p>}
          {onList.length > 0 && <Group label={`On · ${onList.length}`} />}
          {onList.map((f) => (
            <ListRow key={f.id} flow={f} active selected={side && !showCompose && f.id === selected} status={lastStatus(f.id)} onSelect={() => select(f.id)} />
          ))}
          {pausedList.length > 0 && <Group label={`Paused · ${pausedList.length}`} />}
          {pausedList.map((f) => (
            <ListRow key={f.id} flow={f} active={false} selected={side && !showCompose && f.id === selected} status={lastStatus(f.id)} onSelect={() => select(f.id)} />
          ))}
        </div>
      </aside>

      <SplitDetail>
        {!loaded ? null : showCompose ? (
          <Compose
            onCancel={
              empty
                ? undefined
                : () => {
                    setComposing(false)
                    setOpen(false)
                  }
            }
            onCreated={(w, wasDrafted) => {
              upsert(w)
              if (wasDrafted) setDrafted((d) => new Set(d).add(w.id))
              refreshOverview()
              select(w.id)
            }}
          />
        ) : current ? (
          <AutomationDetail
            key={current.id}
            workflow={current}
            drafted={drafted.has(current.id)}
            onSaved={(w) => {
              upsert(w)
              refreshOverview()
            }}
            onDuplicated={(w) => {
              upsert(w)
              select(w.id)
            }}
            onDeleted={() => {
              setFlows((fs) => fs.filter((f) => f.id !== current.id))
              setSelected(null)
              setOpen(false)
              refreshOverview()
            }}
          />
        ) : null}
      </SplitDetail>
    </SplitRoot>
  )
}

function Group({ label }: { label: string }) {
  return <div className="px-2 pb-1 pt-2.5 text-[11.5px] text-dim">{label}</div>
}

function ListRow({ flow, active, selected, status, onSelect }: { flow: Workflow; active: boolean; selected: boolean; status: WorkflowRun['status'] | undefined; onSelect(): void }) {
  const when = scheduleSentence(flow.cron, flow.automation?.watch ?? null)
  const running = status === 'running'
  return (
    <button
      type="button"
      data-id={flow.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={clsx('grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-left mobile:min-h-[56px]', selected ? 'bg-elev' : 'hover:bg-panel', FOCUS)}
    >
      <span aria-hidden="true" className={clsx('h-2 w-2 rounded-full', running ? 'bg-warn ring-[3px] ring-warn/20' : active ? 'bg-ok' : 'bg-line-strong')} />
      <span className="min-w-0">
        <span className={clsx('block truncate text-[13px] font-semibold', !active && 'text-muted')} title={flow.name}>
          {flow.name}
        </span>
        <span className="block truncate text-[12px] text-dim" title={when}>
          {when}
        </span>
      </span>
      <span className={clsx('whitespace-nowrap text-[11px] font-semibold', running ? 'font-normal text-muted' : status === 'ok' ? 'text-ok' : 'text-crimson-hi')}>
        {running ? 'Running' : status === 'ok' ? 'Done' : status === 'error' ? 'Failed' : ''}
      </span>
    </button>
  )
}
