import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import type { Agent, AgentActivity } from '@shared/types'
import { Tile } from './Tile'

const EASE_OUT = [0.2, 0.8, 0.2, 1] as const

/** Skills always on for the agent. */
export const alwaysSkills = (a: Agent) => (a.skillsEnabled || a.skillsAlways.length ? a.skillsAlways : [])

const yes = (v: boolean) => (v ? true : false)

const ROWS: { label: string; cell(a: Agent, act?: AgentActivity): boolean | ReactNode }[] = [
  { label: 'Reads files', cell: () => true },
  { label: 'Edits files', cell: (a) => yes(a.fileAccess === 'write') },
  { label: 'Runs commands', cell: (a) => yes(a.fileAccess === 'write' && !!a.shell) },
  { label: 'Web', cell: (a) => yes(!!a.webEnabled) },
  { label: 'Knowledge', cell: (a) => yes(!!a.knowledgeEnabled) },
  { label: 'MCP servers', cell: (a) => (a.mcpServers?.some((x) => !x.startsWith('!')) ? <span className="text-muted tabular-nums">{a.mcpServers.filter((x) => !x.startsWith('!')).length}</span> : false) },
  {
    label: 'Always-on skills',
    cell: (a) => {
      const s = alwaysSkills(a)
      return s.length ? (
        <span className="inline-flex items-center gap-1.5 text-skill tabular-nums" title={s.join(', ')}>
          <span className="h-2.5 w-2.5 rounded-full bg-skill" />
          {s.length}
        </span>
      ) : (
        false
      )
    }
  },
  { label: 'Model', cell: (a) => <span className="text-caption text-muted">{a.model ? a.model.modelId : "Chat's"}</span> },
  { label: 'Jobs this week', cell: (_a, act) => <span className="text-muted tabular-nums">{act?.jobs ?? 0}</span> }
]

/**
 * The team side by side: one column per agent, one row per thing it may use, so "who can run commands?"
 * is a single row. The tiles arrive from their cards; the cells fill column by column after them.
 */
export function CompareTable({ agents, activity, selected, onOpen }: { agents: Agent[]; activity: Record<string, AgentActivity>; selected: string | null; onOpen(id: string): void }) {
  const [col, setCol] = useState<number | null>(null)
  return (
    <div className="col-span-full overflow-x-auto rounded-[12px] border border-line" onMouseLeave={() => setCol(null)}>
      <table className="w-full min-w-[560px] border-collapse text-ui">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-[1] border-b border-line bg-panel px-3 py-2.5 text-left align-bottom text-caption font-medium text-dim">
              Can it…
            </th>
            {agents.map((a, c) => (
              <th key={a.id} scope="col" onMouseEnter={() => setCol(c)} className={clsx('border-b border-line bg-panel px-3 py-2.5 align-bottom', col === c && 'bg-elev')}>
                <button
                  type="button"
                  data-focus-key={a.id}
                  onClick={() => onOpen(a.id)}
                  aria-haspopup="dialog"
                  aria-expanded={selected === a.id}
                  className="mx-auto grid max-w-[130px] justify-items-center gap-1.5 rounded-[8px] p-1 text-caption font-semibold outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-crimson-line"
                >
                  <Tile name={a.name} builtin={a.builtin} layoutId={`agent-tile-${a.id}`} />
                  <span className="max-w-full truncate">{a.name}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r, ri) => (
            <tr key={r.label} className="group">
              <th scope="row" className="sticky left-0 z-[1] whitespace-nowrap border-b border-line bg-bg px-3 py-2 text-left font-medium text-muted group-last:border-b-0 group-hover:text-fg">
                {r.label}
              </th>
              {agents.map((a, c) => {
                const v = r.cell(a, activity[a.id])
                return (
                  <td
                    key={a.id}
                    onMouseEnter={() => setCol(c)}
                    className={clsx('border-b border-line px-3 py-2 text-center group-last:border-b-0 group-hover:bg-fg/[0.02]', col === c && 'bg-elev/60')}
                  >
                    <motion.span
                      className="inline-flex items-center justify-center"
                      initial={{ opacity: 0, scale: 0.3 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.26, delay: 0.32 + c * 0.06 + ri * 0.018, ease: EASE_OUT }}
                    >
                      {v === true ? (
                        <span className="h-2.5 w-2.5 rounded-full bg-muted" role="img" aria-label="Yes" />
                      ) : v === false ? (
                        <span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-line-strong" role="img" aria-label="No" />
                      ) : (
                        v
                      )}
                    </motion.span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** Seven small bars, oldest first, today in crimson; heights share one scale across the team. */
export function WeekStrip({ days, max }: { days: number[]; max: number }) {
  const total = days.reduce((a, b) => a + b, 0)
  const today = new Date()
  return (
    <span className="flex h-[18px] items-end gap-[3px]" role="img" aria-label={`${total} job${total === 1 ? '' : 's'} in the last 7 days`}>
      {days.map((n, i) => {
        const d = new Date(today)
        d.setDate(today.getDate() - (6 - i))
        return (
          <motion.span
            key={i}
            title={`${DAY.format(d)}: ${n} job${n === 1 ? '' : 's'}`}
            className={clsx('min-h-[2px] flex-1 origin-bottom rounded-[1.5px]', i === 6 ? (n ? 'bg-fg' : 'bg-line-strong') : n ? 'bg-muted/50' : 'bg-line-strong')}
            style={{ height: n ? `${Math.max(18 * (n / Math.max(max, 1)), 4)}px` : '2px' }}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.38, delay: 0.2 + i * 0.035, ease: EASE_OUT }}
          />
        )
      })}
    </span>
  )
}
