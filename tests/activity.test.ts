import { describe, expect, it } from 'vitest'
import type { FileChange, ToolTrace, UiBlock } from '@shared/types'
import { activityStats, changedFiles, elapsed, groupTurn, recentSteps, runNow, runState, runStepCount, runToolIds } from '../src/renderer/src/lib/activity'

const trace = (id: string, extra: Partial<ToolTrace> = {}): ToolTrace => ({ id, name: 'read', args: {}, status: 'ok', result: '', durationMs: null, references: [], ...extra })
const tool = (id: string, extra: Partial<ToolTrace> = {}): UiBlock => ({ type: 'tool', trace: trace(id, extra) })
const text = (t = 'x'): UiBlock => ({ type: 'text', text: t })
const think = (t = 'hmm'): UiBlock => ({ type: 'thinking', text: t })
const change = (path: string, added: number, removed: number, undone?: boolean): FileChange => ({ path, kind: 'modify', diff: '', added, removed, undone })

describe('groupTurn', () => {
  it('folds thinking and tools between text blocks into one group', () => {
    expect(groupTurn([text(), think(), tool('a'), tool('b'), text()], -1)).toEqual([
      { kind: 'block', i: 0 },
      { kind: 'group', key: 'think:1', indices: [1, 2, 3] },
      { kind: 'block', i: 4 }
    ])
  })

  it('keys a group by its first tool call', () => {
    expect(groupTurn([tool('a'), think()], -1)).toEqual([{ kind: 'group', key: 'a', indices: [0, 1] }])
  })

  it('splits groups around tools that keep their own card', () => {
    const blocks = [tool('a'), tool('img', { name: 'generate_image' }), tool('b'), tool('q', { name: 'ask_user' }), tool('c'), tool('t', { name: 'task' }), tool('p', { plan: { title: 'P', steps: [] } }), tool('d')]
    expect(groupTurn(blocks, -1)).toEqual([
      { kind: 'group', key: 'a', indices: [0] },
      { kind: 'block', i: 1 },
      { kind: 'group', key: 'b', indices: [2] },
      { kind: 'block', i: 3 },
      { kind: 'group', key: 'c', indices: [4] },
      { kind: 'block', i: 5 },
      { kind: 'block', i: 6 },
      { kind: 'group', key: 'd', indices: [7] }
    ])
  })

  it('drops superseded todo_write calls without breaking the run, and keeps the latest as a card', () => {
    const blocks = [tool('a'), tool('t1', { name: 'todo_write' }), tool('b'), tool('t2', { name: 'todo_write' }), tool('c')]
    expect(groupTurn(blocks, 3)).toEqual([
      { kind: 'group', key: 'a', indices: [0, 2] },
      { kind: 'block', i: 3 },
      { kind: 'group', key: 'c', indices: [4] }
    ])
  })

  it('keeps a trailing group and a thinking-only group', () => {
    expect(groupTurn([think(), text(), tool('a'), think()], -1)).toEqual([
      { kind: 'group', key: 'think:0', indices: [0] },
      { kind: 'block', i: 1 },
      { kind: 'group', key: 'a', indices: [2, 3] }
    ])
  })

  it('treats invoked-skill and agent-mention traces as ordinary tools', () => {
    expect(groupTurn([tool('s', { name: 'skill_use' }), tool('m', { name: 'agent_mention' }), text()], -1)).toEqual([
      { kind: 'group', key: 's', indices: [0, 1] },
      { kind: 'block', i: 2 }
    ])
  })
})

describe('changedFiles', () => {
  it('sums lines per distinct file and lists undoable calls newest-first', () => {
    const traces = [
      trace('e1', { name: 'edit', changes: [change('a.ts', 1, 1)] }),
      trace('r', { name: 'read' }),
      trace('e2', { name: 'edit', changes: [change('b.ts', 8, 13)] }),
      trace('e3', { name: 'edit', changes: [change('a.ts', 2, 0)] })
    ]
    const r = changedFiles(traces)
    expect(r.files).toEqual([
      { path: 'a.ts', added: 3, removed: 1, undone: false },
      { path: 'b.ts', added: 8, removed: 13, undone: false }
    ])
    expect([r.added, r.removed]).toEqual([11, 14])
    expect(r.undoable).toEqual(['e3', 'e2', 'e1'])
  })

  it('leaves undone calls out of the undo list and marks fully undone files', () => {
    const r = changedFiles([trace('e1', { changes: [change('a.ts', 1, 0, true)] }), trace('e2', { changes: [change('a.ts', 1, 0), change('c.ts', 3, 0, true)] })])
    expect(r.undoable).toEqual(['e2'])
    expect(r.files.map((f) => [f.path, f.undone])).toEqual([
      ['a.ts', false],
      ['c.ts', true]
    ])
  })

  it('is empty when nothing changed', () => {
    expect(changedFiles([trace('r')])).toEqual({ files: [], added: 0, removed: 0, undoable: [] })
  })
})

describe('activityStats', () => {
  it('sums time and lines and counts failures', () => {
    const s = activityStats([trace('a', { durationMs: 400, changes: [change('a', 2, 1)] }), trace('b', { durationMs: 1000, status: 'error' }), trace('c')])
    expect(s).toEqual({ ms: 1400, added: 2, removed: 1, changed: true, failed: 1 })
  })
})

describe('elapsed', () => {
  it('counts whole seconds, then minutes', () => {
    expect(elapsed(6100)).toBe('6s')
    expect(elapsed(65_000)).toBe('1m 5s')
    expect(elapsed(-5)).toBe('0s')
  })
})

describe('agent run helpers', () => {
  const sub = (blocks: UiBlock[], extra: Record<string, unknown> = {}) => ({ role: 'scout' as const, description: 'job', blocks, running: false, ...extra })

  it('counts only tool calls as steps', () => {
    expect(runStepCount(sub([think(), tool('a'), text(), tool('b')]))).toBe(2)
    expect(runStepCount(sub([]))).toBe(0)
  })

  it('finds what a running agent is on', () => {
    expect(runNow([])).toEqual({ kind: 'queued' })
    expect(runNow([text()])).toEqual({ kind: 'queued' })
    expect(runNow([tool('a'), think()])).toEqual({ kind: 'thinking' })
    const r = runNow([think(), tool('a'), text()])
    expect(r.kind === 'tool' && r.trace.id).toBe('a')
  })

  it('keeps the last five steps and counts the earlier tool calls', () => {
    const blocks = [tool('a'), think('t1'), text(), tool('b'), tool('c'), think('t2'), tool('d'), tool('e')]
    const { steps, earlier, offset } = recentSteps(blocks, 5)
    expect(offset).toBe(2)
    expect(earlier).toBe(1)
    expect(steps.map((b) => (b.type === 'tool' ? b.trace.id : b.type === 'thinking' ? b.text : '?'))).toEqual(['b', 'c', 't2', 'd', 'e'])
    expect(recentSteps(blocks, 5, true)).toEqual({ steps: blocks.filter((b) => b.type !== 'text'), earlier: 0, offset: 0 })
    expect(recentSteps([tool('a')], 5)).toEqual({ steps: [tool('a')], earlier: 0, offset: 0 })
  })

  it('lists tool ids, nested runs included', () => {
    expect(runToolIds([tool('a'), think(), tool('t', { name: 'task', subagent: sub([tool('n1'), tool('n2')]) })])).toEqual(['a', 't', 'n1', 'n2'])
  })

  it('reads where a run stands', () => {
    expect(runState({ status: 'running', subagent: sub([]) })).toBe('running')
    expect(runState({ status: 'ok', subagent: sub([], { running: true }) })).toBe('running')
    expect(runState({ status: 'ok', subagent: sub([]) })).toBe('done')
    expect(runState({ status: 'ok', subagent: sub([], { outcome: 'partial' }) })).toBe('partial')
    expect(runState({ status: 'ok', subagent: sub([], { outcome: 'blocked' }) })).toBe('blocked')
    expect(runState({ status: 'error', subagent: sub([], { outcome: 'done' }) })).toBe('failed')
  })
})
