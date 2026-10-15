import type { SubagentRun, ToolTrace, UiBlock } from '@shared/types'

/** One item of an assistant turn: a block shown as-is, or a run of thinking and tool calls folded into one line. */
export type TurnItem = { kind: 'block'; i: number } | { kind: 'group'; key: string; indices: number[] }

/** Tools that keep their own card: the plan, images, questions, Spec → ship rounds and gates, and subagents. */
export const ownCard = (t: ToolTrace): boolean => t.name === 'todo_write' || t.name === 'generate_image' || t.name === 'ask_user' || t.name === 'task' || !!t.subagent || !!t.plan || !!t.questions || !!t.stageGate

/**
 * Folds every run of thinking and ordinary tool blocks into one activity group. Text and own-card
 * tools end a run; todo_write calls other than the latest (`lastTodoIdx`) are dropped.
 */
export function groupTurn(blocks: UiBlock[], lastTodoIdx: number): TurnItem[] {
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
