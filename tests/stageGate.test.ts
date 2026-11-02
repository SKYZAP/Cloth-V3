import { describe, expect, it } from 'vitest'
import { fixMessage, isNothing, splitSummary } from '../src/renderer/src/lib/stageGate'

describe('Spec → Ship stage stops', () => {
  it('pulls the Assumed and Unverified lines out of the bullets', () => {
    expect(splitSummary(['4 criteria', 'Assumed: flags are stored upper case', 'unverified:  nothing '])).toEqual({ bullets: ['4 criteria'], assumed: 'flags are stored upper case', unverified: 'nothing' })
    expect(splitSummary(['Built 3 tickets'])).toEqual({ bullets: ['Built 3 tickets'], assumed: null, unverified: null })
    // An empty line after the label still counts as "nothing".
    expect(splitSummary(['Assumed:']).assumed).toBe('nothing')
    expect(isNothing('Nothing.')).toBe(true)
    expect(isNothing('Redis was not running')).toBe(false)
  })

  it('sends exactly the ticked findings back to be fixed', () => {
    expect(fixMessage([{ axis: 'spec', fix: true, title: 'AC-3: entities stay literal', where: 'src/cli.ts:195' }])).toBe('Fix this review finding, then run the tests and review again:\n- [Spec] AC-3: entities stay literal (src/cli.ts:195)')
    expect(
      fixMessage([
        { axis: 'standards', fix: true, title: 'Uncaught RangeError' },
        { axis: 'spec', fix: false, title: 'Slow import' }
      ])
    ).toBe('Fix these 2 review findings, then run the tests and review again:\n- [Standards] Uncaught RangeError\n- [Spec] Slow import')
  })
})
