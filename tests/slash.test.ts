import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage, type Context } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'

describe('slash-invoked skills', () => {
  it('sends the skill instructions to the model but shows only a chip in the UI', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'commit-style', description: 'Write conventional commits', body: 'Use the form type(scope): subject. SECRET-MARKER' })
    const seen: Context[] = []
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-slash' })
    faux.setResponses([
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage('feat(chat): add slash commands')
      }
    ])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false })
      await services.chat.send(chat.id, 'Commit message for the new composer', ['commit-style'])
      for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 20))

      const sentToModel = JSON.stringify(seen[0].messages.at(-1))
      expect(sentToModel).toContain('SECRET-MARKER')
      expect(sentToModel).toContain('Commit message for the new composer')

      const [user, assistant] = services.chat.messages(chat.id)
      expect(user.skills).toEqual(['commit-style'])
      expect(user.blocks).toEqual([{ type: 'text', text: 'Commit message for the new composer' }])
      expect(assistant.blocks[0]).toMatchObject({ type: 'text', text: 'feat(chat): add slash commands' })
      expect(services.chat.get(chat.id).title).toBe('Commit message for the new composer')
    } finally {
      faux.unregister()
    }
  })

  it('allows invoking a skill with no extra text', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'standup', description: 'Daily standup', body: 'Yesterday / today / blockers.' })
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-slash-2' })
    faux.setResponses([fauxAssistantMessage('ok')])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' } })
      await services.chat.send(chat.id, '', ['standup'])
      for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 20))
      const [user] = services.chat.messages(chat.id)
      expect(user.skills).toEqual(['standup'])
      expect(services.chat.get(chat.id).title).toBe('/standup')
    } finally {
      faux.unregister()
    }
  })
})
