import { describe, expect, it } from 'vitest'
import { activeTickets, parseTicket, ticketStatus } from '../src/renderer/src/lib/tickets'

const T = `# 03: Run a saved search in one click

**What to build:** clicking a saved search runs it.

**Blocked by:** 01, 2

- [x] Clicking runs the query
- [ ] Results replace the current list
- [X] Works from the keyboard
`

describe('tickets', () => {
  it('reads number, title, blockers and criteria', () => {
    expect(parseTicket('docs/specs/x/tickets/03-run.md', T)).toMatchObject({ n: '03', title: 'Run a saved search in one click', blockedBy: ['01', '02'], done: 2, total: 3 })
  })
  it('falls back to the file name and treats "None" as no blockers', () => {
    expect(parseTicket('docs/specs/x/tickets/07-rename-and-delete.md', 'Blocked by: None (can start immediately)\n- [ ] a')).toMatchObject({ n: '07', title: 'Rename and delete', blockedBy: [], done: 0, total: 1 })
  })
  it('works out the column', () => {
    expect(ticketStatus({ n: '01', done: 2, total: 2 }, new Set())).toBe('done')
    expect(ticketStatus({ n: '01', done: 1, total: 2 }, new Set())).toBe('doing')
    expect(ticketStatus({ n: '01', done: 0, total: 2 }, new Set(['01']))).toBe('doing')
    expect(ticketStatus({ n: '01', done: 0, total: 0 }, new Set())).toBe('todo')
  })
  it('finds ticket numbers in running jobs', () => {
    expect([...activeTickets(['Ticket 03', '04 · Rename and delete', 'Build ticket #5 now', 'Review spec'])].sort()).toEqual(['03', '04', '05'])
  })
})
