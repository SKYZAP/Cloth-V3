import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { UiMessage } from '@shared/types'
import { formatCost, formatTokens } from '@/lib/format'
import { chatAgents, runAbout, shortfall, type RunInfo } from '@/lib/workbar'
import { scrollToRun } from '@/components/WorkBar'
import { takeAgentRun, useSetupNav } from './setupNav'

function RunRow({ run, focused }: { run: RunInfo; focused?: boolean }) {
  const short = shortfall(run)
  return (
    <button
      data-run={run.id}
      onClick={() => scrollToRun(run.cardId)}
      className={clsx('block w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-elev', focused && 'bg-elev')}
      title="Show this run in the chat"
    >
      <div className="flex items-center gap-2 text-ui">
        <span
          className={clsx(
            'h-2 w-2 shrink-0 rounded-full',
            run.status === 'running' ? 'animate-pulse bg-warn' : run.outcome === 'partial' ? 'bg-warn' : run.status === 'done' && run.outcome !== 'blocked' ? 'bg-ok' : 'bg-danger'
          )}
          aria-label={run.status === 'running' ? 'Running' : (short ?? (run.status === 'done' ? 'Done' : 'Failed'))}
        />
        <span className="min-w-0 truncate text-fg" title={runAbout(run)}>
          {run.name}
        </span>
        {short && <span className={clsx('shrink-0 text-micro', run.outcome === 'partial' ? 'text-warn' : 'text-danger-hi')}>{short}</span>}
        <div className="flex-1" />
        {run.cost > 0 && <span className="shrink-0 font-mono text-caption tabular-nums text-dim">{formatCost(run.cost)}</span>}
      </div>
      <div className="mt-0.5 truncate pl-4 font-mono text-caption text-dim">
        {run.model ? `${run.model} · ` : ''}
        {run.tierName ? `${run.tierName} effort · ` : ''}
        {formatTokens(run.tokensIn)} in / {formatTokens(run.tokensOut)} out
      </div>
      {run.status === 'running'
        ? run.current && (
            <div className="mt-0.5 truncate pl-4 text-caption text-muted">
              Now: {run.current.tool} {run.current.summary}
            </div>
          )
        : ((run.stepText && run.step !== undefined) || run.files.length > 0) && (
            <div className="mt-0.5 flex gap-2 pl-4 text-caption text-muted">
              {run.stepText && run.step !== undefined && <span className="min-w-0 truncate">for step {run.step}: {run.stepText}</span>}
              {run.files.length > 0 && (
                <span className="shrink-0 text-dim" title={run.files.join('\n')}>
                  {run.files.length} file{run.files.length === 1 ? '' : 's'} changed
                </span>
              )}
            </div>
          )}
    </button>
  )
}

/** Every agent run in this chat: what it is doing or did, and what it cost. */
export function AgentsPanel({ messages }: { messages: UiMessage[] }) {
  const { runs, cost } = useMemo(() => chatAgents(messages), [messages])
  // openAgentRun(): scroll to that run and mark it for a moment.
  const pending = useSetupNav((s) => s.run)
  const list = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<string | null>(null)
  useEffect(() => {
    if (!pending) return
    takeAgentRun(pending.seq)
    setFocused(pending.id)
    const el = list.current?.querySelector<HTMLElement>(`[data-run="${CSS.escape(pending.id)}"]`)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    el?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
    el?.focus({ preventScroll: true })
  }, [pending])
  useEffect(() => {
    if (!focused) return
    const t = window.setTimeout(() => setFocused(null), 1600)
    return () => window.clearTimeout(t)
  }, [focused])
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-ui font-semibold">Agents</span>
        <div className="flex-1" />
        {cost > 0 && <span className="font-mono text-caption tabular-nums text-dim">{formatCost(cost)}</span>}
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {runs.length ? (
          runs.map((r) => <RunRow key={r.id} run={r} focused={r.id === focused} />)
        ) : (
          <p className="px-3 py-6 text-center text-ui leading-relaxed text-dim">No agents yet.</p>
        )}
      </div>
    </div>
  )
}
