import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApi } from '../src/main/api'
import { makeServices } from './helpers'

// A stand-in LM Studio: /v1/models plus the richer /api/v0/models with each model's loaded context.
const loaded: Record<string, number | undefined> = { 'qwen/qwen3.8-27b': 100_096, luna: undefined }
let server: Server
let base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    const ids = ['qwen/qwen3.8-27b', 'luna', 'mystery']
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) }))
    if (req.url === '/api/v0/models')
      return res.end(
        JSON.stringify({
          data: [
            { id: 'qwen/qwen3.8-27b', type: 'llm', state: 'loaded', max_context_length: 262_144, loaded_context_length: loaded['qwen/qwen3.8-27b'] },
            { id: 'luna', type: 'llm', state: loaded.luna ? 'loaded' : 'not-loaded', max_context_length: 131_072, loaded_context_length: loaded.luna }
          ]
        })
      )
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})
afterAll(() => server.close())

describe('context limits', () => {
  it('a chat picks up the current limit when its model is switched, not a stale one', async () => {
    const { services } = makeServices()
    const api = createApi(services)
    const p = services.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: base })
    // What an old listing left behind: default guesses for both models.
    const stale = { contextWindow: 32_768, maxTokens: 8192, reasoning: false, vision: false, embedding: false }
    services.providers.setModels(p.id, [
      { id: 'qwen/qwen3.8-27b', name: 'qwen', ...stale, pricing: { input: 0.1, output: 0.2 } },
      { id: 'luna', name: 'luna', ...stale }
    ])
    const chat = services.chat.create({ model: { providerId: p.id, modelId: 'qwen/qwen3.8-27b' } })

    // Opening the chat: the loaded context (not the 262k maximum, not the 32k guess).
    expect((await api.chat.contextUsage(chat.id)).window).toBe(100_096)

    // Switching to a model that isn't loaded: its reported maximum.
    await api.chat.update(chat.id, { model: { providerId: p.id, modelId: 'luna' } })
    const usage = await api.chat.contextUsage(chat.id)
    expect(usage.window).toBe(131_072)
    expect(usage.estimated).toBe(false)

    // The server loads it with a smaller context; a forced refresh (as after a turn) sees that.
    loaded.luna = 16_384
    await services.providers.refreshModel({ providerId: p.id, modelId: 'luna' }, { force: true })
    expect((await api.chat.contextUsage(chat.id)).window).toBe(16_384)

    // A full model refresh keeps user settings (pricing) but takes the server's limits.
    loaded['qwen/qwen3.8-27b'] = 65_536
    const refreshed = await services.providers.refreshModels(p.id)
    expect(refreshed.models.find((m) => m.id === 'qwen/qwen3.8-27b')).toMatchObject({ contextWindow: 65_536, contextSource: 'server', pricing: { input: 0.1, output: 0.2 } })

    // A model the server says nothing about stays a guess, and the meter says so.
    await api.chat.update(chat.id, { model: { providerId: p.id, modelId: 'mystery' } })
    const guessed = await api.chat.contextUsage(chat.id)
    expect(guessed.window).toBe(32_768)
    expect(guessed.estimated).toBe(true)
  })

  it('an offline provider keeps the limit it had', async () => {
    const { services } = makeServices()
    const p = services.providers.create({ name: 'Gone', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.providers.setModels(p.id, [{ id: 'm', name: 'm', contextWindow: 48_000, maxTokens: 4096, reasoning: false, vision: false, embedding: false, contextSource: 'server' }])
    const chat = services.chat.create({ model: { providerId: p.id, modelId: 'm' } })
    expect((await services.chat.contextUsage(chat.id)).window).toBe(48_000)
  })
})
