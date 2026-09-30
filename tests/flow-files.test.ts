import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { WorkflowNode } from '../src/shared/types'
import { makeServices } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const SLIDES_CODE = `
const PptxGenJS = require('pptxgenjs')
const pptx = new PptxGenJS()
for (const title of args.titles) pptx.addSlide().addText(title, { x: 1, y: 1, fontSize: 28 })
const bytes = await pptx.write({ outputType: 'nodebuffer' })
return 'Saved ' + await workspace.write(args.file, bytes)
`

function flow(nodes: WorkflowNode[]) {
  const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i].id, target: n.id }))
  return { nodes, edges }
}

describe('flow workspace', () => {
  it('a JavaScript tool builds a PowerPoint file in the flow workspace', async () => {
    const { services } = makeServices()
    const ws = mkdtempSync(join(tmpdir(), 'cloth-flowws-'))
    services.custom.create({
      name: 'make_slides',
      description: 'Build a deck',
      kind: 'javascript',
      params: [
        { name: 'titles', type: 'json', description: '', required: true },
        { name: 'file', type: 'string', description: '', required: true }
      ],
      config: { code: SLIDES_CODE }
    })
    const wf = services.workflows.create({ name: 'Deck' })
    services.workflows.save(wf.id, {
      workspace: ws,
      ...flow([
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 'trigger' } },
        { id: 'k', type: 'tool', position: { x: 1, y: 0 }, data: { key: 'deck', tool: 'make_slides', args: '{"titles": ["Q3 results", "Next steps"], "file": "out/{{input.name}}.pptx"}' } }
      ])
    })
    expect(services.workflows.get(wf.id).workspace).toBe(ws)
    const run = await services.workflows.run(wf.id, { name: 'board' })
    expect(run.error).toBeNull()
    expect(run.output).toBe('Saved out/board.pptx')
    expect(run.files).toEqual([join(ws, 'out', 'board.pptx')])
    expect(readFileSync(join(ws, 'out', 'board.pptx')).subarray(0, 2).toString()).toBe('PK')

    // A run can use another workspace, and paths cannot escape it.
    const other = mkdtempSync(join(tmpdir(), 'cloth-flowws-'))
    const escaped = await services.workflows.run(wf.id, { name: '../../evil' }, 'manual', { workspace: other })
    expect(escaped.status).toBe('error')
    expect(escaped.error).toMatch(/outside the workspace/)
    await expect(services.workflows.run(wf.id, {}, 'manual', { workspace: join(other, 'missing') })).rejects.toThrow(/does not exist/)
  })

  it('JavaScript tools: allowed libraries only, read-only without a writable workspace, scratch folder in tests', async () => {
    const { services } = makeServices()
    const tool = { kind: 'javascript' as const, params: [], config: { code: `require('fs')` } }
    await expect(services.custom.execute(tool, {})).rejects.toThrow(/not available in tools\. Available: pptxgenjs, docx/)
    const ws = mkdtempSync(join(tmpdir(), 'cloth-ro-'))
    const writer = { kind: 'javascript' as const, params: [], config: { code: `return workspace.write('a.txt', 'hi')` } }
    await expect(services.custom.execute(writer, {}, undefined, { workspace: { root: ws, writable: false } })).rejects.toThrow(/can only read/)
    await expect(services.custom.execute(writer, {})).rejects.toThrow(/No workspace here/)
    const test = await services.custom.test({ kind: 'javascript', params: [], config: { code: SLIDES_CODE } }, { titles: ['One'], file: 'deck.pptx' })
    expect(test.ok).toBe(true)
    expect(test.output).toContain('Saved deck.pptx')
    expect(test.output).toContain('scratch workspace')
  })

  it('agent nodes: only the picked tools and skills, and they can write in the flow workspace', async () => {
    const { services } = makeServices()
    const ws = mkdtempSync(join(tmpdir(), 'cloth-agentws-'))
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    for (const name of ['wanted_tool', 'other_tool']) services.custom.create({ name, description: name, kind: 'prompt', params: [], config: { prompt: 'x' } })
    await services.skills.create({ name: 'slide-style', description: 'House slide style', body: 'Use crimson.' })
    await services.skills.create({ name: 'unrelated', description: 'Something else', body: 'x' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let tools: string[] = []
    let system = ''
    faux.setResponses([
      (ctx: TranscriptContext) => {
        const sys = ctx.messages as unknown as { role: string; toolsAdded?: { name: string }[]; content?: unknown }[]
        tools = sys.filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name))
        system = JSON.stringify(ctx.messages[0] ?? '')
        return fauxAssistantMessage([fauxToolCall('write', { path: 'notes/plan.md', content: '# Plan' }, { id: 'w1' })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('Wrote the plan.')
    ])
    const wf = services.workflows.create({ name: 'Agent' })
    services.workflows.save(wf.id, {
      workspace: ws,
      ...flow([
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 'trigger' } },
        { id: 'a', type: 'agent', position: { x: 1, y: 0 }, data: { key: 'agent', prompt: 'Plan it', model: { providerId: provider.id, modelId: 'faux-1' }, tools: ['wanted_tool'], skills: ['slide-style'], customTools: true, skillsEnabled: true } }
      ])
    })
    const run = await services.workflows.run(wf.id, {})
    expect(run.error).toBeNull()
    expect(tools).toContain('wanted_tool')
    expect(tools).not.toContain('other_tool')
    expect(tools).toContain('write')
    expect(tools).not.toContain('powershell')
    expect(tools).not.toContain('bash')
    expect(system).toContain('slide-style')
    expect(system).not.toContain('unrelated')
    expect(readFileSync(join(ws, 'notes', 'plan.md'), 'utf8')).toBe('# Plan')
    expect(run.files).toEqual([join(ws, 'notes', 'plan.md')])
  })
})
