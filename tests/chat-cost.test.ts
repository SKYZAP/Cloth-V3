import { describe, expect, it } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { formatCost, formatTokens } from '../src/renderer/src/lib/format'
import { makeServices } from './helpers'

const reply = (cost: number) => ({ role: 'assistant', content: [], provider: 'p', model: 'm', stopReason: 'stop', timestamp: 0, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } } }) as unknown as AssistantMessage

describe('chat cost', () => {
  it('sums what a chat spent, and only that chat', async () => {
    const { services } = makeServices()
    const usage = services.providers.usage
    const chat = services.chat.create({})
    const other = services.chat.create({})
    expect((await services.chat.contextUsage(chat.id)).cost).toBe(0)

    usage.run({ source: 'chat', ref: chat.id }, () => {
      usage.message(reply(0.25), 10)
      usage.message(reply(0.5), 10)
    })
    usage.run({ source: 'chat', ref: other.id }, () => usage.message(reply(3), 10))
    usage.run({ source: 'workflow', ref: chat.id }, () => usage.message(reply(7), 10))

    expect(usage.costFor('chat', chat.id)).toBeCloseTo(0.75)
    expect((await services.chat.contextUsage(chat.id)).cost).toBeCloseTo(0.75)
    expect((await services.chat.contextUsage(other.id)).cost).toBeCloseTo(3)
  })

  it('formats tokens and costs compactly', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(9_999)).toBe('10k')
    expect(formatTokens(48_400)).toBe('48k')
    expect(formatTokens(999_700)).toBe('1.0M')
    expect(formatTokens(1_340_000)).toBe('1.3M')
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatCost(0.01)).toBe('$0.01')
    expect(formatCost(1.268)).toBe('$1.27')
  })
})
