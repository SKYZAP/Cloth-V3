import { describe, expect, it } from 'vitest'
import { OTHER, SERIES, assignModelSlots, heat, modelColor } from '../src/renderer/src/lib/chart-colors'
import { DEFAULT_SETTINGS } from '../src/shared/settings-defaults'
import { clampStrength } from '../src/shared/chat-themes'

describe('model colours', () => {
  it('stay with the model that got them, whatever its rank later', () => {
    const first = assignModelSlots({}, ['p/a', 'p/b'])
    expect(first).toEqual({ 'p/a': 0, 'p/b': 1 })
    // b is now used most, and c is new: neither a nor b moves, c takes the next free slot.
    const later = assignModelSlots(first, ['p/b', 'p/c', 'p/a'])
    expect(later).toEqual({ 'p/a': 0, 'p/b': 1, 'p/c': 2 })
    expect(modelColor(later, 'p/b')).toBe(SERIES[1])
  })

  it('fold into Other once every slot is taken', () => {
    const many = Array.from({ length: 10 }, (_, i) => `p/m${i}`)
    const slots = assignModelSlots({}, many)
    expect(Object.keys(slots)).toHaveLength(SERIES.length)
    expect(modelColor(slots, 'p/m9')).toBe(OTHER)
  })
})

describe('the hours heatmap', () => {
  it('goes from faint to strong in one hue, with the busiest hour strongest', () => {
    expect(heat(1)).toBe('#ec6d80')
    expect(heat(0.01)).toBe('#3a1d25')
    expect(heat(0.5)).not.toBe(heat(1))
  })
})

describe('chat theme strength', () => {
  it('defaults to 20%', () => {
    expect(DEFAULT_SETTINGS.chatThemeStrength).toBe(0.2)
    expect(clampStrength(undefined)).toBe(0.2)
  })
})
