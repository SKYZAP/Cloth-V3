import { describe, expect, it } from 'vitest'
import type { SubagentRun, TodoItem, ToolTrace, UiBlock, UiMessage } from '@shared/types'
import { buildWorkBar, chatAgents, collectRuns, currentTurn, runAbout, runName } from '../src/renderer/src/lib/workbar'

const trace = (id: string, extra: Partial<ToolTrace> = {}): ToolTrace => ({ id, name: 'task', args: {}, status: 'ok', result: '', durationMs: null, references: [], ...extra })
const task = (id: string, run: Partial<SubagentRun> = {}, status: ToolTrace['status'] = 'ok'): UiBlock => ({
  type: 'tool',
  trace: trace(id, { status, subagent: { role: 'worker', description: `do ${id}`, blocks: [], running: false, ...run } })
})
const todo = (todos: TodoItem[]): UiBlock => ({ type: 'tool', trace: trace(`todo-${todos.length}`, { name: 'todo_write', args: { todos } }) })
const msg = (id: string, role: UiMessage['role'], blocks: UiBlock[] = [], extra: Partial<UiMessage> = {}): UiMessage => ({ id, role, blocks, createdAt: 0, ...extra })
const usage = (cost: number, input = 100, output = 10, cached = 0) => ({ input, output, cached, cost })

describe('currentTurn', () => {
  it('is the latest assistant reply, gone once the user sends again', () => {
    const a = msg('a', 'assistant')
    expect(currentTurn([msg('u', 'user'), a])).toBe(a)
    expect(currentTurn([msg('u', 'user'), a, msg('u2', 'user')])).toBeNull()
    expect(currentTurn([])).toBeNull()
  })
})

describe('collectRuns', () => {
  it('lists runs in start order with nested ones pointing at their outer card', () => {
    const blocks = [task('a', { usage: usage(0.5, 100, 20, 50), agent: 'Reviewer', tierName: 'Fast' }), { type: 'text', text: 'x' } as UiBlock, task('b', { blocks: [task('c')] }, 'error')]
    const runs = collectRuns(blocks)
    expect(runs.map((r) => [r.id, r.cardId, r.status])).toEqual([
      ['a', 'a', 'done'],
      ['b', 'b', 'failed'],
      ['c', 'b', 'done']
    ])
    expect(runs[0]).toMatchObject({ name: 'Reviewer', named: true, tierName: 'Fast', cost: 0.5, tokensIn: 150, tokensOut: 20 })
    expect(runs[1]).toMatchObject({ name: 'Operator', named: false })
  })

  it("carries a finished run's outcome, not a running or failed one's", () => {
    expect(collectRuns([task('a', { outcome: 'blocked' })])[0].outcome).toBe('blocked')
    expect(collectRuns([task('a', { outcome: 'partial', running: true }, 'running')])[0].outcome).toBeUndefined()
    expect(collectRuns([task('a', { outcome: 'partial' }, 'error')])[0].outcome).toBeUndefined()
  })

  it('keeps the current action only while running', () => {
    const current = { tool: 'read', summary: 'a.ts' }
    expect(collectRuns([task('a', { running: true, current }, 'running')])[0]).toMatchObject({ status: 'running', current })
    expect(collectRuns([task('a', { current })])[0].current).toBeUndefined()
  })
})

describe('runName', () => {
  it("is the saved agent's name, else Verifier for a check, else the job's access level", () => {
    expect(runName({ role: 'scout', agent: 'Code reviewer' })).toBe('Code reviewer')
    expect(runName({ role: 'worker', agent: 'Designer' })).toBe('Designer')
    expect(runName({ role: 'scout' })).toBe('Reader')
    expect(runName({ role: 'worker', access: 'writer' })).toBe('Writer')
    expect(runName({ role: 'worker', access: 'operator' })).toBe('Operator')
    // Runs from before access levels: a worker could edit and run commands.
    expect(runName({ role: 'worker' })).toBe('Operator')
    expect(runName({ role: 'verifier', access: 'operator' })).toBe('Verifier')
  })

  it('says what a run may do', () => {
    expect(runAbout({ role: 'scout' })).toBe('Reads the project and the web to find things out; it can’t change anything.')
    expect(runAbout({ role: 'worker', access: 'writer' })).toMatch(/^Edits files .*can’t run commands\.$/)
    expect(runAbout({ role: 'worker', tierName: 'High' })).toMatch(/^Edits files and runs commands .* Reasoning: High\.$/)
  })
})

describe('buildWorkBar', () => {
  const todos: TodoItem[] = [
    { content: 'Read the code', status: 'completed' },
    { content: 'Fix the bug', status: 'in_progress' },
    { content: 'Write tests', status: 'pending' }
  ]

  it('is null without a current turn, todos or runs', () => {
    expect(buildWorkBar([])).toBeNull()
    expect(buildWorkBar([msg('u', 'user'), msg('a', 'assistant', [{ type: 'text', text: 'hi' }])])).toBeNull()
    expect(buildWorkBar([msg('a', 'assistant', [todo(todos), task('r')]), msg('u', 'user')])).toBeNull()
  })

  it('matches runs to steps, the latest run winning, and counts them', () => {
    const blocks = [todo(todos), task('r1', { step: 2, usage: usage(0.1) }), task('r2', { step: 2, running: true, usage: usage(0.2) }, 'running'), task('r3', { step: 1, usage: usage(0.05) })]
    const bar = buildWorkBar([msg('u', 'user'), msg('a', 'assistant', blocks, { usage: usage(1) })])!
    expect(bar.mode).toBe('todos')
    expect(bar.current).toBe('Fix the bug')
    expect([bar.done, bar.total, bar.runCount]).toEqual([1, 3, 3])
    expect(bar.cost).toBeCloseTo(1.35)
    expect(bar.progress).toEqual({ completed: 1, inProgress: 1, rest: 1 })
    expect(bar.rows.map((r) => [r.n, r.text, r.status, r.run?.id, r.runs])).toEqual([
      [1, 'Read the code', 'completed', 'r3', 1],
      [2, 'Fix the bug', 'in_progress', 'r2', 2],
      [3, 'Write tests', 'pending', undefined, 0]
    ])
  })

  it('has no current step once every step is done', () => {
    const bar = buildWorkBar([msg('a', 'assistant', [todo([{ content: 'One', status: 'completed' }])])])!
    expect(bar.current).toBeNull()
    expect(bar.done).toBe(1)
  })

  it('uses the plan from earlier in the chat when this turn only has runs for its steps', () => {
    const bar = buildWorkBar([msg('a0', 'assistant', [todo(todos)]), msg('u', 'user'), msg('a1', 'assistant', [task('r', { step: 3 })])])!
    expect(bar.mode).toBe('todos')
    expect(bar.rows[2].run?.id).toBe('r')
  })

  it('without todos lists runs in start order', () => {
    const blocks = [task('r1', { usage: usage(0.1) }), task('r2', { running: true }, 'running'), task('r3', {}, 'error')]
    const bar = buildWorkBar([msg('a0', 'assistant', [todo(todos)]), msg('u', 'user'), msg('a', 'assistant', blocks)])!
    expect(bar.mode).toBe('agents')
    expect(bar.current).toBeNull()
    expect(bar.rows.map((r) => [r.text, r.status, r.run?.id])).toEqual([
      ['do r1', 'completed', 'r1'],
      ['do r2', 'in_progress', 'r2'],
      ['do r3', 'failed', 'r3']
    ])
    expect([bar.done, bar.total, bar.runCount]).toEqual([1, 3, 3])
    expect(bar.progress).toEqual({ completed: 1, inProgress: 1, rest: 1 })
    expect(bar.cost).toBeCloseTo(0.1)
  })
})

describe('chatAgents', () => {
  it('lists every run in the chat newest first with their total cost', () => {
    const messages = [msg('a0', 'assistant', [task('r1', { usage: usage(0.25) })], { archived: true }), msg('u', 'user'), msg('a1', 'assistant', [task('r2', { usage: usage(0.5), blocks: [task('r3', { usage: usage(0.125) })] })])]
    const { runs, cost } = chatAgents(messages)
    expect(runs.map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
    expect(cost).toBeCloseTo(0.875)
  })

  it('is empty without runs', () => {
    expect(chatAgents([msg('u', 'user')])).toEqual({ runs: [], cost: 0 })
  })
})
