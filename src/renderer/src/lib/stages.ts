// Pure helpers behind the work bar's stage rows: what each Spec → Ship stage did and what it cost.
import type { StageGate, TodoItem, UiBlock, UiMessage, WorkflowRoute, WorkflowStage } from '@shared/types'
import { agentCost } from './agentCost'
import { collectRuns, shortfall, type RunInfo } from './workbar'

type Stage = Exclude<WorkflowStage, 'done'>

/** One line under a stage's row. */
export interface StageItem {
  key: string
  text: string
  /** A short note on the right: an outcome, a count. */
  note?: string
  tone?: 'ok' | 'warn' | 'danger'
  /** What an agent run cost. */
  cost?: number
  /** The chat card to scroll to, for agent runs. */
  cardId?: string
}

/** What one stage did, read from the messages between its start and the next stage's. */
export interface StageRecord {
  stage: Stage
  /** The reply and every agent it handed work to. */
  cost: number
  /** Counts for the row's right side, e.g. "2 rounds · 3 runs". */
  summary: string
  route?: WorkflowRoute
  items: StageItem[]
  /** Files the stage wrote, from its gate. */
  files: string[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function* tools(blocks: UiBlock[]) {
  for (const b of blocks) if (b.type === 'tool') yield b.trace
}

/** The last todo list written in these messages (null without one). */
function lastTodos(messages: UiMessage[]): TodoItem[] | null {
  let out: TodoItem[] | null = null
  for (const m of messages)
    for (const t of tools(m.blocks)) {
      const list = t.name === 'todo_write' && t.status !== 'error' ? (t.args as { todos?: unknown })?.todos : undefined
      if (Array.isArray(list)) out = list.filter((x): x is TodoItem => !!x && typeof (x as TodoItem).content === 'string')
    }
  return out
}

function record(stage: Stage, messages: UiMessage[]): StageRecord {
  const replies = messages.filter((m) => m.role === 'assistant')
  const cost = replies.reduce((sum, m) => sum + (m.usage?.cost ?? 0) + agentCost(m), 0)
  const traces = replies.flatMap((m) => [...tools(m.blocks)])
  const rounds = traces.filter((t) => t.questions).map((t) => t.questions!)
  const gate: StageGate | undefined = traces.filter((t) => t.stageGate && t.status !== 'error').at(-1)?.stageGate
  const runs: RunInfo[] = replies.flatMap((m) => collectRuns(m.blocks))
  const todos = lastTodos(replies)
  const files = gate?.files ?? []

  const items: StageItem[] = []
  for (const r of rounds) items.push({ key: `round-${r.round}`, text: `Round ${r.round}: ${plural(r.questions.length, 'question')}`, note: r.recorded })
  const runItem = (r: RunInfo): StageItem => {
    const short = shortfall(r)
    return {
      key: r.id,
      text: r.stepText ?? r.description,
      note: r.status === 'failed' ? 'Failed' : (short ?? (r.status === 'running' ? 'Running' : r.files.length ? `Merged · ${plural(r.files.length, 'file')}` : 'Done')),
      tone: r.status === 'failed' || r.outcome === 'blocked' ? 'danger' : r.outcome === 'partial' || r.status === 'running' ? 'warn' : 'ok',
      cost: r.cost,
      cardId: r.cardId
    }
  }
  // The stage's steps in order, each step an agent ran shown as its runs; runs for no step follow.
  todos?.forEach((t, i) => {
    const mine = runs.filter((r) => r.step === i + 1)
    if (mine.length) items.push(...mine.map(runItem))
    else items.push({ key: `todo-${i}`, text: t.content, note: t.status === 'completed' ? undefined : t.status === 'in_progress' ? 'In progress' : 'Not done', tone: t.status === 'completed' ? 'ok' : 'warn' })
  })
  items.push(...runs.filter((r) => !todos || r.step === undefined || r.step > todos.length).map(runItem))
  gate?.summary.forEach((line, i) => items.push({ key: `gate-${i}`, text: line }))

  const tickets = files.filter((f) => /\/tickets\/[^/]+\.md$/.test(f)).length
  const parts = [
    rounds.length ? plural(rounds.length, 'round') : '',
    tickets ? plural(tickets, 'ticket') : '',
    runs.length ? plural(runs.length, 'run') : '',
    gate?.findings?.length ? plural(gate.findings.length, 'finding') : '',
    !rounds.length && !tickets && files.length ? plural(files.length, 'file') : ''
  ]
  return { stage, cost, summary: parts.filter(Boolean).join(' · '), route: gate?.route, items, files }
}

/** Each stage the chat's current workflow has reached, keyed by stage: the messages from its start marker up to the next one. */
export function stageRecords(all: UiMessage[]): Partial<Record<Stage, StageRecord>> {
  // Only the workflow running now: a chat that ran Spec → Ship before starts again at a new Grill.
  const messages = all.slice(Math.max(0, all.findLastIndex((m) => m.workflowStage === 'grill')))
  const out: Partial<Record<Stage, StageRecord>> = {}
  let stage: Stage | null = null
  let start = 0
  const close = (end: number) => {
    // A stage started again (sent back for changes) adds to what it did the first time.
    if (!stage) return
    const r = record(stage, messages.slice(start, end))
    const prev = out[stage]
    out[stage] = prev
      ? { ...r, cost: prev.cost + r.cost, items: [...prev.items, ...r.items], files: [...new Set([...prev.files, ...r.files])], route: r.route ?? prev.route, summary: r.summary || prev.summary }
      : r
  }
  messages.forEach((m, i) => {
    if (!m.workflowStage) return
    close(i)
    stage = m.workflowStage === 'done' ? null : m.workflowStage
    start = i
  })
  close(messages.length)
  return out
}
