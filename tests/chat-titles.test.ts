import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent } from '../src/shared/types'
import { cleanTitle } from '../src/main/agent/chat'
import { fuzzyBest, fuzzyMatch } from '../src/renderer/src/lib/fuzzy'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup() {
  const env = makeServices()
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  env.services.settings.update({ aiTitles: true })
  const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false, skillsEnabled: false, customTools: false })
  return { ...env, session }
}

/** Title requests are one-shot calls with the title system prompt; everything else is the chat. */
const isTitleCall = (ctx: TranscriptContext) => JSON.stringify(ctx.messages).includes('You name chat conversations')

async function turn(env: ReturnType<typeof setup>, text: string) {
  await env.services.chat.send(env.session.id, text)
  for (let i = 0; i < 300; i++) {
    await wait(10)
    if (!env.services.chat.isRunning(env.session.id) && !(env.services.chat as unknown as { titling: Set<string> }).titling.has(env.session.id)) break
  }
  await wait(20)
}

describe('AI chat titles', () => {
  it('names the chat after the first reply, again once it has grown, and never over a typed name', async () => {
    const env = setup()
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const prompts: string[] = []
    let titles = ['"Hilti IT presentation deck."', 'Title: Hilti deck and speaker notes']
    faux.setResponses(
      Array.from({ length: 12 }, () => (ctx: TranscriptContext) => {
        if (isTitleCall(ctx)) {
          prompts.push(JSON.stringify(ctx.messages))
          return fauxAssistantMessage(titles.shift() ?? 'Unexpected title')
        }
        return fauxAssistantMessage('Sure — here is a draft.')
      })
    )
    await turn(env, 'Make me a 12-slide deck about Hilti IT in Asia, using the presentation-design skill please and thanks')
    let s = env.services.chat.get(env.session.id)
    expect(s.title).toBe('Hilti IT presentation deck')
    expect(s.titleSource).toBe('ai')
    const events = env.events.filter((e) => e.channel === 'chat' && (e.payload as ChatEvent).type === 'title').map((e) => (e.payload as { title: string }).title)
    expect(events[0]).toMatch(/^Make me a 12-slide deck/) // the first message, straight away
    expect(events.at(-1)).toBe('Hilti IT presentation deck')
    expect(prompts[0]).toContain('Hilti IT in Asia')
    expect(prompts[0]).toContain('Sure — here is a draft.')

    // Turns 2 and 3 keep the title; turn 4 refreshes it once.
    await turn(env, 'Add speaker notes')
    await turn(env, 'Make slide 3 shorter')
    expect(prompts).toHaveLength(1)
    await turn(env, 'Now export it')
    expect(env.services.chat.get(env.session.id).title).toBe('Hilti deck and speaker notes')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('Now export it')
    await turn(env, 'Thanks')
    expect(prompts).toHaveLength(2)

    // A name the user types is theirs, until they ask for a new one.
    env.services.chat.update(env.session.id, { title: 'My deck' })
    expect(env.services.chat.get(env.session.id).titleSource).toBe('user')
    titles = ['Regenerated deck title']
    expect(await env.services.chat.retitle(env.session.id)).toBeNull()
    expect(env.services.chat.get(env.session.id).title).toBe('My deck')
    expect(await env.services.chat.retitle(env.session.id, { force: true })).toBe('Regenerated deck title')
    s = env.services.chat.get(env.session.id)
    expect(s.titleSource).toBe('ai')
  })

  it('can be turned off', async () => {
    const env = setup()
    env.services.settings.update({ aiTitles: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let titleCalls = 0
    faux.setResponses([(ctx: TranscriptContext) => (isTitleCall(ctx) ? (titleCalls++, fauxAssistantMessage('x')) : fauxAssistantMessage('ok'))])
    await turn(env, 'Explain the difference between let and const')
    expect(titleCalls).toBe(0)
    expect(env.services.chat.get(env.session.id)).toMatchObject({ title: 'Explain the difference between let and const', titleSource: 'first-message' })
  })

  it('cleans up what models reply', () => {
    expect(cleanTitle('<think>they want a deck</think>\n"Quarterly sales review deck."')).toBe('Quarterly sales review deck')
    expect(cleanTitle('**Title:** NestJS guards for admin routes')).toBe('NestJS guards for admin routes')
    expect(cleanTitle('\n\n')).toBe('')
    expect(cleanTitle('A very long title that goes on and on about many different things in one breath forever').length).toBeLessThanOrEqual(60)
  })
})

describe('picker matching', () => {
  it('ranks substrings first, then letters in order', () => {
    expect(fuzzyMatch('luna', 'GPT-6 Luna')).toMatchObject({ hits: [6, 7, 8, 9] })
    expect(fuzzyMatch('g6l', 'GPT-6 Luna')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'GPT-6 Luna')).toBeNull()
    const exact = fuzzyMatch('nano', 'GPT-5.4 nano')!.score
    const loose = fuzzyMatch('nano', 'gpt-4.1-mini-nanobanana')!.score
    expect(exact).toBeGreaterThan(fuzzyMatch('n', 'x n')!.score - 1000 + 0)
    expect(exact).toBeGreaterThan(loose - 20)
    // Matching the id or provider still finds the model, without highlighting the name.
    expect(fuzzyBest('qwen/qwen3.8', ['Qwen 3.8 27B', 'qwen/qwen3.8-27b', 'LM Studio'])).toMatchObject({ hits: [] })
    expect(fuzzyBest('lm studio', ['Qwen 3.8 27B', 'qwen/qwen3.8-27b', 'LM Studio'])).not.toBeNull()
  })
})
