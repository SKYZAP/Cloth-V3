import { activeTheme, allThemes, BUILTIN_THEMES, clampStrength, NO_THEME, normalizeTheme, themeId, type ChatTheme } from '@shared/chat-themes'
import type { SettingsService } from '../core/settings'

export type ThemeInput = Partial<Omit<ChatTheme, 'id' | 'builtin'>>

/** Chat themes kept in Settings: shared by the Settings page and the chat agent's chat_theme tool. */
export class ChatThemes {
  constructor(private settings: SettingsService) {}

  /** How much of the background shows (the same for every theme). */
  setStrength(n: number): number {
    const strength = clampStrength(n)
    this.settings.update({ chatThemeStrength: strength })
    return strength
  }

  list(): { themes: ChatTheme[]; active: string; strength: number } {
    const s = this.settings.get()
    return { themes: allThemes(s.chatThemes), strength: clampStrength(s.chatThemeStrength), active: s.chatTheme === NO_THEME ? NO_THEME : (activeTheme(s.chatTheme, s.chatThemes)?.id ?? NO_THEME) }
  }

  private find(id: string): ChatTheme {
    const t = allThemes(this.settings.get().chatThemes).find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase())
    if (!t) throw new Error(`There's no theme "${id}". Themes: ${allThemes(this.settings.get().chatThemes).map((x) => x.id).join(', ')}`)
    return t
  }

  /** A new theme, starting from `from` (a theme id; default the active one) with `input` changed. */
  create(input: ThemeInput & { name: string }, from?: string | null, apply = false): ChatTheme {
    const s = this.settings.get()
    const base = from ? this.find(from) : (activeTheme(s.chatTheme, s.chatThemes) ?? BUILTIN_THEMES[0])
    const all = allThemes(s.chatThemes)
    if (all.length >= 40) throw new Error('There are 40 themes already. Delete one first.')
    const theme = normalizeTheme({ ...base, ...input, id: themeId(input.name, all.map((t) => t.id)) }, base)
    this.settings.update({ chatThemes: [...s.chatThemes, theme], ...(apply ? { chatTheme: theme.id } : {}) })
    return theme
  }

  /** Change a saved theme. A built-in one can't change: a copy with the changes is made instead. */
  update(id: string, input: ThemeInput, apply = false): ChatTheme {
    const t = this.find(id)
    if (t.builtin) return this.create({ ...input, name: input.name ?? `${t.name} (custom)` }, t.id, apply || this.settings.get().chatTheme === t.id)
    const theme = normalizeTheme({ ...t, ...input, id: t.id }, t)
    const s = this.settings.get()
    this.settings.update({ chatThemes: s.chatThemes.map((x) => (x.id === t.id ? theme : x)), ...(apply ? { chatTheme: theme.id } : {}) })
    return theme
  }

  apply(id: string): string {
    const next = id === NO_THEME ? NO_THEME : this.find(id).id
    this.settings.update({ chatTheme: next })
    return next
  }

  remove(id: string): void {
    const t = this.find(id)
    if (t.builtin) throw new Error(`${t.name} comes with Cloth and can't be deleted`)
    const s = this.settings.get()
    this.settings.update({ chatThemes: s.chatThemes.filter((x) => x.id !== t.id), ...(s.chatTheme === t.id ? { chatTheme: BUILTIN_THEMES[0].id } : {}) })
  }
}
