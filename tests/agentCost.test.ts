import { describe, expect, it } from 'vitest'
import type { ToolTrace, UiBlock } from '@shared/types'
import { agentCost } from '../src/renderer/src/lib/agentCost'

const tool = (id: string, extra: Partial<ToolTrace> = {}): UiBlock => ({ type: 'tool', trace: { id, name: 'task', args: {}, ...extra } as ToolTrace })
const task = (id: string, cost: number | undefined, blocks: UiBlock[] = []): UiBlock =>
  tool(id, { subagent: { role: 'scout', description: id, blocks, running: false, ...(cost === undefined ? {} : { usage: { input: 1, output: 1, cost } }) } })

describe('agentCost', () => {
  it('is zero without subagents', () => {
    expect(agentCost({ blocks: [{ type: 'text', text: 'hi' }, tool('a')] })).toBe(0)
  })

  it('sums every subagent run, nested ones included', () => {
    const blocks = [task('a', 0.5), { type: 'text', text: 'x' } as UiBlock, task('b', 0.25, [task('c', 0.125), tool('d')]), task('e', undefined)]
    expect(agentCost({ blocks })).toBeCloseTo(0.875)
  })
})
