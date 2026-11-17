import { describe, expect, it } from 'vitest'
import { makeServices } from './helpers'

describe('picks carry over to new chats', () => {
  const { services } = makeServices()
  const chat = services.chat
  const luna = { providerId: 'p1', modelId: 'gpt-6-luna' }
  const other = { providerId: 'p1', modelId: 'other' }
  // What the app's chat.update does: remember the picks, then apply the patch.
  const pick = (id: string, patch: Parameters<typeof chat.update>[1]) => chat.update(id, chat.rememberPicks(id, patch), { share: true })

  it('starts new chats on the model, effort and Auto/Manual picked last', () => {
    const first = chat.create()
    pick(first.id, { model: luna })
    pick(first.id, { thinking: 'high' })
    pick(first.id, { permissions: 'auto' })
    const next = chat.create()
    expect(next.model).toEqual(luna)
    expect(next.thinking).toBe('high')
    expect(next.permissions).toBe('auto')
    expect(services.settings.get().defaultModel).toEqual(luna)
  })

  it('keeps the effort per model: switching back to a model brings its effort back', () => {
    const c = chat.create()
    pick(c.id, { model: other })
    pick(c.id, { thinking: 'low' })
    expect(pick(c.id, { model: luna }).thinking).toBe('high')
    expect(pick(c.id, { model: other }).thinking).toBe('low')
  })

  it("doesn't carry Plan mode, or the Auto that OpenSpec sets by itself", () => {
    const c = chat.create()
    pick(c.id, { permissions: 'manual' })
    pick(c.id, { permissions: 'plan' })
    pick(c.id, { openspec: { step: 'setup', change: null, waitAfterPropose: false, tasks: null, pr: null, startedAt: Date.now() }, permissions: 'auto' })
    expect(chat.create().permissions).toBe('manual')
  })

  it('a chat asked for with its own settings keeps them', () => {
    const c = chat.create({ model: other, thinking: 'medium', permissions: 'plan' })
    expect(c.model).toEqual(other)
    expect(c.thinking).toBe('medium')
    expect(c.permissions).toBe('plan')
  })
})
