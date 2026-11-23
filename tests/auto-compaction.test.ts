import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext, type UserMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, ToolTrace, UiMessage } from '../src/shared/types'
import { budget, compactedHistory, datedSummaries, findCut, planCompaction, splitSummary, withSummary } from '../src/main/agent/compaction'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

/** A chat on a faux model with the given context window, reading from a scratch folder. */
function setup(contextWindow: number) {
  const env = makeServices()
  const root = mkdtempSync(join(tmpdir(), 'cloth-compact-'))
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  env.services.providers.setModels(provider.id, [{ id: 'faux-1', name: 'faux-1', contextWindow, maxTokens: 2048, reasoning: false, vision: false, embedding: false }])
  const session = env.services.chat.create({
    model: { providerId: provider.id, modelId: 'faux-1' },
    workspace: root,
    fileAccess: 'read',
    knowledgeEnabled: false,
    skillsEnabled: false,
    customTools: false,
    subagents: false,
    codeIntel: false,
    imagesEnabled: false
  })
  return { ...env, root, session }
}

async function send(env: ReturnType<typeof setup>, text: string) {
  await env.services.chat.send(env.session.id, text)
  for (let i = 0; i < 500 && env.services.chat.isRunning(env.session.id); i++) await wait(10)
  expect(env.services.chat.isRunning(env.session.id)).toBe(false)
}

/** A file of roughly `tokens` tokens (4 characters a token), in lines the read tool keeps whole. */
function bigFile(env: ReturnType<typeof setup>, name: string, tokens: number) {
  const line = `${name} `.padEnd(99, 'x')
  writeFileSync(join(env.root, name), Array.from({ length: Math.ceil((tokens * 4) / 100) }, () => line).join('\n'))
}

type Msg = { role: string; content?: unknown; toolCallId?: string }
const toolCallIds = (msgs: Msg[]) =>
  msgs.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? (m.content as { type: string; id?: string }[]).filter((c) => c.type === 'toolCall').map((c) => c.id!) : []))
const toolResultIds = (msgs: Msg[]) => msgs.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId!)

/** Every tool call has its result, every result follows its call. */
function expectPaired(msgs: Msg[]) {
  const seen = new Set<string>()
  for (const m of msgs) {
    for (const id of toolCallIds([m])) seen.add(id)
    if (m.role === 'toolResult') expect(seen.has(m.toolCallId!), `result ${m.toolCallId} without its call`).toBe(true)
  }
  expect(toolResultIds(msgs).sort()).toEqual(toolCallIds(msgs).sort())
}

const chatEvents = (env: ReturnType<typeof setup>) => env.events.filter((e) => e.channel === 'chat').map((e) => e.payload as ChatEvent)
const traces = (ms: UiMessage[]) => ms.flatMap((m) => m.blocks).filter((b) => b.type === 'tool').map((b) => (b as { trace: ToolTrace }).trace)
const isSummaryCall = (ctx: TranscriptContext) => JSON.stringify(ctx.messages).includes('<conversation>')

describe('cutting a long turn', () => {
  const text = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ')
  const call = (id: string, ts: number) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: `${id}.txt` } }], stopReason: 'toolUse', timestamp: ts })
  const result = (id: string, ts: number) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: text(600, id) }], isError: false, timestamp: ts })
  // One request, three tool steps, a final answer.
  const turn = [
    { role: 'system', content: 'You are Cloth.', timestamp: 0 },
    { role: 'user', content: 'Read c1, c2 and c3.', timestamp: 1 },
    call('c1', 2),
    result('c1', 3),
    call('c2', 4),
    result('c2', 5),
    call('c3', 6),
    result('c3', 7),
    { role: 'assistant', content: [{ type: 'text', text: 'All three read.' }], stopReason: 'stop', timestamp: 8 }
  ] as unknown as AgentMessage[]

  it('only cuts a single-turn chat when allowed to split the turn', () => {
    expect(findCut(turn, 100)).toBeNull()
    expect(findCut(turn, 100, { steps: true })).not.toBeNull()
  })

  it('never separates a tool call from its result, whatever is kept', () => {
    for (let keep = 0; keep < 4000; keep += 50) {
      const plan = planCompaction(turn, keep, { steps: true })!
      expect(plan).not.toBeNull()
      const kept = compactedHistory(plan, 'summary')
      expect(kept[0].role).toBe('system')
      expect(kept[1].role).toBe('user')
      expectPaired(kept as Msg[])
      expectPaired(plan.older as Msg[])
      // The request is repeated to carry the summary; at least the first step was summarised.
      expect(plan.inTurn).toBe(true)
      expect(toolCallIds(plan.older as Msg[])).toContain('c1')
      expect(kept.length).toBeLessThan(turn.length)
    }
  })

  it('keeps the latest steps and repeats the request with the summary', () => {
    // A result is about 700 tokens: keeping 300 keeps the last call and its result, not the one before.
    const plan = planCompaction(turn, 300, { steps: true })!
    expect(toolCallIds(plan.rest as Msg[])).toEqual(['c3'])
    expect(toolCallIds(plan.older as Msg[])).toEqual(['c1', 'c2'])
    const kept = compactedHistory(plan, '## Goal\n- read files')
    const carrier = kept[1] as UserMessage
    expect(JSON.stringify(carrier.content)).toContain('Read c1, c2 and c3.')
    expect(JSON.stringify(carrier.content)).toContain('including the work already done')
    expect(splitSummary(carrier).summary).toBe('## Goal\n- read files')
  })

  it('dates the summary when it was made, so usage reported before it no longer sizes the reply', () => {
    // As it happened: a step sent ~284k tokens and was kept whole; after summarising, the history is far smaller.
    const model = { contextWindow: 288_000 } as Parameters<typeof clampMaxTokensToContext>[0]
    const plan = planCompaction(turn, 300, { steps: true })!
    const kept = compactedHistory(plan, 'summary').map((m) =>
      m.role === 'assistant' ? ({ ...m, usage: { input: 0, output: 100, cacheRead: 24_000, cacheWrite: 260_000, totalTokens: 284_100 } } as AgentMessage) : m
    )
    const at = 100
    // With the request's old date the stale usage wins: the reply gets almost nothing.
    expect(clampMaxTokensToContext(model, { messages: kept } as never, 32_000)).toBeLessThan(100)
    const dated = datedSummaries(kept, at)
    expect(dated[1].timestamp).toBe(at)
    expect(clampMaxTokensToContext(model, { messages: dated } as never, 32_000)).toBe(32_000)
    // Only the summary's carrier changes; nothing to date gives the same array back.
    expect(dated.filter((m, i) => m !== kept[i])).toHaveLength(1)
    expect(datedSummaries(turn, at)).toBe(turn)
    expect(datedSummaries(kept, 0)).toBe(kept)
    expect(datedSummaries(dated, at)).toBe(dated)
  })

  it('tells the model to carry on after summarising mid-turn', () => {
    const kept = compactedHistory(planCompaction(turn, 300, { steps: true })!, 'x')
    expect(JSON.stringify(kept[1])).toMatch(/Carry on with that work from where it stopped/)
    expect(splitSummary(kept[1] as UserMessage).summary).toBe('x')
  })

  it('folds an earlier summary on the request into the new one', () => {
    const summarised = [...turn]
    summarised[1] = withSummary(turn[1] as UserMessage, 'earlier work')
    const plan = planCompaction(summarised, 300, { steps: true })!
    expect(plan.previous).toBe('earlier work')
    expect(JSON.stringify(plan.older)).not.toContain('earlier work')
    const kept = compactedHistory(plan, 'new summary')
    expect(JSON.stringify(kept)).not.toContain('earlier work')
    expect(splitSummary(kept[1] as UserMessage).summary).toBe('new summary')
  })
})

describe('automatic summarising threshold', () => {
  it('summarises at 75% of the context window', () => {
    expect(budget(272_000).threshold).toBe(204_000)
    expect(budget(200_000).threshold).toBe(150_000)
    expect(budget(32_768).threshold).toBe(24_576)
    for (const w of [8000, 32_768, 128_000, 272_000, 1_000_000]) {
      const b = budget(w)
      // The reserve covers the rest of the window; the verbatim tail fits well under the threshold.
      expect(b.reserve + b.threshold).toBe(w)
      expect(b.keep).toBeLessThan(b.threshold / 2)
    }
  })

  it('reports the 75% threshold to the context meter', async () => {
    const env = setup(272_000)
    const u = await env.services.chat.contextUsage(env.session.id)
    expect(u.threshold).toBe(204_000)
  })
})

describe('automatic summarising during a turn', () => {
  it('summarises before the next model call when tool results outgrow the context, and the turn completes', async () => {
    const env = setup(16_000) // summarises above 12k
    bigFile(env, 'a.txt', 5500)
    bigFile(env, 'b.txt', 5500)
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let summaryPrompt = ''
    let finalContext: Msg[] = []
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' }, { id: 'r1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('read', { path: 'b.txt' }, { id: 'r2' })], { stopReason: 'toolUse' }),
      (ctx: TranscriptContext) => {
        expect(isSummaryCall(ctx)).toBe(true)
        summaryPrompt = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('## Goal\n- Compare a.txt and b.txt\n\n## Progress\n### Done\n- [x] Read a.txt')
      },
      (ctx: TranscriptContext) => {
        finalContext = ctx.messages as Msg[]
        return fauxAssistantMessage('Both files read.')
      }
    ])
    await send(env, 'Read a.txt and then b.txt, then compare them.')

    // The summary covered the earlier step of this turn.
    expect(summaryPrompt).toContain('a.txt')
    const types = chatEvents(env).map((e) => e.type)
    expect(types).toContain('compacting')
    const compacted = chatEvents(env).find((e) => e.type === 'compacted') as Extract<ChatEvent, { type: 'compacted' }>
    expect(compacted).toBeTruthy()
    expect(compacted.error).toBeUndefined()
    // Compaction happened inside the turn: between its start and its end.
    expect(types.indexOf('compacting')).toBeGreaterThan(types.indexOf('start'))
    expect(types.indexOf('compacted')).toBeLessThan(types.lastIndexOf('end'))
    const end = chatEvents(env).filter((e) => e.type === 'end').at(-1) as Extract<ChatEvent, { type: 'end' }>
    expect(end.error).toBeUndefined()

    // The model's next request: summary up front, the in-flight call and its result intact, the older step gone.
    expect(JSON.stringify(finalContext.filter((m) => m.role === 'user')[0])).toContain('conversation-summary')
    expect(JSON.stringify(finalContext.filter((m) => m.role === 'user')[0])).toContain('Read a.txt and then b.txt')
    expect(toolCallIds(finalContext)).toEqual(['r2'])
    expectPaired(finalContext)

    // The chat shows the summarised step as archived and finishes the turn live.
    const ui = env.services.chat.messages(env.session.id)
    expect(traces(ui.filter((m) => m.archived)).map((t) => t.id)).toEqual(['r1'])
    const live = ui.filter((m) => !m.archived)
    expect(live.find((m) => m.role === 'user')?.summary).toContain('Compare a.txt and b.txt')
    expect(traces(live).map((t) => [t.id, t.status])).toEqual([['r2', 'ok']])
    expect(live.at(-1)?.blocks.some((b) => b.type === 'text' && b.text === 'Both files read.')).toBe(true)
  })

  it('keeps the turn going when summarising fails mid-turn, and says so', async () => {
    const env = setup(16_000)
    bigFile(env, 'a.txt', 5500)
    bigFile(env, 'b.txt', 5500)
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let finalContext: Msg[] = []
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' }, { id: 'r1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('read', { path: 'b.txt' }, { id: 'r2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary model unavailable' }),
      (ctx: TranscriptContext) => {
        finalContext = ctx.messages as Msg[]
        return fauxAssistantMessage('Done anyway.')
      }
    ])
    await send(env, 'Read a.txt and b.txt.')

    const compacted = chatEvents(env).find((e) => e.type === 'compacted') as Extract<ChatEvent, { type: 'compacted' }>
    expect(compacted?.error).toContain('summary model unavailable')
    const end = chatEvents(env).filter((e) => e.type === 'end').at(-1) as Extract<ChatEvent, { type: 'end' }>
    expect(end.error).toBeUndefined()
    // Nothing was dropped: the model got the whole turn.
    expect(toolCallIds(finalContext)).toEqual(['r1', 'r2'])
    expectPaired(finalContext)
    const ui = env.services.chat.messages(env.session.id)
    expect(ui.some((m) => m.archived)).toBe(false)
    expect(ui.at(-1)?.blocks.some((b) => b.type === 'text' && b.text === 'Done anyway.')).toBe(true)
  })
})

describe('automatic summarising before a turn', () => {
  it('summarises a chat whose only turn is one long agentic run before the next message', async () => {
    const env = setup(16_000)
    bigFile(env, 'a.txt', 7800) // read numbers its lines (~5% more text): still just under the threshold
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let summarised = false
    let nextContext: Msg[] = []
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' }, { id: 'r1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('a.txt is a long file of x.'),
      (ctx: TranscriptContext) => {
        summarised = isSummaryCall(ctx)
        return fauxAssistantMessage('## Goal\n- Look at a.txt')
      },
      (ctx: TranscriptContext) => {
        nextContext = ctx.messages as Msg[]
        return fauxAssistantMessage('Sure.')
      }
    ])
    await send(env, 'Read a.txt')
    // Below the threshold until the next message arrives.
    expect(chatEvents(env).some((e) => e.type === 'compacting')).toBe(false)
    await send(env, `Now summarise it for me. ${'please '.repeat(200)}`)

    expect(summarised).toBe(true)
    const compacted = chatEvents(env).find((e) => e.type === 'compacted') as Extract<ChatEvent, { type: 'compacted' }>
    expect(compacted?.error).toBeUndefined()
    expect(JSON.stringify(nextContext.filter((m) => m.role === 'user')[0])).toContain('conversation-summary')
    expect(toolCallIds(nextContext)).toEqual([])
    expectPaired(nextContext)
    const ui = env.services.chat.messages(env.session.id)
    expect(traces(ui.filter((m) => m.archived)).map((t) => t.id)).toEqual(['r1'])
    expect(ui.at(-1)?.blocks.some((b) => b.type === 'text' && b.text === 'Sure.')).toBe(true)
  })
})
