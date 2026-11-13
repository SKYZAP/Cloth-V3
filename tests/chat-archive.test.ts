import { describe, expect, it } from 'vitest'
import { makeServices } from './helpers'

describe('archiving chats', () => {
  it('keeps the archived mark through other changes, and clears it', () => {
    const { services } = makeServices()
    const c = services.chat.create({})
    expect(c.archivedAt ?? null).toBeNull()
    const at = Date.now()
    expect(services.chat.update(c.id, { archivedAt: at }).archivedAt).toBe(at)
    // Changing something else leaves it archived.
    expect(services.chat.update(c.id, { title: 'Renamed', webEnabled: false }).archivedAt).toBe(at)
    expect(services.chat.list().find((x) => x.id === c.id)?.archivedAt).toBe(at)
    expect(services.chat.update(c.id, { archivedAt: null }).archivedAt).toBeNull()
  })
})
