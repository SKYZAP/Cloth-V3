import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { makeServices } from './helpers'

// A stand-in LiteLLM Proxy: /v1/models lists model groups, /model_group/info (root only) describes them,
// shaped like litellm/types/router.py ModelGroupInfo.
const groups: Record<string, unknown>[] = [
  {
    model_group: 'claude-sonnet',
    providers: ['anthropic'],
    max_input_tokens: 200000.0,
    max_output_tokens: 64000.0,
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    mode: 'chat',
    supports_vision: true,
    supports_reasoning: true,
    supports_function_calling: true,
    supported_reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    deployment_pricing: [{ provider: 'anthropic', costs: { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6 } }]
  },
  {
    model_group: 'o-mini',
    providers: ['openai'],
    max_input_tokens: 128000,
    max_output_tokens: 32000,
    input_cost_per_token: 1.1e-6,
    output_cost_per_token: 4.4e-6,
    mode: 'chat',
    supports_reasoning: true,
    supported_reasoning_efforts: ['low', 'medium', 'high']
  },
  { model_group: 'house-llama', providers: ['ollama'], max_input_tokens: null, max_output_tokens: null, input_cost_per_token: 0, output_cost_per_token: 0, mode: 'chat', supports_reasoning: false },
  { model_group: 'embed', providers: ['openai'], max_input_tokens: 8191, input_cost_per_token: 2e-8, output_cost_per_token: 0, mode: 'embedding' },
  { model_group: 'whisper', providers: ['openai'], mode: 'audio_transcription' }
]
let auth: string | undefined
let server: Server
let base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: groups.map((g) => ({ id: g.model_group, object: 'model' })) }))
    if (req.url === '/model_group/info') {
      auth = req.headers.authorization
      return res.end(JSON.stringify({ data: groups }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => server.close())

describe('LiteLLM proxy', () => {
  it('is offered when adding a provider', () => {
    const { services } = makeServices()
    expect(services.providers.presets().find((p) => p.id === 'litellm')).toMatchObject({ kind: 'openai-compatible', baseUrl: 'http://localhost:4000/v1' })
  })

  it('reads limits, prices, vision and reasoning levels from /model_group/info', async () => {
    const { services } = makeServices()
    const p = services.providers.create({ name: 'LiteLLM', kind: 'openai-compatible', baseUrl: base, apiKey: 'sk-test' })
    const { models } = await services.providers.refreshModels(p.id)
    expect(auth).toBe('Bearer sk-test')
    // Speech-to-text can't chat: dropped.
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet', 'o-mini', 'house-llama', 'embed'])

    const claude = models.find((m) => m.id === 'claude-sonnet')!
    expect(claude).toMatchObject({ contextWindow: 200_000, contextSource: 'server', maxTokens: 64_000, vision: true, reasoning: true, offEffort: 'none' })
    expect(claude.efforts).toBeUndefined() // takes every level
    expect(claude.listPrice).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    // On this PC, but it bills for Anthropic: priced all the same.
    expect(services.providers.pricing(p.id, 'claude-sonnet')).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })

    const mini = models.find((m) => m.id === 'o-mini')!
    expect(mini).toMatchObject({ reasoning: true, efforts: ['low', 'medium', 'high'], offEffort: null, maxTokens: 32_000 })

    // A free model on the proxy is free, not priced from the catalogue.
    expect(services.providers.pricing(p.id, 'house-llama')).toBeNull()
    expect(models.find((m) => m.id === 'house-llama')).toMatchObject({ reasoning: false, contextSource: 'guess' })

    expect(models.find((m) => m.id === 'embed')).toMatchObject({ embedding: true, reasoning: false, contextWindow: 8191 })
  })

  it('sends reasoning_effort "none" only to models that take it', async () => {
    const { services } = makeServices()
    const p = services.providers.create({ name: 'LiteLLM', kind: 'openai-compatible', baseUrl: base })
    await services.providers.refreshModels(p.id)
    const claude = services.providers.resolve({ providerId: p.id, modelId: 'claude-sonnet' }).model
    expect(claude.thinkingLevelMap?.off).toBe('none')
    const mini = services.providers.resolve({ providerId: p.id, modelId: 'o-mini' }).model
    // Thinking off sends nothing (the model's default); xhigh rounds down to the highest it takes.
    expect(mini.thinkingLevelMap && 'off' in mini.thinkingLevelMap).toBe(false)
    expect(mini.thinkingLevelMap?.xhigh).toBe('high')
  })

  it('a refresh takes the proxy\'s new limits and levels but keeps the user\'s own price', async () => {
    const { services } = makeServices()
    const p = services.providers.create({ name: 'LiteLLM', kind: 'openai-compatible', baseUrl: base })
    const first = await services.providers.refreshModels(p.id)
    services.providers.setModels(p.id, first.models.map((m) => (m.id === 'o-mini' ? { ...m, pricing: { input: 9, output: 9 } } : m)))
    const g = groups[1] as { max_output_tokens: number; supported_reasoning_efforts: string[] }
    g.max_output_tokens = 100_000
    g.supported_reasoning_efforts = ['none', 'low', 'medium', 'high', 'xhigh']
    try {
      const mini = (await services.providers.refreshModels(p.id)).models.find((m) => m.id === 'o-mini')!
      expect(mini).toMatchObject({ maxTokens: 100_000, offEffort: 'none', pricing: { input: 9, output: 9 } })
      expect(mini.efforts).toBeUndefined()
    } finally {
      g.max_output_tokens = 32000
      g.supported_reasoning_efforts = ['low', 'medium', 'high']
    }
  })

  it('leaves other OpenAI-compatible servers alone', async () => {
    const { services } = makeServices()
    const p = services.providers.create({ name: 'Elsewhere', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.providers.setModels(p.id, [{ id: 'm', name: 'm', contextWindow: 48_000, maxTokens: 4096, reasoning: true, vision: false, embedding: false }])
    expect(services.providers.resolve({ providerId: p.id, modelId: 'm' }).model.thinkingLevelMap).toEqual({ off: 'none' })
  })
})
