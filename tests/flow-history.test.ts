import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { WorkflowNode } from '../src/shared/types'
import { describeChange, shapeOf } from '../src/main/workflows/history'
import { makeServices } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const node = (id: string, type: WorkflowNode['type'], data: Record<string, unknown>, x = 0): WorkflowNode => ({ id, type, position: { x, y: 0 }, data: { key: id, ...data } })
const chain = (ids: string[]) => ids.slice(1).map((id, i) => ({ id: `e${i}`, source: ids[i], target: id }))

describe('flow history', () => {
  it('keeps a version per saved change, with a summary, and restores without losing anything', () => {
    const { services } = makeServices()
    const wf = services.workflows.create({ name: 'Digest' })
    expect(services.workflows.versions(wf.id).map((v) => v.source)).toEqual(['created'])

    const base = services.workflows.get(wf.id)
    const withWeb = [...base.nodes, node('news', 'web', { query: 'x' })]
    services.workflows.save(wf.id, { nodes: withWeb })
    services.workflows.save(wf.id, { nodes: withWeb.map((n) => (n.id === 'news' ? { ...n, data: { ...n.data, query: 'typescript news', k: 3 } } : n)) })
    services.workflows.save(wf.id, { cron: '0 9 * * 1', cronEnabled: false }) // schedule only: no new version
    services.workflows.save(wf.id, { nodes: services.workflows.get(wf.id).nodes.map((n) => ({ ...n, position: { x: n.position.x + 40, y: 0 } })) })
    const vs = services.workflows.versions(wf.id)
    expect(vs.map((v) => [v.source, v.summary])).toEqual([
      ['edit', 'Moved nodes'],
      ['edit', 'Changed news (query, k)'],
      ['edit', 'Added news'],
      ['created', '3 nodes']
    ])

    // Restore the first version: the flow goes back, and the restore itself is a new version.
    const restored = services.workflows.restore(wf.id, vs.at(-1)!.id)
    expect(restored.nodes.map((n) => n.data.key)).toEqual(base.nodes.map((n) => n.data.key))
    const after = services.workflows.versions(wf.id)
    expect(after).toHaveLength(5)
    expect(after[0]).toMatchObject({ source: 'restore', summary: 'Removed news' })
    expect(after[0].note).toMatch(/^Restored the version from/)
    expect(services.workflows.version(after[1].id).snapshot!.nodes.some((n) => n.data.key === 'news')).toBe(true)
    expect(() => services.workflows.restore('wf_other', after[1].id)).toThrow(/another flow/)
  })

  it('flows from before history keep their old state as the first version; copies and AI builds start with one', () => {
    const { services } = makeServices()
    const wf = services.workflows.create({ name: 'Old' })
    services.ctx.db.prepare('DELETE FROM workflow_versions').run()
    services.workflows.save(wf.id, { name: 'Old, renamed' })
    expect(services.workflows.versions(wf.id).map((v) => [v.source, v.summary])).toEqual([
      ['edit', 'Renamed to “Old, renamed”'],
      ['original', 'As it was before history was kept']
    ])
    const copy = services.workflows.duplicate(wf.id)
    expect(services.workflows.versions(copy.id).map((v) => [v.source, v.note])).toEqual([['created', 'Copied from “Old, renamed”']])
    const built = services.workflows.createFromGraph({ name: 'Built', description: '', nodes: base(), edges: [] })
    expect(services.workflows.versions(built.id).map((v) => v.source)).toEqual(['ai-build'])
  })

  it('summaries name what changed', () => {
    const a = { name: 'F', description: '', workspace: null, nodes: [node('t', 'trigger', {}), node('x', 'llm', { prompt: 'a' })], edges: chain(['t', 'x']) }
    expect(describeChange(a, a)).toBe('')
    const b = { ...a, workspace: 'C:\\w', nodes: [node('t', 'trigger', {}), node('x', 'llm', { prompt: 'b' }), node('y', 'output', {})], edges: chain(['t', 'x', 'y']) }
    expect(describeChange(a, b)).toBe('Added y · Changed x (prompt) · 1 connection changed · Workspace set')
    expect(shapeOf({ slides: [{ title: 'Growth', bullets: ['a'] }], theme: 'dark' })).toBe('object { slides: array of 1, items like object {title, bullets}; theme: string (4 chars): "dark" }')
  })
})

function base(): WorkflowNode[] {
  return [node('t', 'trigger', { defaultInput: '{}' }), node('o', 'output', {})]
}

describe('fix with AI', () => {
  it('reports where a run broke, and the builder fixes it from that report', async () => {
    const { services } = makeServices()
    services.custom.create({
      name: 'make_deck',
      description: 'Build a deck from slides',
      kind: 'javascript',
      params: [
        { name: 'title', type: 'string', description: 'Deck title', required: true },
        { name: 'slides', type: 'json', description: 'Array of {title, bullets}', required: true }
      ],
      config: { code: 'return `${args.title}: ${args.slides.length} slides`' }
    })
    const wf = services.workflows.create({ name: 'business_presentation_generator' })
    const ids = ['request', 'outline', 'deck', 'result']
    services.workflows.save(wf.id, {
      nodes: [
        node('request', 'trigger', { label: 'Presentation request input', defaultInput: '{"topic": "Quarterly business review"}' }),
        node('outline', 'transform', { label: 'Prepare deck outline', code: 'return { slides: [{ title: "Growth", bullets: ["+18%"] }, { title: "Next", bullets: ["v2"] }], theme: "dark" }' }, 1),
        node('deck', 'tool', { label: 'Generate editable PowerPoint script', tool: 'make_deck', args: '{"title": "{{input.topic}}"}' }, 2),
        node('result', 'output', { value: '{{deck}}' }, 3)
      ],
      edges: chain(ids)
    })
    const failed = await services.workflows.run(wf.id, { topic: 'Quarterly business review' })
    expect(failed.status).toBe('error')
    expect(failed.error).toMatch(/Missing required argument "slides"/)

    const report = services.workflows.failureReport(failed.id)
    expect(report).toContain('Step "Generate editable PowerPoint script" (key deck, tool) failed with: Missing required argument "slides"')
    expect(report).toContain('Parameters: title (string, required) — Deck title; slides (json, required) — Array of {title, bullets}')
    expect(report).toContain('Missing required arguments: slides')
    expect(report).toContain('- "Prepare deck outline" (key outline, transform): object { slides: array of 2, items like object {title, bullets}; theme: string')
    expect(report).toContain('## Not reached: result')

    // The builder gets the report and repairs the args mapping.
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let task = ''
    faux.setResponses([
      (ctx: TranscriptContext) => {
        task = JSON.stringify(ctx.messages)
        return fauxAssistantMessage([fauxToolCall('update_node', { key: 'deck', data: { args: '{"title": "{{input.topic}}", "slides": {{outline.slides}}}' } })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage([fauxToolCall('finish', { name: 'business_presentation_generator', description: 'Makes decks' })], { stopReason: 'toolUse' })
    ])
    const graph = await services.workflows.build({ description: '', model: { providerId: provider.id, modelId: 'faux-1' }, workflowId: wf.id, buildId: 'b1', fixRunId: failed.id })
    expect(task).toContain('Fix the workflow so the same input would succeed')
    expect(task).toContain('Missing required arguments: slides')
    services.workflows.save(wf.id, { nodes: graph.nodes, edges: graph.edges }, { source: 'ai-fix', note: failed.error! })
    expect(services.workflows.versions(wf.id)[0]).toMatchObject({ source: 'ai-fix', summary: 'Changed deck (args)' })
    const fixed = await services.workflows.run(wf.id, { topic: 'Quarterly business review' })
    expect(fixed.error).toBeNull()
    expect(fixed.output).toBe('Quarterly business review: 2 slides')
  })

  it('tool steps accept args as an object (as the AI builder writes them), keeping arrays as arrays', async () => {
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
