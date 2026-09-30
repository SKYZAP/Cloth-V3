/**
 * Loose "type a few letters" matching for pickers: an exact substring ranks first (earlier is
 * better), otherwise the letters must appear in order, with consecutive runs scoring higher.
 * Returns null when there is no match, and which characters of `text` matched (for highlighting).
 */
export function fuzzyMatch(query: string, text: string): { score: number; hits: number[] } | null {
  const needle = query.toLowerCase().replace(/\s+/g, '')
  if (!needle) return { score: 0, hits: [] }
  const hay = text.toLowerCase()
  const at = hay.indexOf(needle)
  if (at >= 0) return { score: 1000 - at, hits: Array.from({ length: needle.length }, (_, i) => at + i) }
  const hits: number[] = []
  let from = 0
  let score = 0
  let prev = -2
  for (const ch of needle) {
    const i = hay.indexOf(ch, from)
    if (i < 0) return null
    score += i === prev + 1 ? 8 : 1
    // Letters that start a word ("gpt-5.4-nano" → n of nano) count extra.
    if (i === 0 || /[\s\-_/.:]/.test(hay[i - 1])) score += 4
    hits.push(i)
    prev = i
    from = i + 1
  }
  return { score, hits }
}

/** Best match of a query against several fields of one item; hits refer to the first field only. */
export function fuzzyBest(query: string, fields: string[]): { score: number; hits: number[] } | null {
  let best: { score: number; hits: number[] } | null = null
  fields.forEach((f, i) => {
    const m = fuzzyMatch(query, f)
    if (m && (!best || m.score > best.score)) best = i === 0 ? m : { score: m.score - 1, hits: [] }
  })
  return best
}
