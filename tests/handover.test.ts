import { describe, expect, it } from 'vitest'
import { handoverText, specIndexLine } from '../src/main/agent/workflow'
import { capOutput } from '../src/main/agent/workspace'

describe('Spec → Ship handover', () => {
  it('carries each stage result, what the person said and the change, not the conversation', () => {
    const text = handoverText({
      route: 'quick',
      slug: 'flag-casing',
      gates: [{ stage: 'grill', summary: ['Route: Quick'], files: ['docs/specs/flag-casing/spec.md'] }, { stage: 'review', summary: ['2 findings'], findings: [{ axis: 'spec', fix: true, title: 'AC-2 untested', where: 'AC-2' }] }],
      said: ['Make --Flag work like --flag', 'Keep the old flag working too'],
      base: 'abc1234',
      changed: ['src/flags.ts']
    })
    expect(text).toContain('Route: Quick. Feature folder: docs/specs/flag-casing/')
    expect(text).toContain('Grill reported:\n- Route: Quick\n- Files: docs/specs/flag-casing/spec.md')
    expect(text).toContain('- Finding (spec, fix before shipping): AC-2 untested (AC-2)')
    expect(text).toContain('as they wrote it')
    expect(text).toContain('> Make --Flag work like --flag')
    expect(text).toContain('What the person said after that (their answers and change requests, oldest first):\n- Keep the old flag working too')
    expect(text).toContain('The change: `git diff abc1234`, 1 file: src/flags.ts.')
  })

  it('keeps a long request whole, with its lines, so its exact texts reach the spec', () => {
    const request = ['Add /remove and /move.', ...Array.from({ length: 40 }, (_, i) => `- Reply ${i}: \`> **Removed** <title> **from the queue.**\``), 'Errors (all ephemeral): `There is no track at position <n>.`'].join('\n')
    expect(request.length).toBeGreaterThan(2000)
    const text = handoverText({ slug: 'queue', gates: [], said: [request] })
    for (const line of request.split('\n')) expect(text).toContain(`> ${line}`)
  })

  it('keeps every grilling answer: whole rounds, and the oldest shortened rather than dropped', () => {
    const round = (n: number) => Array.from({ length: 6 }, (_, i) => `Q${i + 1} (Decision ${n}.${i + 1}): yes, ${'use the existing reply format and keep it ephemeral '.repeat(2).trim()}`).join('\n')
    const rounds = [1, 2, 3].map(round)
    const text = handoverText({ slug: 'queue', gates: [], said: ['Add /remove.', ...rounds] })
    // A round of six answers is far past the old 600-character cut; every answer of every round survives.
    expect(rounds[0].length).toBeGreaterThan(600)
    for (const r of rounds) for (const line of r.split('\n')) expect(text).toContain(line)
    // Past the limit, the oldest round still appears (shortened), and the latest is whole.
    const many = Array.from({ length: 40 }, (_, i) => `round ${i}\n${round(i)}`)
    const long = handoverText({ slug: 'queue', gates: [], said: ['Add /remove.', ...many] })
    expect(long).toContain('- round 0')
    for (const line of many[39].split('\n')) expect(long).toContain(line)
  })

  it('lists a finished spec in the index once', () => {
    expect(specIndexLine('# Specs\n', 'saved-searches', '# Saved searches\n')).toBe('- [saved-searches](saved-searches/spec.md): Saved searches')
    expect(specIndexLine('- [saved-searches](saved-searches/spec.md): x', 'saved-searches', '# Saved searches')).toBeNull()
  })
})

describe('capOutput', () => {
  it('leaves short output alone and keeps the start and end of long output', () => {
    expect(capOutput('ok\n')).toBe('ok\n')
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const out = capOutput(long)
    expect(out.length).toBeLessThanOrEqual(8200)
    expect(out.startsWith('line 0 ')).toBe(true)
    expect(out.endsWith(`line 1999 ${'x'.repeat(40)}`)).toBe(true)
    expect(out).toMatch(/\[… \d+ lines cut to save context/)
  })
})
