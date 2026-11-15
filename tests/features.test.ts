import { describe, expect, it, vi } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { executeGraph } from '../src/main/workflows/engine'
import { parseDuckDuckGo } from '../src/main/web/obscura'
import { isPrivateHost } from '../src/main/web/web'
import { rerankByOverlap } from '../src/main/web/searxng'
import { buildTools, describeBuiltins } from '../src/main/agent/tools'
import { makeServices } from './helpers'

describe('custom tools', () => {
  it('validates names and reserved built-ins', () => {
    const { services } = makeServices()
    const base = { description: 'd', kind: 'javascript' as const, params: [], config: { code: 'return 1' } }
    expect(() => services.custom.create({ ...base, name: 'Bad Name' })).toThrow(/snake_case/)
    expect(() => services.custom.create({ ...base, name: 'web_search' })).toThrow(/built-in/)
    services.custom.create({ ...base, name: 'one' })
    expect(() => services.custom.create({ ...base, name: 'one' })).toThrow(/already exists/)
  })

  it('runs javascript tools with typed args and captured console', async () => {
    const { services } = makeServices()
    const tool = services.custom.create({
      name: 'add',
      description: 'Add numbers',
      kind: 'javascript',
      params: [
        { name: 'a', type: 'number', description: '', required: true },
        { name: 'b', type: 'number', description: '', required: true }
      ],
      config: { code: 'console.log("adding"); return { sum: args.a + args.b }' }
    })
    const out = await services.custom.execute(tool, { a: '2', b: 3 })
    expect(out).toContain('adding')
    expect(out).toContain('"sum": 5')
    await expect(services.custom.execute(tool, { a: 1 })).rejects.toThrow(/Missing required argument "b"/)
  })

  it('runs command tools without a shell (one templated arg per line)', async () => {
    const { services } = makeServices()
    const res = await services.custom.test(
      { kind: 'command', params: [{ name: 'msg', type: 'string', description: '', required: true }], config: { command: process.execPath, args: '-e\nconsole.log(process.argv[1])\n{{msg}}' } },
      { msg: 'hello; echo injected' }
    )
    expect(res.ok).toBe(true)
    expect(res.output.trim()).toBe('hello; echo injected')
  })

  it('offers enabled custom tools to the agent alongside scoped built-ins', () => {
    const { services } = makeServices()
    services.custom.create({ name: 'ping_tool', description: 'x', kind: 'javascript', params: [], config: { code: 'return "pong"' } })
    const deps = { rag: services.rag, skills: services.skills, web: services.web, custom: services.custom }
    const names = (scope: Parameters<typeof buildTools>[1]) => buildTools(deps, scope).map((t) => t.name)
    expect(names({ collectionIds: [], skillsEnabled: false, workspace: null })).toEqual(['ping_tool'])
    expect(names({ collectionIds: [], skillsEnabled: true, webEnabled: true, customTools: false, workspace: null })).toEqual(['web_search', 'web_fetch', 'skill_list', 'skill_use'])
    expect(describeBuiltins().map((b) => b.name)).toContain('grep')
  })
})

describe('workflow engine', () => {
  it('executes web and tool node types via the engine executor contract', async () => {
    const res = await executeGraph(
      {
        nodes: [
          { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 't' } },
          { id: 'o', type: 'output', position: { x: 1, y: 0 }, data: { key: 'o' } }
        ],
        edges: [{ id: 'e', source: 't', target: 'o' }]
      },
      { q: 1 },
      async (n, { prev }) => ({ output: n.type === 'output' ? prev : prev }),
      new AbortController().signal
    )
    expect(res.output).toEqual({ q: 1 })
  })
})

describe('web search plumbing', () => {
  it('parses DuckDuckGo HTML results and unwraps redirect links', () => {
    const html = `<div class="result results_links"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.nestjs.com%2Fguards&rut=x">Guards | NestJS</a></h2><a class="result__snippet">Guards have a single responsibility.</a></div>
      <div class="result result--ad"><a class="result__a" href="https://ads.example">Ad</a></div>
      <div class="result"><a class="result__a" href="https://example.com/b">B</a><div class="result__snippet">  two   </div></div>`
    expect(parseDuckDuckGo(html)).toEqual([
      { title: 'Guards | NestJS', url: 'https://docs.nestjs.com/guards', snippet: 'Guards have a single responsibility.', engine: 'duckduckgo' },
      { title: 'B', url: 'https://example.com/b', snippet: 'two', engine: 'duckduckgo' }
    ])
  })

  it('drops metasearch junk that shares no query terms and ranks by overlap', () => {
    const r = (title: string, url: string) => ({ title, url, snippet: '' })
    const out = rerankByOverlap('nestjs guards', [r('Summer Place', 'https://summerplace.example'), r('Guards', 'https://x/guards'), r('NestJS Guards', 'https://docs.nestjs.com/guards')])
    expect(out.map((x) => x.title)).toEqual(['NestJS Guards', 'Guards'])
  })

  it('classifies private hosts for web_fetch', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.1.1', '[::1]']) expect(isPrivateHost(h)).toBe(true)
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h)).toBe(false)
  })

  it('refuses private web_fetch targets by default', async () => {
    const { services } = makeServices()
    await expect(services.web.fetchPage('http://127.0.0.1:9/x')).rejects.toThrow(/private network/)
  })
})

describe('ask the collection', () => {
  it('answers from retrieved passages, and skips the model when nothing matches', async () => {
    const { services } = makeServices()
    const col = services.rag.createCollection({ name: 'docs', embedding: null })
    await services.rag.ingestText(col.id, 'Guards', '# Guards\n\nA guard implements CanActivate and decides whether a request is handled.')
    const prompts: string[] = []
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-ask' })
    faux.setResponses([
      (ctx) => {
        prompts.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('Guards implement CanActivate [1].')
      }
    ])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
      const res = await services.rag.ask({ query: 'what does a guard implement', collectionIds: [col.id] })
      expect(res.answer).toBe('Guards implement CanActivate [1].')
      expect(res.search.hits[0].title).toBe('Guards')
      expect(prompts[0]).toContain('[1] Guards')
      const none = await services.rag.ask({ query: 'kubernetes helm charts', collectionIds: [col.id] })
      expect(none.search.hits).toHaveLength(0)
      expect(none.answer).toBeNull()
      expect(prompts).toHaveLength(1)
      services.settings.update({ defaultModel: null })
      const noModel = await services.rag.ask({ query: 'guard', collectionIds: [col.id] })
      expect(noModel.answer).toBeNull()
      expect(noModel.error).toMatch(/default chat model/)
    } finally {
      faux.unregister()
    }
  })
})

describe('example knowledge', () => {
  it('seeds the bundled docs once and makes them searchable', async () => {
    const { services } = makeServices()
    await services.examples.seedIfNeeded()
    // Ingestion is queued; wait for the queue to drain.
    for (let i = 0; i < 100 && services.rag.listCollections()[0]?.docCount !== services.examples.files().length; i++) await new Promise((r) => setTimeout(r, 50))
    const col = services.rag.listCollections()[0]
    expect(col.name).toBe('Cloth examples')
    expect(col.docCount).toBe(services.examples.files().length)
    const res = await services.rag.search({ query: 'undo the last commit but keep changes', collectionIds: [col.id] })
    expect(res.hits[0].title).toBe('git-cheatsheet.md')
    services.rag.deleteCollection(col.id)
    await services.examples.seedIfNeeded()
    expect(services.rag.listCollections()).toHaveLength(0)
  })

  it('covers current features in the user guide, and reloads the docs once when a release changes them', async () => {
    const { services } = makeServices()
    await services.examples.seedIfNeeded()
    const count = () => services.rag.listCollections()[0]?.docCount
    for (let i = 0; i < 100 && count() !== services.examples.files().length; i++) await new Promise((r) => setTimeout(r, 50))
    const col = services.rag.listCollections()[0]
    const res = await services.rag.search({ query: 'tracker tickets planner reviewer implementer worktree', collectionIds: [col.id] })
    expect(res.hits[0].title).toBe('cloth-user-guide.md')

    const hash = services.settings.get().examplesHash
    expect(hash).toMatch(/^[a-f0-9]{40}$/)
    const load = vi.spyOn(services.examples, 'load')
    // The same bundle as last time: nothing to do.
    await services.examples.seedIfNeeded()
    expect(load).not.toHaveBeenCalled()
    // A release changed the docs: they are loaded again, once.
    services.settings.update({ examplesHash: 'an older release' })
    await services.examples.seedIfNeeded()
    expect(load).toHaveBeenCalledTimes(1)
    expect(services.settings.get().examplesHash).toBe(hash)
    expect(services.rag.listCollections()).toHaveLength(1)
    load.mockRestore()
    services.rag.deleteCollection(col.id)
  })
})

describe('reasoning models in one-shot calls', () => {
  it('retries with thinking off when a model spends its whole budget thinking', async () => {
    const { services } = makeServices()
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-think' })
    faux.setResponses([
      fauxAssistantMessage([{ type: 'thinking', thinking: 'Let me think about this at great length…' }], { stopReason: 'length' }),
      fauxAssistantMessage('{"cases": []}')
    ])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const { text } = await services.providers.complete({ providerId: provider.id, modelId: 'faux-1' }, { prompt: 'json please' })
      expect(text).toBe('{"cases": []}')
      expect(faux.state.callCount).toBe(2)
    } finally {
      faux.unregister()
    }
  })

  it('drops temperature for models that only accept the default, and remembers it', async () => {
    const { services } = makeServices()
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-temp' })
    const seen: (number | undefined)[] = []
    const reply = (_ctx: unknown, options: { temperature?: number } | undefined) => {
      seen.push(options?.temperature)
      return options?.temperature !== undefined
        ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: "400 Unsupported parameter: 'temperature' is not supported with this model." })
        : fauxAssistantMessage('PASS')
    }
    faux.setResponses([reply, reply, reply])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const ref = { providerId: provider.id, modelId: 'gpt-6-luna' }
      expect((await services.providers.complete(ref, { prompt: 'grade', temperature: 0 })).text).toBe('PASS')
      expect((await services.providers.complete(ref, { prompt: 'grade', temperature: 0 })).text).toBe('PASS')
      expect(seen).toEqual([0, undefined, undefined])
    } finally {
      faux.unregister()
    }
  })

  it('recognises reasoning-by-default model families', async () => {
    const { isReasoningModelId, stripThinkTags } = await import('../src/main/providers/providers')
    for (const id of ['qwen/qwen3.5-9b', 'qwen35', 'deepseek-r1-distill-qwen-7b', 'openai/gpt-oss-20b', 'qwq-32b']) expect(isReasoningModelId(id)).toBe(true)
    for (const id of ['google/gemma-4-e4b', 'llama-3.1-8b-instruct', 'mistral-small']) expect(isReasoningModelId(id)).toBe(false)
    expect(stripThinkTags('<think>hmm</think>{"a":1}')).toBe('{"a":1}')
  })
})
