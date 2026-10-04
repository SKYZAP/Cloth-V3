// Skills named inline in a chat message: "/name" at the start of the message or after whitespace.

/** A "/name" at the start of the message or after whitespace, ending at whitespace or the end. */
export const SKILL_TOKEN = /(^|\s)\/([a-z0-9][a-z0-9-]*)(?=\s|$)/gi

/** The skills a message invokes: every "/name" that names an installed skill, in order, once each. */
export function invokedSkills(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const m of text.matchAll(SKILL_TOKEN)) {
    const name = m[2].toLowerCase()
    if (known.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** "/name" tokens that look like skills but match none (sent as plain text). */
export function unknownSkills(text: string, known: ReadonlySet<string>): string[] {
  return [...text.matchAll(SKILL_TOKEN)].map((m) => m[2]).filter((n) => !known.has(n.toLowerCase())).map((n) => `/${n}`)
}

/** The "/query" being typed just before the caret, for the skill menu. */
export function slashAt(value: string, caret: number): { query: string; start: number; end: number } | null {
  const m = /(^|\s)\/([a-z0-9-]*)$/i.exec(value.slice(0, caret))
  if (!m) return null
  const rest = /^[a-z0-9-]*/i.exec(value.slice(caret))?.[0] ?? ''
  return { query: m[2].toLowerCase(), start: caret - m[2].length - 1, end: caret + rest.length }
}
