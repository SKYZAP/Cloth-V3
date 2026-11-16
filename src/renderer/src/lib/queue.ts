import { create } from 'zustand'
import type { ChatAttachment, NudgeInput, PendingNudge } from '@shared/types'
import { api } from './api'
import { useApp } from './store'

/** A message written while its chat was busy: sent as soon as the chat is free. */
export interface QueuedMessage {
  id: string
  text: string
  skills: string[]
  agents: string[]
  attachments: ChatAttachment[]
}

/** Queued messages per chat, oldest first. Kept while you look at other chats; not saved across restarts. */
export const useQueue = create<{ bySession: Record<string, QueuedMessage[]>; nudges: Record<string, PendingNudge[]> }>(() => ({ bySession: {}, nudges: {} }))

/** Nudges the running agent hasn't read yet, as the main process reports them. */
export function setNudges(sessionId: string, pending: PendingNudge[]): void {
  useQueue.setState((s) => {
    const nudges = { ...s.nudges }
    if (pending.length) nudges[sessionId] = pending
    else delete nudges[sessionId]
    return { nudges }
  })
}

/** Nudges a run ended without reading: first in the queue, in the order they were written. */
export function requeue(sessionId: string, items: NudgeInput[]): void {
  edit(sessionId, (q) => [...items.map((m) => ({ ...m, id: `q${++seq}` })), ...q])
}

const edit = (sessionId: string, fn: (q: QueuedMessage[]) => QueuedMessage[]) =>
  useQueue.setState((s) => {
    const next = fn(s.bySession[sessionId] ?? [])
    const bySession = { ...s.bySession }
    if (next.length) bySession[sessionId] = next
    else delete bySession[sessionId]
    return { bySession }
  })

let seq = 0
export function enqueue(sessionId: string, m: Omit<QueuedMessage, 'id'>): void {
  edit(sessionId, (q) => [...q, { ...m, id: `q${++seq}` }])
}

export function unqueue(sessionId: string, id: string): QueuedMessage | undefined {
  const m = useQueue.getState().bySession[sessionId]?.find((x) => x.id === id)
  edit(sessionId, (q) => q.filter((x) => x.id !== id))
  return m
}

/** Move a message to the front, so it is the next one sent. */
export function promote(sessionId: string, id: string): void {
  edit(sessionId, (q) => {
    const m = q.find((x) => x.id === id)
    return m ? [m, ...q.filter((x) => x !== m)] : q
  })
}

const sending = new Set<string>()

/**
 * Send the chat's next queued message, if it has one and isn't sending one already. Called when the
 * chat's reply ends; one refused because the chat is still busy goes back to the front quietly and
 * waits for the next end, any other refusal goes back with a message.
 */
export async function drain(sessionId: string): Promise<void> {
  if (sending.has(sessionId)) return
  const next = useQueue.getState().bySession[sessionId]?.[0]
  if (!next) return
  sending.add(sessionId)
  edit(sessionId, (q) => q.filter((x) => x.id !== next.id))
  try {
    await api.chat.send(sessionId, next.text, next.skills, next.attachments, next.agents)
  } catch (e) {
    edit(sessionId, (q) => [next, ...q])
    const msg = e instanceof Error ? e.message : String(e)
    if (!/already running/i.test(msg)) useApp.getState().toast(`Couldn’t send the queued message: ${msg}`, 'error')
  } finally {
    sending.delete(sessionId)
  }
}
