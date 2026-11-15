import { describe, expect, it } from 'vitest'
import { EFFORT_OPTIONS, effortLabel, normalizeEffort, normalizeEffortOrNull } from '../src/shared/effort'

describe('reasoning effort', () => {
  it('offers four levels in order: Low, Medium, High, Max', () => {
    expect(EFFORT_OPTIONS).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Max' }
    ])
  })

  it("reads old 'off' and 'minimal' as low and keeps the four levels", () => {
    expect(normalizeEffort('off')).toBe('low')
    expect(normalizeEffort('minimal')).toBe('low')
    expect(normalizeEffort(undefined)).toBe('low')
    expect(normalizeEffort('nonsense')).toBe('low')
    for (const v of ['low', 'medium', 'high', 'xhigh'] as const) expect(normalizeEffort(v)).toBe(v)
    expect(normalizeEffort('max')).toBe('xhigh')
  })

  it("keeps null (the chat's effort) as null", () => {
    expect(normalizeEffortOrNull(null)).toBeNull()
    expect(normalizeEffortOrNull(undefined)).toBeNull()
    expect(normalizeEffortOrNull('off')).toBe('low')
    expect(normalizeEffortOrNull('xhigh')).toBe('xhigh')
  })

  it('labels every saved level', () => {
    expect(effortLabel('off')).toBe('Low')
    expect(effortLabel('minimal')).toBe('Low')
    expect(effortLabel('low')).toBe('Low')
    expect(effortLabel('medium')).toBe('Medium')
    expect(effortLabel('high')).toBe('High')
    expect(effortLabel('xhigh')).toBe('Max')
  })
})

describe('models that take only some efforts', () => {
  const bonsai = ['low', 'medium', 'xhigh'] as const

  it('shows only those efforts, and the saved one rounded up to one it takes', async () => {
    const { effortFor, effortOptions } = await import('../src/shared/effort')
    expect(effortOptions(bonsai).map((o) => o.label)).toEqual(['Low', 'Medium', 'Max'])
    expect(effortOptions(undefined)).toHaveLength(4)
    expect(effortFor('high', bonsai)).toBe('xhigh')
    expect(effortFor('medium', bonsai)).toBe('medium')
    expect(effortFor('off', bonsai)).toBe('low')
    expect(effortFor('high', undefined)).toBe('high')
  })

  it('sends every other level as the nearest one it takes', async () => {
    const { effortMap } = await import('../src/main/providers/providers')
    expect(effortMap([...bonsai])).toEqual({ off: 'low', minimal: 'low', high: 'xhigh', max: 'xhigh' })
  })
})
