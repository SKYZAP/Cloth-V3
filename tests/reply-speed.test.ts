import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { toUiMessages } from '../src/main/agent/chat'

const step = (ts: number, output: number, genMs?: number, text = 'hi') =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'm',
    usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: ts,
    ...(genMs !== undefined ? { genMs } : {})
  }) as unknown as AgentMessage

const user = (ts: number) => ({ role: 'user', content: 'go', timestamp: ts }) as AgentMessage

describe('reply speed', () => {
  it('adds up the timed steps of a reply', () => {
    const [, reply] = toUiMessages([user(1), step(2, 300, 2000), step(3, 100, 2000)])
    expect(reply.usage).toMatchObject({ output: 400, genMs: 4000, genOutput: 400 })
  })

  it('leaves out steps without a usable time: old messages and replies that arrived in one piece', () => {
    const [, reply] = toUiMessages([user(1), step(2, 200, 1000), step(3, 500), step(4, 50, 10)])
    expect(reply.usage).toMatchObject({ output: 750, genMs: 1000, genOutput: 200 })
    const [, old] = toUiMessages([user(1), step(2, 200)])
    expect(old.usage?.genMs).toBeUndefined()
  })
})
