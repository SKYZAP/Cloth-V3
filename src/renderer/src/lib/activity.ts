import type { SubagentRun, TodoItem, ToolTrace, UiBlock } from '@shared/types'

/** One item of an assistant turn: a block shown as-is, a run of thinking and tool calls folded into one line, or the
 * run card: the turn's todo list with the work done for each step under it. */
export type TurnItem = { kind: 'block'; i: number } | { kind: 'group'; key: string; indices: number[] } | { kind: 'run'; key: string; plan: RunPlan }

/** The items of a todo_write call. */
export function todosOf(args: unknown): TodoItem[] {
  const list = (args as { todos?: unknown })?.todos
  return Array.isArray(list) ? list.filter((t): t is TodoItem => !!t && typeof (t as TodoItem).content === 'string') : []
}

/** One step of a run card: a todo item as the latest list has it, and the blocks done while it was the current step. */
export interface RunStep {
  text: string
  status: TodoItem['status']
  indices: number[]
}

export interface RunPlan {
  steps: RunStep[]
  /** Where the card goes: the turn's first todo_write. */
  at: number
  /** Every block the card shows (its steps' blocks) or replaces (the todo_write calls). */
  claimed: Set<number>
}

/** Blocks a run card takes into its steps: thinking, ordinary tool calls, questions and agent runs. Other cards
 * (images, swatches, plans, rounds, gates) stay in the reply. */
const stepBlock = (b: UiBlock): boolean => b.type === 'thinking' || (b.type === 'tool' && b.trace.name !== 'todo_write' && (!ownCard(b.trace) || b.trace.name === 'ask_user' || !!b.trace.subagent || b.trace.name === 'task'))

/**
 * The run card for a turn that keeps a todo list of two or more items, or null. Each block after the first
 * todo_write belongs to the step that was current when it ran: the item in progress, else the first one not done.
 * Once every item is done, later blocks stay in the reply as an ordinary group (the wrap-up). Steps are matched by
 * their text, then by position, so a list the agent rewords keeps its work.
 */
export function planRun(blocks: UiBlock[], lastTodoIdx: number): RunPlan | null {
  if (lastTodoIdx < 0) return null
  const last = blocks[lastTodoIdx]
  const final = last?.type === 'tool' ? todosOf(last.trace.args) : []
  if (final.length < 2) return null
  const steps: RunStep[] = final.map((t) => ({ text: t.content, status: t.status, indices: [] }))
  const claimed = new Set<number>()
  let at = -1
  let current: number | null = null
  blocks.forEach((b, i) => {
    if (b.type === 'tool' && b.trace.name === 'todo_write') {
      if (at < 0) at = i
      claimed.add(i)
      const list = todosOf(b.trace.args)
      let k = list.findIndex((t) => t.status === 'in_progress')
      if (k < 0) k = list.findIndex((t) => t.status !== 'completed')
      if (k < 0) current = null
      else {
        const byText = final.findIndex((t) => t.content === list[k].content)
        current = byText >= 0 ? byText : k < steps.length ? k : null
      }
      return
    }
    if (at < 0 || current === null || !stepBlock(b)) return
    steps[current].indices.push(i)
    claimed.add(i)
  })
  return { steps, at, claimed }
}

/** The step a live run is on: the one in progress, else the first not done (-1: all done). */
export const currentStep = (plan: RunPlan): number => {
  const k = plan.steps.findIndex((s) => s.status === 'in_progress')
  return k >= 0 ? k : plan.steps.findIndex((s) => s.status !== 'completed')
}

/** Tools that keep their own card: the plan, images, swatches, questions, Spec → Ship rounds and gates, and subagents. */
export const ownCard = (t: ToolTrace): boolean => t.name === 'todo_write' || t.name === 'generate_image' || t.name === 'ask_user' || t.name === 'task' || !!t.subagent || !!t.plan || !!t.questions || !!t.stageGate || !!t.openspecStep || !!t.swatch

/**
 * Folds every run of thinking and ordinary tool blocks into one activity group. Text and own-card
 * tools end a run; todo_write calls other than the latest (`lastTodoIdx`) are dropped. A turn with a todo list of
 * two or more items gets the run card (planRun) where the list first appeared, holding the work done for each step.
 */
export function groupTurn(blocks: UiBlock[], lastTodoIdx: number, plan: RunPlan | null = planRun(blocks, lastTodoIdx)): TurnItem[] {
  const out: TurnItem[] = []
  let run: number[] = []
  const flush = () => {
    if (run.length) {
      const first = blocks[run[0]]
      out.push({ kind: 'group', key: first.type === 'tool' ? first.trace.id : `think:${run[0]}`, indices: run })
    }
    run = []
  }
  blocks.forEach((b, i) => {
    if (plan && i === plan.at) {
      flush()
      out.push({ kind: 'run', key: b.type === 'tool' ? `run:${b.trace.id}` : `run:${i}`, plan })
      return
    }
    if (plan?.claimed.has(i)) return
    if (b.type === 'tool' && b.trace.name === 'todo_write' && i !== lastTodoIdx) return
    if (b.type === 'thinking' || (b.type === 'tool' && !ownCard(b.trace))) return void run.push(i)
    flush()
    out.push({ kind: 'block', i })
  })
  flush()
  return out
}

export interface ChangedFile {
  path: string
  added: number
  removed: number
  /** Every change to this file was undone. */
  undone: boolean
}

/** Files a turn's tool calls changed, one row per file, and the calls that can still be undone (newest first). */
export function changedFiles(traces: ToolTrace[]): { files: ChangedFile[]; added: number; removed: number; undoable: string[] } {
  const byPath = new Map<string, ChangedFile>()
  for (const t of traces)
    for (const c of t.changes ?? []) {
      const f = byPath.get(c.path) ?? { path: c.path, added: 0, removed: 0, undone: true }
      f.added += c.added
      f.removed += c.removed
      f.undone &&= !!c.undone
      byPath.set(c.path, f)
    }
  const files = [...byPath.values()]
  // Same rule as a trace card's Undo button. A checkpoint refuses to restore a file changed again
  // since, so several edits to one file only undo cleanly newest-first.
  const undoable = traces.filter((t) => (t.changes ?? []).length > 0 && !(t.changes ?? []).every((c) => c.undone)).map((t) => t.id).reverse()
  return { files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), undoable }
}

/** Line counts, total time and failures of a group's tool calls. */
export function activityStats(traces: ToolTrace[]): { ms: number; added: number; removed: number; changed: boolean; failed: number } {
  const changes = traces.flatMap((t) => t.changes ?? [])
  return {
    ms: traces.reduce((n, t) => n + (t.durationMs ?? 0), 0),
    added: changes.reduce((n, c) => n + c.added, 0),
    removed: changes.reduce((n, c) => n + c.removed, 0),
    changed: changes.length > 0,
    failed: traces.filter((t) => t.status === 'error').length
  }
}

/** Seconds on a live timer: 6s, 1m 5s. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** How many tool calls a subagent run has made. */
export const runStepCount = (run: Pick<SubagentRun, 'blocks'>): number => run.blocks.filter((b) => b.type === 'tool').length

/** What a running agent is on: its latest tool call, thinking, or nothing yet (queued). */
export type RunNow = { kind: 'queued' } | { kind: 'thinking' } | { kind: 'tool'; trace: ToolTrace }

export function runNow(blocks: UiBlock[]): RunNow {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type === 'tool') return { kind: 'tool', trace: b.trace }
    if (b.type === 'thinking') return { kind: 'thinking' }
  }
  return { kind: 'queued' }
}

/** A run's steps (tool calls and thinking): the last `n`, or all of them, and how many earlier ones are left out. */
export function recentSteps(blocks: UiBlock[], n: number, all = false): { steps: UiBlock[]; earlier: number; offset: number } {
  const steps = blocks.filter((b) => b.type === 'tool' || b.type === 'thinking')
  if (all || steps.length <= n) return { steps, earlier: 0, offset: 0 }
  const offset = steps.length - n
  // Counted like the line's "N steps": tool calls only, not thinking.
  return { steps: steps.slice(-n), earlier: steps.slice(0, offset).filter((b) => b.type === 'tool').length, offset }
}

/** Every tool call id inside a run, nested runs included. */
export function runToolIds(blocks: UiBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === 'tool' ? [b.trace.id, ...(b.trace.subagent ? runToolIds(b.trace.subagent.blocks) : [])] : []))
}

export type RunState = 'running' | 'done' | 'partial' | 'blocked' | 'failed'

/** Where a `task` run stands: still going, or how it ended (a failed call wins over the report's outcome). */
export function runState(trace: Pick<ToolTrace, 'status'> & { subagent?: Pick<SubagentRun, 'running' | 'outcome'> }): RunState {
  if (trace.status === 'error') return 'failed'
  if (trace.subagent?.running || trace.status === 'running') return 'running'
  const o = trace.subagent?.outcome
  return o === 'partial' ? 'partial' : o === 'blocked' ? 'blocked' : 'done'
}
