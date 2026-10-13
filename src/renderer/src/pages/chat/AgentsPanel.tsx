import { useMemo } from 'react'
import clsx from 'clsx'
import type { UiMessage } from '@shared/types'
import { formatCost, formatTokens } from '@/lib/format'
import { chatAgents, runAccess, shortfall, type RunInfo } from '@/lib/workbar'
import { scrollToRun } from '@/components/WorkBar'

function RunRow({ run }: { run: RunInfo }) {
  const short = shortfall(run)
  return (
    <button onClick={() => scrollToRun(run.cardId)} className="block w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-elev" title="Show this run in the chat">
      <div className="flex items-center gap-2 text-[12.5px]">
        <span
          className={clsx(
            'h-2 w-2 shrink-0 rounded-full',
            run.status === 'running' ? 'animate-pulse bg-warn' : run.outcome === 'partial' ? 'bg-warn' : run.status === 'done' && run.outcome !== 'blocked' ? 'bg-ok' : 'bg-crimson'
          )}
          aria-label={run.status === 'running' ? 'Running' : (short ?? (run.status === 'done' ? 'Done' : 'Failed'))}
        />
        <span className="min-w-0 truncate text-fg">{run.name}</span>
        {short && <span className={clsx('shrink-0 text-[10.5px]', run.outcome === 'partial' ? 'text-warn' : 'text-crimson-hi')}>{short}</span>}
        {run.tierName && <span className="shrink-0 rounded-full bg-agent-soft px-1.5 py-px text-[10.5px] text-agent">{run.tierName}</span>}
        <span className={clsx('shrink-0 text-[11px]', run.role === 'worker' ? 'text-warn' : 'text-dim')}>{runAccess(run.role)}</span>
        <div className="flex-1" />
        {run.cost > 0 && <span className="shrink-0 font-mono text-[11px] tabular-nums text-dim">{formatCost(run.cost)}</span>}
      </div>
      <div className="mt-0.5 truncate pl-4 font-mono text-[11px] text-dim">
        {run.model ? `${run.model} · ` : ''}
        {formatTokens(run.tokensIn)} in / {formatTokens(run.tokensOut)} out
      </div>
      {run.status === 'running'
        ? run.current && (
            <div className="mt-0.5 truncate pl-4 text-[11.5px] text-muted">
              Now: {run.current.tool} {run.current.summary}
            </div>
          )
        : ((run.stepText && run.step !== undefined) || run.files.length > 0) && (
            <div className="mt-0.5 flex gap-2 pl-4 text-[11.5px] text-muted">
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[12.5px] font-semibold">Agents</span>
        <div className="flex-1" />
        {cost > 0 && <span className="font-mono text-[11px] tabular-nums text-dim">{formatCost(cost)}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {runs.length ? (
          runs.map((r) => <RunRow key={r.id} run={r} />)
        ) : (
          <p className="px-3 py-6 text-center text-[12.5px] leading-relaxed text-dim">No agents yet. When Cloth hands work to an agent, it shows here with what it's doing and what it costs.</p>
        )}
      </div>
    </div>
  )
}
