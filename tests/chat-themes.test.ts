import { describe, expect, it } from 'vitest'
import { activeTheme, BUILTIN_THEMES, normalizeTheme, THEME_PATTERNS, themeId } from '../src/shared/chat-themes'
import { ChatThemes } from '../src/main/agent/themes'
import { makeServices } from './helpers'

describe('chat themes', () => {
  it('clamps dials and refuses bad colours', () => {
    const t = normalizeTheme({ id: 'x', name: 'X', scale: 99, speed: -3, colors: ['red', '#000', '#111111', '#222222'] as never })
    expect(t.scale).toBe(4)
    expect(t.speed).toBe(0)
    expect(t.colors).toEqual(BUILTIN_THEMES[0].colors)
    expect(themeId('Ocean drift', ['ocean-drift'])).toBe('ocean-drift-2')
    expect(themeId('None', [])).toBe('none-2')
  })

  it('keeps every pattern, ships one theme per pattern, and refuses unknown ones', () => {
    for (const p of THEME_PATTERNS) expect(normalizeTheme({ id: 'x', pattern: p }).pattern).toBe(p)
    expect(normalizeTheme({ id: 'x', pattern: 'plasma' as never }).pattern).toBe(BUILTIN_THEMES[0].pattern)
    expect(BUILTIN_THEMES.map((t) => t.pattern).sort()).toEqual([...THEME_PATTERNS].sort())
  })

  it('defaults to Crimson flow, and none turns it off', () => {
    expect(activeTheme(undefined, [])?.id).toBe('crimson-flow')
    expect(activeTheme('gone', [])?.id).toBe('crimson-flow')
    expect(activeTheme('none', [])).toBeNull()
  })

  it('makes, adjusts, applies and deletes themes, and sets the strength', () => {
    const { services } = makeServices()
    const themes = new ChatThemes(services.settings)
    expect(themes.list()).toMatchObject({ active: 'crimson-flow', strength: 0.55 })

    const ocean = themes.create({ name: 'Ocean', colors: ['#000814', '#001d3d', '#003566', '#4cc9f0'] }, null, true)
    expect(services.settings.get().chatTheme).toBe(ocean.id)
    // Starts from the theme that was on: the flow field's dials.
    expect(ocean).toMatchObject({ pattern: 'flow', scale: 1.5 })

    expect(themes.update(ocean.id, { speed: 0.2 }).speed).toBe(0.2)

    // A built-in theme stays as it is: the change goes to a copy, which is put on.
    const copy = themes.update('crimson-waves', { speed: 0.3 }, true)
    expect(copy).toMatchObject({ name: 'Crimson waves (custom)', pattern: 'waves', speed: 0.3 })
    expect(copy.builtin).toBeUndefined()
    expect(services.settings.get().chatTheme).toBe(copy.id)

    expect(themes.setStrength(4)).toBe(1)
    expect(services.settings.get().chatThemeStrength).toBe(1)

    themes.remove(copy.id)
    expect(services.settings.get().chatTheme).toBe('crimson-flow')
    expect(() => themes.remove('crimson-flow')).toThrow(/can't be deleted/)
    expect(themes.apply('none')).toBe('none')
    expect(themes.list().themes.map((t) => t.id)).toEqual([...BUILTIN_THEMES.map((t) => t.id), ocean.id])
  })
})
