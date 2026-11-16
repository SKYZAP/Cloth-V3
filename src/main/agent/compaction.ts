import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent, Message, TextContent, UserMessage } from '@earendil-works/pi-ai'
import { estimateTokens, serializeConversation } from '@earendil-works/pi-coding-agent'
import type { ModelRef } from '@shared/types'
import type { ProviderService } from '../providers/providers'

/**
 * Conversation summarising ("compaction"). Older turns are replaced by a structured summary that
 * rides on the first kept user message as a tagged text block; the originals move to the
 * session's archive so the UI can still show them.
 */
export const SUMMARY_OPEN = '<conversation-summary>'
export const SUMMARY_CLOSE = '</conversation-summary>'
const PREAMBLE = 'The conversation so far was summarised to save context. Summary of everything before this message:'
/** A summary taken in the middle of a turn also covers the work already done on that turn's request. */
const PREAMBLE_IN_TURN = 'The conversation so far was summarised to save context, including the work already done on the request in this message. Summary:'

/** Summarise automatically once the history reaches this share of the model's context window. */
export const AUTO_COMPACT_AT = 0.75

/**
 * When to summarise automatically (`threshold`), the room that leaves for the reply, a running
 * turn's tool results and the summary call itself (`reserve`), and how much recent history to keep
 * verbatim (`keep`).
 */
export function budget(contextWindow: number): { reserve: number; keep: number; threshold: number } {
  const threshold = Math.round(contextWindow * AUTO_COMPACT_AT)
  const keep = Math.min(20_000, Math.round(contextWindow * 0.3))
  return { reserve: contextWindow - threshold, keep, threshold }
}

/** A reply cut off by the output limit before it said or did anything: nothing but (maybe) reasoning. */
export function cutOffEmpty(m: AgentMessage | undefined): boolean {
  if (!m || m.role !== 'assistant' || m.stopReason !== 'length') return false
  return !m.content.some((c) => (c.type === 'text' && c.text.trim()) || c.type === 'toolCall')
}

/** The latest step's tool results: the run of results at the end of the history. */
export function latestResults(messages: AgentMessage[]): AgentMessage[] {
  let i = messages.length
  while (i > 0 && messages[i - 1]!.role === 'toolResult') i--
  return messages.slice(i)
}

/**
 * The latest step's tool results trimmed so together they take at most `room` tokens: the last resort when, even after
 * summarising, the request would leave the model no room to answer (summarising always keeps the latest step whole, so a
 * few huge GitHub or web responses can fill the window on their own). Results under their fair share stay whole; bigger
 * ones keep their start and end around a note of what was left out. For the request only: the chat keeps the full
 * results. Returns `messages` itself when nothing needed trimming.
 */
export function fitToolResults(messages: AgentMessage[], room: number): AgentMessage[] {
  const latest = latestResults(messages)
  const sizes = latest.map((m) => estimateTokens(m))
  if (!latest.length || sizes.reduce((a, b) => a + b, 0) <= room) return messages
  // Fair share: what's left after the small ones, split between the big ones.
  let cap = Math.max(500, room / latest.length)
  for (let pass = 0; pass < latest.length; pass++) {
    const small = sizes.filter((s) => s <= cap)
    const big = sizes.length - small.length
    if (!big) break
    const next = Math.max(500, (room - small.reduce((a, b) => a + b, 0)) / big)
    if (Math.abs(next - cap) < 1) break
    cap = next
  }
  const first = messages.length - latest.length
  let changed = false
  const out = messages.map((m, i) => {
    if (i < first || m.role !== 'toolResult') return m
    const tokens = sizes[i - first]!
    if (tokens <= cap) return m
    const chars = m.content.reduce((n, c) => n + (c.type === 'text' ? c.text.length : 0), 0)
    if (!chars) return m
    // Characters to keep, scaled from the estimate, so the trimmed result estimates at about the cap.
    const keepChars = Math.max(2000, Math.floor((chars * cap) / tokens))
    changed = true
    const content = m.content.map((c) => {
      if (c.type !== 'text') return c
      const keep = Math.min(c.text.length, Math.floor((keepChars * c.text.length) / chars))
      if (keep >= c.text.length) return c
      const head = c.text.slice(0, Math.floor(keep * 0.7))
      const tail = c.text.slice(c.text.length - (keep - head.length))
      const cut = c.text.length - head.length - tail.length
      return { ...c, text: `${head}\n\n[… ${cut.toLocaleString('en')} characters left out here: this result was too long for the model's context window. If the missing part matters, ask for less at a time (a narrower query, fewer fields, one page or file at a time).]\n\n${tail}` }
    })
    return { ...m, content }
  })
  return changed ? out : messages
}

/** Tokens the history will cost on the next request (last reported usage + anything after it). */
export function estimateHistory(messages: AgentMessage[], notBefore = 0): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant' || m.stopReason === 'error' || m.stopReason === 'aborted' || !m.usage) continue
    // Usage reported before a compaction describes the old, longer context.
    if (m.timestamp < notBefore) break
    const u = m.usage
    const reported = u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
    if (!reported) break
    return reported + messages.slice(i + 1).reduce((n, x) => n + estimateTokens(x), 0)
  }
  return messages.reduce((n, x) => n + estimateTokens(x), 0)
}

/**
 * Index of the first message to keep: the latest boundary such that the kept tail holds at least
 * `keep` tokens. Boundaries are user messages and, with `steps`, the start of any later step of a
 * turn (an assistant message after the turn's first): every tool call before it already has its
 * result, so no call is ever separated from its result. Returns null when there is nothing worth
 * summarising.
 */
export function findCut(messages: AgentMessage[], keep: number, opts: { steps?: boolean } = {}): number | null {
  // pi keeps the system prompt as the first message; it is never summarised.
  const start = messages.findIndex((m) => m.role !== 'system')
  if (start < 0) return null
  const boundary: boolean[] = []
  let inTurn = false
  let stepped = false
  for (const m of messages) {
    if (m.role === 'user') {
      inTurn = true
      stepped = false
      boundary.push(true)
    } else if (m.role === 'assistant') {
      boundary.push(!!opts.steps && inTurn && stepped)
      stepped = true
    } else boundary.push(false)
  }
  let tail = 0
  let latest: number | null = null
  for (let i = messages.length - 1; i > start; i--) {
    tail += estimateTokens(messages[i])
    if (!boundary[i]) continue
    latest ??= i
    if (tail >= keep) return i
  }
  // History shorter than the keep budget (manual summarising): keep only the latest exchange.
  return latest
}

/** How a history gets summarised: what goes into the summary, and what stays around it. */
export interface CompactionPlan {
  /** System messages (the prompt, tool declarations) before the cut: they stay, at the head. */
  system: AgentMessage[]
  /** The messages to summarise (and archive), without the earlier summary. */
  older: AgentMessage[]
  /** The summary already in the history, folded into the new one. */
  previous: string | null
  /** The user message that carries the new summary. */
  carrier: UserMessage
  /** Messages kept verbatim after the carrier. */
  rest: AgentMessage[]
  /** The cut fell between two steps of a turn: the carrier repeats that turn's request. */
  inTurn: boolean
}

export function planCompaction(messages: AgentMessage[], keep: number, opts: { steps?: boolean } = {}): CompactionPlan | null {
  const cut = findCut(messages, keep, opts)
  if (cut === null) return null
  const head = messages.slice(0, cut)
  const system = head.filter((m) => m.role === 'system')
  const older = head.filter((m) => m.role !== 'system')
  // Fold an earlier summary (on the first user message) into the new one rather than re-summarising it.
  let previous: string | null = null
  const firstUser = older.findIndex((m) => m.role === 'user')
  if (firstUser >= 0) {
    const split = splitSummary(older[firstUser] as UserMessage)
    previous = split.summary
    older[firstUser] = split.message
  }
  const tail = messages.slice(cut)
  if (tail[0].role === 'user') return { system, older, previous, carrier: tail[0], rest: tail.slice(1), inTurn: false }
  // Cut inside a turn: its request is summarised with the steps before the cut, and also stays to carry the summary.
  const request = older.findLast((m): m is UserMessage => m.role === 'user')!
  return { system, older, previous, carrier: request, rest: tail, inTurn: true }
}

/** The history after summarising: system messages, the summary on its carrier, then what was kept. */
export function compactedHistory(plan: CompactionPlan, summary: string): AgentMessage[] {
  return [...plan.system, withSummary(plan.carrier, summary, plan.inTurn), ...plan.rest]
}

/** Pull a previous summary out of a user message, returning it and the message without it. */
export function splitSummary(m: UserMessage): { summary: string | null; message: UserMessage } {
  if (typeof m.content === 'string') return { summary: null, message: m }
  const block = m.content.find((c): c is TextContent => c.type === 'text' && c.text.startsWith(SUMMARY_OPEN))
  if (!block) return { summary: null, message: m }
  const summary = block.text.slice(SUMMARY_OPEN.length, block.text.lastIndexOf(SUMMARY_CLOSE)).trim().replace(PREAMBLE, '').replace(PREAMBLE_IN_TURN, '').trim()
  return { summary, message: { ...m, content: m.content.filter((c) => c !== block) } }
}

export function withSummary(m: UserMessage, summary: string, inTurn = false): UserMessage {
  const block: TextContent = {
    type: 'text',
    text: `${SUMMARY_OPEN}\n${inTurn ? PREAMBLE_IN_TURN : PREAMBLE}\n\n${summary}\n${SUMMARY_CLOSE}`
  }
  const inner = splitSummary(m).message.content
  const rest: (TextContent | ImageContent)[] = typeof inner === 'string' ? [{ type: 'text', text: inner }] : inner
  return { ...m, content: [block, ...rest] }
}

const SYSTEM = `You write context checkpoints: structured summaries of a conversation between a user and an AI coding assistant, used by another model to continue the work seamlessly. Be specific: keep exact file paths, function names, commands, error messages, decisions and numbers. Do not continue the conversation or answer questions in it.`

const FORMAT = `Use exactly this format:

## Goal
[What the user is trying to accomplish — several items if the conversation covers several tasks.]

## Constraints & Preferences
- [Requirements or preferences the user stated, or "(none)"]

## Progress
### Done
- [x] [Completed work, including files created or changed]
### In Progress
- [ ] [Current work]
### Blocked
- [Open problems, or "(none)"]

## Key Decisions
- **[Decision]**: [Why]

## Next Steps
1. [What should happen next, in order]

## Critical Context
- [Data, snippets, paths or references needed to continue, or "(none)"]`

/**
 * Summarise `messages` (optionally folding in an earlier summary) with the chat's model.
 * Histories larger than the model can read are summarised in chunks, each folding into the last.
 */
export async function summarize(
  providers: ProviderService,
  model: ModelRef,
  messages: AgentMessage[],
  opts: { previous?: string | null; instructions?: string; signal?: AbortSignal; contextWindow?: number } = {}
): Promise<string> {
  const room = Math.max(4000, Math.round((opts.contextWindow ?? 32_768) * 0.55))
  const chunks: AgentMessage[][] = [[]]
  let size = 0
  for (const m of messages) {
    const t = estimateTokens(m)
    if (size + t > room && chunks.at(-1)!.length) {
      chunks.push([])
      size = 0
    }
    chunks.at(-1)!.push(m)
    size += t
  }
  let previous = opts.previous ?? null
  for (const chunk of chunks) previous = await summarizeChunk(providers, model, chunk, { ...opts, previous, room })
  return previous!
}

async function summarizeChunk(
  providers: ProviderService,
  model: ModelRef,
  messages: AgentMessage[],
  opts: { previous?: string | null; instructions?: string; signal?: AbortSignal; room: number }
): Promise<string> {
  let transcript = serializeConversation(messages.filter((m): m is Message => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult'))
  // A single oversized message (e.g. a huge tool result) still has to fit: keep its head and tail.
  const maxChars = opts.room * 4
  if (transcript.length > maxChars) transcript = `${transcript.slice(0, maxChars * 0.6)}\n\n[… ${transcript.length - maxChars} characters omitted …]\n\n${transcript.slice(-maxChars * 0.4)}`
  const prompt = [
    opts.previous ? `<previous-summary>\n${opts.previous}\n</previous-summary>\n\nThe conversation below continues from that summary. Merge both into one updated summary.\n` : '',
    `<conversation>\n${transcript}\n</conversation>`,
    '',
    FORMAT,
    opts.instructions?.trim() ? `\nAlso follow these instructions from the user: ${opts.instructions.trim()}` : ''
  ].join('\n')
  const { text } = await providers.complete(model, { system: SYSTEM, prompt, maxTokens: 4000, temperature: 0.2, signal: opts.signal })
  const summary = text.trim()
  if (!summary) throw new Error('The model returned an empty summary')
  return summary
}
