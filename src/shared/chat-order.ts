import type { ChatSession } from './types'

/** The order chats show in a group of the list: ones never placed by hand first (newest first), then the hand-placed ones. */
export function ordered<T extends Pick<ChatSession, 'updatedAt' | 'sortOrder'>>(chats: T[]): T[] {
  const placed = (c: T) => c.sortOrder !== null && c.sortOrder !== undefined
  const free = chats.filter((c) => !placed(c)).sort((a, b) => b.updatedAt - a.updatedAt)
  const set = chats.filter(placed).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  return [...free, ...set]
}
