import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent } from '../src/shared/types'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

/** A chat whose run takes `ms` to get ready (its instructions load slowly), with a model that counts its calls. */
function setup(ms: number) {
  const env = makeServices()
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: mkdtempSync(join(tmpdir(), 'cloth-send-')), knowledgeEnabled: false, skillsEnabled: false, customTools: false, subagents: false })
  const chat = env.services.chat as unknown as { instructions: () => Promise<string> }
  chat.instructions = () => new Promise((r) => setTimeout(() => r(''), ms))
  faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
  let calls = 0
  faux.setResponses([() => (calls++, fauxAssistantMessage('Hello'))])
  const chatEvents = () => env.events.filter((e) => e.channel === 'chat').map((e) => e.payload as ChatEvent)
  const shown = () => chatEvents().some((e) => e.type === 'message' && e.message.role === 'user')
  return { env, session, calls: () => calls, chatEvents, shown }
}

describe('sending a message', () => {
  it('shows the message before the run has finished getting ready', async () => {
    const t = setup(400)
    const sent = t.env.services.chat.send(t.session.id, 'hi')
    await wait(50)
    expect(t.shown()).toBe(true)
    expect(t.env.services.chat.isRunning(t.session.id)).toBe(true)
    expect(t.calls()).toBe(0)
    await sent
    for (let i = 0; i < 300 && t.env.services.chat.isRunning(t.session.id); i++) await wait(10)
    expect(t.calls()).toBe(1)
  })

  it('refuses a second message while the first is getting ready', async () => {
    const t = setup(300)
    const sent = t.env.services.chat.send(t.session.id, 'one')
    await wait(30)
    await expect(t.env.services.chat.send(t.session.id, 'two')).rejects.toThrow(/already running/)
    await sent
  })

  it('stopping while getting ready ends the run without calling the model', async () => {
    const t = setup(300)
    const sent = t.env.services.chat.send(t.session.id, 'hi')
    await wait(30)
    t.env.services.chat.abort(t.session.id)
    await sent
    await wait(50)
    expect(t.calls()).toBe(0)
    expect(t.env.services.chat.isRunning(t.session.id)).toBe(false)
    expect(t.chatEvents().some((e) => e.type === 'end')).toBe(true)
    // The message stays in the chat.
    expect(t.env.services.chat.messages(t.session.id).map((m) => m.role)).toEqual(['user'])
  })
})
