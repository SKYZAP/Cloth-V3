import { describe, expect, it } from 'vitest'
import type { ReviewFinding, SpecWorkflow, StageGate } from '../src/shared/types'
import { autoAdvances, workflowReport } from '../src/main/agent/chat'
import { findingsLogLines, handoverText, stageNote, workflowSection } from '../src/main/agent/workflow'

const flow = (extra: Partial<SpecWorkflow> = {}): SpecWorkflow => ({ kind: 'spec-ship', stage: 'review', slug: 'due-dates', ...extra })
const gate = (stage: StageGate['stage'], findings?: ReviewFinding[]): StageGate => ({ stage, summary: ['done'], ...(findings ? { findings } : {}) })
const mustFix = (status?: 'open' | 'fixed'): ReviewFinding => ({ axis: 'break', fix: true, title: 'invalid date saved', ...(status ? { status } : {}) })

describe('Spec → Ship on its own', () => {
  it('goes on from the spec, the build and a review with nothing left to fix; the grilling always waits', () => {
    expect(autoAdvances(gate('spec'), flow())).toBe(true)
    expect(autoAdvances(gate('build'), flow())).toBe(true)
    expect(autoAdvances(gate('review', [mustFix('fixed'), { axis: 'standards', fix: false, title: 'name' }]), flow())).toBe(true)
    expect(autoAdvances(gate('grill'), flow())).toBe(false)
  })

  it('stops for the person when a must-fix finding is still open, when they want to approve the spec, or when switched off', () => {
    expect(autoAdvances(gate('review', [mustFix('open')]), flow())).toBe(false)
    // A finding from before statuses existed counts as open.
    expect(autoAdvances(gate('review', [mustFix()]), flow())).toBe(false)
    expect(autoAdvances(gate('spec'), flow({ approveSpec: true }))).toBe(false)
    expect(autoAdvances(gate('build'), flow({ approveSpec: true }))).toBe(true)
    expect(autoAdvances(gate('build'), flow({ autoContinue: false }))).toBe(false)
    expect(autoAdvances(undefined, flow())).toBe(false)
  })

  it('reports back when it finishes, stops for the person, or fails, and stays quiet when it goes on', () => {
    expect(workflowReport({ finished: gate('build'), onward: true, wrapped: false, slug: 'due-dates', reply: '' })).toBeNull()
    expect(workflowReport({ onward: false, wrapped: false, slug: null, reply: 'just chatting' })).toBeNull()
    expect(workflowReport({ onward: false, wrapped: true, slug: 'due-dates', reply: 'Shipped AC-1 to AC-5; all checks pass.' })).toEqual({ title: 'Spec → Ship finished (due-dates)', body: 'Shipped AC-1 to AC-5; all checks pass.' })
    expect(workflowReport({ finished: gate('review', [mustFix('open'), mustFix('fixed')]), onward: false, wrapped: false, slug: 'due-dates', reply: '' })).toEqual({
      title: 'Spec → Ship needs you (due-dates)',
      body: '1 finding to fix before shipping still open: pick what to fix.'
    })
    expect(workflowReport({ finished: gate('grill'), onward: false, wrapped: false, slug: null, reply: '' })?.body).toMatch(/decisions are settled/)
    expect(workflowReport({ error: 'Model overloaded', finished: gate('build'), onward: true, wrapped: false, slug: 'x', reply: '' })).toEqual({ title: 'Spec → Ship stopped (x)', body: 'Model overloaded' })
  })
})

describe('the review stage', () => {
  it('checks with verifiers, tries to break the change, fixes what it proves and gets a second opinion', () => {
    const text = workflowSection(flow({ route: 'standard' })) ?? ''
    expect(text).toContain('`task` with kind check')
    expect(text).toContain('- Break (verifiers)')
    expect(text).toContain('- Safety (a verifier')
    expect(text).toContain('Keep only what reproduces')
    expect(text).toContain('At most two rounds of fixes')
    // Findings must be reachable by real callers; fixes keep to public APIs and leave the project's mocks alone.
    expect(text).toContain('how a real caller reaches it')
    expect(text).toContain('never their private fields or internals')
    expect(text).toContain('never edits the project\'s existing test helpers or mocks')
    expect(text).toContain('Standards check again on the fixes\' diff')
    expect(text).toContain('second opinion')
    // Work happens without the person; they are told when it's done.
    expect(text).toContain('Work on your own and report back')
    expect(stageNote('done', 'x')).toContain('report back')
    expect(stageNote('done', 'x')).toContain('docs/specs/FINDINGS.md')
  })

  it('tells Build and Review whether the project has its verification guide', () => {
    expect(handoverText({ slug: 'x', gates: [], said: [], verifyGuide: false })).toContain("docs/verify/README.md doesn't exist")
    expect(handoverText({ slug: 'x', gates: [], said: [], verifyGuide: true })).toContain('Verification guide: docs/verify/README.md (use it')
    expect(handoverText({ slug: 'x', gates: [], said: [] })).not.toContain('Verification guide')
    expect(workflowSection(flow({ stage: 'build' }))).toContain('`verify-guide` skill')
  })

  it("hands the review's proof, fixes and second opinion on to the wrap-up", () => {
    const review: StageGate = {
      stage: 'review',
      summary: ['checked'],
      findings: [{ axis: 'break', fix: true, title: 'invalid date saved', where: 'AC-2', status: 'fixed', proof: { command: 'node bin/todo.js add x --due 2026-02-30', observed: 'exit 0' } }],
      attention: ['the safety check only ran on the new file format']
    }
    const text = handoverText({ slug: 'x', gates: [review], said: [] })
    expect(text).toContain('Finding (break, fix before shipping, fixed): invalid date saved (AC-2); shown by `node bin/todo.js add x --due 2026-02-30`')
    expect(text).toContain('Second opinion: the safety check only ran on the new file format')
  })

  it('logs each finding for the repeat check, with whether it was proven and fixed', () => {
    expect(
      findingsLogLines('due-dates', '2026-11-10', [
        { axis: 'break', fix: true, title: 'invalid date\n saved', where: 'AC-2', status: 'fixed', proof: { command: 'c', observed: 'o' } },
        { axis: 'spec', fix: true, title: 'AC-4 untested', status: 'open' },
        { axis: 'standards', fix: false, title: 'unclear name' }
      ])
    ).toEqual([
      '- 2026-11-10 due-dates: [break, must fix, fixed, proven] invalid date saved (AC-2)',
      '- 2026-11-10 due-dates: [spec, must fix, open] AC-4 untested',
      '- 2026-11-10 due-dates: [standards, optional] unclear name'
    ])
    expect(findingsLogLines('x', 'd', [])).toEqual([])
  })
})
