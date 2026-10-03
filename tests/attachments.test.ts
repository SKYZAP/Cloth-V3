import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage, type Context } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64')
// 1×1 transparent PNG.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function setup(name: string, replies = 1) {
  const { services } = makeServices()
  const seen: Context[] = []
  const faux = registerFauxProvider({ api: 'openai-completions', provider: name })
  faux.setResponses(
    Array.from({ length: replies }, () => (ctx: Context) => {
      seen.push(ctx)
      return fauxAssistantMessage('Got it')
    })
  )
  const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false })
  const settle = async () => {
    for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 20))
  }
  return { services, chat, seen, faux, settle }
}

describe('chat attachments', () => {
  it('sends file text to the model and shows chips and images in the chat', async () => {
    const { services, chat, seen, faux, settle } = await setup('faux-attach')
    try {
      await services.chat.send(chat.id, 'What does this do?', [], [
        { name: 'notes.md', mimeType: 'text/markdown', data: b64('# Plan\nATTACHED-MARKER') },
        { name: 'shot.png', mimeType: 'image/png', data: PIXEL }
      ])
      await settle()

      expect(JSON.stringify(seen[0].messages.at(-1))).toContain('ATTACHED-MARKER')
      const [user, assistant] = services.chat.messages(chat.id)
      expect(user.blocks).toEqual([{ type: 'text', text: 'What does this do?' }])
      expect(user.attachments).toEqual([
        { kind: 'file', name: 'notes.md', chars: 22 },
        { kind: 'image', mimeType: 'image/png', data: PIXEL }
      ])
      expect(assistant.blocks[0]).toMatchObject({ type: 'text', text: 'Got it' })
    } finally {
      faux.unregister()
    }
  })

  it('accepts attachments without text and titles the chat after them', async () => {
    const { services, chat, faux, settle } = await setup('faux-attach-2')
    try {
      await services.chat.send(chat.id, '', [], [{ name: 'report.csv', mimeType: 'text/csv', data: b64('a,b\n1,2') }])
      await settle()
      expect(services.chat.get(chat.id).title).toBe('report.csv')
      expect(services.chat.messages(chat.id)[0].blocks[0]).toEqual({ type: 'text', text: 'Have a look at the attached file.' })
    } finally {
      faux.unregister()
    }
  })

  it('refuses binary files it cannot read', async () => {
    const { services, chat, faux } = await setup('faux-attach-3')
    try {
      await expect(services.chat.send(chat.id, 'hi', [], [{ name: 'app.exe', mimeType: 'application/octet-stream', data: b64(Buffer.from([0x4d, 0x5a, 0, 0, 1, 2])) }])).rejects.toThrow(/isn't a text file/)
      expect(services.chat.messages(chat.id)).toEqual([])
    } finally {
      faux.unregister()
    }
  })

  it('resends a message with its attachments', async () => {
    const { services, chat, seen, faux, settle } = await setup('faux-attach-4', 2)
    try {
      await services.chat.send(chat.id, 'Summarise', [], [{ name: 'a.txt', mimeType: 'text/plain', data: b64('RESEND-MARKER') }])
      await settle()
      const [user] = services.chat.messages(chat.id)
      await services.chat.resend(chat.id, user.id)
      await settle()
      expect(JSON.stringify(seen[1].messages)).toContain('RESEND-MARKER')
      const after = services.chat.messages(chat.id)
      expect(after).toHaveLength(2)
      expect(after[0].attachments).toEqual([{ kind: 'file', name: 'a.txt', chars: 13 }])
    } finally {
      faux.unregister()
    }
  })
})
