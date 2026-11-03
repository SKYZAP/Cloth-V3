import { describe, expect, it } from 'vitest'
import type { ToolTrace, UiBlock, UiMessage, WorkflowStage } from '@shared/types'
import { stageRecords } from '../src/renderer/src/lib/stages'

let id = 0
const user = (workflowStage?: WorkflowStage): UiMessage => ({ id: `u${id++}`, role: 'user', blocks: [{ type: 'text', text: 'ok' }], createdAt: 0, ...(workflowStage ? { workflowStage } : {}) })
const reply = (cost: number, blocks: UiBlock[] = []): UiMessage => ({ id: `a${id++}`, role: 'assistant', blocks, createdAt: 0, usage: { input: 1, output: 1, cost } })
const tool = (name: string, extra: Partial<ToolTrace> = {}): UiBlock => ({ type: 'tool', trace: { id: `t${id++}`, name, args: {}, status: 'ok', result: '', durationMs: 1, references: [], ...extra } })
const task = (cost: number, extra: Record<string, unknown> = {}): UiBlock =>
  tool('task', { subagent: { role: 'worker', description: 'Ticket 1', blocks: [], running: false, usage: { input: 1, output: 1, cost }, ...extra } })

describe('stageRecords', () => {
  it('splits the chat at stage markers and totals each stage, agents included', () => {
    const r = stageRecords([
      user('grill'),
      reply(0.1, [tool('ask_questions', { questions: { round: 1, questions: [{ title: 'a', recommendation: 'x' }, { title: 'b', recommendation: 'y' }], recorded: '2 terms' } })]),
      user(),
      reply(0.05, [tool('finish_stage', { stageGate: { stage: 'grill', summary: ['Route chosen'], route: 'standard', files: ['GLOSSARY.md'] } })]),
      user('tickets'),
      reply(0.2, [tool('finish_stage', { stageGate: { stage: 'tickets', summary: [], files: ['docs/specs/x/tickets/01-a.md', 'docs/specs/x/tickets/02-b.md'] } })]),
      user('build'),
      reply(0.3, [task(1.5, { files: ['a.ts', 'b.ts'] }), task(0.5, { outcome: 'partial' })])
    ])
    expect(r.grill?.cost).toBeCloseTo(0.15)
    expect(r.grill?.route).toBe('standard')
    expect(r.grill?.summary).toBe('1 round')
    expect(r.grill?.items.map((i) => i.text)).toEqual(['Round 1: 2 questions', 'Route chosen'])
    expect(r.grill?.files).toEqual(['GLOSSARY.md'])
    expect(r.tickets?.summary).toBe('2 tickets')
    expect(r.build?.cost).toBeCloseTo(2.3)
    expect(r.build?.summary).toBe('2 runs')
    expect(r.build?.items.map((i) => [i.note, i.cost])).toEqual([
      ['Merged · 2 files', 1.5],
      ['Partly done', 0.5]
    ])
    expect(r.spec).toBeUndefined()
  })

  it("lists the stage's steps in order, with an agent's run in place of its step", () => {
    const todos = [
      { content: 'Read the spec', status: 'completed' },
      { content: 'Build ticket 1', status: 'completed' },
      { content: 'Run the suite', status: 'pending' }
    ]
    const r = stageRecords([user('build'), reply(0, [tool('todo_write', { args: { todos } }), task(0.1, { step: 2, stepText: 'Build ticket 1' })])])
    expect(r.build?.items.map((i) => [i.text, i.note])).toEqual([
      ['Read the spec', undefined],
      ['Build ticket 1', 'Done'],
      ['Run the suite', 'Not done']
    ])
  })

  it('counts only the workflow running now when the chat ran one before', () => {
    const r = stageRecords([user('grill'), reply(1), user('build'), reply(2), user('review'), reply(3), user('done'), reply(4), user('grill'), reply(0.5)])
    expect(r.grill?.cost).toBeCloseTo(0.5)
    expect(r.build).toBeUndefined()
    expect(r.review).toBeUndefined()
  })

  it('adds a stage sent back and started again to its first pass', () => {
    const r = stageRecords([user('review'), reply(0.25), user('build'), reply(0.5), user('review'), reply(0.25)])
    expect(r.review?.cost).toBeCloseTo(0.5)
    expect(r.build?.cost).toBeCloseTo(0.5)
  })
})
