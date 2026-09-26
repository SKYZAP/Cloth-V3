/** Pull the first JSON object/array out of a model reply (tolerates fences and chatter). */
export function parseJsonLoose<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.search(/[[{]/)
    if (start < 0) continue
    const open = c[start]
    const close = open === '{' ? '}' : ']'
    const end = c.lastIndexOf(close)
    if (end <= start) continue
    try {
      return JSON.parse(c.slice(start, end + 1)) as T
    } catch {
      /* try next */
    }
  }
  return null
}
