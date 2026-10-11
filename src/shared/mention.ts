// Saved agents tagged inline in a chat message: "@slug" at the start of the message or after whitespace.

/** A "@slug" at the start of the message or after whitespace, ending at whitespace or the end (so "a@b.com" is not one). */
export const AGENT_TOKEN = /(^|\s)@([a-z0-9][a-z0-9-]*)(?=\s|$)/gi

/** The handle an agent is tagged by: its name lower-cased, each run of other characters a "-" ("Code reviewer" → "code-reviewer"). */
export function agentSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The agents a message tags: every "@slug" that names a known agent, in order, once each (as slugs). */
export function mentionedAgents(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const m of text.matchAll(AGENT_TOKEN)) {
    const slug = m[2].toLowerCase()
    if (known.has(slug) && !out.includes(slug)) out.push(slug)
  }
  return out
}

/** The "@query" being typed just before the caret, for the agent menu. */
export function mentionAt(value: string, caret: number): { query: string; start: number; end: number } | null {
  const m = /(^|\s)@([a-z0-9-]*)$/i.exec(value.slice(0, caret))
  if (!m) return null
  const rest = /^[a-z0-9-]*/i.exec(value.slice(caret))?.[0] ?? ''
  return { query: m[2].toLowerCase(), start: caret - m[2].length - 1, end: caret + rest.length }
}
