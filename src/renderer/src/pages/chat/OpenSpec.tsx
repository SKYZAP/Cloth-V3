import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import { ArrowSquareOut, CheckCircle, FileText, FolderSimple, GitPullRequest, Pause, Stop } from '@phosphor-icons/react'
import { OPENSPEC_STEP_LABEL, OPENSPEC_STEPS, type OpenSpecRun, type OpenSpecStepReport, type ToolTrace } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { Switch } from '@/components/ui'

const ENTER = { type: 'spring', stiffness: 260, damping: 28 } as const

/** OpenSpec mode's progress above the message box: the seven steps, the change, tasks, and the run's two controls. */
export function OpenSpecBar({ run, running, onWait, onStop }: { run: OpenSpecRun; running: boolean; onWait(on: boolean): void; onStop(): void }) {
  const at = run.step === 'done' ? OPENSPEC_STEPS.length : OPENSPEC_STEPS.indexOf(run.step)
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={ENTER} className="rounded-[14px] border border-ospec-line bg-card px-3 pb-2.5 pt-2 shadow-[0_12px_32px_-14px_rgb(0_0_0/0.8)]" role="group" aria-label="OpenSpec progress">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-caption">
        <span className="flex items-center gap-1.5 font-semibold text-ospec">
          <FileText size={13} weight="bold" /> OpenSpec
        </span>
        {run.change && <span className="font-mono text-muted">{run.change}</span>}
        {run.tasks && run.tasks.total > 0 && (
          <span className="tabular-nums text-dim">
            tasks {run.tasks.done} of {run.tasks.total}
          </span>
        )}
        {run.awaitingReview && <span className="font-medium text-warn">Waiting for you to read the proposal. Reply to carry on.</span>}
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-dim" title="Stop after the proposal validates, so you can read it before anything is built">
            <Pause size={12} /> Wait for me after Propose
            <Switch checked={run.waitAfterPropose} onChange={onWait} ariaLabel="Wait for me after Propose" />
          </span>
          <button onClick={onStop} className="flex h-6 items-center gap-1 rounded-md border border-line px-2 text-dim transition-colors hover:border-line-strong hover:text-fg" title={running ? 'Stop the run and leave OpenSpec mode' : 'Leave OpenSpec mode'}>
            <Stop size={11} weight="fill" /> {running ? 'Stop' : 'Leave'}
          </button>
        </span>
      </div>
      <div className="flex gap-1" aria-label={`Step ${Math.min(at + 1, OPENSPEC_STEPS.length)} of ${OPENSPEC_STEPS.length}: ${OPENSPEC_STEP_LABEL[run.step]}`}>
        {OPENSPEC_STEPS.map((s, i) => {
          const done = i < at
          const now = i === at
          return (
            <div key={s} className={clsx('flex min-w-0 flex-1 flex-col gap-1 text-micro', done ? 'text-muted' : now ? 'font-semibold text-ospec' : 'text-dim')}>
              <span className={clsx('h-1 rounded-full', done ? 'bg-ospec' : now ? (running ? 'animate-pulse bg-ospec' : 'bg-ospec') : 'bg-line-strong')} />
              <span className="truncate">
                {OPENSPEC_STEP_LABEL[s]}
                {s === 'apply' && now && run.tasks?.total ? ` · ${run.tasks.done}/${run.tasks.total}` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </motion.div>
  )
}

/** One reported step in the conversation: a divider with the step's name, then what it did. */
export function OpenSpecStepCard({ trace, fresh }: { trace: ToolTrace; fresh: boolean }) {
  const r = trace.openspecStep as OpenSpecStepReport
  const done = r.step === 'done'
  return (
    <motion.div initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={ENTER} className="my-4">
      <div className="mb-2 flex items-center gap-2.5 text-micro font-semibold uppercase tracking-[0.07em] text-ospec">
        <span className="h-px flex-1 bg-ospec-line" />
        {done ? 'OpenSpec done' : OPENSPEC_STEP_LABEL[r.step]}
        <span className="h-px flex-1 bg-ospec-line" />
      </div>
      <div className="rounded-xl border border-line bg-card px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-ui">
          {done ? <CheckCircle size={15} weight="fill" className="text-ok" /> : <FileText size={15} className="text-ospec" />}
          {r.change && <span className="font-mono text-caption text-muted">{r.change}</span>}
          {r.tasks && r.tasks.total > 0 && (
            <span className="ml-auto text-caption tabular-nums text-dim">
              tasks {r.tasks.done} of {r.tasks.total}
            </span>
          )}
        </div>
        <p className="selectable mt-1 text-body leading-relaxed text-fg">{r.summary}</p>
        {r.tasks && r.tasks.total > 0 && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-elev-2" aria-hidden="true">
            <div className="h-full rounded-full bg-ospec transition-[width] duration-500" style={{ width: `${Math.round((r.tasks.done / r.tasks.total) * 100)}%` }} />
          </div>
        )}
        {r.pr && (
          <a href={r.pr} target="_blank" rel="noreferrer" className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-lg border border-ospec-line bg-ospec-soft px-2.5 text-caption font-semibold text-ospec hover:bg-ospec/15">
            <GitPullRequest size={13} /> Open the pull request <ArrowSquareOut size={11} />
          </a>
        )}
      </div>
    </motion.div>
  )
}

interface ChangeRow {
  name: string
  completedTasks?: number
  totalTasks?: number
  status?: string
}

/** The side panel's OpenSpec tab: the folder's changes with their task progress, and its specs. */
export function OpenSpecPanel({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.panel.openspec>> | null>(null)
  const load = () => void api.panel.openspec(sessionId).then(setData, (err: unknown) => setData({ initialised: false, changes: null, specs: null, error: err instanceof Error ? err.message : String(err) }))
  useEffect(() => {
    if (visible) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, visible])
  useEvent('chat', (e) => e.sessionId === sessionId && (e.type === 'end' || e.type === 'setup') && visible && load())
  if (!data) return <div className="p-4 text-caption text-dim">Loading…</div>
  if (!data.initialised)
    return (
      <div className="grid gap-2 p-4 text-ui text-muted">
        <p>{data.error ?? 'This folder has no openspec/ folder yet.'}</p>
        {!data.error && <p className="text-caption text-dim">Pick OpenSpec in the message box's mode menu: its first step sets the folder up.</p>}
      </div>
    )
  const changes = pick<ChangeRow>(data.changes, 'changes')
  const specs = pick<{ id?: string; name?: string; requirementCount?: number }>(data.specs, 'specs')
  return (
    <div className="h-full overflow-y-auto p-3">
      {data.error && <p className="mb-3 rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-caption text-danger-hi">{data.error}</p>}
      <h3 className="mb-1.5 px-1 text-micro font-semibold uppercase tracking-[0.07em] text-dim">Changes</h3>
      <div className="mb-4 overflow-hidden rounded-xl border border-line">
        {changes.length ? (
          changes.map((c) => {
            const total = c.totalTasks ?? 0
            const done = c.completedTasks ?? 0
            return (
              <div key={c.name} className="flex items-center gap-2 border-line px-3 py-2 text-ui [&+&]:border-t">
                <FolderSimple size={14} className="shrink-0 text-dim" />
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg">{c.name}</span>
                {total > 0 && <span className={clsx('shrink-0 font-mono text-micro tabular-nums', done === total ? 'text-ok' : 'text-info')}>{done}/{total}</span>}
              </div>
            )
          })
        ) : (
          <p className="px-3 py-3 text-caption text-dim">No active changes.</p>
        )}
      </div>
      <h3 className="mb-1.5 px-1 text-micro font-semibold uppercase tracking-[0.07em] text-dim">Specs</h3>
      <div className="overflow-hidden rounded-xl border border-line">
        {specs.length ? (
          specs.map((sp) => (
            <div key={sp.id ?? sp.name} className="flex items-center gap-2 border-line px-3 py-2 text-ui [&+&]:border-t">
              <FileText size={14} className="shrink-0 text-dim" />
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg">{sp.id ?? sp.name}</span>
              {sp.requirementCount !== undefined && <span className="shrink-0 text-micro tabular-nums text-dim">{sp.requirementCount} req</span>}
            </div>
          ))
        ) : (
          <p className="px-3 py-3 text-caption text-dim">No specs yet. Archiving a change merges its specs here.</p>
        )}
      </div>
    </div>
  )
}

/** `openspec list --json` output is an object with a list under `key`, or the list itself. */
function pick<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>)[key])) return (raw as Record<string, T[]>)[key]
  return []
}
