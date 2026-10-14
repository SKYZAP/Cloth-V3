// Pure helpers behind the chat's work bar and the side panel's Agents tab: which agent runs a chat has,
// how they line up with the todo list, and what they cost.
import type { SubagentActivity, SubagentRun, TodoItem, ToolTrace, UiBlock, UiMessage } from '@shared/types'
import { agentCost } from './agentCost'

export type RunStatus = 'running' | 'done' | 'failed'

/** One `task` run as the bar and the Agents tab show it. */
export interface RunInfo {
  /** The task trace's id. */
  id: string
  /** The id of the top-level trace whose card shows this run (itself, or the run it is nested in). */
  cardId: string
  /** The saved agent's name, else "Scout" or "Worker" for a plain job (see runName). */
  name: string
  /** Whether a saved agent ran (vs a plain job). */
  named: boolean
  role: SubagentRun['role']
  tierName?: string
  model?: string
  description: string
  status: RunStatus
  /** What a finished run's report says it achieved (none = done or no `Result:` line). */
  outcome?: SubagentRun['outcome']
  cost: number
  /** Uncached plus cached input tokens. */
  tokensIn: number
  tokensOut: number
  step?: number
  stepText?: string
  current?: SubagentActivity
  files: string[]
}

export const runCardId = (traceId: string) => `run-${traceId}`

/** What a run is called: the saved agent that ran, else "Scout" or "Worker" for a plain job. */
export const runName = (run: Pick<SubagentRun, 'agent' | 'role'>): string => run.agent ?? (run.role === 'worker' ? 'Worker' : 'Scout')

/** What a run may do with files: "Reader" (scout, read-only) or "Editor" (worker, can edit). */
export const runAccess = (role: SubagentRun['role']): string => (role === 'worker' ? 'Editor' : 'Reader')

/** How a finished run that fell short is labelled: "Partly done" or "Blocked" (null otherwise). */
export const shortfall = (r: RunInfo): string | null => (r.outcome === 'partial' ? 'Partly done' : r.outcome === 'blocked' ? 'Blocked' : null)

function runInfo(trace: ToolTrace, run: SubagentRun, cardId: string): RunInfo {
  const status: RunStatus = trace.status === 'error' ? 'failed' : run.running || trace.status === 'running' ? 'running' : 'done'
  return {
    id: trace.id,
    cardId,
    name: runName(run),
    named: !!run.agent,
    role: run.role,
    tierName: run.tierName,
    model: run.model,
    description: run.description,
    status,
    outcome: status === 'done' ? run.outcome : undefined,
    cost: run.usage?.cost ?? 0,
    tokensIn: (run.usage?.input ?? 0) + (run.usage?.cached ?? 0),
    tokensOut: run.usage?.output ?? 0,
    step: run.step,
    stepText: run.stepText,
    current: status === 'running' ? run.current : undefined,
    files: run.files ?? []
  }
}

/** Every agent run in these blocks, nested runs included, in the order they started. */
export function collectRuns(blocks: UiBlock[], cardId?: string): RunInfo[] {
  const out: RunInfo[] = []
  for (const b of blocks) {
    if (b.type !== 'tool' || !b.trace.subagent) continue
    const card = cardId ?? b.trace.id
    out.push(runInfo(b.trace, b.trace.subagent, card))
    out.push(...collectRuns(b.trace.subagent.blocks, card))
  }
  return out
}

/** The todos of the last todo_write in these blocks (null without one). */
function todosIn(blocks: UiBlock[]): TodoItem[] | null {
  for (let j = blocks.length - 1; j >= 0; j--) {
    const b = blocks[j]
    if (b.type === 'tool' && b.trace.name === 'todo_write' && b.trace.status !== 'error') {
      const list = (b.trace.args as { todos?: unknown })?.todos
      return Array.isArray(list) ? list.filter((t): t is TodoItem => !!t && typeof (t as TodoItem).content === 'string') : []
    }
  }
  return null
}

/** The current turn: the latest assistant reply, as long as the user hasn't sent another message after it. */
export function currentTurn(messages: UiMessage[]): UiMessage | null {
  const last = messages.at(-1)
  return last && last.role === 'assistant' && !last.archived ? last : null
}

export type StepStatus = TodoItem['status'] | 'failed'

export interface BarRow {
  key: string
  /** The step number (1-based) with a todo list. */
  n?: number
  text: string
  status: StepStatus
  /** The latest run for this step (or the row's own run without a todo list). */
  run?: RunInfo
  /** How many runs worked on this step. */
  runs: number
}

export interface WorkBar {
  /** Whether the bar follows a todo list or just the turn's agent runs. */
  mode: 'todos' | 'agents'
  /** The step in progress or next up; null when every step is done (or without a todo list). */
  current: string | null
  done: number
  total: number
  /** Agent runs in the turn (top-level and nested). */
  runCount: number
  /** What the turn cost: the reply itself plus its agents. */
  cost: number
  rows: BarRow[]
  /** Segment counts for the progress bar. */
  progress: { completed: number; inProgress: number; rest: number }
}

/** Todos for a turn: its own todo_write, else (when its runs name steps) the plan from earlier in the chat. */
function turnTodos(messages: UiMessage[], turn: UiMessage, runs: RunInfo[]): TodoItem[] | null {
  const own = todosIn(turn.blocks)
  if (own) return own.length ? own : null
  if (!runs.some((r) => r.step !== undefined)) return null
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i]
    if (m.archived) break
    const t = todosIn(m.blocks)
    if (t) return t.length ? t : null
  }
  return null
}

const runStatusToStep = (s: RunStatus): StepStatus => (s === 'running' ? 'in_progress' : s === 'done' ? 'completed' : 'failed')

/** The work bar for the chat, or null when the current turn has no todo list and no agent runs. */
export function buildWorkBar(messages: UiMessage[]): WorkBar | null {
  const turn = currentTurn(messages)
  if (!turn) return null
  const runs = collectRuns(turn.blocks)
  const todos = turnTodos(messages, turn, runs)
  if (!todos && !runs.length) return null
  const cost = (turn.usage?.cost ?? 0) + agentCost(turn)

  if (todos) {
    const rows: BarRow[] = todos.map((t, i) => {
      const n = i + 1
      const mine = runs.filter((r) => r.step === n)
      return { key: `step-${n}`, n, text: t.content, status: t.status, run: mine.at(-1), runs: mine.length }
    })
    const completed = todos.filter((t) => t.status === 'completed').length
    const inProgress = todos.filter((t) => t.status === 'in_progress').length
    const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending')
    return {
      mode: 'todos',
      current: current?.content ?? null,
      done: completed,
      total: todos.length,
      runCount: runs.length,
      cost,
      rows,
      progress: { completed, inProgress, rest: todos.length - completed - inProgress }
    }
  }

  const rows: BarRow[] = runs.map((r) => ({ key: r.id, text: r.description, status: runStatusToStep(r.status), run: r, runs: 1 }))
  const completed = runs.filter((r) => r.status === 'done').length
  const inProgress = runs.filter((r) => r.status === 'running').length
  return {
    mode: 'agents',
    current: null,
    done: completed,
    total: runs.length,
    runCount: runs.length,
    cost,
    rows,
    progress: { completed, inProgress, rest: runs.length - completed - inProgress }
  }
}

export type SegmentStatus = 'completed' | 'in_progress' | 'pending' | 'failed'

/** One meter segment per step, in step order: the todo rows' statuses, or one per run (running = in progress, failed = failed, otherwise completed). */
export function barSegments(bar: Pick<WorkBar, 'rows'>): SegmentStatus[] {
  return bar.rows.map((r) => (r.status === 'in_progress' ? 'in_progress' : r.status === 'pending' ? 'pending' : r.status === 'failed' ? 'failed' : 'completed'))
}

/** Every agent run in the chat, newest first, and what they cost together. */
export function chatAgents(messages: UiMessage[]): { runs: RunInfo[]; cost: number } {
  const runs = messages.flatMap((m) => (m.role === 'assistant' ? collectRuns(m.blocks) : []))
  return { runs: runs.reverse(), cost: runs.reduce((sum, r) => sum + r.cost, 0) }
}
