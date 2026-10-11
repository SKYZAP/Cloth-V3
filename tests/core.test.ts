import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from '@earendil-works/pi-ai'
import { registerFauxProvider, streamSimple } from '@earendil-works/pi-ai/compat'
import { chunkText, cleanHeading } from '../src/main/rag/chunker'
import { executeGraph, renderTemplate, topoSort } from '../src/main/workflows/engine'
import { parseSkillMd, serializeSkillMd } from '../src/main/skills/skills'
import { toUiMessages } from '../src/main/agent/chat'
import { parseJsonLoose } from '../src/main/core/llm-json'
import { extractHtml, loadUrl, needsRendering } from '../src/main/rag/extract'
import type { WorkflowNode } from '../src/shared/types'
import { makeServices } from './helpers'

describe('chunker', () => {
  it('tracks heading paths and respects size', () => {
    const md = `# Guide\n\nIntro para.\n\n## Install\n\n${'word '.repeat(300)}\n\n## Usage\n\n\`\`\`ts\nconst a = 1\n\nconst b = 2\n\`\`\`\n`
    const chunks = chunkText(md, { size: 500, overlap: 100 })
    expect(chunks[0].headingPath).toBe('Guide')
    expect(chunks.some((c) => c.headingPath === 'Guide › Install')).toBe(true)
    const usage = chunks.find((c) => c.headingPath === 'Guide › Usage')!
    expect(usage.text).toContain('const a = 1\n\nconst b = 2') // fence kept intact
    expect(chunks.every((c) => c.text.length <= 600)).toBe(true)
  })

  it('does not treat # inside code fences as headings', () => {
    const chunks = chunkText('# Real\n\n```sh\n# comment\necho hi\n```', { size: 1000, overlap: 0 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('Real')
  })
})

describe('js-rendered pages', () => {
  it('cleans anchor links out of heading paths', () => {
    expect(cleanHeading('Binding guards[#](/guards#binding-guards)')).toBe('Binding guards')
    expect(cleanHeading('The **`CanActivate`** interface ##')).toBe('The CanActivate interface')
  })

  it('detects an unrendered SPA shell and re-renders it', async () => {
    const shell = extractHtml('<html><head><title>Docs</title></head><body><app-root></app-root><script src="main.js"></script></body></html>', 'https://docs.example.com/')
    expect(needsRendering(shell)).toBe(true)
    const full = extractHtml(`<html><body><main><h1>Guide</h1><p>${'Real content. '.repeat(60)}</p><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></main></body></html>`, 'https://docs.example.com/')
    expect(needsRendering(full)).toBe(false)

    const calls: string[] = []
    const server = await import('node:http').then(({ createServer }) =>
      createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><div id="root"></div></body></html>'))
    )
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
    const renderer = async (u: string) => {
      calls.push(u)
      return `<html><body><main><h1>Rendered</h1><p>${'Rendered by the browser. '.repeat(40)}</p><a href="/x">x</a><a href="/y">y</a><a href="/z">z</a></main></body></html>`
    }
    const sticky = { render: false }
    const page = await loadUrl(url, { renderer, sticky })
    expect(page.rendered).toBe(true)
    expect(page.text).toContain('Rendered by the browser')
    expect(sticky.render).toBe(true)
    expect((await loadUrl(url, { renderer, mode: 'never' })).rendered).toBe(false)
    server.close()
    expect(calls).toHaveLength(1)
  })

  it('flags documents with no text as errors instead of silently indexing 0 chunks', async () => {
    const { services } = makeServices()
    const col = services.rag.createCollection({ name: 'x', embedding: null })
    await expect(services.rag.ingestText(col.id, 'Empty', '   ')).rejects.toThrow(/no extractable text/)
    expect(services.rag.listDocuments(col.id)[0].status).toBe('error')
  })
})

describe('workflow engine', () => {
  const node = (id: string, type: WorkflowNode['type'], x: number, data: Record<string, unknown> = {}): WorkflowNode => ({
    id,
    type,
    position: { x, y: 0 },
    data: { key: id, ...data }
  })

  it('renders templates with nested paths and JSON strings', () => {
    expect(renderTemplate('Hi {{input.name}} / {{ a.b[1] }} / {{missing}}', { input: { name: 'Ada' }, a: '{"b":[1,2]}' })).toBe('Hi Ada / 2 / ')
  })

  it('detects cycles', () => {
    expect(() => topoSort([node('a', 'llm', 0), node('b', 'llm', 1)], [{ id: '1', source: 'a', target: 'b' }, { id: '2', source: 'b', target: 'a' }])).toThrow(/cycle/)
  })

  it('follows condition branches and skips the other side', async () => {
    const wf = {
      nodes: [node('t', 'trigger', 0), node('c', 'condition', 1), node('yes', 'output', 2), node('no', 'output', 2)],
      edges: [
        { id: '1', source: 't', target: 'c' },
        { id: '2', source: 'c', target: 'yes', sourceHandle: 'true' },
        { id: '3', source: 'c', target: 'no', sourceHandle: 'false' }
      ]
    }
    const res = await executeGraph(
      wf,
      { n: 5 },
      async (n, { prev }) => {
        if (n.type === 'condition') return { output: prev, branch: (prev as { n: number }).n > 3 ? 'true' : 'false' }
        if (n.type === 'output') return { output: `${n.id}` }
        return { output: prev }
      },
      new AbortController().signal
    )
    expect(res.output).toBe('yes')
    expect(res.traces.find((t) => t.nodeId === 'no')!.status).toBe('skipped')
  })
})

describe('skills', () => {
  it('round-trips SKILL.md frontmatter', () => {
    const md = serializeSkillMd({ name: 'x', description: 'Does: things', version: 2 }, '# Body')
    const parsed = parseSkillMd(md)
    expect(parsed.frontmatter).toMatchObject({ name: 'x', description: 'Does: things', version: 2 })
    expect(parsed.body).toBe('# Body')
  })

  it('creates, lists and imports skills on disk', async () => {
    const { services, dataDir } = makeServices()
    await services.skills.create({ name: 'My Skill', description: 'Test skill', body: 'Do the thing.' })
    const ext = join(dataDir, 'external', 'other-skill')
    mkdirSync(ext, { recursive: true })
    writeFileSync(join(ext, 'SKILL.md'), '---\nname: other-skill\ndescription: Imported\n---\nBody')
    expect(await services.skills.importFrom(join(dataDir, 'external'))).toEqual(['other-skill'])
    const names = (await services.skills.list()).map((s) => s.name)
    expect(names).toEqual(['my-skill', 'other-skill'])
  })
})

describe('rag', () => {
  it('indexes text and finds it with keyword search', async () => {
    const { services } = makeServices()
    const col = services.rag.createCollection({ name: 'docs', embedding: null })
    await services.rag.ingestText(col.id, 'Guards', '# Guards\n\nA guard decides whether a request is handled by the route handler.\n\n# Pipes\n\nPipes transform input data.')
    await services.rag.ingestText(col.id, 'Other', 'Unrelated content about cooking pasta.')
    const res = await services.rag.search({ query: 'how do guards handle requests', collectionIds: [col.id] })
    expect(res.hits[0].title).toBe('Guards')
    expect(res.hits[0].headingPath).toBe('Guards')
    expect(res.notes.join()).toMatch(/keyword-only/)
    expect(services.rag.listCollections()[0]).toMatchObject({ docCount: 2 })
  })

  it('extracts readable markdown and links from HTML', () => {
    const html = `<html><head><title>T</title></head><body><nav><a href="/a">A</a></nav><main><h1>Hello</h1><p>${'Body text. '.repeat(40)}</p><a href="/docs/next#x">next</a></main></body></html>`
    const out = extractHtml(html, 'https://example.com/docs/')
    expect(out.text).toContain('Hello')
    expect(out.links).toContain('https://example.com/docs/next')
  })
})

describe('agent (pi-agent-core)', () => {
  it('produces UI turns with tool traces and references', async () => {
    const faux = registerFauxProvider()
    faux.setResponses([
      fauxAssistantMessage([fauxText('Let me search.'), fauxToolCall('lookup', { q: 'x' }, { id: 'call_1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Answer [1].')
    ])
    const agent = new Agent({
      initialState: {
        systemPrompt: 'test',
        model: faux.getModel(),
        tools: [
          {
            name: 'lookup',
            label: 'Lookup',
            description: 'x',
            parameters: Type.Object({ q: Type.String() }),
            execute: async () => ({ content: [{ type: 'text', text: 'result' }], details: { durationMs: 5, references: [{ chunkId: 'c1', title: 'Doc' }] } })
          }
        ]
      },
      streamFn: streamSimple,
      getApiKey: async () => 'k'
    })
    await agent.prompt('question')
    const ui = toUiMessages(agent.state.messages)
    faux.unregister()
    expect(ui.map((m) => m.role)).toEqual(['user', 'assistant'])
    const blocks = ui[1].blocks
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool', 'text'])
    const tool = blocks[1] as Extract<(typeof blocks)[number], { type: 'tool' }>
    expect(tool.trace).toMatchObject({ name: 'lookup', status: 'ok', result: 'result', durationMs: 5 })
    expect(tool.trace.references[0].title).toBe('Doc')
  })

  it('parses loose JSON from model replies', () => {
    expect(parseJsonLoose('Sure!\n```json\n{"a": [1]}\n```')).toEqual({ a: [1] })
    expect(parseJsonLoose('here: {"queries": ["x"]} done')).toEqual({ queries: ['x'] })
  })
})
