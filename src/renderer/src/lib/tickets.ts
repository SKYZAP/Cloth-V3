import type { TodoItem, UiBlock, UiMessage } from '@shared/types'

/** A Spec → Ship ticket file (docs/specs/<slug>/tickets/NN-slug.md), as the board shows it. */
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

/** Done when every criterion is ticked or Build has finished it; in progress when it is being built or some are ticked; else to do. */
export function ticketStatus(t: Pick<Ticket, 'n' | 'done' | 'total'>, active: ReadonlySet<string>, finished: ReadonlySet<string> = new Set()): TicketStatus {
  if ((t.total > 0 && t.done === t.total) || finished.has(t.n)) return 'done'
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

/** Ticket numbers a line of text names: "ticket 03", "Ticket #3", "tickets 01 and 02", "tickets 01–03". */
export function ticketRefs(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\btickets?\s*#?\s*(\d{1,3}(?:\s*(?:,|and|&|to|-|–|—)\s*#?\d{1,3})*)/gi)) {
    const nums = m[1].match(/\d{1,3}/g) ?? []
    const range = nums.length === 2 && /(?:to|-|–|—)/i.test(m[1])
    if (range) for (let i = Number(nums[0]); i <= Number(nums[1]) && i - Number(nums[0]) < 50; i++) out.add(pad(String(i)))
    else for (const n of nums) out.add(pad(n))
  }
  return [...out]
}

/** Which tickets Build is working on and has finished, from what the chat shows before any box is ticked. */
export interface TicketProgress {
  /** A worker is on it, or its todo is in progress. */
  active: Set<string>
  /** Its todo is completed (ticked boxes count too, in ticketStatus). */
  finished: Set<string>
}

/**
 * Ticket progress from the chat: running agents whose job names a ticket, and the Build stage's todo list (the chat
 * often builds tickets itself, and ticks their boxes only later).
 */
export function ticketProgress(messages: UiMessage[]): TicketProgress {
  const running: string[] = []
  const walk = (blocks: UiBlock[]) => {
    for (const b of blocks) {
      if (b.type !== 'tool' || b.trace.name !== 'task') continue
      if (b.trace.status === 'running' || b.trace.subagent?.running) running.push(String((b.trace.args as { description?: unknown })?.description ?? ''))
      if (b.trace.subagent) walk(b.trace.subagent.blocks)
    }
  }
  for (const m of messages) walk(m.blocks)
  const active = activeTickets(running)
  const finished = new Set<string>()
  // Only the todo list written since Build started: earlier stages' todos ("write ticket 02") aren't building them.
  const build = messages.findLastIndex((m) => m.workflowStage === 'build')
  let todos: TodoItem[] | null = null
  if (build >= 0)
    for (const m of messages.slice(build))
      for (const b of m.blocks) {
        const list = b.type === 'tool' && b.trace.name === 'todo_write' && b.trace.status !== 'error' ? (b.trace.args as { todos?: unknown })?.todos : undefined
        if (Array.isArray(list)) todos = list.filter((t): t is TodoItem => !!t && typeof (t as TodoItem).content === 'string')
      }
  for (const t of todos ?? []) {
    for (const n of ticketRefs(t.content)) {
      if (t.status === 'completed') finished.add(n)
      else if (t.status === 'in_progress') active.add(n)
    }
  }
  return { active, finished }
}

/** Changes whenever a message arrives or a tool call finishes, so documents written mid-reply are read again. */
export function docsVersion(messages: UiMessage[]): number {
  return messages.reduce((n, m) => n + 1 + m.blocks.filter((b) => b.type === 'tool' && b.trace.status !== 'running').length, 0)
}
