import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { RESULT_STRIPPED, stripToolResults } from '../src/main/agent/strip'
import { toUiMessages } from '../src/main/agent/chat'

const big = 'x'.repeat(2000)
const call = (id: string, ts: number): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: {} }], stopReason: 'toolUse', timestamp: ts, model: 'm', api: 'a', provider: 'p', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as unknown as AgentMessage
const result = (id: string, text: string, ts: number): AgentMessage =>
  ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: ts }) as unknown as AgentMessage

describe('stripToolResults', () => {
  const history: AgentMessage[] = [{ role: 'user', content: 'hi', timestamp: 1 } as AgentMessage, call('a', 2), result('a', big, 3), call('b', 4), result('b', 'ok', 5)]

  it('replaces big results with a note and keeps small ones', () => {
    const { messages, count } = stripToolResults(history)
    expect(count).toBe(1)
    const a = messages[2] as unknown as { content: { text: string }[]; stripped: { text: string }[] }
    expect(a.content).toEqual([{ type: 'text', text: RESULT_STRIPPED }])
    expect(a.stripped[0].text).toBe(big)
    expect(messages[4]).toBe(history[4])
    expect((history[2] as unknown as { content: { text: string }[] }).content[0].text).toBe(big)
  })

  it('does nothing the second time, and the chat still shows the original output', () => {
    const once = stripToolResults(history).messages
    const twice = stripToolResults(once)
    expect(twice.count).toBe(0)
    expect(twice.messages).toBe(once)
    const tool = toUiMessages(once)[1].blocks.find((b) => b.type === 'tool')
    expect(tool?.type === 'tool' && tool.trace.result).toBe(big)
  })
})
