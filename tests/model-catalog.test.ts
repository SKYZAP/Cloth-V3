import { describe, expect, it } from 'vitest'
import { catalogModel, isLocalUrl, modelKey } from '../src/main/providers/catalog'
import { guessModelInfo, modelCost, serverPrice } from '../src/main/providers/providers'

const anthropic = { kind: 'anthropic' as const, baseUrl: 'https://api.anthropic.com' }
const openrouter = { kind: 'openai-compatible' as const, baseUrl: 'https://openrouter.ai/api/v1' }
const proxy = { kind: 'openai-compatible' as const, baseUrl: 'https://llm.example.com/v1' }
const zai = { kind: 'openai-compatible' as const, baseUrl: 'https://api.z.ai/api/coding/paas/v4' }
const local = { kind: 'openai-compatible' as const, baseUrl: 'http://localhost:1234/v1' }

describe('model catalogue', () => {
  it('spells one model the same way across catalogues', () => {
    expect(modelKey('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5')
    expect(modelKey('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(modelKey('zai-org/GLM-5.3:batch')).toBe('glm-5-3')
  })

  it('knows Opus 5.5 at Anthropic, through OpenRouter and behind a proxy', () => {
    for (const [p, id] of [[anthropic, 'claude-opus-5-5'], [openrouter, 'anthropic/claude-opus-5.5'], [proxy, 'claude-opus-5.5']] as const) {
      const info = guessModelInfo(p, id)
      expect(info.contextSource).toBe('catalog')
      expect(info.contextWindow).toBeGreaterThanOrEqual(1_000_000)
      const c = modelCost(p, undefined, id)
      expect(c.input).toBeGreaterThan(0)
      expect(c.output).toBeGreaterThan(c.input)
      expect(c.cacheRead).toBeGreaterThan(0)
    }
  })

  it('knows GLM 5.3 at Z.ai', () => {
    const info = guessModelInfo(zai, 'glm-5.3')
    expect(info.contextWindow).toBeGreaterThanOrEqual(1_000_000)
    expect(info.contextSource).toBe('catalog')
    const c = modelCost(zai, undefined, 'glm-5.3')
    expect(c.input).toBeCloseTo(1.4)
    expect(c.output).toBeCloseTo(4.4)
  })

  it('never prices a server on this PC', () => {
    expect(isLocalUrl(local.baseUrl)).toBe(true)
    expect(isLocalUrl('http://192.168.1.20:8000/v1')).toBe(true)
    expect(isLocalUrl(openrouter.baseUrl)).toBe(false)
    expect(catalogModel(local, 'claude-opus-5.5')).toBeNull()
    expect(modelCost(local, undefined, 'claude-opus-5.5')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(guessModelInfo(local, 'qwen-local').contextSource).toBe('guess')
  })

  it('a user price keeps the listed cache prices it leaves out', () => {
    const listed = modelCost(anthropic, undefined, 'claude-opus-5-5')
    const c = modelCost(anthropic, { pricing: { input: 3, output: 15 } }, 'claude-opus-5-5')
    expect(c).toMatchObject({ input: 3, output: 15, cacheRead: listed.cacheRead, cacheWrite: listed.cacheWrite })
    expect(modelCost(anthropic, { pricing: { input: 3, output: 15, cacheRead: 0.1 } }, 'claude-opus-5-5').cacheRead).toBe(0.1)
    // On this PC a price the user set still counts.
    expect(modelCost(local, { pricing: { input: 1, output: 2 } }, 'qwen-local')).toMatchObject({ input: 1, output: 2 })
  })

  it('prefers the price the provider lists', () => {
    const listPrice = serverPrice({ prompt: '0.000004', completion: '0.00002', input_cache_read: '0.0000002', input_cache_write: '0.000005' })
    expect(listPrice).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(serverPrice({ prompt: '0', completion: '0' })).toBeNull()
    expect(modelCost(openrouter, { listPrice: { input: 9, output: 9, cacheRead: 1, cacheWrite: 1 } }, 'anthropic/claude-opus-5.5').input).toBe(9)
  })

  it('leaves an unknown hosted model unpriced with a guessed context', () => {
    expect(modelCost(proxy, undefined, 'house-model-7')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(guessModelInfo(proxy, 'house-model-7').contextSource).toBe('guess')
  })
})
