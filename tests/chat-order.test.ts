import { describe, expect, it } from 'vitest'
import { makeServices } from './helpers'
import { ordered } from '../src/shared/chat-order'

describe('ordering chats by hand', () => {
  it('saves a sort key without counting as activity, keeps it through other changes, and clears it', () => {
    const { services } = makeServices()
    const a = services.chat.create({})
    const b = services.chat.create({})
    const c = services.chat.create({})
    const before = new Map(services.chat.list().map((x) => [x.id, x.updatedAt]))
    const list = services.chat.reorder([c.id, a.id, b.id])
    const order = (id: string) => list.find((x) => x.id === id)?.sortOrder
    expect([order(c.id), order(a.id), order(b.id)]).toEqual([0, 1, 2])
    // Not activity: the last-updated times stay.
    for (const x of list) expect(x.updatedAt).toBe(before.get(x.id))
    // Kept through another change.
    expect(services.chat.update(a.id, { title: 'Renamed' }).sortOrder).toBe(1)
    // Cleared: back to newest first.
    const cleared = services.chat.reorder([], [a.id, b.id, c.id])
    expect(cleared.every((x) => (x.sortOrder ?? null) === null)).toBe(true)
  })

  it('lists chats never placed by hand first, newest first, then the placed ones in their order', () => {
    const chat = (id: string, updatedAt: number, sortOrder: number | null) => ({ id, updatedAt, sortOrder })
    const out = ordered([chat('old', 1, null), chat('second', 50, 1), chat('first', 60, 0), chat('new', 9, null)])
    expect(out.map((x) => x.id)).toEqual(['new', 'old', 'first', 'second'])
  })
})
