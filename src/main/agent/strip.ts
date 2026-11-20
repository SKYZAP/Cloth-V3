import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ToolResultMessage } from '@earendil-works/pi-ai'

export const RESULT_STRIPPED = '(tool result removed to free up context)'

/** Results this short cost less than a re-run would, and often carry the person's own answers (ask_user, plans): kept. */
export const STRIP_MIN_CHARS = 400

/** A tool result whose content was stripped keeps the original here, for the chat to show; it is never sent to the model. */
export type StrippedResult = ToolResultMessage & { stripped?: ToolResultMessage['content'] }

/**
 * The history with every tool result's content replaced by a short note, so the calls stay paired with their
 * results (providers require that) but the output no longer fills the context. Results under `STRIP_MIN_CHARS`
 * with no image are kept. Never mutates what it is given; `count` is how many results were stripped.
 */
export function stripToolResults(messages: AgentMessage[]): { messages: AgentMessage[]; count: number } {
  let count = 0
  const out = messages.map((m) => {
    if (m.role !== 'toolResult') return m
    const r = m as StrippedResult
    if (r.stripped) return m
    const chars = r.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : Infinity), 0)
    if (chars < STRIP_MIN_CHARS) return m
    count++
    return { ...r, content: [{ type: 'text' as const, text: RESULT_STRIPPED }], stripped: r.content } as AgentMessage
  })
  return { messages: count ? out : messages, count }
}
