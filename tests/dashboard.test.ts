import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage, registerFauxProvider } from '@mariozechner/pi-ai'
import { makeServices } from './helpers'

describe('usage log and dashboard', () => {
  it('records model calls, tools and skills with their origin and prices them', async () => {
    const { services } = makeServices()
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-usage' })
    faux.setResponses([fauxAssistantMessage('first answer'), fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'boom' })])
    try {
      const provider = services.providers.create({ name: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      services.providers.setModels(provider.id, [
        { id: 'priced-model', name: 'priced-model', contextWindow: 32768, maxTokens: 4096, reasoning: false, vision: false, embedding: false, pricing: { input: 2, output: 8 } }
      ])
      const usage = services.providers.usage
      await usage.run({ source: 'skills', ref: 'demo' }, () => services.providers.complete({ providerId: provider.id, modelId: 'priced-model' }, { prompt: 'a fairly long prompt so there are some tokens to count' }))
      await usage.run({ source: 'chat' }, () => services.providers.complete({ providerId: provider.id, modelId: 'priced-model' }, { prompt: 'fail please' })).catch(() => {})
      usage.run({ source: 'chat' }, () => {
        usage.tool('rag_search', 'builtin', 40, true)
        usage.tool('rag_search', 'builtin', 60, false)
        usage.tool('date_math', 'custom', 5, true)
        usage.skill('nestjs-guards', 'slash')
        usage.skill('nestjs-guards', 'tool')
      })

      const s = await services.dashboard.stats('24h')
      expect(s.totals.calls).toBe(2)
      expect(s.totals.errors).toBe(1)
      expect(s.totals.inputTokens).toBeGreaterThan(0)
      expect(s.totals.cost).toBeGreaterThan(0)
      expect(s.totals.unpricedTokens).toBe(0)
      expect(s.totals.toolCalls).toBe(3)
      expect(s.totals.toolErrors).toBe(1)
      expect(s.totals.skillUses).toBe(2)
      expect(s.models).toHaveLength(1)
      expect(s.models[0]).toMatchObject({ providerId: provider.id, provider: 'Local', modelId: 'priced-model', calls: 2, errors: 1, priced: true })
      expect(s.tools[0]).toMatchObject({ name: 'rag_search', calls: 2, errors: 1, avgMs: 50 })
      expect(s.skills[0]).toMatchObject({ name: 'nestjs-guards', uses: 2, via: { slash: 1, tool: 1 } })
      expect(s.sources.map((x) => x.source).sort()).toEqual(['chat', 'skills'])
      expect(s.bucket).toBe('hour')
      expect(s.timeline.length).toBeGreaterThanOrEqual(24)
      expect(s.timeline.reduce((n, b) => n + b.calls, 0)).toBe(2)
      expect(s.hours.reduce((a, b) => a + b, 0)).toBe(5)
      expect(s.recent[0].kind).toBe('skill')
      expect(s.previous?.calls).toBe(0)
      expect(s.inventory.providers).toBe(1)
    } finally {
      faux.unregister()
    }
  })

  it('attributes agent tool calls and workflow runs', async () => {
    const { services } = makeServices()
    const wf = services.workflows.create({ name: 'loop demo' })
    services.workflows.save(wf.id, {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 'start', defaultInput: '{"xs":[1,2,3]}' } },
        { id: 'l', type: 'loop', position: { x: 300, y: 0 }, data: { key: 'each', mode: 'each', items: '{{input.xs}}' } },
        { id: 'd', type: 'transform', position: { x: 600, y: 0 }, data: { key: 'double', code: 'return nodes.loop.item * 2' } },
        { id: 'o', type: 'output', position: { x: 900, y: 0 }, data: { key: 'result', value: '' } }
      ],
      edges: [
        { id: 'e1', source: 't', target: 'l' },
        { id: 'e2', source: 'l', target: 'd', sourceHandle: 'body' },
        { id: 'e3', source: 'd', target: 'l', targetHandle: 'next' },
        { id: 'e4', source: 'l', target: 'o', sourceHandle: 'done' }
      ]
    })
    const run = await services.workflows.run(wf.id, { xs: [1, 2, 3] })
    expect(run.status).toBe('ok')
    expect(run.output).toEqual([2, 4, 6])
    const s = await services.dashboard.stats('7d')
    expect(s.workflows).toMatchObject({ runs: 1, ok: 1, errors: 0 })
    expect(s.workflows.top[0].name).toBe('loop demo')
    expect(s.bucket).toBe('day')
  })
})
