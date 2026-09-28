import { describe, expect, it } from 'vitest'
import type { WorkflowEdge, WorkflowNode } from '../src/shared/types'
import { executeGraph, renderTemplate, resolveItems, topoSort, type Executor } from '../src/main/workflows/engine'
import { layeredLayout } from '../src/shared/layout'
import { DraftGraph } from '../src/main/workflows/builder'

const node = (id: string, type: WorkflowNode['type'], data: Record<string, unknown> = {}, x = 0): WorkflowNode => ({ id, type, position: { x, y: 0 }, data: { key: id, ...data } })
const edge = (source: string, target: string, sourceHandle: string | null = null, targetHandle: string | null = null): WorkflowEdge => ({ id: `${source}-${target}-${sourceHandle}`, source, target, sourceHandle, targetHandle })

/** Tiny executor: `transform` nodes render `tpl`; `condition` nodes evaluate a JS expression over scope. */
const exec: Executor = async (n, { scope }) => {
  if (n.type === 'trigger') return { output: scope.input }
  if (n.type === 'condition') return { output: scope.prev, branch: new Function('s', `return (${n.data.expression})`)(scope) ? 'true' : 'false' }
  if (n.type === 'output') return { output: n.data.value ? renderTemplate(String(n.data.value), scope) : scope.prev }
  return { output: renderTemplate(String(n.data.tpl ?? '{{prev}}'), scope) }
}
const run = (nodes: WorkflowNode[], edges: WorkflowEdge[], input: unknown = {}) => executeGraph({ nodes, edges }, input, exec, new AbortController().signal)

describe('loop nodes', () => {
  it('runs the body once per item and collects results', async () => {
    const nodes = [
      node('t', 'trigger', {}, 0),
      node('each', 'loop', { mode: 'each', items: '{{input.names}}' }, 1),
      node('greet', 'transform', { tpl: 'hi {{loop.item}} #{{loop.index}}' }, 2),
      node('out', 'output', { value: '' }, 3)
    ]
    const edges = [edge('t', 'each'), edge('each', 'greet', 'body'), edge('greet', 'each', null, 'next'), edge('each', 'out', 'done')]
    const { output, traces } = await run(nodes, edges, { names: ['ada', 'linus', 'grace'] })
    expect(output).toEqual(['hi ada #0', 'hi linus #1', 'hi grace #2'])
    expect(traces.find((t) => t.nodeId === 'each')?.iterations).toBe(3)
    expect(traces.find((t) => t.nodeId === 'greet')?.iterations).toBe(3)
    expect(traces.find((t) => t.nodeId === 'out')?.status).toBe('ok')
  })

  it('repeats until the condition holds, feeding each result back in as prev', async () => {
    const nodes = [
      node('t', 'trigger', {}, 0),
      node('refine', 'loop', { mode: 'until', until: 'String(prev).length >= 4', maxIterations: 10 }, 1),
      node('grow', 'transform', { tpl: '{{prev}}x' }, 2),
      node('out', 'output', {}, 3)
    ]
    const edges = [edge('t', 'refine'), edge('refine', 'grow', 'body'), edge('refine', 'out', 'done')]
    const { output, traces } = await run(nodes, edges, 'a')
    expect(output).toBe('axxx')
    expect(traces.find((t) => t.nodeId === 'refine')?.iterations).toBe(3)
  })

  it('stops at maxIterations', async () => {
    const nodes = [node('t', 'trigger'), node('l', 'loop', { mode: 'until', until: 'false', maxIterations: 4 }, 1), node('b', 'transform', { tpl: '{{loop.index}}' }, 2)]
    const { traces } = await run(nodes, [edge('t', 'l'), edge('l', 'b', 'body')])
    expect(traces.find((t) => t.nodeId === 'l')?.iterations).toBe(4)
  })

  it('handles branches inside the body per iteration and nested loops', async () => {
    const nodes = [
      node('t', 'trigger', {}, 0),
      node('rows', 'loop', { items: '{{input.grid}}' }, 1),
      node('cells', 'loop', { items: '{{loop.item}}' }, 2),
      node('even', 'condition', { expression: 's.loop.item % 2 === 0' }, 3),
      node('yes', 'transform', { tpl: 'E{{loop.item}}' }, 4),
      node('no', 'transform', { tpl: 'O{{loop.item}}' }, 4),
      node('out', 'output', {}, 6)
    ]
    const edges = [
      edge('t', 'rows'),
      edge('rows', 'cells', 'body'),
      edge('cells', 'even', 'body'),
      edge('even', 'yes', 'true'),
      edge('even', 'no', 'false'),
      edge('yes', 'cells', null, 'next'),
      edge('no', 'cells', null, 'next'),
      edge('cells', 'rows', 'done', 'next'),
      edge('rows', 'out', 'done')
    ]
    const { output } = await run(nodes, edges, { grid: [[1, 2], [3, 4, 5]] })
    expect(output).toEqual([['O1', 'E2'], ['O3', 'E4', 'O5']])
  })

  it('an empty list skips the body and yields []', async () => {
    const nodes = [node('t', 'trigger'), node('l', 'loop', { items: '{{input.xs}}' }, 1), node('b', 'transform', {}, 2), node('out', 'output', {}, 3)]
    const { output, traces } = await run(nodes, [edge('t', 'l'), edge('l', 'b', 'body'), edge('l', 'out', 'done')], { xs: [] })
    expect(output).toEqual([])
    expect(traces.find((t) => t.nodeId === 'b')?.status).toBe('skipped')
  })

  it('still rejects cycles that do not go through a loop', () => {
    const nodes = [node('a', 'transform'), node('b', 'transform')]
    expect(() => topoSort(nodes, [edge('a', 'b'), edge('b', 'a')])).toThrow(/Loop node/)
  })

  it('resolves items from arrays, JSON, lines and { hits } objects', () => {
    expect(resolveItems('{{x}}', { x: [1, 2] })).toEqual([1, 2])
    expect(resolveItems('["a","b"]', {})).toEqual(['a', 'b'])
    expect(resolveItems('{{x}}', { x: 'one\ntwo\n\nthree' })).toEqual(['one', 'two', 'three'])
    expect(resolveItems('{{r}}', { r: { text: 'x', hits: [{ a: 1 }] } })).toEqual([{ a: 1 }])
  })

  it('the builder closes loops with a loop-back edge and validates branches', () => {
    const g = new DraftGraph()
    g.add('trigger', 'start', undefined, { defaultInput: '{"urls": []}' })
    g.add('loop', 'each_url', undefined, { items: '{{input.urls}}' })
    g.add('llm', 'summarize', undefined, { prompt: 'Summarize {{loop.item}}' })
    g.add('output', 'result', undefined)
    g.connect('start', 'each_url')
    expect(() => g.connect('each_url', 'summarize')).toThrow(/body/)
    g.connect('each_url', 'summarize', 'body')
    expect(g.connect('summarize', 'each_url')).toMatch(/loop back/)
    g.connect('each_url', 'result', 'done')
    expect(g.validate({ collections: [], skills: [], tools: [] })).toEqual([])
    expect(g.edges.find((e) => e.target === g.byKey('each_url').id && e.source === g.byKey('summarize').id)?.targetHandle).toBe('next')
  })
})

describe('auto layout', () => {
  it('lays nodes out left to right in dependency order without overlaps', () => {
    const ids = ['t', 'a', 'b', 'c', 'out']
    const nodes = ids.map((id, i) => ({ id, width: 230, height: 70, position: { x: 500 - i * 100, y: i * 37 } }))
    const edges = [edge('t', 'a'), edge('a', 'b', 'true'), edge('a', 'c', 'false'), edge('b', 'out'), edge('c', 'out'), edge('b', 'a', null, 'next')]
    const pos = layeredLayout(nodes, edges)
    expect(pos.get('t')!.x).toBeLessThan(pos.get('a')!.x)
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x)
    expect(pos.get('b')!.x).toBe(pos.get('c')!.x)
    expect(pos.get('b')!.y).toBeLessThan(pos.get('c')!.y) // "true" branch above "false"
    expect(Math.abs(pos.get('b')!.y - pos.get('c')!.y)).toBeGreaterThanOrEqual(70)
    expect(pos.get('out')!.x).toBeGreaterThan(pos.get('b')!.x)
    // A straight chain stays level.
    expect(pos.get('t')!.y).toBe(pos.get('a')!.y)
  })
})
