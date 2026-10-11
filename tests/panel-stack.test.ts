import { describe, expect, it } from 'vitest'
import { canStack, focusOrReplace, focusSection, migrate, resize, shownTabs, showTab, stackBelow, unstack, type PanelStack } from '../src/shared/panel-stack'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const near = (xs: number[], ys: number[]) => {
  expect(xs).toHaveLength(ys.length)
  xs.forEach((x, i) => expect(x).toBeCloseTo(ys[i], 9))
}

describe('panel stack: migrate', () => {
  it('turns an old single tab into a one-section stack', () => {
    expect(migrate({ open: true, tab: 'terminal', width: 500 })).toEqual({ stack: ['terminal'], sizes: [1], focus: 0 })
  })
  it('falls back to Setup for nothing or nonsense', () => {
    for (const raw of [null, undefined, 'x', {}, { tab: 'nope' }, { stack: [] }, { stack: ['nope'] }]) expect(migrate(raw)).toEqual({ stack: ['setup'], sizes: [1], focus: 0 })
  })
  it('keeps a saved stack, normalizing its sizes', () => {
    expect(migrate({ stack: ['files', 'terminal'], sizes: [1, 3], focus: 1 })).toEqual({ stack: ['files', 'terminal'], sizes: [0.25, 0.75], focus: 1 })
  })
  it('drops duplicates, unknown tabs and extras beyond three, and evens out sizes that no longer fit', () => {
    const s = migrate({ stack: ['git', 'git', 'bogus', 'files', 'setup', 'terminal'], sizes: [0.5, 0.5], focus: 7 })
    expect(s.stack).toEqual(['git', 'files', 'setup'])
    near(s.sizes, [1 / 3, 1 / 3, 1 / 3])
    expect(s.focus).toBe(0)
  })
  it('evens out sizes with bad numbers', () => {
    near(migrate({ stack: ['git', 'files'], sizes: [0, 1] }).sizes, [0.5, 0.5])
    near(migrate({ stack: ['git', 'files'], sizes: [NaN, 1] }).sizes, [0.5, 0.5])
    near(migrate({ stack: ['git', 'files'], sizes: 'x' }).sizes, [0.5, 0.5])
  })
  it('prefers the stack over an old tab', () => {
    expect(migrate({ tab: 'git', stack: ['files'], sizes: [1] }).stack).toEqual(['files'])
  })
})

describe('panel stack: stackBelow', () => {
  const one: PanelStack = { stack: ['files'], sizes: [1], focus: 0 }
  it('adds a section at the bottom with an even share, and focuses it', () => {
    const two = stackBelow(one, 'terminal')
    expect(two.stack).toEqual(['files', 'terminal'])
    near(two.sizes, [0.5, 0.5])
    expect(two.focus).toBe(1)
    const three = stackBelow({ ...two, sizes: [0.8, 0.2] }, 'git')
    expect(three.stack).toEqual(['files', 'terminal', 'git'])
    near(three.sizes, [0.8 * (2 / 3), 0.2 * (2 / 3), 1 / 3])
    expect(sum(three.sizes)).toBeCloseTo(1, 9)
    expect(three.focus).toBe(2)
  })
  it('only focuses a tab already shown', () => {
    const two: PanelStack = { stack: ['files', 'terminal'], sizes: [0.3, 0.7], focus: 1 }
    expect(stackBelow(two, 'files')).toEqual({ ...two, focus: 0 })
    expect(stackBelow(two, 'terminal')).toBe(two)
  })
  it('stops at three', () => {
    const three: PanelStack = { stack: ['files', 'terminal', 'git'], sizes: [0.2, 0.3, 0.5], focus: 0 }
    expect(canStack(three)).toBe(false)
    expect(stackBelow(three, 'setup')).toBe(three)
  })
})

describe('panel stack: unstack', () => {
  const three: PanelStack = { stack: ['files', 'terminal', 'git'], sizes: [0.2, 0.3, 0.5], focus: 2 }
  it('gives the height to the section above', () => {
    const s = unstack(three, 2)
    expect(s.stack).toEqual(['files', 'terminal'])
    near(s.sizes, [0.2, 0.8])
    expect(s.focus).toBe(1)
  })
  it('gives the top section’s height to the one below', () => {
    const s = unstack(three, 0)
    expect(s.stack).toEqual(['terminal', 'git'])
    near(s.sizes, [0.5, 0.5])
    expect(s.focus).toBe(1)
  })
  it('keeps focus on the same section when another goes', () => {
    expect(unstack({ ...three, focus: 0 }, 1).focus).toBe(0)
    expect(unstack({ ...three, focus: 2 }, 1)).toMatchObject({ stack: ['files', 'git'], focus: 1 })
  })
  it('moves focus up when the focused section goes (to the new top when it was the top)', () => {
    expect(unstack({ ...three, focus: 1 }, 1).focus).toBe(0)
    expect(unstack({ ...three, focus: 0 }, 0).focus).toBe(0)
  })
  it('never removes the last section, and ignores indexes outside the stack', () => {
    const one: PanelStack = { stack: ['git'], sizes: [1], focus: 0 }
    expect(unstack(one, 0)).toBe(one)
    expect(unstack(three, 3)).toBe(three)
    expect(unstack(three, -1)).toBe(three)
  })
  it('ends with a single full-height section', () => {
    expect(unstack(unstack(three, 0), 0)).toEqual({ stack: ['git'], sizes: [1], focus: 0 })
  })
})

describe('panel stack: focusOrReplace and focusSection', () => {
  const two: PanelStack = { stack: ['files', 'terminal'], sizes: [0.4, 0.6], focus: 1 }
  it('replaces the focused section’s tab, keeping sizes', () => {
    expect(focusOrReplace(two, 'git')).toEqual({ stack: ['files', 'git'], sizes: [0.4, 0.6], focus: 1 })
    expect(focusOrReplace({ ...two, focus: 0 }, 'setup')).toEqual({ stack: ['setup', 'terminal'], sizes: [0.4, 0.6], focus: 0 })
  })
  it('focuses the section already showing the tab', () => {
    expect(focusOrReplace(two, 'files')).toEqual({ ...two, focus: 0 })
    expect(focusOrReplace(two, 'terminal')).toBe(two)
  })
  it('focusSection ignores indexes outside the stack', () => {
    expect(focusSection(two, 0).focus).toBe(0)
    expect(focusSection(two, 2)).toBe(two)
    expect(focusSection(two, -1)).toBe(two)
  })
})

describe('panel stack: resize', () => {
  it('moves the handle between two sections by pixels', () => {
    near(resize([0.5, 0.5], 0, 100, 1000), [0.6, 0.4])
    near(resize([0.2, 0.3, 0.5], 1, -50, 1000), [0.2, 0.25, 0.55])
  })
  it('keeps both sections at least the minimum', () => {
    near(resize([0.5, 0.5], 0, 10_000, 1000), [0.88, 0.12])
    near(resize([0.5, 0.5], 0, -10_000, 1000), [0.12, 0.88])
    near(resize([0.5, 0.5], 0, 400, 1000, 200), [0.8, 0.2])
  })
  it('leaves the sizes alone when the two can’t both fit, or for a bad handle or height', () => {
    near(resize([0.1, 0.1, 0.8], 0, 30, 1000), [0.1, 0.1, 0.8])
    near(resize([0.5, 0.5], 1, 30, 1000), [0.5, 0.5])
    near(resize([0.5, 0.5], 0, 30, 0), [0.5, 0.5])
  })
  it('keeps the shares summing to 1', () => {
    expect(sum(resize([0.2, 0.3, 0.5], 0, 77, 900))).toBeCloseTo(1, 9)
  })
})

describe('panel stack: phones', () => {
  const two: PanelStack = { stack: ['files', 'terminal'], sizes: [0.4, 0.6], focus: 1 }
  it('show only the top tab', () => {
    expect(shownTabs(two, true)).toEqual(['files'])
    expect(shownTabs(two, false)).toEqual(['files', 'terminal'])
  })
  it('showing a tab gives a single section on phones and uses the focused section otherwise', () => {
    expect(showTab(two, 'git', true)).toEqual({ stack: ['git'], sizes: [1], focus: 0 })
    expect(showTab(two, 'git', false)).toEqual({ stack: ['files', 'git'], sizes: [0.4, 0.6], focus: 1 })
  })
})
