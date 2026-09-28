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

/** How much room to leave for the reply, and how much recent history to keep verbatim. */
export function budget(contextWindow: number): { reserve: number; keep: number; threshold: number } {
  const reserve = Math.min(16_384, Math.round(contextWindow * 0.25))
  const keep = Math.min(20_000, Math.round(contextWindow * 0.3))
  return { reserve, keep, threshold: contextWindow - reserve }
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
 * Index of the first message to keep: the latest user-message boundary such that the kept tail
 * holds at least `keep` tokens. Cutting at a user message keeps tool calls paired with their results.
 * Returns null when there is nothing worth summarising.
 */
export function findCut(messages: AgentMessage[], keep: number): number | null {
  // pi keeps the system prompt as the first message; it is never summarised.
  const start = messages.findIndex((m) => m.role !== 'system')
  if (start < 0) return null
  let tail = 0
  let latestUser: number | null = null
  for (let i = messages.length - 1; i > start; i--) {
    tail += estimateTokens(messages[i])
    if (messages[i].role !== 'user') continue
    latestUser ??= i
    if (tail >= keep) return i
  }
  // History shorter than the keep budget (manual summarising): keep only the latest exchange.
  return latestUser
}

/** Pull a previous summary out of a user message, returning it and the message without it. */
export function splitSummary(m: UserMessage): { summary: string | null; message: UserMessage } {
  if (typeof m.content === 'string') return { summary: null, message: m }
  const block = m.content.find((c): c is TextContent => c.type === 'text' && c.text.startsWith(SUMMARY_OPEN))
  if (!block) return { summary: null, message: m }
  const summary = block.text.slice(SUMMARY_OPEN.length, block.text.lastIndexOf(SUMMARY_CLOSE)).trim().replace(PREAMBLE, '').trim()
  return { summary, message: { ...m, content: m.content.filter((c) => c !== block) } }
}

export function withSummary(m: UserMessage, summary: string): UserMessage {
  const block: TextContent = {
    type: 'text',
    text: `${SUMMARY_OPEN}\n${PREAMBLE}\n\n${summary}\n${SUMMARY_CLOSE}`
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
