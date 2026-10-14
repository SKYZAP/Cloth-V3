import { describe, expect, it } from 'vitest'
import type { ToolTrace, UiBlock, UiMessage } from '@shared/types'
import { barSegments, buildWorkBar } from '../src/renderer/src/lib/workbar'

const todoWrite = (todos: { content: string; status: string }[]): UiBlock => ({
  type: 'tool',
  trace: { id: 'tw', name: 'todo_write', args: { todos }, status: 'done' } as unknown as ToolTrace
})
const task = (id: string, running: boolean, status = 'done'): UiBlock => ({
  type: 'tool',
  trace: { id, name: 'task', args: {}, status: running ? 'running' : status, subagent: { role: 'worker', description: id, blocks: [], running } } as unknown as ToolTrace
})
const turn = (blocks: UiBlock[]): UiMessage[] => [{ id: 'a', role: 'assistant', blocks } as unknown as UiMessage]

describe('barSegments', () => {
  it('follows the todo statuses in step order', () => {
    const bar = buildWorkBar(
      turn([
        todoWrite([
          { content: 'one', status: 'completed' },
          { content: 'two', status: 'in_progress' },
          { content: 'three', status: 'pending' },
          { content: 'four', status: 'completed' }
        ])
      ])
    )!
    expect(barSegments(bar)).toEqual(['completed', 'in_progress', 'pending', 'completed'])
  })

  it('has one segment per run in agents mode', () => {
    const bar = buildWorkBar(turn([task('r1', false), task('r2', true), task('r3', false)]))!
    expect(bar.mode).toBe('agents')
    expect(barSegments(bar)).toEqual(['completed', 'in_progress', 'completed'])
  })

  it('is empty without rows', () => {
    expect(barSegments({ rows: [] })).toEqual([])
  })
})
