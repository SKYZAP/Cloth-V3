/**
 * Chat themes: the animated background behind the conversation. A theme is a pattern, four colours (darkest
 * first) and a few dials. Cloth ships one per pattern; you, or the chat agent, can add and adjust more.
 */
/** flow: a turbulent field; waves: soft horizontal bands; mesh: large blended blobs; swirl: dithered spiral arms; halftone: a dot screen. */
export const THEME_PATTERNS = ['flow', 'waves', 'mesh', 'swirl', 'halftone'] as const
export type ChatThemePattern = (typeof THEME_PATTERNS)[number]

export interface ChatTheme {
  id: string
  name: string
  pattern: ChatThemePattern
  /** Four colours from the darkest to the brightest, as #rrggbb. */
  colors: [string, string, string, string]
  /** Zoom of the pattern: higher shows more, smaller detail. 0.5 to 4. */
  scale: number
  /** How strongly the pattern bends and swirls. 0 to 1. */
  intensity: number
  /** Animation speed. 0 (still) to 2. */
  speed: number
  /** Slow wander of the whole pattern. 0 to 0.5. */
  drift: number
  /** Film grain. 0 to 0.5. */
  grain: number
  /** Darkening towards the edges. 0 to 1. */
  vignette: number
  /** Added to every colour: below 0 darker, above 0 lighter. -0.6 to 0.3. */
  brightness: number
  /** Softening. 0 to 0.03. */
  blur: number
  /** Shipped with Cloth: can be chosen, not changed or deleted. */
  builtin?: boolean
}

export const BUILTIN_THEMES: ChatTheme[] = [
  { id: 'crimson-flow', name: 'Crimson flow', pattern: 'flow', colors: ['#050102', '#5c0812', '#cf2845', '#f78c96'], scale: 1.5, intensity: 0.48, speed: 0.86, drift: 0.156, grain: 0.35, vignette: 0.61, brightness: -0.32, blur: 0.016, builtin: true },
  { id: 'crimson-waves', name: 'Crimson waves', pattern: 'waves', colors: ['#020103', '#120305', '#6b0d1c', '#cf2845'], scale: 1.54, intensity: 0.71, speed: 0.86, drift: 0.14, grain: 0.06, vignette: 0.37, brightness: 0, blur: 0, builtin: true },
  { id: 'crimson-mesh', name: 'Crimson mesh', pattern: 'mesh', colors: ['#0a0204', '#5a0a18', '#c22440', '#f58a96'], scale: 1.1, intensity: 0.6, speed: 0.7, drift: 0.12, grain: 0.06, vignette: 0.35, brightness: -0.08, blur: 0, builtin: true },
  { id: 'crimson-swirl', name: 'Crimson swirl', pattern: 'swirl', colors: ['#040102', '#24040a', '#7a0f21', '#e0465d'], scale: 1.6, intensity: 0.5, speed: 0.6, drift: 0.08, grain: 0, vignette: 0.5, brightness: -0.08, blur: 0, builtin: true },
  { id: 'crimson-halftone', name: 'Crimson halftone', pattern: 'halftone', colors: ['#030102', '#1a0307', '#8c1226', '#f27887'], scale: 1.4, intensity: 0.5, speed: 0.6, drift: 0.1, grain: 0.04, vignette: 0.45, brightness: -0.05, blur: 0, builtin: true }
]

/** The background chats start with. */
export const DEFAULT_CHAT_THEME = 'crimson-flow'
/** No background. */
export const NO_THEME = 'none'
/** How much of the background shows through behind the chat (Settings › Chat), whatever the theme. */
export const STRENGTH_RANGE = [0.1, 1] as const
export const DEFAULT_STRENGTH = 0.55
export const clampStrength = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(STRENGTH_RANGE[1], Math.max(STRENGTH_RANGE[0], n)) : DEFAULT_STRENGTH)

const RANGES = {
  scale: [0.5, 4],
  intensity: [0, 1],
  speed: [0, 2],
  drift: [0, 0.5],
  grain: [0, 0.5],
  vignette: [0, 1],
  brightness: [-0.6, 0.3],
  blur: [0, 0.03]
} as const satisfies Record<string, readonly [number, number]>
export type ThemeDial = keyof typeof RANGES
export const THEME_DIALS = Object.keys(RANGES) as ThemeDial[]
export const dialRange = (k: ThemeDial): readonly [number, number] => RANGES[k]

const HEX = /^#[0-9a-f]{6}$/i

/** A theme made safe to store and render: dials clamped, colours checked, missing parts from `base`. */
export function normalizeTheme(input: Partial<ChatTheme> & { id: string }, base: ChatTheme = BUILTIN_THEMES[0]): ChatTheme {
  const colors = (Array.isArray(input.colors) && input.colors.length === 4 && input.colors.every((c) => typeof c === 'string' && HEX.test(c)) ? input.colors.map((c) => c.toLowerCase()) : base.colors) as ChatTheme['colors']
  const out: ChatTheme = {
    id: input.id,
    name: String(input.name ?? '').trim().slice(0, 40) || base.name,
    pattern: (THEME_PATTERNS as readonly unknown[]).includes(input.pattern) ? (input.pattern as ChatThemePattern) : base.pattern,
    colors,
    ...Object.fromEntries(
      THEME_DIALS.map((k) => {
        const v = input[k]
        const [lo, hi] = RANGES[k]
        return [k, typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : base[k]]
      })
    )
  } as ChatTheme
  return out
}

/** The themes to choose from: the built-in ones, then saved ones. */
export function allThemes(saved: ChatTheme[] | undefined): ChatTheme[] {
  return [...BUILTIN_THEMES, ...(saved ?? []).filter((t) => !BUILTIN_THEMES.some((b) => b.id === t.id)).map((t) => normalizeTheme(t))]
}

/** The theme a chat shows, or null for none (an unknown id falls back to the default). */
export function activeTheme(id: string | undefined, saved: ChatTheme[] | undefined): ChatTheme | null {
  if (id === NO_THEME) return null
  const all = allThemes(saved)
  return all.find((t) => t.id === id) ?? all.find((t) => t.id === DEFAULT_CHAT_THEME)!
}

/** An id for a new theme from its name ("Ocean drift" → "ocean-drift", made unique). */
export function themeId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'theme'
  let id = base
  for (let i = 2; taken.includes(id) || id === NO_THEME; i++) id = `${base}-${i}`
  return id
}
