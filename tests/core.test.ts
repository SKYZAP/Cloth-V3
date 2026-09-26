import { describe, expect, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Agent } from '@mariozechner/pi-agent-core'
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider, Type } from '@mariozechner/pi-ai'
import { chunkText } from '../src/main/rag/chunker'
import { executeGraph, renderTemplate, topoSort } from '../src/main/workflows/engine'
import { computeVerdict, parseSkillMd, serializeSkillMd } from '../src/main/skills/skills'
import { toUiMessages } from '../src/main/agent/chat'
import { parseJsonLoose } from '../src/main/core/llm-json'
import { extractHtml } from '../src/main/rag/extract'
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

  it('computes verdicts', () => {
    const base = { cases: [], issues: [], baselineScore: null }
    expect(computeVerdict({ ...base, score: 0.3 }, null, false).verdict).toBe('failing')
    expect(computeVerdict({ ...base, score: 1 }, null, false).verdict).toBe('fresh')
    expect(computeVerdict({ ...base, score: 0.7 }, 1, false).verdict).toBe('stale')
    expect(computeVerdict({ ...base, score: 1, baselineScore: 1 }, null, false).verdict).toBe('redundant')
    expect(computeVerdict({ ...base, score: null, issues: [{ severity: 'high', excerpt: '', problem: '', suggestion: '' }] }, null, true).verdict).toBe('stale')
    expect(computeVerdict({ ...base, score: null }, null, true).verdict).toBe('fresh')
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
