import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent } from '../src/shared/types'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const nudge = (text: string) => ({ text, skills: [], agents: [], attachments: [] })

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

/** A chat whose first reply waits until `release()`; every call records the last user text the model saw. */
function setup() {
  const env = makeServices()
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: mkdtempSync(join(tmpdir(), 'cloth-nudge-')), knowledgeEnabled: false, skillsEnabled: false, customTools: false, subagents: false })
  faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const seen: string[] = []
  const lastUser = (ctx: { messages: { role: string; content: unknown }[] }) => {
    const m = ctx.messages.findLast((x) => x.role === 'user')
    return typeof m?.content === 'string' ? m.content : ((m?.content as { type: string; text?: string }[]) ?? []).map((c) => c.text ?? '').join('')
  }
  faux.setResponses([
    async (ctx) => (seen.push(lastUser(ctx as never)), await gate, fauxAssistantMessage('Working on it')),
    (ctx) => (seen.push(lastUser(ctx as never)), fauxAssistantMessage('Got it, using tabs'))
  ])
  const chat = env.services.chat
  const events = () => env.events.filter((e) => e.channel === 'chat').map((e) => e.payload as ChatEvent)
  const idle = async () => {
    for (let i = 0; i < 300 && chat.isRunning(session.id); i++) await wait(10)
  }
  const model = async () => {
    for (let i = 0; i < 300 && !seen.length; i++) await wait(10)
  }
  return { chat, session, seen, release, events, idle, model }
}

describe('nudging a running chat', () => {
  it('hands the message to the agent after its step, without stopping it', async () => {
    const t = setup()
    await t.chat.send(t.session.id, 'Format the file')
    await t.model()
    const pending = await t.chat.nudge(t.session.id, nudge('use tabs'))
    expect(t.chat.nudges(t.session.id)).toEqual([pending])
    t.release()
    await t.idle()
    expect(t.seen).toEqual(['Format the file', 'use tabs'])
    expect(t.chat.nudges(t.session.id)).toEqual([])
    const roles = t.chat.messages(t.session.id).map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    // It showed in the chat when the agent read it, and nothing went back to the queue.
    expect(t.events().some((e) => e.type === 'message' && e.message.role === 'user' && e.message.blocks.some((b) => b.type === 'text' && b.text === 'use tabs'))).toBe(true)
    expect(t.events().some((e) => e.type === 'nudges' && e.returned)).toBe(false)
    expect(t.events().filter((e) => e.type === 'end')).toHaveLength(1)
  })

  it('can be taken back before the agent reads it', async () => {
    const t = setup()
    await t.chat.send(t.session.id, 'Format the file')
    await t.model()
    const pending = await t.chat.nudge(t.session.id, nudge('use tabs'))
    expect(t.chat.unnudge(t.session.id, pending.id)).toBe(true)
    t.release()
    await t.idle()
    expect(t.seen).toEqual(['Format the file'])
    expect(t.chat.unnudge(t.session.id, pending.id)).toBe(false)
  })

  it('goes back to the queue when the reply is stopped first', async () => {
    const t = setup()
    await t.chat.send(t.session.id, 'Format the file')
    await t.model()
    await t.chat.nudge(t.session.id, nudge('use tabs'))
    t.chat.abort(t.session.id)
    t.release()
    await t.idle()
    expect(t.seen).toEqual(['Format the file'])
    const back = t.events().find((e) => e.type === 'nudges' && e.returned)
    expect(back && back.type === 'nudges' && back.returned).toEqual([nudge('use tabs')])
    // Handed back before the run's end, so the queue sends it once the chat is free.
    const order = t.events().map((e) => (e.type === 'nudges' && e.returned ? 'returned' : e.type))
    expect(order.indexOf('returned')).toBeLessThan(order.lastIndexOf('end'))
  })

  it('is refused when the chat is not running', async () => {
    const t = setup()
    await expect(t.chat.nudge(t.session.id, nudge('hi'))).rejects.toThrow(/isn't running/)
  })
})
