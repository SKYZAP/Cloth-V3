/**
 * Design systems: a handful of choices (seed colours, fonts, shape) expanded into full colour
 * scales, light/dark roles, a type scale and spacing — and written out as DESIGN.md (for people and
 * coding agents), tokens.css, a Tailwind v4 theme and W3C-style tokens.json. Pure functions, used by
 * the editor's live preview and by the exporter.
 */

export type DesignMode = 'dark' | 'light' | 'both'
export type Density = 'compact' | 'comfortable' | 'spacious'
export type ShadowStyle = 'none' | 'soft' | 'strong'

export interface DesignInput {
  brand: string
  /** Optional second colour for highlights; null = brand only. */
  accent: string | null
  success: string
  warning: string
  danger: string
  /** 0 = pure grey neutrals, 1 = neutrals clearly tinted with the brand hue. */
  neutralTint: number
  /** Which themes the system defines (the first listed is the default). */
  mode: DesignMode
  fontSans: string
  fontHeading: string
  fontMono: string
  /** Body text size in px. */
  baseSize: number
  /** Type scale ratio (1.125 … 1.5). */
  scale: number
  /** Base corner radius in px. */
  radius: number
  density: Density
  shadow: ShadowStyle
  /** Short rules in the system's voice ("Calm, dense, keyboard-first"). */
  principles: string[]
}

/** A design as edited or proposed, before it has an id. */
export interface DesignDraft {
  name: string
  description: string
  input: DesignInput
}

export interface DesignSystem {
  id: string
  name: string
  description: string
  input: DesignInput
  createdAt: number
  updatedAt: number
}

export const DEFAULT_DESIGN: DesignInput = {
  brand: '#4f5bd5',
  accent: null,
  success: '#22a06b',
  warning: '#d9a21b',
  danger: '#d93a4a',
  neutralTint: 0.3,
  mode: 'both',
  fontSans: 'Inter',
  fontHeading: 'Inter',
  fontMono: 'JetBrains Mono',
  baseSize: 15,
  scale: 1.25,
  radius: 8,
  density: 'comfortable',
  shadow: 'soft',
  principles: ['Clear hierarchy: one primary action per view', 'Content first; chrome stays quiet', 'Readable at a glance — generous line height, strong contrast']
}

export const FONT_CHOICES = {
  sans: ['Inter', 'Geist', 'IBM Plex Sans', 'Manrope', 'DM Sans', 'Plus Jakarta Sans', 'Source Sans 3', 'Nunito Sans', 'Work Sans', 'System UI'],
  heading: ['Inter', 'Geist', 'Space Grotesk', 'Sora', 'Outfit', 'Fraunces', 'Playfair Display', 'IBM Plex Serif', 'Manrope', 'System UI'],
  mono: ['JetBrains Mono', 'Geist Mono', 'IBM Plex Mono', 'Fira Code', 'Source Code Pro', 'System mono']
}

export const SCALES: { value: number; label: string }[] = [
  { value: 1.125, label: 'Major second (1.125)' },
  { value: 1.2, label: 'Minor third (1.2)' },
  { value: 1.25, label: 'Major third (1.25)' },
  { value: 1.333, label: 'Perfect fourth (1.333)' },
  { value: 1.414, label: 'Augmented fourth (1.414)' },
  { value: 1.5, label: 'Perfect fifth (1.5)' }
]

// ─── Colour maths (OKLCH) ─────────────────────────────────────────────────────

type Lch = { l: number; c: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function isHex(s: string): boolean {
  return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim())
}

export function normalizeHex(s: string): string {
  let h = s.trim().toLowerCase()
  if (!h.startsWith('#')) h = `#${h}`
  if (/^#[0-9a-f]{3}$/.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`
  return /^#[0-9a-f]{6}$/.test(h) ? h : '#000000'
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex)
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const x = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')
  return `#${x(r)}${x(g)}${x(b)}`
}

export function hexToOklch(hex: string): Lch {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const c = Math.sqrt(A * A + B * B)
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360
  return { l: L, c, h }
}

function oklchToLinear({ l, c, h }: Lch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180)
  const b = c * Math.sin((h * Math.PI) / 180)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  ]
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005)

/** OKLCH → hex, reducing chroma until the colour fits in sRGB. */
export function oklchToHex(lch: Lch): string {
  let { c } = lch
  let rgb = oklchToLinear({ ...lch, c })
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinear({ ...lch, c: mid }))) lo = mid
      else hi = mid
    }
    c = lo
    rgb = oklchToLinear({ ...lch, c })
  }
  return rgbToHex(rgb.map((v) => toGamma(clamp(v, 0, 1))) as [number, number, number])
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio between two colours (1 … 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// ─── Scales and roles ─────────────────────────────────────────────────────────

export const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const
export type Step = (typeof STEPS)[number]
export type Scale = Record<Step, string>
const LIGHTNESS: Record<Step, number> = { 50: 0.975, 100: 0.94, 200: 0.885, 300: 0.81, 400: 0.72, 500: 0.635, 600: 0.555, 700: 0.475, 800: 0.395, 900: 0.31, 950: 0.225 }

/** A tonal scale around a seed colour: hue kept, chroma eased off towards the light and dark ends. */
export function scaleFrom(hex: string, chromaOverride?: number): Scale {
  const seed = hexToOklch(hex)
  const out = {} as Scale
  for (const s of STEPS) {
    const l = LIGHTNESS[s]
    const ease = 1 - Math.min(0.85, Math.abs(l - 0.6) * 1.15)
    const c = chromaOverride ?? seed.c * ease
    out[s] = oklchToHex({ l, c, h: seed.h })
  }
  return out
}

export type RoleName =
  | 'background'
  | 'surface'
  | 'surfaceRaised'
  | 'border'
  | 'borderStrong'
  | 'text'
  | 'textMuted'
  | 'textSubtle'
  | 'primary'
  | 'primaryHover'
  | 'onPrimary'
  | 'primarySoft'
  | 'accent'
  | 'onAccent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'onDanger'
  | 'focus'

export type Roles = Record<RoleName, string>

export const ROLE_INFO: Record<RoleName, string> = {
  background: 'Page background',
  surface: 'Cards, panels, inputs',
  surfaceRaised: 'Menus, popovers, hover rows',
  border: 'Dividers and input borders',
  borderStrong: 'Hovered / emphasised borders',
  text: 'Body text and headings',
  textMuted: 'Secondary text, labels',
  textSubtle: 'Hints, placeholders, disabled',
  primary: 'Primary buttons, links, selection',
  primaryHover: 'Primary hover / pressed',
  onPrimary: 'Text and icons on primary',
  primarySoft: 'Selected rows, soft badges',
  accent: 'Highlights that are not actions',
  onAccent: 'Text on accent',
  success: 'Success states',
  warning: 'Warnings',
  danger: 'Errors and destructive actions',
  onDanger: 'Text on danger buttons',
  focus: 'Focus rings'
}

/** The step of `scale` that reads best as text/icons on `bg` while staying as close as possible to `prefer`. */
function legibleStep(scale: Scale, bg: string, prefer: Step, min: number): string {
  const order = [...STEPS].sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer))
  return scale[order.find((s) => contrast(scale[s], bg) >= min) ?? prefer]
}

/** The scale step `by` steps darker (+) or lighter (−) than `hex`, which is one of its steps. */
function shifted(scale: Scale, hex: string, by: number): string {
  const i = STEPS.findIndex((s) => scale[s] === hex)
  return scale[STEPS[clamp((i < 0 ? 6 : i) + by, 0, STEPS.length - 1)]]
}

const onColor = (bg: string, light: string, dark: string) => (contrast(bg, light) >= contrast(bg, dark) ? light : dark)

export interface BuiltDesign {
  scales: { brand: Scale; neutral: Scale; accent: Scale | null; success: Scale; warning: Scale; danger: Scale }
  roles: { light: Roles; dark: Roles }
  type: { name: string; size: number; lineHeight: number; weight: number; font: 'heading' | 'sans' }[]
  radii: Record<'sm' | 'md' | 'lg' | 'xl' | 'full', number>
  space: number[]
  control: { height: number; paddingX: number }
  shadows: Record<'sm' | 'md' | 'lg', string>
  checks: { label: string; mode: 'light' | 'dark'; fg: string; bg: string; ratio: number; need: number }[]
}

export function buildDesign(input: DesignInput): BuiltDesign {
  const brandSeed = hexToOklch(input.brand)
  const brand = scaleFrom(input.brand)
  const neutral = scaleFrom(oklchToHex({ l: 0.6, c: 0.001, h: brandSeed.h }), clamp(input.neutralTint, 0, 1) * 0.028)
  const accent = input.accent ? scaleFrom(input.accent) : null
  const success = scaleFrom(input.success)
  const warning = scaleFrom(input.warning)
  const danger = scaleFrom(input.danger)
  const white = '#ffffff'

  const lightBg = white
  const lightPrimary = legibleStep(brand, lightBg, 600, 4.5)
  const light: Roles = {
    background: lightBg,
    surface: neutral[50],
    surfaceRaised: white,
    border: neutral[200],
    borderStrong: neutral[300],
    text: neutral[950],
    textMuted: neutral[700],
    textSubtle: neutral[500],
    primary: lightPrimary,
    primaryHover: shifted(brand, lightPrimary, 1),
    onPrimary: onColor(lightPrimary, white, neutral[950]),
    primarySoft: brand[100],
    accent: accent ? accent[500] : brand[400],
    onAccent: onColor(accent ? accent[500] : brand[400], white, neutral[950]),
    success: legibleStep(success, lightBg, 600, 4.5),
    warning: legibleStep(warning, lightBg, 700, 4.5),
    danger: legibleStep(danger, lightBg, 600, 4.5),
    onDanger: onColor(legibleStep(danger, lightBg, 600, 4.5), white, neutral[950]),
    focus: brand[500]
  }

  const darkBg = neutral[950]
  const darkPrimary = legibleStep(brand, darkBg, 400, 4.5)
  const dark: Roles = {
    background: darkBg,
    surface: neutral[900],
    surfaceRaised: neutral[800],
    border: neutral[800],
    borderStrong: neutral[700],
    text: neutral[50],
    textMuted: neutral[300],
    textSubtle: neutral[500],
    primary: darkPrimary,
    primaryHover: shifted(brand, darkPrimary, -1),
    onPrimary: onColor(darkPrimary, white, neutral[950]),
    primarySoft: brand[900],
    accent: accent ? accent[400] : brand[300],
    onAccent: onColor(accent ? accent[400] : brand[300], white, neutral[950]),
    success: legibleStep(success, darkBg, 400, 4.5),
    warning: legibleStep(warning, darkBg, 400, 4.5),
    danger: legibleStep(danger, darkBg, 400, 4.5),
    onDanger: onColor(legibleStep(danger, darkBg, 400, 4.5), white, neutral[950]),
    focus: brand[400]
  }

  const r = input.scale
  const b = input.baseSize
  const size = (n: number) => Math.round(b * r ** n)
  const type: BuiltDesign['type'] = [
    { name: 'display', size: size(5), lineHeight: 1.1, weight: 700, font: 'heading' },
    { name: 'h1', size: size(4), lineHeight: 1.15, weight: 700, font: 'heading' },
    { name: 'h2', size: size(3), lineHeight: 1.2, weight: 650, font: 'heading' },
    { name: 'h3', size: size(2), lineHeight: 1.25, weight: 600, font: 'heading' },
    { name: 'h4', size: size(1), lineHeight: 1.3, weight: 600, font: 'heading' },
    { name: 'body', size: b, lineHeight: 1.55, weight: 400, font: 'sans' },
    { name: 'small', size: Math.max(11, Math.round(b / r)), lineHeight: 1.45, weight: 400, font: 'sans' },
    { name: 'caption', size: Math.max(10, Math.round(b / r ** 2)), lineHeight: 1.4, weight: 500, font: 'sans' }
  ]
  const rad = clamp(input.radius, 0, 32)
  const unit = input.density === 'compact' ? 3.5 : input.density === 'spacious' ? 4.5 : 4
  const shadowAlpha = input.shadow === 'strong' ? [0.12, 0.16, 0.22] : [0.05, 0.08, 0.12]
  const shadows =
    input.shadow === 'none'
      ? { sm: 'none', md: 'none', lg: 'none' }
      : {
          sm: `0 1px 2px rgb(0 0 0 / ${shadowAlpha[0]})`,
          md: `0 2px 4px rgb(0 0 0 / ${shadowAlpha[0]}), 0 6px 16px rgb(0 0 0 / ${shadowAlpha[1]})`,
          lg: `0 4px 8px rgb(0 0 0 / ${shadowAlpha[1]}), 0 16px 40px rgb(0 0 0 / ${shadowAlpha[2]})`
        }

  const checks: BuiltDesign['checks'] = []
  for (const [mode, roles] of [
    ['light', light],
    ['dark', dark]
  ] as const) {
    checks.push(
      { label: 'Text on background', mode, fg: roles.text, bg: roles.background, ratio: contrast(roles.text, roles.background), need: 4.5 },
      { label: 'Muted text on surface', mode, fg: roles.textMuted, bg: roles.surface, ratio: contrast(roles.textMuted, roles.surface), need: 4.5 },
      { label: 'Label on primary button', mode, fg: roles.onPrimary, bg: roles.primary, ratio: contrast(roles.onPrimary, roles.primary), need: 4.5 },
      { label: 'Primary link on background', mode, fg: roles.primary, bg: roles.background, ratio: contrast(roles.primary, roles.background), need: 4.5 },
      { label: 'Danger on background', mode, fg: roles.danger, bg: roles.background, ratio: contrast(roles.danger, roles.background), need: 4.5 },
      { label: 'Label on danger button', mode, fg: roles.onDanger, bg: roles.danger, ratio: contrast(roles.onDanger, roles.danger), need: 4.5 },
      { label: 'Input border on surface', mode, fg: roles.borderStrong, bg: roles.surface, ratio: contrast(roles.borderStrong, roles.surface), need: 1.5 }
    )
  }

  return {
    scales: { brand, neutral, accent, success, warning, danger },
    roles: { light, dark },
    type,
    radii: { sm: Math.round(rad * 0.5), md: rad, lg: Math.round(rad * 1.5), xl: Math.round(rad * 2), full: 9999 },
    space: [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24].map((n) => Math.round(n * unit)),
    control: { height: input.density === 'compact' ? 32 : input.density === 'spacious' ? 44 : 38, paddingX: Math.round(unit * 3.5) },
    shadows,
    checks
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)
const stack = (font: string, kind: 'sans' | 'mono' | 'serif') => {
  const fallback = kind === 'mono' ? "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace" : kind === 'serif' ? "Georgia, 'Times New Roman', serif" : "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  if (font === 'System UI' || font === 'System mono') return fallback
  return `'${font}', ${fallback}`
}
const SERIFS = new Set(['Fraunces', 'Playfair Display', 'IBM Plex Serif'])
export const fontStack = (input: DesignInput, which: 'sans' | 'heading' | 'mono') =>
  which === 'mono' ? stack(input.fontMono, 'mono') : which === 'heading' ? stack(input.fontHeading, SERIFS.has(input.fontHeading) ? 'serif' : 'sans') : stack(input.fontSans, 'sans')

function roleVars(roles: Roles, indent: string): string {
  return (Object.keys(roles) as RoleName[]).map((k) => `${indent}--color-${kebab(k)}: ${roles[k]};`).join('\n')
}

/** CSS custom properties: scales and shared tokens on :root, roles per theme. */
export function toCss(input: DesignInput, d = buildDesign(input), selector = ':root'): string {
  const lines: string[] = [`${selector} {`]
  for (const [name, scale] of Object.entries(d.scales)) {
    if (!scale) continue
    for (const s of STEPS) lines.push(`  --${name}-${s}: ${scale[s]};`)
  }
  lines.push(`  --font-sans: ${fontStack(input, 'sans')};`, `  --font-heading: ${fontStack(input, 'heading')};`, `  --font-mono: ${fontStack(input, 'mono')};`)
  for (const t of d.type) lines.push(`  --text-${t.name}: ${t.size}px;`, `  --leading-${t.name}: ${t.lineHeight};`)
  for (const [k, v] of Object.entries(d.radii)) lines.push(`  --radius-${k}: ${v}px;`)
  d.space.forEach((v, i) => lines.push(`  --space-${i}: ${v}px;`))
  lines.push(`  --control-height: ${d.control.height}px;`)
  for (const [k, v] of Object.entries(d.shadows)) lines.push(`  --shadow-${k}: ${v};`)
  const first = input.mode === 'light' ? 'light' : 'dark'
  if (input.mode !== 'both') {
    lines.push(`  color-scheme: ${first};`, roleVars(d.roles[first], '  '), '}')
    return lines.join('\n') + '\n'
  }
  lines.push('  color-scheme: dark;', roleVars(d.roles.dark, '  '), '}', '')
  lines.push(`${selector === ':root' ? '' : `${selector}`}[data-theme='light']${selector === ':root' ? ', .light' : ''} {`, '  color-scheme: light;', roleVars(d.roles.light, '  '), '}', '')
  lines.push('@media (prefers-color-scheme: light) {', `  ${selector}:not([data-theme='dark']) {`, '    color-scheme: light;', roleVars(d.roles.light, '    '), '  }', '}')
  return lines.join('\n') + '\n'
}

/** Tailwind v4: theme variables, so classes like bg-primary, text-muted and rounded-md use the system. */
export function toTailwind(input: DesignInput, d = buildDesign(input)): string {
  const lines = ["@import 'tailwindcss';", "@import './tokens.css';", '', '@theme inline {']
  for (const k of Object.keys(d.roles.dark) as RoleName[]) lines.push(`  --color-${kebab(k)}: var(--color-${kebab(k)});`)
  for (const [name, scale] of Object.entries(d.scales)) if (scale) for (const s of STEPS) lines.push(`  --color-${name}-${s}: var(--${name}-${s});`)
  lines.push('  --font-sans: var(--font-sans);', '  --font-heading: var(--font-heading);', '  --font-mono: var(--font-mono);')
  for (const t of d.type) lines.push(`  --text-${t.name}: var(--text-${t.name});`, `  --text-${t.name}--line-height: var(--leading-${t.name});`)
  for (const k of Object.keys(d.radii)) lines.push(`  --radius-${k}: var(--radius-${k});`)
  for (const k of Object.keys(d.shadows)) lines.push(`  --shadow-${k}: var(--shadow-${k});`)
  lines.push('}')
  return lines.join('\n') + '\n'
}

/** Design tokens in the W3C draft format. */
export function toTokensJson(input: DesignInput, d = buildDesign(input)): string {
  const color = (v: string) => ({ $type: 'color', $value: v })
  const dim = (v: number) => ({ $type: 'dimension', $value: `${v}px` })
  const scales = Object.fromEntries(Object.entries(d.scales).filter(([, s]) => s).map(([n, s]) => [n, Object.fromEntries(STEPS.map((k) => [k, color(s![k])]))]))
  const roles = (r: Roles) => Object.fromEntries((Object.keys(r) as RoleName[]).map((k) => [k, { ...color(r[k]), $description: ROLE_INFO[k] }]))
  return (
    JSON.stringify(
      {
        color: { ...scales, light: roles(d.roles.light), dark: roles(d.roles.dark) },
        font: { sans: { $type: 'fontFamily', $value: fontStack(input, 'sans') }, heading: { $type: 'fontFamily', $value: fontStack(input, 'heading') }, mono: { $type: 'fontFamily', $value: fontStack(input, 'mono') } },
        text: Object.fromEntries(d.type.map((t) => [t.name, { size: dim(t.size), lineHeight: { $type: 'number', $value: t.lineHeight }, weight: { $type: 'fontWeight', $value: t.weight } }])),
        radius: Object.fromEntries(Object.entries(d.radii).map(([k, v]) => [k, dim(v)])),
        space: Object.fromEntries(d.space.map((v, i) => [i, dim(v)])),
        shadow: Object.fromEntries(Object.entries(d.shadows).map(([k, v]) => [k, { $type: 'shadow', $value: v }]))
      },
      null,
      2
    ) + '\n'
  )
}

/** DESIGN.md: the system written for people and coding agents building UI with it. */
export function toDesignMd(system: Pick<DesignSystem, 'name' | 'description' | 'input'>, d = buildDesign(system.input)): string {
  const i = system.input
  const modes = i.mode === 'both' ? ['dark', 'light'] : [i.mode]
  const lines: string[] = [`# ${system.name} — design system`, '']
  if (system.description.trim()) lines.push(system.description.trim(), '')
  if (i.principles.length) lines.push('## Principles', '', ...i.principles.map((p) => `- ${p}`), '')
  lines.push(
    '## How to use this file',
    '',
    '- Build UI only from the tokens below (CSS variables in `tokens.css`, or the Tailwind theme in `tailwind.css`). Never hard-code hex colours, font sizes or radii.',
    `- Themes: ${i.mode === 'both' ? 'dark is the default; light applies with `data-theme="light"` (or the system preference)' : `${i.mode} only`}. Use role variables (\`--color-text\`, \`--color-primary\` …) so both themes work.`,
    '- One primary button per view. Secondary actions use the surface style; destructive actions use danger.',
    '- Keep text contrast at WCAG AA (4.5:1 for text, 3:1 for large text and icons). The checks below already pass or flag where they do not.',
    ''
  )
  lines.push('## Colour roles', '', `| Role | ${modes.map((m) => m[0].toUpperCase() + m.slice(1)).join(' | ')} | Use for |`, `|---|${modes.map(() => '---').join('|')}|---|`)
  for (const k of Object.keys(ROLE_INFO) as RoleName[]) lines.push(`| \`--color-${kebab(k)}\` | ${modes.map((m) => `\`${d.roles[m as 'light' | 'dark'][k]}\``).join(' | ')} | ${ROLE_INFO[k]} |`)
  lines.push('', '## Colour scales', '', `| Step | ${Object.entries(d.scales).filter(([, s]) => s).map(([n]) => n).join(' | ')} |`, `|---|${Object.entries(d.scales).filter(([, s]) => s).map(() => '---').join('|')}|`)
  for (const s of STEPS) lines.push(`| ${s} | ${Object.values(d.scales).filter(Boolean).map((sc) => `\`${sc![s]}\``).join(' | ')} |`)
  lines.push('', 'Use scale steps for illustrations, charts and tinted backgrounds; use roles for interface elements.', '')
  lines.push('## Typography', '', `- Body: **${i.fontSans}** (\`--font-sans\`), ${i.baseSize}px, line height ${d.type.find((t) => t.name === 'body')!.lineHeight}`, `- Headings: **${i.fontHeading}** (\`--font-heading\`)`, `- Code: **${i.fontMono}** (\`--font-mono\`)`, `- Scale ratio ${i.scale}`, '', '| Style | Size | Line height | Weight | Font |', '|---|---|---|---|---|')
  for (const t of d.type) lines.push(`| ${t.name} | ${t.size}px | ${t.lineHeight} | ${t.weight} | ${t.font} |`)
  lines.push('', 'Limit a screen to three type sizes plus headings. Use weight and colour (text / muted / subtle) for hierarchy before size.', '')
  lines.push('## Space, shape and elevation', '', `- Spacing scale (\`--space-N\`): ${d.space.map((v) => `${v}`).join(', ')} px — ${i.density} density`, `- Controls (buttons, inputs): ${d.control.height}px tall, ${d.control.paddingX}px horizontal padding`, `- Radius: sm ${d.radii.sm}px · md ${d.radii.md}px (default) · lg ${d.radii.lg}px (cards, dialogs) · xl ${d.radii.xl}px · full for pills`, `- Shadows: ${i.shadow === 'none' ? 'none — separate layers with borders and surface colour' : `sm (\`${d.shadows.sm}\`) for raised controls, md for menus and popovers, lg for dialogs`}`, '')
  lines.push(
    '## Components',
    '',
    `- **Button (primary):** background \`--color-primary\`, text \`--color-on-primary\`, radius md, height ${d.control.height}px; hover \`--color-primary-hover\`; focus ring 2px \`--color-focus\` with 2px offset.`,
    '- **Button (secondary):** background `--color-surface`, 1px `--color-border`, text `--color-text`; hover border `--color-border-strong`.',
    '- **Button (danger):** background `--color-danger`, text `--color-on-danger`. Only for destructive actions, and always name what is destroyed.',
    '- **Input:** background `--color-surface`, 1px `--color-border`, radius md; placeholder `--color-text-subtle`; focus border `--color-primary` plus the focus ring. Labels above the field in `--color-text-muted`, small size.',
    `- **Card / panel:** background \`--color-surface\`, 1px \`--color-border\`, radius lg, padding ${d.space[5]}–${d.space[6]}px${i.shadow === 'none' ? '' : ', shadow sm'}.`,
    '- **Badge:** small text, radius full; neutral uses `--color-surface-raised`; selected/info uses `--color-primary-soft` with `--color-primary` text.',
    '- **Alert:** 1px border and soft tint of the status colour, text in `--color-text`, icon in the status colour.',
    '- **Menu / popover:** `--color-surface-raised`, radius md, shadow md; hovered item `--color-primary-soft`.',
    ''
  )
  lines.push('## Contrast checks', '', '| Pair | Theme | Ratio | Needs | |', '|---|---|---|---|---|')
  for (const c of d.checks.filter((x) => modes.includes(x.mode))) lines.push(`| ${c.label} | ${c.mode} | ${c.ratio.toFixed(2)} | ${c.need} | ${c.ratio >= c.need ? 'pass' : '**fails**'} |`)
  lines.push('', '## Files', '', '- `DESIGN.md` — this guide', '- `tokens.css` — CSS variables for both themes', '- `tailwind.css` — Tailwind v4 theme mapped to the tokens', '- `tokens.json` — the same tokens in the W3C design-tokens format', '')
  return lines.join('\n')
}

/** Every export file, by name. */
export function designFiles(system: Pick<DesignSystem, 'name' | 'description' | 'input'>): Record<string, string> {
  const d = buildDesign(system.input)
  return { 'DESIGN.md': toDesignMd(system, d), 'tokens.css': toCss(system.input, d), 'tailwind.css': toTailwind(system.input, d), 'tokens.json': toTokensJson(system.input, d) }
}

/** Cleans up a design from a model or an import: valid colours, numbers in range, known options. */
export function sanitizeDesign(raw: Partial<Record<keyof DesignInput, unknown>>, base: DesignInput = DEFAULT_DESIGN): DesignInput {
  const hex = (v: unknown, fallback: string) => (typeof v === 'string' && isHex(v) ? normalizeHex(v) : fallback)
  const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback)
  const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T) => (options.includes(v as T) ? (v as T) : fallback)
  const font = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() && v.length < 60 ? v.trim() : fallback)
  return {
    brand: hex(raw.brand, base.brand),
    accent: raw.accent === null ? null : typeof raw.accent === 'string' && isHex(raw.accent) ? normalizeHex(raw.accent) : base.accent,
    success: hex(raw.success, base.success),
    warning: hex(raw.warning, base.warning),
    danger: hex(raw.danger, base.danger),
    neutralTint: num(raw.neutralTint, 0, 1, base.neutralTint),
    mode: pick(raw.mode, ['dark', 'light', 'both'] as const, base.mode),
    fontSans: font(raw.fontSans, base.fontSans),
    fontHeading: font(raw.fontHeading, base.fontHeading),
    fontMono: font(raw.fontMono, base.fontMono),
    baseSize: Math.round(num(raw.baseSize, 12, 20, base.baseSize)),
    scale: num(raw.scale, 1.067, 1.618, base.scale),
    radius: Math.round(num(raw.radius, 0, 32, base.radius)),
    density: pick(raw.density, ['compact', 'comfortable', 'spacious'] as const, base.density),
    shadow: pick(raw.shadow, ['none', 'soft', 'strong'] as const, base.shadow),
    principles: Array.isArray(raw.principles) ? raw.principles.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim()).slice(0, 8) : base.principles
  }
}
