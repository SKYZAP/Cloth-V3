import { describe, expect, it } from 'vitest'
import { activeTickets, parseTicket, ticketProgress, ticketRefs, ticketStatus } from '../src/renderer/src/lib/tickets'
import type { TodoItem, UiMessage, WorkflowStage } from '../src/shared/types'

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
  it('reads a "Blocked by" heading with the list under it', () => {
    const t = ['# 06: Set up MLX', '', '## What to build', 'x', '', '## Blocked by', '', '- 05: Add local MLX', '- #2', '', '## Acceptance criteria', '', '- [ ] a', ''].join('\n')
    expect(parseTicket('t/06-x.md', t)).toMatchObject({ n: '06', blockedBy: ['05', '02'], total: 1 })
    const first = ['# 01: First', '', '## Blocked by', '', 'None - can start immediately.', '', '## Acceptance criteria', '- [ ] a', ''].join('\n')
    expect(parseTicket('t/01-x.md', first).blockedBy).toEqual([])
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
  it('finds tickets named in a line of text', () => {
    expect(ticketRefs('Implement ticket 01 with criterion-led tests')).toEqual(['01'])
    expect(ticketRefs('Tickets 01 and 3, then ticket #12')).toEqual(['01', '03', '12'])
    expect(ticketRefs('Build tickets 02–04')).toEqual(['02', '03', '04'])
    expect(ticketRefs('Run the full suite at 1 pm')).toEqual([])
  })
  it("follows Build's todo list when the chat builds tickets itself, before any box is ticked", () => {
    const todo = (id: string, todos: [string, TodoItem['status']][]): UiMessage => ({
      id,
      role: 'assistant',
      createdAt: 0,
      blocks: [{ type: 'tool', trace: { id, name: 'todo_write', args: { todos: todos.map(([content, status]) => ({ content, status })) }, status: 'ok', result: '', durationMs: 1, references: [] } }]
    })
    const marker = (stage: WorkflowStage): UiMessage => ({ id: stage, role: 'user', createdAt: 0, blocks: [], workflowStage: stage })
    const messages = [
      // A Spec-stage todo naming tickets doesn't count: nothing is being built yet.
      marker('spec'),
      todo('s', [['Write ticket 01', 'completed'], ['Write ticket 02', 'in_progress']]),
      marker('build'),
      todo('b', [['Read the spec', 'completed'], ['Ticket 01: store due dates', 'completed'], ['Ticket 02: show them', 'in_progress'], ['Ticket 03: filter', 'pending']])
    ]
    const p = ticketProgress(messages)
    expect([...p.finished]).toEqual(['01'])
    expect([...p.active]).toEqual(['02'])
    expect(ticketStatus({ n: '01', done: 0, total: 3 }, p.active, p.finished)).toBe('done')
    expect(ticketStatus({ n: '02', done: 0, total: 3 }, p.active, p.finished)).toBe('doing')
    expect(ticketStatus({ n: '03', done: 0, total: 3 }, p.active, p.finished)).toBe('todo')
    expect(ticketProgress(messages.slice(0, 2))).toEqual({ active: new Set(), finished: new Set() })
  })
})
