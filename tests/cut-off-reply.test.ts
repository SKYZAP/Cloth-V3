import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxThinking, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { estimateTokens } from '@earendil-works/pi-coding-agent'
import { cutOffEmpty, fitToolResults } from '../src/main/agent/compaction'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup(contextWindow: number) {
  const env = makeServices()
  const root = mkdtempSync(join(tmpdir(), 'cloth-cutoff-'))
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  env.services.providers.setModels(provider.id, [{ id: 'faux-1', name: 'faux-1', contextWindow, maxTokens: 2048, reasoning: false, vision: false, embedding: false }])
  const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: root, fileAccess: 'read', knowledgeEnabled: false, skillsEnabled: false, customTools: false, subagents: false, codeIntel: false, imagesEnabled: false })
  faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
  return { ...env, root, session }
}

async function send(env: ReturnType<typeof setup>, text: string) {
  await env.services.chat.send(env.session.id, text)
  for (let i = 0; i < 500 && env.services.chat.isRunning(env.session.id); i++) await wait(10)
  expect(env.services.chat.isRunning(env.session.id)).toBe(false)
}

const result = (text: string) => ({ role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: 1 }) as unknown as AgentMessage
const textOf = (m: AgentMessage) => ((m as { content: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('')

describe('a reply cut off before it starts', () => {
  it('is recognised only when it said and did nothing', () => {
    const msg = (content: unknown[], stopReason = 'length') => ({ role: 'assistant', content, stopReason, timestamp: 1 }) as unknown as AgentMessage
    expect(cutOffEmpty(msg([{ type: 'thinking', thinking: 'hmm' }]))).toBe(true)
    expect(cutOffEmpty(msg([]))).toBe(true)
    expect(cutOffEmpty(msg([{ type: 'text', text: 'Partial answer' }]))).toBe(false)
    expect(cutOffEmpty(msg([{ type: 'thinking', thinking: 'hmm' }], 'stop'))).toBe(false)
  })

  it('gets one more go on its own instead of leaving the chat waiting for a nudge', async () => {
    const env = setup(200_000)
    const calls: TranscriptContext[] = []
    faux!.setResponses([
      (ctx) => (calls.push(ctx), fauxAssistantMessage([fauxThinking('Planning a long answer')], { stopReason: 'length' })),
      (ctx) => (calls.push(ctx), fauxAssistantMessage('Here is the answer.'))
    ])
    await send(env, 'Tell me about the original Cloth')
    expect(calls).toHaveLength(2)
    // The cut-off reply isn't sent again, and no "continue" was added for the person.
    expect(calls[1]!.messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
    const ui = env.services.chat.messages(env.session.id)
    expect(ui.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(ui.at(-1))).toContain('Here is the answer.')
  })

  it('is retried only once', async () => {
    const env = setup(200_000)
    let n = 0
    faux!.setResponses([() => (n++, fauxAssistantMessage([fauxThinking('x')], { stopReason: 'length' })), () => (n++, fauxAssistantMessage([fauxThinking('y')], { stopReason: 'length' })), () => (n++, fauxAssistantMessage('never'))])
    await send(env, 'hi')
    expect(n).toBe(2)
  })
})

describe('tool results too big for the window', () => {
  it('are trimmed to the room given, keeping both ends and saying what was left out', () => {
    const big = `START ${'x'.repeat(400_000)} END`
    const msgs = [{ role: 'user', content: 'go', timestamp: 0 } as AgentMessage, result(big)]
    const fitted = fitToolResults(msgs, 40_000)
    expect(fitted).not.toBe(msgs)
    const text = textOf(fitted[1]!)
    expect(text.startsWith('START')).toBe(true)
    expect(text.endsWith('END')).toBe(true)
    expect(text).toMatch(/characters left out here/)
    expect(estimateTokens(fitted[1]!)).toBeLessThanOrEqual(40_000 * 1.05)
    // The originals are untouched, and results that fit pass through as they were.
    expect(textOf(msgs[1]!)).toBe(big)
    const small = [result('short')]
    expect(fitToolResults(small, 40_000)).toBe(small)
  })

  it('leave small results whole and split the rest between the big ones', () => {
    const msgs = [{ role: 'user', content: 'go', timestamp: 0 } as AgentMessage, result('s'.repeat(4_000)), ...Array.from({ length: 3 }, () => result('y'.repeat(200_000)))]
    const fitted = fitToolResults(msgs, 30_000)
    expect(textOf(fitted[1]!)).toBe('s'.repeat(4_000))
    const total = fitted.slice(1).reduce((n, m) => n + estimateTokens(m), 0)
    expect(total).toBeLessThanOrEqual(30_000 * 1.1)
  })

  it('no longer leave a turn without room to answer', async () => {
    // A 20k window (summarises above 15k) and one step reading three big files: their results alone are over the line,
    // and summarising keeps that step whole, so it can't make room.
    const env = setup(20_000)
    const names = ['a.json', 'b.json', 'c.json']
    for (const n of names) writeFileSync(join(env.root, n), Array.from({ length: 1200 }, (_, i) => `{"${n}": ${i}, "pad": "${'z'.repeat(90)}"}`).join('\n'))
    const seen: TranscriptContext[] = []
    faux!.setResponses([
      (ctx) => (seen.push(ctx), fauxAssistantMessage(names.map((n, i) => fauxToolCall('read', { path: n }, { id: `r${i}` })), { stopReason: 'toolUse' })),
      (ctx) => (seen.push(ctx), fauxAssistantMessage('Read them.'))
    ])
    await send(env, 'Read the three files')
    const answer = seen.at(-1)!
    const sent = answer.messages.filter((m) => m.role === 'toolResult')
    expect(sent).toHaveLength(3)
    const full = env.services.chat.messages(env.session.id)
    // Without trimming the three results would be well over the line.
    expect(sent.reduce((n, m) => n + estimateTokens(m as AgentMessage), 0)).toBeLessThanOrEqual(15_000)
    expect(JSON.stringify(sent)).toMatch(/characters left out here/)
    expect(JSON.stringify(full)).not.toMatch(/characters left out here/)
    expect(JSON.stringify(full.at(-1))).toContain('Read them.')
  })
})
