import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ExportEvent, FlowBundleGraph, FlowBundleManifest } from '../src/shared/flow-bundle'
import type { BundledCollection, BundledTool } from '../src/shared/flow-bundle'
import type { WorkflowNode } from '../src/shared/types'
import { planExport } from '../src/main/export/plan'
import { esc, fourPartVersion, installerScript, safeFileName } from '../src/main/export/nsis'
import { installBundle, inputFields } from '../src/runner/main/install'
import { makeServices, REPO } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const node = (id: string, type: WorkflowNode['type'], data: Record<string, unknown>): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, data: { key: id, ...data } })

/** A stand-in for the packaged runner: just the executable name the exporter renames. */
function fakeRunner(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-runner-'))
  writeFileSync(join(dir, 'FlowRunner.exe'), 'MZ')
  mkdirSync(join(dir, 'resources'))
  return dir
}

async function deckFlow(env: ReturnType<typeof makeServices>) {
  const { services } = env
  const provider = services.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const col = services.rag.createCollection({ name: 'Brand guide', embedding: null })
  await services.rag.ingestText(col.id, 'Colours', '# Colours\n\nUse crimson #dc2645 on near-black backgrounds for title slides.')
  await services.skills.create({ name: 'slide-style', description: 'House slide style', body: 'Titles in crimson.' }, { files: [{ path: 'templates/layout.md', content: '# Layout' }] })
  await services.skills.create({ name: 'unused-skill', description: 'Not in the flow', body: 'x' })
  services.custom.create({ name: 'summarise', description: 'Summarise text', kind: 'prompt', params: [{ name: 'text', type: 'string', description: '', required: true }], config: { prompt: 'Summarise {{text}}', model: { providerId: provider.id, modelId: 'qwen' } } })
  services.custom.create({ name: 'not_used', description: 'x', kind: 'prompt', params: [], config: { prompt: 'x' } })
  services.custom.create({
    name: 'make_slides',
    description: 'Save slides as a PowerPoint file',
    kind: 'javascript',
    params: [{ name: 'title', type: 'string', description: '', required: true }],
    config: {
      code: "const P = require('pptxgenjs'); const p = new P(); const s = p.addSlide(); s.background = { color: '0F0F11' }; s.addText(args.title, { x: 0.6, y: 2.2, w: 8.8, fontSize: 36, bold: true, color: 'EF3D5C' }); return 'Saved ' + await workspace.write(args.title.replace(/[^A-Za-z0-9]+/g, '-') + '.pptx', await p.write({ outputType: 'nodebuffer' }))"
    }
  })
  const wf = services.workflows.create({ name: 'Board deck' })
  const model = { providerId: provider.id, modelId: 'qwen' }
  services.workflows.save(wf.id, {
    nodes: [
      node('trigger', 'trigger', { defaultInput: '{\n  "topic": "Q3 results",\n  "brief": "Focus on growth",\n  "slides": 8,\n  "dark": true\n}' }),
      node('research', 'rag', { query: '{{input.topic}}', collectionIds: [col.id] }),
      node('writer', 'agent', { prompt: 'Write the deck', model, tools: ['summarise'], skills: ['slide-style'], customTools: true, skillsEnabled: true, workspace: 'C:\\somewhere' }),
      node('slides', 'tool', { label: 'Build the slides', tool: 'make_slides', args: '{"title": "{{input.topic}}"}' }),
      node('out', 'output', { value: '{{writer}}' })
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'research' },
      { id: 'e2', source: 'research', target: 'writer' },
      { id: 'e3', source: 'writer', target: 'slides' },
      { id: 'e4', source: 'slides', target: 'out' }
    ]
  })
  return { wf, col, provider }
}

describe('export plan', () => {
  it('collects exactly what the flow uses, with errors and warnings', () => {
    const tools = [
      { name: 'a', enabled: true, kind: 'http', config: { url: 'http://localhost:3000' } },
      { name: 'b', enabled: true, kind: 'command', config: { command: 'python' } },
      { name: 'c', enabled: false, kind: 'prompt', config: {} },
      { name: 'd', enabled: true, kind: 'prompt', config: {} }
    ] as never
    const inv = { tools, skills: [{ name: 's1' }, { name: 's2' }], collections: [{ id: 'c1', name: 'one' }, { id: 'c2', name: 'two' }] }
    const plan = planExport(
      {
        nodes: [
          node('t1', 'tool', { tool: 'a' }),
          node('ag', 'agent', { tools: ['b'], skills: ['s1'], collectionIds: [], webEnabled: true }),
          node('sk', 'skill', { skill: 'ghost' }),
          node('tc', 'tool', { tool: 'c' })
        ]
      },
      inv
    )
    expect(plan.tools).toEqual(['a', 'b', 'c'])
    expect(plan.skills).toEqual(['ghost', 's1'])
    expect(plan.collections.sort()).toEqual(['c1', 'c2'])
    expect(plan.web).toBe(true)
    expect(plan.errors.join('\n')).toMatch(/"c" is disabled/)
    expect(plan.errors.join('\n')).toMatch(/skill "ghost"/)
    expect(plan.warnings.join('\n')).toMatch(/runs "python"/)
    expect(plan.warnings.join('\n')).toMatch(/local address/)
    // An agent with no picks takes every enabled tool and every skill — and says so.
    const all = planExport({ nodes: [node('ag', 'agent', {})] }, inv)
    expect(all.tools).toEqual(['a', 'b', 'd'])
    expect(all.skills).toEqual(['s1', 's2'])
    expect(all.warnings.join('\n')).toMatch(/every enabled tool/)
  })

  it('writes a safe NSIS script', () => {
    expect(esc('Cost $5 "deal"')).toBe('Cost $$5 $\\"deal$\\"')
    expect(safeFileName('Deck: "Q3"/<draft>?')).toBe('Deck Q3draft')
    expect(fourPartVersion('1.2')).toBe('1.2.0.0')
    const s = installerScript({ name: 'Deck $maker', appId: 'cloth.flow.deck', version: '1.0.0', description: '', sourceDir: 'C:\\stage\\app', exe: 'Deck $maker.exe', icon: 'C:\\i.ico', outFile: 'C:\\out\\Deck.exe' })
    expect(s).toContain('Name "Deck $$maker"')
    expect(s).toContain('InstallDir "$LOCALAPPDATA\\Programs\\Deck $$maker"')
    expect(s).toContain('File /r "C:\\stage\\app\\*.*"')
    expect(s).toContain('RequestExecutionLevel user')
    expect(s).toContain('CreateShortcut "$SMPROGRAMS\\Deck $$maker.lnk" "$INSTDIR\\Deck $$maker.exe"')
  })
})

describe('export and install', () => {
  it('bundles the flow, then a fresh runner installs and runs it', async () => {
    const env = makeServices()
    const { wf, col } = await deckFlow(env)
    const runnerDir = fakeRunner()
    ;(env.services.exporter as unknown as { toolchain: { runnerDir: () => string } }).toolchain.runnerDir = () => runnerDir
    const outDir = mkdtempSync(join(tmpdir(), 'cloth-exports-'))
    const out = await env.services.exporter.run('exp_test', { workflowId: wf.id, name: 'Board Deck Maker', description: 'Makes board decks', version: '1.2', model: 'gpt-test', outputDir: outDir, format: 'folder' })

    const events = env.events.filter((e) => e.channel === 'export').map((e) => e.payload as ExportEvent)
    expect(events.filter((e) => e.type === 'step').map((e) => (e as { step: number }).step)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.at(-1)?.type).toBe('done')
    expect(events.some((e) => e.type === 'log' && e.level === 'warn' && /own folder/.test(e.message))).toBe(true)

    expect(out).toBe(join(outDir, 'Board Deck Maker'))
    expect(existsSync(join(out, 'Board Deck Maker.exe'))).toBe(true)
    const bundle = join(out, 'resources', 'bundle')
    const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')) as FlowBundleManifest
    expect(manifest).toMatchObject({ name: 'Board Deck Maker', appId: 'cloth.flow.board-deck-maker', version: '1.2', model: 'gpt-test', web: false })
    const graph = JSON.parse(readFileSync(join(bundle, 'flow.json'), 'utf8')) as FlowBundleGraph
    const writer = graph.nodes.find((n) => n.id === 'writer')!
    expect(writer.data.model).toBeUndefined()
    expect(writer.data.workspace).toBeUndefined()
    const tools = JSON.parse(readFileSync(join(bundle, 'tools.json'), 'utf8')) as BundledTool[]
    expect(tools.map((t) => t.name)).toEqual(['make_slides', 'summarise'])
    expect(tools[1].config.model).toBeNull()
    expect(existsSync(join(bundle, 'skills', 'slide-style', 'templates', 'layout.md'))).toBe(true)
    expect(existsSync(join(bundle, 'skills', 'unused-skill'))).toBe(false)
    const knowledge = JSON.parse(readFileSync(join(bundle, 'knowledge', `${col.id}.json`), 'utf8')) as BundledCollection
    expect(knowledge.snapshot.documents[0].chunks[0].text).toContain('crimson #dc2645')

    // A fresh runner: its own data, the bundle installed into it.
    const runner = makeServices()
    const { flowId } = await installBundle(runner.services, bundle)
    const flow = runner.services.workflows.get(flowId)
    const cols = runner.services.rag.listCollections()
    expect(cols.map((c) => c.name)).toEqual(['Brand guide'])
    expect(flow.nodes.find((n) => n.id === 'research')!.data.collectionIds).toEqual([cols[0].id])
    expect(runner.services.custom.list().map((t) => t.name)).toEqual(['make_slides', 'summarise'])
    expect((await runner.services.skills.list()).map((s) => s.name)).toEqual(['slide-style'])
    const hits = await runner.services.rag.search({ query: 'crimson title slides', collectionIds: [cols[0].id], k: 3, mode: 'hybrid' })
    expect(hits.hits[0]?.text).toContain('#dc2645')
    expect(inputFields(flow.nodes).map((f) => [f.key, f.kind])).toEqual([
      ['topic', 'text'],
      ['brief', 'long'],
      ['slides', 'number'],
      ['dark', 'boolean']
    ])

    // Installing the same export again changes nothing; the flow runs on the app's model.
    expect((await installBundle(runner.services, bundle)).flowId).toBe(flowId)
    expect(runner.services.rag.listCollections()).toHaveLength(1)
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([fauxAssistantMessage('# Deck\n\n1. Growth')])
    const p = runner.services.providers.create({ name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    runner.services.settings.update({ defaultModel: { providerId: p.id, modelId: 'faux-1' } })
    const ws = mkdtempSync(join(tmpdir(), 'cloth-runner-ws-'))
    const run = await runner.services.workflows.run(flowId, { topic: 'Q3' }, 'manual', { workspace: ws })
    expect(run.error).toBeNull()
    expect(run.output).toBe('# Deck\n\n1. Growth')
  })

  it('stops with a clear error when the flow cannot be exported', async () => {
    const env = makeServices()
    const { wf } = await deckFlow(env)
    env.services.custom.setEnabled(env.services.custom.findByName('summarise')!.id, false)
    ;(env.services.exporter as unknown as { toolchain: { runnerDir: () => string } }).toolchain.runnerDir = fakeRunner
    await expect(env.services.exporter.run('exp_bad', { workflowId: wf.id, name: 'X', description: '', version: '1.0.0', model: null, outputDir: tmpdir(), format: 'folder' })).rejects.toThrow(/disabled/)
    const last = env.events.filter((e) => e.channel === 'export').at(-1)?.payload as ExportEvent
    expect(last).toMatchObject({ type: 'failed', cancelled: false })
    const preview = await env.services.exporter.preview(wf.id)
    expect(preview.missing.join('\n')).toMatch(/NSIS/)
  })

  // Slow (compresses a real runner): EXPORT_INSTALLER=1 npx vitest run tests/export.test.ts
  it.runIf(process.env.EXPORT_INSTALLER === '1' && existsSync(join(REPO, 'build', 'runner-dist', 'win-unpacked')))(
    'builds a real installer with NSIS',
    async () => {
      const env = makeServices()
      const { wf } = await deckFlow(env)
      const tc = (env.services.exporter as unknown as { toolchain: Record<string, unknown> }).toolchain
      tc.runnerDir = () => join(REPO, 'build', 'runner-dist', 'win-unpacked')
      tc.nsisDir = () => join(REPO, 'build', 'nsis')
      const outDir = process.env.EXPORT_OUT ?? mkdtempSync(join(tmpdir(), 'cloth-installer-'))
      const folder = process.env.EXPORT_FORMAT === 'folder'
      const file = await env.services.exporter.run('exp_real', { workflowId: wf.id, name: 'Board Deck Maker', description: 'Makes board decks', version: '1.0.0', model: null, outputDir: outDir, format: folder ? 'folder' : 'installer' })
      if (folder) expect(existsSync(join(file, 'Board Deck Maker.exe'))).toBe(true)
      else {
        expect(file).toBe(join(outDir, 'Board Deck Maker Setup 1.0.0.exe'))
        expect(readFileSync(file).subarray(0, 2).toString()).toBe('MZ')
      }
      const logs = env.events.filter((e) => e.channel === 'export').map((e) => e.payload as ExportEvent)
      console.log(logs.map((e) => (e.type === 'log' ? `[${e.level}] ${e.message}` : e.type === 'step' ? `— ${e.step}/${e.steps} ${e.title}` : e.type)).join('\n'))
    },
    600_000
  )
})
