import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, ToolTrace } from '../src/shared/types'
import { budget, findCut } from '../src/main/agent/compaction'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup(contextWindow = 32_768) {
  const env = makeServices()
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  env.services.providers.setModels(provider.id, [{ id: 'faux-1', name: 'faux-1', contextWindow, maxTokens: 2048, reasoning: false, vision: false, embedding: false }])
  const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false, skillsEnabled: false, customTools: false })
  return { ...env, session }
}

async function send(env: ReturnType<typeof setup>, text: string) {
  await env.services.chat.send(env.session.id, text)
  for (let i = 0; i < 400 && env.services.chat.isRunning(env.session.id); i++) await wait(10)
}

const long = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join(' ')

describe('todo_write', () => {
  it('records the plan as structured todos on the trace', async () => {
    const env = setup()
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const todos = [
      { content: 'Read the config', status: 'completed' },
      { content: 'Add the port option', status: 'in_progress' },
      { content: 'Update the README', status: 'pending' }
    ]
    faux.setResponses([fauxAssistantMessage([fauxToolCall('todo_write', { todos }, { id: 't1' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Working on it.')])
    await send(env, 'do the thing')
    const trace = env.services.chat
      .messages(env.session.id)
      .flatMap((m) => m.blocks)
      .find((b) => b.type === 'tool') as { trace: ToolTrace }
    expect(trace.trace.name).toBe('todo_write')
    expect(trace.trace.status).toBe('ok')
    expect(trace.trace.result).toContain('1/3 completed')
    expect(trace.trace.result).toContain('In progress: Add the port option')
  })
})

describe('conversation summarising', () => {
  it('findCut keeps the recent tail and cuts at a user message', () => {
    const msgs = [
      { role: 'user', content: long(400, 'a'), timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: long(400, 'b') }], timestamp: 2 },
      { role: 'user', content: long(400, 'c'), timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text', text: long(400, 'd') }], timestamp: 4 },
      { role: 'user', content: 'latest', timestamp: 5 }
    ] as never[]
    expect(findCut(msgs, 1)).toBe(4)
    expect(findCut(msgs, 10)).toBe(2)
    expect(findCut(msgs.slice(0, 1), 10)).toBeNull()
    expect(budget(32_768)).toMatchObject({ reserve: 8192, threshold: 24_576 })
  })

  it('summarises automatically near the context limit and keeps the old turns visible', async () => {
    const env = setup(6000)
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let summaryPrompt = ''
    faux.setResponses([
      fauxAssistantMessage(long(700, 'alpha')),
      fauxAssistantMessage(long(700, 'beta')),
      (ctx: TranscriptContext) => {
        summaryPrompt = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('## Goal\n- Discuss alpha and beta\n\n## Next Steps\n1. Continue with gamma')
      },
      (ctx: TranscriptContext) => {
        // The model sees the summary on the first message it receives.
        expect(JSON.stringify(ctx.messages.filter((m) => m.role === 'user')[0])).toContain('conversation-summary')
        return fauxAssistantMessage('gamma answer')
      }
    ])
    await send(env, 'tell me about alpha')
    await send(env, 'now beta')
    await send(env, 'and gamma')

    expect(summaryPrompt).toContain('<conversation>')
    expect(summaryPrompt).toContain('alpha')
    const events = env.events.filter((e) => e.channel === 'chat').map((e) => (e.payload as ChatEvent).type)
    expect(events).toContain('compacting')
    expect(events).toContain('compacted')

    const ui = env.services.chat.messages(env.session.id)
    const archived = ui.filter((m) => m.archived)
    expect(archived.length).toBeGreaterThanOrEqual(2)
    const carrier = ui.find((m) => m.summary)
    expect(carrier?.summary).toContain('Discuss alpha and beta')
    expect(carrier?.blocks[0]).toMatchObject({ type: 'text' })
    expect((carrier?.blocks[0] as { text: string }).text).not.toContain('conversation-summary')
    expect(ui.at(-1)?.blocks.some((b) => b.type === 'text' && b.text === 'gamma answer')).toBe(true)
  })

  it('compacts on demand and keeps the summary through regenerate', async () => {
    const env = setup(200_000)
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage('one'),
      fauxAssistantMessage('two'),
      fauxAssistantMessage('## Goal\n- testing manual compaction'),
      (ctx: TranscriptContext) => fauxAssistantMessage(JSON.stringify(ctx.messages.filter((m) => m.role === 'user')[0]).includes('testing manual compaction') ? 'still has summary' : 'lost summary')
    ])
    await send(env, 'first')
    await send(env, 'second')
    const after = await env.services.chat.compact(env.session.id, { instructions: 'focus on tests' })
    const carrier = after.find((m) => m.summary)!
    expect(carrier.summary).toContain('manual compaction')
    // Regenerate the answer to the message that carries the summary.
    env.services.chat.rewind(env.session.id, carrier.id)
    await send(env, 'second')
    const last = env.services.chat.messages(env.session.id).at(-1)!
    expect(last.blocks.find((b) => b.type === 'text')).toMatchObject({ text: 'still has summary' })
  })

  it('breaks context usage down by what it is spent on', async () => {
    const env = setup(32_768)
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('todo_write', { todos: [{ content: 'step one', status: 'in_progress' }] }, { id: 'tw' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(long(200, 'answer'))
    ])
    await send(env, long(100, 'question'))
    const u = await env.services.chat.contextUsage(env.session.id)
    const keys = u.breakdown.map((s) => s.key)
    expect(keys).toEqual(expect.arrayContaining(['system', 'tools', 'user', 'assistant', 'toolResults']))
    expect(keys).not.toContain('summary')
    const sum = u.breakdown.reduce((n, s) => n + s.tokens, 0)
    expect(Math.abs(sum - u.tokens)).toBeLessThanOrEqual(u.breakdown.length)
    expect(u.breakdown.find((s) => s.key === 'assistant')!.tokens).toBeGreaterThan(u.breakdown.find((s) => s.key === 'user')!.tokens)
  })

  it('reports context usage against the model window', async () => {
    const env = setup(8000)
    const u = await env.services.chat.contextUsage(env.session.id)
    expect(u.window).toBe(8000)
    expect(u.threshold).toBe(6000)
    expect(u.tokens).toBeGreaterThan(0)
  })
})
