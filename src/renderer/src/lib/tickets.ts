/** A Spec → ship ticket file (docs/specs/<slug>/tickets/NN-slug.md), as the board shows it. */
export interface Ticket {
  path: string
  /** "01", "02"… from the heading, else from the file name. */
  n: string
  title: string
  /** Numbers of the tickets it waits for. */
  blockedBy: string[]
  /** Acceptance criteria ticked, and in all. */
  done: number
  total: number
  text: string
}

export type TicketStatus = 'todo' | 'doing' | 'done'

const pad = (n: string) => n.padStart(2, '0')

export function parseTicket(path: string, text: string): Ticket {
  const file = path.split('/').pop() ?? path
  const head = /^#\s*(\d+)\s*[:.\-–—]\s*(.+?)\s*$/m.exec(text)
  const fromName = /^(\d+)-(.+)\.md$/i.exec(file)
  const n = pad(head?.[1] ?? fromName?.[1] ?? '?')
  const title = head?.[2] ?? (fromName ? fromName[2].replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) : file)
  // "Blocked by: 01, 02" on one line, or a "## Blocked by" heading with the list under it.
  const sameLine = /blocked by\**[ \t]*:?\**[ \t]*(\S.*)?$/im.exec(text)
  const underHeading = /^#{1,6}[ \t]*blocked by[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(text)?.[1] ?? ''
  const blockedLine = sameLine?.[1] ?? underHeading
  const blockedBy = /\bnone\b/i.test(blockedLine) ? [] : [...new Set((blockedLine.match(/\d+/g) ?? []).map(pad))].filter((b) => b !== n)
  const boxes = [...text.matchAll(/^\s*[-*]\s*\[( |x|X)\]/gm)]
  return { path, n, title: title.replace(/\*\*/g, ''), blockedBy, done: boxes.filter((b) => b[1] !== ' ').length, total: boxes.length, text }
}

/** Done when every criterion is ticked; in progress when a worker is on it or some are ticked; else to do. */
export function ticketStatus(t: Pick<Ticket, 'n' | 'done' | 'total'>, active: ReadonlySet<string>): TicketStatus {
  if (t.total > 0 && t.done === t.total) return 'done'
  if (active.has(t.n) || t.done > 0) return 'doing'
  return 'todo'
}

/** Ticket numbers mentioned in running agents' job titles ("Ticket 03 …", "03 · Run a saved search"). */
export function activeTickets(descriptions: string[]): Set<string> {
  const out = new Set<string>()
  for (const d of descriptions) {
    const m = /(?:ticket\s*#?\s*|^#?)(\d{1,3})\b/i.exec(d.trim())
    if (m) out.add(pad(m[1]))
  }
  return out
}
