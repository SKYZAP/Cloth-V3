import { describe, expect, it } from 'vitest'
import type { WorkflowNode } from '../src/shared/types'
import { makeServices } from './helpers'

const node = (id: string, type: WorkflowNode['type'], data: Record<string, unknown>, x = 0): WorkflowNode => ({ id, type, position: { x, y: 0 }, data: { key: id, ...data } })
const chain = (ids: string[]) => ids.slice(1).map((id, i) => ({ id: `e${i}`, source: ids[i], target: id }))

describe('tool steps', () => {
  it('accept args as an object, keeping arrays as arrays', async () => {
    const { services } = makeServices()
    services.custom.create({
      name: 'make_deck',
      description: 'Build a deck',
      kind: 'javascript',
      params: [
        { name: 'slides', type: 'json', description: '', required: true },
        { name: 'filename', type: 'string', description: '', required: false }
      ],
      config: { code: 'return `${args.filename}: ${Array.isArray(args.slides)} ${args.slides.length} slides`' }
    })
    const wf = services.workflows.create({ name: 'Object args' })
    services.workflows.save(wf.id, {
      nodes: [
        node('request', 'trigger', { defaultInput: '{}' }),
        node('outline', 'transform', { code: 'return { slides: [{ title: "A" }, { title: "B" }, { title: "C" }], filename: "qbr" }' }, 1),
        node('deck', 'tool', { tool: 'make_deck', args: { slides: '{{outline.slides}}', filename: '{{outline.filename}}.pptx' } }, 2),
        node('result', 'output', { value: '{{deck}}' }, 3)
      ],
      edges: chain(['request', 'outline', 'deck', 'result'])
    })
    const run = await services.workflows.run(wf.id, {})
    expect(run.error).toBeNull()
    expect(run.output).toBe('qbr.pptx: true 3 slides')
  })
})
