import { describe, expect, it } from 'vitest'
import { checkNote, parseCheckReport } from '../src/main/agent/checks'

const report = [
  'Result: issues',
  '',
  '### Finding: an invalid date is saved',
  'Criterion: AC-2',
  'Command: `node bin/todo.js add "x" --due 2026-02-30`',
  'Observed: exit 0, todo saved with due 2026-02-30',
  'Expected: "Invalid due date: 2026-02-30" on stderr, exit 1, nothing saved',
  'Fix before ship: yes',
  '',
  '### Finding: overdue shows for done todos',
  'Command: node --test tests/overdue.test.js',
  'Observed: 1 failing: done todo shows (overdue)',
  'Fix before ship: no',
  '',
  '### Finding: it might be slow on big files',
  'Fix before ship: no',
  '',
  'Checked: `npm test` passed (24 tests)'
].join('\n')

describe('verifier reports', () => {
  it('keeps findings that came with a command and its output, and drops the rest as unproven', () => {
    const r = parseCheckReport(report, 'spec')
    expect(r.verdict).toBe('issues')
    expect(r.findings).toHaveLength(2)
    expect(r.findings[0]).toEqual({
      axis: 'spec',
      fix: true,
      title: 'an invalid date is saved',
      where: 'AC-2',
      proof: { command: 'node bin/todo.js add "x" --due 2026-02-30', observed: 'exit 0, todo saved with due 2026-02-30', expected: '"Invalid due date: 2026-02-30" on stderr, exit 1, nothing saved' },
      status: 'open'
    })
    expect(r.findings[1]).toMatchObject({ fix: false, title: 'overdue shows for done todos', proof: { command: 'node --test tests/overdue.test.js' } })
    expect(r.findings[1]).not.toHaveProperty('where')
    expect(r.unproven).toEqual(['it might be slow on big files'])
    expect(checkNote(r)).toContain('Dropped as unproven')
  })

  it('counts a report without its verdict, or with issues but no proof, as a gap rather than a pass', () => {
    expect(parseCheckReport('All good, everything works.').verdict).toBe('gap')
    expect(parseCheckReport('Result: issues\n### Finding: something is off\nFix before ship: yes').verdict).toBe('gap')
    expect(checkNote(parseCheckReport('looks fine'))).toMatch(/never as a pass/)
  })

  it('reads pass and blocked verdicts, in bold too', () => {
    expect(parseCheckReport('**Result:** pass\nChecked: npm test passed').verdict).toBe('pass')
    expect(parseCheckReport('Result: blocked\nBlocked by: the app needs a login').verdict).toBe('blocked')
  })
})
