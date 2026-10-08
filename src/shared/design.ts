import { DEFAULT_KIT, KIT, KIT_NAMES, KIT_USAGE, kitCss, kitMarkdown, kitSpecimen, sanitizeKit, type KitSettings } from './kit'
/**
 * Design systems: a handful of choices (seed colours, fonts, shape) expanded into full colour
 * scales, light/dark roles, a type scale and spacing — and written out as DESIGN.md (for people and
 * coding agents), tokens.css, a Tailwind v4 theme and W3C-style tokens.json. Pure functions, used by
 * the editor's live preview and by the exporter.
 */
import { shadcnFiles, shadcnMarkdown } from './shadcn'

export type DesignMode = 'dark' | 'light' | 'both'
export type Density = 'compact' | 'comfortable' | 'spacious'
export type ShadowStyle = 'none' | 'soft' | 'strong'
/** Which family the greys come from: the brand's hue, or a classic grey. */
export type NeutralFamily = 'brand' | 'slate' | 'zinc' | 'gray' | 'stone' | 'sand' | 'olive' | 'custom'

export interface DesignInput {
  brand: string
  /** Optional second colour for highlights; null = brand only. */
  accent: string | null
  success: string
  warning: string
  danger: string
  /** Use the brand colour exactly for buttons and links (otherwise Cloth picks the most readable shade). */
  pinBrand: boolean
  /** Where the greys get their hue. */
  neutral: NeutralFamily
  /** How strongly the greys show that hue (0 = none, 1 = clearly tinted). */
  neutralTint: number
  /** For the "custom" grey family: the colour whose hue the greys take (usually a near-grey from a palette). */
  neutralSeed: string | null
  /** The palette this system was built from (e.g. imported from Coolors), kept for reference and re-assigning. */
  palette: string[]
  /** Dark theme background: 0 = near black, 1 = soft charcoal. */
  darkDepth: number
  /** Which themes the system defines (the first listed is the default). */
  mode: DesignMode
  fontSans: string
  fontHeading: string
  fontMono: string
  /** Body text size in px. */
  baseSize: number
  /** Type scale ratio (1.125 … 1.5). */
  scale: number
  /** Weight of the largest headings (smaller ones step down). */
  headingWeight: number
  /** Letter-spacing of the largest headings, in em (negative = tighter). */
  headingTracking: number
  /** Line height of body text. */
  bodyLeading: number
  /** Base corner radius in px. */
  radius: number
  density: Density
  shadow: ShadowStyle
  /** Short rules in the system's voice ("Calm, dense, keyboard-first"). */
  principles: string[]
  /** Hand-picked colours for single roles, per theme; they win over the generated ones. */
  overrides: { light: Partial<Roles>; dark: Partial<Roles> }
  /** Settings of the built-in components (button, input, card …). */
  kit: KitSettings
  /** What the editor's sample screen shows: content written for this product, or null for the generic screen. */
  sample: SampleContent | null
}

/** Words for the sample screen, so a design is judged on its own product rather than a stand-in. */
export interface SampleContent {
  /** The product's name in the header. */
  app: string
  /** Links in the header. */
  nav: string[]
  title: string
  subtitle: string
  /** A search or sign-up field in the hero: its label and example text. */
  field: string
  placeholder: string
  primary: string
  secondary: string
  /** The section heading above the cards. */
  section: string
  items: { title: string; meta: string; tag: string }[]
  /** A confirmation message. */
  done: string
}

export const DEFAULT_SAMPLE: SampleContent = {
  app: 'Your app',
  nav: ['Home', 'Explore', 'Account'],
  title: 'Everything in one place',
  subtitle: 'Three things need your attention this week. The rest is on track.',
  field: 'Email',
  placeholder: 'you@example.com',
  primary: 'Get started',
  secondary: 'Learn more',
  section: 'This week',
  items: [
    { title: 'Quarterly report', meta: 'Due Friday', tag: 'In progress' },
    { title: 'Team offsite', meta: 'Tuesday, 10:00', tag: 'Booked' },
    { title: 'Website refresh', meta: 'Waiting on review', tag: 'Paused' }
  ],
  done: 'Saved. Everyone on the team can see it now.'
}

/** Cleans up sample-screen words from a model: short strings, three cards. Null when there's nothing usable. */
export function sanitizeSample(raw: unknown): SampleContent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max: number, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback)
  const d = DEFAULT_SAMPLE
  const items = Array.isArray(r.items)
    ? r.items
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .slice(0, 3)
        .map((i, n) => ({ title: str(i.title, 40, d.items[n].title), meta: str(i.meta, 50, d.items[n].meta), tag: str(i.tag, 20, d.items[n].tag) }))
    : []
  if (!items.length && typeof r.title !== 'string') return null
  while (items.length < 3) items.push(d.items[items.length])
  return {
    app: str(r.app, 30, d.app),
    nav: Array.isArray(r.nav) ? r.nav.filter((n): n is string => typeof n === 'string' && !!n.trim()).map((n) => n.trim().slice(0, 16)).slice(0, 4) : d.nav,
    title: str(r.title, 70, d.title),
    subtitle: str(r.subtitle, 160, d.subtitle),
    field: str(r.field, 30, d.field),
    placeholder: str(r.placeholder, 40, d.placeholder),
    primary: str(r.primary, 24, d.primary),
    secondary: str(r.secondary, 24, d.secondary),
    section: str(r.section, 40, d.section),
    items,
    done: str(r.done, 100, d.done)
  }
}

/** One version of a component: specimen markup, its styles, and a minimal usage snippet. */
export interface ComponentVersion {
  html: string
  css: string
  usage: string
  /** What was asked for to get this version. */
  prompt: string
  createdAt: number
}

/** A component in a design system's library, built only from the system's tokens. */
export interface DesignComponent extends ComponentVersion {
  id: string
  designId: string
  name: string
  description: string
  /** Earlier versions, newest first (undo). */
  history: ComponentVersion[]
  updatedAt: number
}

/** A design as edited or proposed, before it has an id. */
export interface DesignDraft {
  name: string
  description: string
  input: DesignInput
}

/** Looks proposed for a description by the guided setup, with the words for its sample screen. */
export interface DesignLooks {
  sample: SampleContent | null
  looks: (DesignDraft & { why: string })[]
}

/** A file of the system in a project's design/ folder, compared with what the system would write now. */
export type DesignFileState = 'missing' | 'current' | 'outdated' | 'edited'

/** A project's copy of a design system's files. */
export interface DesignProjectSync {
  projectId: string
  name: string
  color: string
  folder: string | null
  /** The project follows this system (its chats get DESIGN.md). */
  linked: boolean
  files: { path: string; state: DesignFileState }[]
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
  pinBrand: false,
  neutral: 'brand',
  neutralTint: 0.3,
  neutralSeed: null,
  palette: [],
  darkDepth: 0.35,
  mode: 'both',
  fontSans: 'Inter',
  fontHeading: 'Inter',
  fontMono: 'JetBrains Mono',
  baseSize: 15,
  scale: 1.25,
  headingWeight: 700,
  headingTracking: -0.02,
  bodyLeading: 1.55,
  radius: 8,
  density: 'comfortable',
  shadow: 'soft',
  principles: ['Clear hierarchy: one primary action per view', 'Content first; chrome stays quiet', 'Readable at a glance — generous line height, strong contrast'],
  overrides: { light: {}, dark: {} },
  kit: DEFAULT_KIT,
  sample: null
}

/** Grey families: a hue and how much colour they carry at full tint (null hue = the brand's). */
export const NEUTRALS: Record<NeutralFamily, { label: string; hue: number | null; chroma: number }> = {
  brand: { label: 'Brand', hue: null, chroma: 0.014 },
  slate: { label: 'Slate', hue: 255, chroma: 0.03 },
  zinc: { label: 'Zinc', hue: 285, chroma: 0.012 },
  gray: { label: 'Grey', hue: 0, chroma: 0 },
  stone: { label: 'Stone', hue: 60, chroma: 0.014 },
  sand: { label: 'Sand', hue: 80, chroma: 0.03 },
  olive: { label: 'Olive', hue: 120, chroma: 0.02 },
  custom: { label: 'Palette', hue: null, chroma: 0.03 }
}

export const FONT_CHOICES = {
  sans: ['Inter', 'Geist', 'IBM Plex Sans', 'Manrope', 'DM Sans', 'Plus Jakarta Sans', 'Source Sans 3', 'Nunito Sans', 'Work Sans', 'System UI'],
  heading: ['Inter', 'Geist', 'Space Grotesk', 'Sora', 'Outfit', 'Fraunces', 'Playfair Display', 'IBM Plex Serif', 'Manrope', 'System UI'],
  mono: ['JetBrains Mono', 'Geist Mono', 'IBM Plex Mono', 'Fira Code', 'Source Code Pro', 'System mono']
}

export const SCALES: { value: number; label: string; hint: string }[] = [
  { value: 1.125, label: 'Tight', hint: 'Dense apps; headings barely bigger than text' },
  { value: 1.2, label: 'Balanced', hint: 'Most product UI' },
  { value: 1.25, label: 'Roomy', hint: 'Clear steps between levels' },
  { value: 1.333, label: 'Expressive', hint: 'Content sites, docs' },
  { value: 1.5, label: 'Dramatic', hint: 'Marketing pages, big headlines' }
]

// ─── Colour maths (OKLCH) ─────────────────────────────────────────────────────

export type Lch = { l: number; c: number; h: number }

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
export function scaleFrom(hex: string, chromaOverride?: number, hueOverride?: number): Scale {
  const seed = hexToOklch(hex)
  const out = {} as Scale
  for (const s of STEPS) {
    const l = LIGHTNESS[s]
    const ease = 1 - Math.min(0.85, Math.abs(l - 0.6) * 1.15)
    const c = chromaOverride ?? seed.c * ease
    out[s] = oklchToHex({ l, c, h: hueOverride ?? seed.h })
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
  | 'onPrimarySoft'
  | 'accent'
  | 'onAccent'
  | 'accentSoft'
  | 'onAccentSoft'
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
  onPrimarySoft: 'Text and icons on primary-soft (never on-primary there)',
  accent: 'Highlights that are not actions',
  onAccent: 'Text on a solid accent fill only',
  accentSoft: 'Tinted highlight backgrounds (new, featured)',
  onAccentSoft: 'Text and icons on accent-soft (never on-accent there)',
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
  /** The roles before hand-picked overrides (what "reset" returns to). */
  generated: { light: Roles; dark: Roles }
  type: { name: string; size: number; lineHeight: number; weight: number; tracking: number; font: 'heading' | 'sans' }[]
  radii: Record<'sm' | 'md' | 'lg' | 'xl' | 'full', number>
  space: number[]
  control: { height: number; paddingX: number }
  shadows: Record<'sm' | 'md' | 'lg', string>
  checks: { label: string; mode: 'light' | 'dark'; fg: string; bg: string; ratio: number; need: number }[]
}

export function buildDesign(input: DesignInput): BuiltDesign {
  const brandHex = normalizeHex(input.brand)
  const brandSeed = hexToOklch(brandHex)
  const brand = scaleFrom(brandHex)
  // A pinned brand colour is one of its own scale's steps (the one closest in lightness).
  if (input.pinBrand) {
    const nearest = STEPS.reduce((best, s) => (Math.abs(LIGHTNESS[s] - brandSeed.l) < Math.abs(LIGHTNESS[best] - brandSeed.l) ? s : best), 500 as Step)
    brand[nearest] = brandHex
  }
  const family = NEUTRALS[input.neutral] ?? NEUTRALS.brand
  const seed = input.neutral === 'custom' && input.neutralSeed ? hexToOklch(input.neutralSeed) : null
  // A seed with no measurable hue (pure grey) falls back to the brand's.
  const greyHue = family.hue ?? (seed && seed.c > 0.002 ? seed.h : brandSeed.h)
  const greyChroma = family.chroma * clamp(input.neutralTint, 0, 1) * 2
  // Hue passed directly: a near-grey seed colour would lose it to 8-bit rounding.
  const neutral = scaleFrom(brandHex, greyChroma, greyHue)
  const accent = input.accent ? scaleFrom(input.accent) : null
  // The accent marks highlights, not text: keep the shade closest to the chosen colour.
  const accentL = input.accent ? hexToOklch(input.accent).l : 0
  const accentTone = accent ? accent[STEPS.reduce((best, s) => (Math.abs(LIGHTNESS[s] - accentL) < Math.abs(LIGHTNESS[best] - accentL) ? s : best), 500 as Step)] : null
  const success = scaleFrom(input.success)
  const warning = scaleFrom(input.warning)
  const danger = scaleFrom(input.danger)
  const white = '#ffffff'
  const pinnedShade = (dl: number) => oklchToHex({ ...brandSeed, l: clamp(brandSeed.l + dl, 0.05, 0.98) })

  const lightBg = white
  const lightPrimary = input.pinBrand ? brandHex : legibleStep(brand, lightBg, 600, 4.5)
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
    primaryHover: input.pinBrand ? pinnedShade(-0.07) : shifted(brand, lightPrimary, 1),
    onPrimary: onColor(lightPrimary, white, neutral[950]),
    primarySoft: brand[100],
    onPrimarySoft: legibleStep(brand, brand[100], 700, 4.5),
    accent: accentTone ?? brand[400],
    onAccent: onColor(accentTone ?? brand[400], white, neutral[950]),
    accentSoft: (accent ?? brand)[100],
    onAccentSoft: legibleStep(accent ?? brand, (accent ?? brand)[100], 800, 4.5),
    success: legibleStep(success, lightBg, 600, 4.5),
    warning: legibleStep(warning, lightBg, 700, 4.5),
    danger: legibleStep(danger, lightBg, 600, 4.5),
    onDanger: onColor(legibleStep(danger, lightBg, 600, 4.5), white, neutral[950]),
    focus: brand[500]
  }

  // Dark surfaces step up from a background whose depth is chosen (near black … soft charcoal).
  const depth = 0.15 + clamp(input.darkDepth, 0, 1) * 0.11
  const darkTone = (l: number) => oklchToHex({ l, c: greyChroma * 0.9, h: greyHue })
  const darkBg = darkTone(depth)
  const darkPrimary = input.pinBrand ? brandHex : legibleStep(brand, darkBg, 400, 4.5)
  const dark: Roles = {
    background: darkBg,
    surface: darkTone(depth + 0.035),
    surfaceRaised: darkTone(depth + 0.07),
    border: darkTone(depth + 0.09),
    borderStrong: darkTone(depth + 0.17),
    text: neutral[50],
    textMuted: darkTone(0.8),
    textSubtle: darkTone(0.64),
    primary: darkPrimary,
    primaryHover: input.pinBrand ? pinnedShade(0.07) : shifted(brand, darkPrimary, -1),
    onPrimary: onColor(darkPrimary, white, neutral[950]),
    primarySoft: brand[900],
    onPrimarySoft: legibleStep(brand, brand[900], 200, 4.5),
    accent: accentTone ?? brand[300],
    onAccent: onColor(accentTone ?? brand[300], white, neutral[950]),
    accentSoft: (accent ?? brand)[900],
    onAccentSoft: legibleStep(accent ?? brand, (accent ?? brand)[900], 200, 4.5),
    success: legibleStep(success, darkBg, 400, 4.5),
    warning: legibleStep(warning, darkBg, 400, 4.5),
    danger: legibleStep(danger, darkBg, 400, 4.5),
    onDanger: onColor(legibleStep(danger, darkBg, 400, 4.5), white, neutral[950]),
    focus: brand[400]
  }

  // Hand-picked roles win; text on a hand-picked fill stays readable unless that was picked too.
  const withOverrides = (roles: Roles, picked: Partial<Roles> = {}): Roles => {
    const out = { ...roles }
    for (const [k, v] of Object.entries(picked)) if (k in out && typeof v === 'string' && isHex(v)) out[k as RoleName] = normalizeHex(v)
    if (picked.primary && !picked.onPrimary) out.onPrimary = onColor(out.primary, white, neutral[950])
    if (picked.accent && !picked.onAccent) out.onAccent = onColor(out.accent, white, neutral[950])
    if (picked.danger && !picked.onDanger) out.onDanger = onColor(out.danger, white, neutral[950])
    if (picked.primarySoft && !picked.onPrimarySoft) out.onPrimarySoft = onColor(out.primarySoft, white, neutral[950])
    if (picked.accentSoft && !picked.onAccentSoft) out.onAccentSoft = onColor(out.accentSoft, white, neutral[950])
    return out
  }
  const lightRoles = withOverrides(light, input.overrides?.light)
  const darkRoles = withOverrides(dark, input.overrides?.dark)

  const r = input.scale
  const b = input.baseSize
  const size = (n: number) => Math.round(b * r ** n)
  const hw = clamp(Math.round(input.headingWeight / 50) * 50, 400, 900)
  const step = (by: number) => Math.max(500, hw - by)
  const ht = clamp(input.headingTracking, -0.06, 0.06)
  const bl = clamp(input.bodyLeading, 1.25, 1.9)
  const em = (v: number) => Math.round(v * 1000) / 1000
  const type: BuiltDesign['type'] = [
    { name: 'display', size: size(5), lineHeight: 1.1, weight: hw, tracking: em(ht), font: 'heading' },
    { name: 'h1', size: size(4), lineHeight: 1.15, weight: hw, tracking: em(ht), font: 'heading' },
    { name: 'h2', size: size(3), lineHeight: 1.2, weight: step(50), tracking: em(ht * 0.7), font: 'heading' },
    { name: 'h3', size: size(2), lineHeight: 1.25, weight: step(100), tracking: em(ht * 0.4), font: 'heading' },
    { name: 'h4', size: size(1), lineHeight: 1.3, weight: step(100), tracking: em(ht * 0.2), font: 'heading' },
    { name: 'body', size: b, lineHeight: em(bl), weight: 400, tracking: 0, font: 'sans' },
    { name: 'small', size: Math.max(11, Math.round(b / r)), lineHeight: em(bl - 0.1), weight: 400, tracking: 0, font: 'sans' },
    { name: 'caption', size: Math.max(10, Math.round(b / r ** 2)), lineHeight: em(bl - 0.15), weight: 500, tracking: 0.01, font: 'sans' }
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
    ['light', lightRoles],
    ['dark', darkRoles]
  ] as const) {
    checks.push(
      { label: 'Text on background', mode, fg: roles.text, bg: roles.background, ratio: contrast(roles.text, roles.background), need: 4.5 },
      { label: 'Muted text on surface', mode, fg: roles.textMuted, bg: roles.surface, ratio: contrast(roles.textMuted, roles.surface), need: 4.5 },
      { label: 'Label on primary button', mode, fg: roles.onPrimary, bg: roles.primary, ratio: contrast(roles.onPrimary, roles.primary), need: 4.5 },
      { label: 'Primary link on background', mode, fg: roles.primary, bg: roles.background, ratio: contrast(roles.primary, roles.background), need: 4.5 },
      { label: 'Label on primary-soft', mode, fg: roles.onPrimarySoft, bg: roles.primarySoft, ratio: contrast(roles.onPrimarySoft, roles.primarySoft), need: 4.5 },
      { label: 'Label on accent-soft', mode, fg: roles.onAccentSoft, bg: roles.accentSoft, ratio: contrast(roles.onAccentSoft, roles.accentSoft), need: 4.5 },
      { label: 'Danger on background', mode, fg: roles.danger, bg: roles.background, ratio: contrast(roles.danger, roles.background), need: 4.5 },
      { label: 'Label on danger button', mode, fg: roles.onDanger, bg: roles.danger, ratio: contrast(roles.onDanger, roles.danger), need: 4.5 },
      { label: 'Input border on surface', mode, fg: roles.borderStrong, bg: roles.surface, ratio: contrast(roles.borderStrong, roles.surface), need: 1.5 }
    )
  }

  return {
    scales: { brand, neutral, accent, success, warning, danger },
    roles: { light: lightRoles, dark: darkRoles },
    generated: { light, dark },
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
  for (const t of d.type) lines.push(`  --text-${t.name}: ${t.size}px;`, `  --leading-${t.name}: ${t.lineHeight};`, `  --tracking-${t.name}: ${t.tracking}em;`, `  --weight-${t.name}: ${t.weight};`)
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
  for (const t of d.type)
    lines.push(`  --text-${t.name}: var(--text-${t.name});`, `  --text-${t.name}--line-height: var(--leading-${t.name});`, `  --text-${t.name}--letter-spacing: var(--tracking-${t.name});`, `  --text-${t.name}--font-weight: var(--weight-${t.name});`)
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
        text: Object.fromEntries(d.type.map((t) => [t.name, { size: dim(t.size), lineHeight: { $type: 'number', $value: t.lineHeight }, weight: { $type: 'fontWeight', $value: t.weight }, letterSpacing: { $type: 'dimension', $value: `${t.tracking}em` } }])),
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
export function toDesignMd(system: Pick<DesignSystem, 'name' | 'description' | 'input'>, d = buildDesign(system.input), components: Pick<DesignComponent, 'name' | 'description' | 'html' | 'usage'>[] = []): string {
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
  if (i.pinBrand) lines.push('The brand colour is used exactly for primary actions (`--color-primary`); check the contrast table if you change it.', '')
  lines.push('## Colour roles', '', `| Role | ${modes.map((m) => m[0].toUpperCase() + m.slice(1)).join(' | ')} | Use for |`, `|---|${modes.map(() => '---').join('|')}|---|`)
  for (const k of Object.keys(ROLE_INFO) as RoleName[]) lines.push(`| \`--color-${kebab(k)}\` | ${modes.map((m) => `\`${d.roles[m as 'light' | 'dark'][k]}\``).join(' | ')} | ${ROLE_INFO[k]} |`)
  lines.push('', '## Colour scales', '', `| Step | ${Object.entries(d.scales).filter(([, s]) => s).map(([n]) => n).join(' | ')} |`, `|---|${Object.entries(d.scales).filter(([, s]) => s).map(() => '---').join('|')}|`)
  for (const s of STEPS) lines.push(`| ${s} | ${Object.values(d.scales).filter(Boolean).map((sc) => `\`${sc![s]}\``).join(' | ')} |`)
  lines.push('', 'Use scale steps for illustrations, charts and tinted backgrounds; use roles for interface elements.', '')
  if (i.palette.length) lines.push(`Source palette: ${i.palette.map((c) => `\`${c}\``).join(' ')} — the roles above are derived from it. Use palette colours directly only for illustration and decoration.`, '')
  lines.push('## Typography', '', `- Body: **${i.fontSans}** (\`--font-sans\`), ${i.baseSize}px, line height ${d.type.find((t) => t.name === 'body')!.lineHeight}`, `- Headings: **${i.fontHeading}** (\`--font-heading\`)`, `- Code: **${i.fontMono}** (\`--font-mono\`)`, `- Scale ratio ${i.scale}`, '', '| Style | Size | Line height | Weight | Letter-spacing | Font |', '|---|---|---|---|---|---|')
  for (const t of d.type) lines.push(`| ${t.name} | ${t.size}px | ${t.lineHeight} | ${t.weight} | ${t.tracking}em | ${t.font} |`)
  lines.push('', 'Limit a screen to three type sizes plus headings. Use weight and colour (text / muted / subtle) for hierarchy before size.', '')
  lines.push('## Space, shape and elevation', '', `- Spacing scale (\`--space-N\`): ${d.space.map((v) => `${v}`).join(', ')} px — ${i.density} density`, `- Controls (buttons, inputs): ${d.control.height}px tall, ${d.control.paddingX}px horizontal padding`, `- Radius: sm ${d.radii.sm}px · md ${d.radii.md}px (default) · lg ${d.radii.lg}px (cards, dialogs) · xl ${d.radii.xl}px · full for pills`, `- Shadows: ${i.shadow === 'none' ? 'none — separate layers with borders and surface colour' : `sm (\`${d.shadows.sm}\`) for raised controls, md for menus and popovers, lg for dialogs`}`, '')
  lines.push(
    '## Components',
    '',
    ...kitMarkdown(i.kit),
    '- **Colour pairs:** text on a fill uses that fill’s own on- role — `--color-on-primary` only on `--color-primary`, `--color-on-primary-soft` on `--color-primary-soft`, `--color-on-accent` only on `--color-accent`, `--color-on-accent-soft` on `--color-accent-soft`. Mixing them (e.g. on-accent on accent-soft) can be unreadable in one of the themes.',
    i.accent
      ? '- **Accent:** `--color-accent` (on it, `--color-on-accent`) and `--color-accent-soft` mark things worth noticing that are not actions — "new" badges, featured items, highlights in charts and progress, illustrations. Never use the accent for buttons or links.'
      : '- **Accent:** this system has no separate accent; `--color-accent` is a lighter brand shade for highlights. Keep actions on `--color-primary`.',
    ''
  )
  const families = [...new Set([i.fontSans, i.fontHeading, i.fontMono])].filter((f) => !f.startsWith('System'))
  if (families.length)
    lines.push(
      '## Fonts',
      '',
      'Load the fonts before the tokens, e.g. from Google Fonts:',
      '',
      '```html',
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families.map((f) => `family=${f.replace(/ /g, '+')}:wght@400;500;600;700`).join('&')}&display=swap" />`,
      '```',
      '',
      'Or self-host them (for example with the @fontsource packages). The stacks fall back to system fonts until they load.',
      ''
    )
  lines.push('## Contrast checks', '', '| Pair | Theme | Ratio | Needs | |', '|---|---|---|---|---|')
  for (const c of d.checks.filter((x) => modes.includes(x.mode))) lines.push(`| ${c.label} | ${c.mode} | ${c.ratio.toFixed(2)} | ${c.need} | ${c.ratio >= c.need ? 'pass' : '**fails**'} |`)
  if (components.length) {
    lines.push(
      '',
      '## Component library',
      '',
      'Ready-made components built from these tokens and the built-in ones. Their styles are in `components.css` (load it after `tokens.css`); each has a page with every variant in `components/`. Reuse them instead of restyling the same thing.',
      ''
    )
    for (const c of components) {
      lines.push(`### ${c.name}`, '')
      if (c.description) lines.push(c.description, '')
      lines.push('```html', c.usage.trim() || c.html.trim().slice(0, 1200), '```', '')
    }
  }
  lines.push('', ...shadcnMarkdown())
  lines.push('## Files', '', '- `DESIGN.md` — this guide', '- `tokens.css` — CSS variables for both themes', '- `tailwind.css` — Tailwind v4 theme mapped to the tokens', '- `tokens.json` — the same tokens in the W3C design-tokens format')
  lines.push('- `components.css` — styles for the built-in components' + (components.length ? ' and the component library' : ''), '- `components/*.html` — every component with its variants', '- `shadcn/` — the theme and starter components for shadcn/ui projects')
  lines.push('')
  return lines.join('\n')
}

/** Every export file, by name (components get a page each under components/). */
export function designFiles(system: Pick<DesignSystem, 'name' | 'description' | 'input'>, components: Pick<DesignComponent, 'name' | 'description' | 'html' | 'css' | 'usage'>[] = []): Record<string, string> {
  const d = buildDesign(system.input)
  const files: Record<string, string> = { 'DESIGN.md': toDesignMd(system, d, components), 'tokens.css': toCss(system.input, d), 'tailwind.css': toTailwind(system.input, d), 'tokens.json': toTokensJson(system.input, d) }
  files['components.css'] = [kitCss(system.input.kit), ...components.map((c) => `/* ── ${c.name} ── */\n${c.css.trim()}\n`)].join('\n')
  const page = { tokens: '../tokens.css', components: '../components.css' }
  for (const n of KIT_NAMES) files[`components/ds-${n}.html`] = componentDocument(system.input, { html: kitSpecimen(n), css: '' }, { ...page, title: `${system.name} — ${KIT[n].label}` })
  for (const c of components) files[`components/${componentSlug(c.name)}.html`] = componentDocument(system.input, c, { ...page, title: `${system.name} — ${c.name}` })
  for (const [path, content] of Object.entries(shadcnFiles(system.input, d))) files[`shadcn/${path}`] = content
  return files
}

// ─── Component library ────────────────────────────────────────────────────────

export const componentSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'component'

/** Markup from a model: no scripts, embeds, event handlers or javascript: links (components are HTML and CSS only). */
export function sanitizeComponentHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|style|template)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|style)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    .trim()
}

/** Styles from a model: no imports, external URLs or attempts to close the style element. */
export function sanitizeComponentCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:)[^)]*\1\s*\)/gi, 'none')
    .replace(/<\/?\s*style[^>]*>/gi, '')
    .trim()
}

/**
 * CSS variables a component uses that the system doesn't define (and the component doesn't set itself).
 * A missing variable silently drops the whole declaration — e.g. an unknown weight in a `font:` shorthand.
 */
export function unknownTokens(css: string, html: string, input: DesignInput): string[] {
  const defined = new Set([...toCss(input).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))
  const styles = [css, ...[...html.matchAll(/style\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => m[2] ?? m[3] ?? '')]
  for (const text of styles) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
  const out = new Set<string>()
  // Only uses without a fallback: var(--x, 4px) still works when --x is missing.
  for (const text of styles) for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) if (!defined.has(m[1])) out.add(m[1])
  return [...out]
}

const WEIGHT_NAMES: Record<string, number> = { thin: 100, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, 'semi-bold': 600, bold: 700, extrabold: 800, 'extra-bold': 800, black: 900, heavy: 900 }

/** Models often invent named weight tokens (--weight-bold); the system has per-style weights, so use the number. */
export function repairTokens(css: string): string {
  return css.replace(/var\(\s*--(?:font-)?weight-([a-z-]+)\s*\)/g, (m, name: string) => (WEIGHT_NAMES[name] ? String(WEIGHT_NAMES[name]) : m))
}

/** Colours written as literals instead of tokens (the component would ignore theme and system changes). */
export function componentLint(css: string, html: string): string[] {
  const found = new Set<string>()
  const scan = (text: string) => {
    // Fallbacks inside var(--x, …) are fine; strip them before looking.
    const body = text.replace(/var\([^()]*(\([^()]*\))?[^()]*\)/g, '')
    for (const m of body.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\([^)]*\)/gi)) found.add(m[0])
  }
  scan(css)
  for (const m of html.matchAll(/style\s*=\s*("([^"]*)"|'([^']*)')/gi)) scan(m[2] ?? m[3] ?? '')
  return [...found]
}

export const SPECIMEN_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{padding:28px;background:var(--color-background);color:var(--color-text);font-family:var(--font-sans);font-size:var(--text-body);line-height:var(--leading-body);-webkit-font-smoothing:antialiased}
.specimen{display:grid;gap:28px}
.specimen-section{display:grid;gap:12px}
.specimen-label{font-size:var(--text-caption);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--color-text-subtle)}
.specimen-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}`

/**
 * A full HTML page showing a component: tokens, specimen layout, the component's styles and markup.
 * For the live preview the stylesheets are inlined; exported pages link to tokens.css / components.css.
 */
export function componentDocument(
  input: DesignInput,
  comp: Pick<DesignComponent, 'html' | 'css'>,
  opts: { theme?: 'light' | 'dark'; tokens?: string; components?: string; fontCss?: string; title?: string } = {}
): string {
  const theme = opts.theme ?? (input.mode === 'light' ? 'light' : 'dark')
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    opts.title ? `<title>${opts.title.replace(/</g, '&lt;')}</title>` : '',
    opts.fontCss ? `<style>${opts.fontCss}</style>` : '',
    opts.tokens ? `<link rel="stylesheet" href="${opts.tokens}">` : `<style>${toCss(input)}</style>`,
    `<style>${SPECIMEN_CSS}</style>`,
    opts.components ? `<link rel="stylesheet" href="${opts.components}">` : `<style data-kit>${kitCss(input.kit)}</style>\n<style data-component>${sanitizeComponentCss(comp.css)}</style>`
  ]
  return `<!doctype html>\n<html data-theme="${theme}">\n<head>\n${head.filter(Boolean).join('\n')}\n</head>\n<body>\n${sanitizeComponentHtml(comp.html)}\n</body>\n</html>\n`
}

/** Reads a model's component answer (the NAME / DESCRIPTION / === CSS === … format; code fences tolerated). */
export function parseComponentAnswer(text: string, opts: { partial?: boolean } = {}): { name: string; description: string; css: string; html: string; usage: string } | null {
  const section = (label: string) => {
    const m = new RegExp(`===\\s*${label}\\s*===\\s*\\n([\\s\\S]*?)(?=\\n\\s*===\\s*[A-Z]+\\s*===|$)`, 'i').exec(text)
    return m ? m[1].replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim() : ''
  }
  const line = (label: string) => new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(text)?.[1].trim() ?? ''
  const html = section('HTML')
  const css = section('CSS')
  // A change to one part may touch only markup (no CSS).
  if (!html || (!css && !opts.partial)) return null
  return { name: line('NAME').replace(/^["'*]+|["'*]+$/g, '').slice(0, 60), description: line('DESCRIPTION').slice(0, 300), css, html, usage: section('USAGE') }
}

/** The model's instructions for writing or refining a component in this system. */
export function componentPrompt(system: Pick<DesignSystem, 'name' | 'description' | 'input'>): string {
  const d = buildDesign(system.input)
  const roles = (Object.keys(ROLE_INFO) as RoleName[]).map((k) => `--color-${kebab(k)} (${ROLE_INFO[k]})`).join('\n')
  return `You build UI components for the "${system.name}" design system${system.description ? ` — ${system.description}` : ''}.
${system.input.principles.length ? `Principles: ${system.input.principles.join('; ')}.\n` : ''}
Write each component as plain HTML and CSS (no JavaScript, no frameworks, no external assets). Answer in exactly this format, with nothing before or after it:

NAME: short component name
DESCRIPTION: one sentence on what it is for
=== CSS ===
(the component's styles)
=== HTML ===
(the specimen page)
=== USAGE ===
(the minimal markup to copy)

Rules:
- Use ONLY these CSS variables for colour, type, spacing, radius and shadow — never hex, rgb or named colours (transparent and currentColor are fine; color-mix() of variables is fine):
${roles}
--font-sans, --font-heading, --font-mono
--text-{display,h1,h2,h3,h4,body,small,caption} with --leading-*, --weight-*, --tracking-* of the same names (e.g. --weight-h1, --weight-body; there are no --weight-bold-style tokens — use 400-800 for other weights)
--space-0 … --space-12 (${d.space.slice(1, 13).join(', ')} px), --radius-{sm,md,lg,xl,full}, --shadow-{sm,md,lg}, --control-height (${d.control.height}px)
- Built-in components already exist (their CSS is loaded on every page). Reuse them inside your component instead of styling your own buttons, fields, cards, badges, tabs, alerts or menus, and never redefine their ds- classes:
${KIT_NAMES.map((n) => `  ${KIT[n].label}: ${KIT_USAGE[n]}`).join('\n')}
- Prefix every class with c- and the component name (e.g. .c-button, .c-button--primary, .c-button__icon). Variants are modifier classes; states use :hover, :focus-visible, :disabled / [aria-*] and also static classes (.is-hover, .is-focus, .is-disabled, .is-loading) so they can be shown side by side.
- Text on a fill uses that fill's own on- role: --color-on-primary only on --color-primary, --color-on-primary-soft on --color-primary-soft, --color-on-accent only on --color-accent, --color-on-accent-soft on --color-accent-soft, --color-on-danger on --color-danger. Never mix them — e.g. on-accent on accent-soft is unreadable in dark mode.
- Focus states are visible: 2px outline in --color-focus with 2px offset.
- Accessible markup: real buttons and labels, aria attributes where needed, text contrast from the role pairs above.
- "html" is a specimen page: wrap everything in <div class="specimen">, and group variants in <section class="specimen-section"> each starting with <div class="specimen-label">Variant name</div> and the examples in <div class="specimen-row">. Show every variant, size and state, with realistic content.
- "usage" is the minimal markup for the most common case (what a developer would copy).
- Icons: inline <svg> with stroke="currentColor", 16-20px.
- Work in both light and dark themes (roles switch automatically).`
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
    pinBrand: typeof raw.pinBrand === 'boolean' ? raw.pinBrand : (base.pinBrand ?? false),
    neutral: pick(raw.neutral, Object.keys(NEUTRALS) as NeutralFamily[], base.neutral ?? 'brand'),
    neutralTint: num(raw.neutralTint, 0, 1, base.neutralTint),
    neutralSeed: raw.neutralSeed === null ? null : typeof raw.neutralSeed === 'string' && isHex(raw.neutralSeed) ? normalizeHex(raw.neutralSeed) : (base.neutralSeed ?? null),
    palette: Array.isArray(raw.palette) ? [...new Set(raw.palette.filter((c): c is string => typeof c === 'string' && isHex(c)).map(normalizeHex))].slice(0, MAX_PALETTE) : (base.palette ?? []),
    darkDepth: num(raw.darkDepth, 0, 1, base.darkDepth ?? DEFAULT_DESIGN.darkDepth),
    mode: pick(raw.mode, ['dark', 'light', 'both'] as const, base.mode),
    fontSans: font(raw.fontSans, base.fontSans),
    fontHeading: font(raw.fontHeading, base.fontHeading),
    fontMono: font(raw.fontMono, base.fontMono),
    baseSize: Math.round(num(raw.baseSize, 12, 20, base.baseSize)),
    scale: num(raw.scale, 1.067, 1.618, base.scale),
    headingWeight: Math.round(num(raw.headingWeight, 400, 900, base.headingWeight ?? DEFAULT_DESIGN.headingWeight) / 50) * 50,
    headingTracking: num(raw.headingTracking, -0.06, 0.06, base.headingTracking ?? DEFAULT_DESIGN.headingTracking),
    bodyLeading: num(raw.bodyLeading, 1.25, 1.9, base.bodyLeading ?? DEFAULT_DESIGN.bodyLeading),
    radius: Math.round(num(raw.radius, 0, 32, base.radius)),
    density: pick(raw.density, ['compact', 'comfortable', 'spacious'] as const, base.density),
    shadow: pick(raw.shadow, ['none', 'soft', 'strong'] as const, base.shadow),
    principles: Array.isArray(raw.principles) ? raw.principles.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim()).slice(0, 8) : base.principles,
    overrides: cleanOverrides(raw.overrides, base.overrides),
    kit: sanitizeKit(raw.kit, base.kit ?? DEFAULT_KIT),
    sample: raw.sample === null ? null : (sanitizeSample(raw.sample) ?? base.sample ?? null)
  }
}

function cleanOverrides(v: unknown, fallback: DesignInput['overrides'] | undefined): DesignInput['overrides'] {
  if (!v || typeof v !== 'object') return fallback ?? { light: {}, dark: {} }
  const side = (o: unknown): Partial<Roles> => {
    if (!o || typeof o !== 'object') return {}
    const out: Partial<Roles> = {}
    for (const [k, c] of Object.entries(o as Record<string, unknown>)) if (k in ROLE_INFO && typeof c === 'string' && isHex(c)) out[k as RoleName] = normalizeHex(c)
    return out
  }
  const o = v as { light?: unknown; dark?: unknown }
  return { light: side(o.light), dark: side(o.dark) }
}

/** Starting points: each a complete look to adjust from. */
export const PRESETS: { id: string; name: string; blurb: string; input: Partial<DesignInput> }[] = [
  {
    id: 'precise',
    name: 'Precise',
    blurb: 'Dense, dark-first tool for power users. Small type, tight corners, quiet greys.',
    input: { brand: '#5e6ad2', neutral: 'zinc', neutralTint: 0.4, darkDepth: 0.15, mode: 'both', fontSans: 'Inter', fontHeading: 'Inter', fontMono: 'JetBrains Mono', baseSize: 14, scale: 1.2, headingWeight: 600, headingTracking: -0.02, bodyLeading: 1.5, radius: 6, density: 'compact', shadow: 'soft', principles: ['Keyboard first; every action has a shortcut', 'Dense but calm — spacing does the grouping, not boxes', 'Colour only for state and selection'] }
  },
  {
    id: 'friendly',
    name: 'Friendly',
    blurb: 'Soft, rounded and light-first. Warm greys, generous spacing.',
    input: { brand: '#ff6b4a', accent: '#7c5cff', neutral: 'sand', neutralTint: 0.5, darkDepth: 0.5, mode: 'light', fontSans: 'Nunito Sans', fontHeading: 'Outfit', fontMono: 'Fira Code', baseSize: 16, scale: 1.25, headingWeight: 700, headingTracking: -0.01, bodyLeading: 1.65, radius: 14, density: 'spacious', shadow: 'soft', principles: ['Talk like a person, never like a system', 'One idea per screen', 'Celebrate progress with colour and motion'] }
  },
  {
    id: 'fintech',
    name: 'Trusted',
    blurb: 'Calm and credible for money and data. Deep navy, crisp type, restrained colour.',
    input: { brand: '#1d4ed8', accent: '#0ea5a4', neutral: 'slate', neutralTint: 0.45, darkDepth: 0.3, mode: 'both', fontSans: 'IBM Plex Sans', fontHeading: 'IBM Plex Sans', fontMono: 'IBM Plex Mono', baseSize: 15, scale: 1.2, headingWeight: 600, headingTracking: -0.01, bodyLeading: 1.55, radius: 8, density: 'comfortable', shadow: 'soft', principles: ['Numbers first: tabular figures, right-aligned', 'Every state is explicit — pending, done, failed', 'Never surprise: confirm anything that moves money'] }
  },
  {
    id: 'editorial',
    name: 'Editorial',
    blurb: 'Reading-first, with a serif voice for headlines and lots of white space.',
    input: { brand: '#9f1239', neutral: 'stone', neutralTint: 0.4, darkDepth: 0.4, mode: 'light', fontSans: 'Source Sans 3', fontHeading: 'Fraunces', fontMono: 'IBM Plex Mono', baseSize: 17, scale: 1.333, headingWeight: 600, headingTracking: -0.015, bodyLeading: 1.7, radius: 4, density: 'spacious', shadow: 'none', principles: ['Typography carries the hierarchy', 'Measure under 72 characters', 'Ornament only where it helps reading'] }
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    blurb: 'Raw and loud: hard edges, heavy type, no shadows, high contrast.',
    input: { brand: '#111111', accent: '#ffe600', pinBrand: true, neutral: 'gray', neutralTint: 0, darkDepth: 0, mode: 'light', fontSans: 'Space Grotesk', fontHeading: 'Space Grotesk', fontMono: 'JetBrains Mono', baseSize: 16, scale: 1.5, headingWeight: 800, headingTracking: -0.04, bodyLeading: 1.45, radius: 0, density: 'comfortable', shadow: 'none', principles: ['Borders, not shadows', 'Big type, few words', 'One loud colour, used sparingly'] }
  },
  {
    id: 'playful',
    name: 'Playful',
    blurb: 'Bright, bouncy colour and round shapes for consumer and education apps.',
    input: { brand: '#8b5cf6', accent: '#f59e0b', neutral: 'brand', neutralTint: 0.6, darkDepth: 0.55, mode: 'both', fontSans: 'Plus Jakarta Sans', fontHeading: 'Sora', fontMono: 'Fira Code', baseSize: 16, scale: 1.25, headingWeight: 800, headingTracking: -0.02, bodyLeading: 1.6, radius: 16, density: 'spacious', shadow: 'strong', principles: ['Reward every action', 'Colour is information and delight', 'Big, thumb-friendly targets'] }
  },
  {
    id: 'terminal',
    name: 'Terminal',
    blurb: 'Developer tool in the dark: mono accents, green signal, almost no radius.',
    input: { brand: '#22c55e', accent: '#38bdf8', neutral: 'zinc', neutralTint: 0.2, darkDepth: 0.05, mode: 'dark', fontSans: 'Geist', fontHeading: 'Geist', fontMono: 'Geist Mono', baseSize: 14, scale: 1.2, headingWeight: 600, headingTracking: -0.01, bodyLeading: 1.5, radius: 3, density: 'compact', shadow: 'none', principles: ['Show the raw data; explain it beside', 'Logs and code are first-class content', 'Status colours mean something — never decorate with them'] }
  },
  {
    id: 'luxe',
    name: 'Luxe',
    blurb: 'Quiet premium feel: dark charcoal, gold accent, elegant serif headings.',
    input: { brand: '#c8a35b', accent: '#c8a35b', pinBrand: true, neutral: 'stone', neutralTint: 0.3, darkDepth: 0.6, mode: 'dark', fontSans: 'Manrope', fontHeading: 'Playfair Display', fontMono: 'IBM Plex Mono', baseSize: 15, scale: 1.333, headingWeight: 600, headingTracking: 0, bodyLeading: 1.65, radius: 2, density: 'spacious', shadow: 'soft', principles: ['Restraint: fewer elements, more space', 'Gold marks only what matters most', 'Photography and type do the selling'] }
  }
]

// ─── Palettes (Coolors and friends) ───────────────────────────────────────────

export const MAX_PALETTE = 10

/**
 * Colours from pasted text: a Coolors link (coolors.co/54494b-f1f7ed-b33951), a Coolors export
 * (CSS variables, JSON, arrays, SCSS) or any list of hex / rgb() colours. Order kept, duplicates dropped.
 */
export function parsePalette(text: string): string[] {
  const out: string[] = []
  const add = (hex: string) => {
    const h = normalizeHex(hex.slice(0, hex.startsWith('#') ? 7 : 6))
    if (!out.includes(h)) out.push(h)
  }
  // Coolors links carry the palette in the path: /54494b-f1f7ed-b33951 or /palette/54494b-…
  const link = /coolors\.co\/(?:palette\/)?([0-9a-f]{6}(?:-[0-9a-f]{6})+)/i.exec(text)
  if (link) {
    link[1].split('-').forEach(add)
    return out.slice(0, MAX_PALETTE)
  }
  const re = /(?:#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])|(?<![0-9a-z#])([0-9a-f]{6})(?![0-9a-z])|rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})[^)]*\))/gi
  for (const m of text.matchAll(re)) {
    if (m[1]) add(m[1].length === 3 ? normalizeHex(m[1]) : `#${m[1]}`)
    else if (m[2]) {
      // A bare six-letter word could be English ("decade", "facade"); only count it with a digit in it.
      if (/\d/.test(m[2])) add(m[2])
    } else add(rgbToHex([Number(m[3]) / 255, Number(m[4]) / 255, Number(m[5]) / 255]))
  }
  return out.slice(0, MAX_PALETTE)
}

/** A Coolors link for a palette, to keep generating there. */
export function coolorsUrl(colors: string[]): string {
  return `https://coolors.co/${colors.map((c) => normalizeHex(c).slice(1)).join('-')}`
}

/** The palette to send to Coolors: the imported one, or the system's own key colours. */
export function systemPalette(input: DesignInput, d = buildDesign(input)): string[] {
  if (input.palette.length) return input.palette
  return [d.scales.neutral[900], input.brand, ...(input.accent ? [input.accent] : []), d.scales.neutral[100], input.success]
}

/** What a palette colour can be used as in the system. */
export type PaletteUse = 'brand' | 'accent' | 'greys' | 'lightBackground' | 'darkBackground' | 'lightText'

/** Apply one palette colour to a role (keeping the rest of the system). */
export function applyPaletteColor(input: DesignInput, color: string, use: PaletteUse): Partial<DesignInput> {
  const hex = normalizeHex(color)
  switch (use) {
    case 'brand':
      return { brand: hex, pinBrand: true }
    case 'accent':
      return { accent: hex }
    case 'greys': {
      const { c } = hexToOklch(hex)
      return { neutral: 'custom', neutralSeed: hex, neutralTint: c < 0.002 ? 0 : clamp(Math.round((c / 0.06) * 20) / 20, 0.15, 1) }
    }
    case 'lightBackground':
      return { overrides: { ...input.overrides, light: { ...input.overrides.light, background: hex } } }
    case 'darkBackground':
      return { overrides: { ...input.overrides, dark: { ...input.overrides.dark, background: hex } } }
    case 'lightText':
      return { overrides: { ...input.overrides, light: { ...input.overrides.light, text: hex } } }
  }
}

/**
 * Turn a palette into colour settings: the most vivid colour becomes the brand, a second vivid colour
 * with a different hue the accent. Near-whites and near-blacks become the theme backgrounds, and the
 * greys take their hue from the light background (else the most tinted near-grey), so surfaces match it.
 * Hand-picked role colours are cleared, since they were chosen for the old colours.
 */
export function paletteToDesign(colors: string[], input: DesignInput): Partial<DesignInput> {
  const palette = [...new Set(colors.map(normalizeHex))].slice(0, MAX_PALETTE)
  if (!palette.length) return {}
  const info = palette.map((hex) => ({ hex, ...hexToOklch(hex) }))
  // Vivid colours, best first: chroma, nudged towards a usable mid lightness.
  const score = (c: (typeof info)[number]) => c.c - Math.abs(c.l - 0.55) * 0.08
  const vivid = info.filter((c) => c.c >= 0.05).sort((a, b) => score(b) - score(a))
  const brand = vivid[0] ?? [...info].sort((a, b) => b.c - a.c || Math.abs(a.l - 0.5) - Math.abs(b.l - 0.5))[0]
  const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
  const accent = vivid.find((c) => c !== brand && hueGap(c.h, brand.h) >= 25) ?? null
  const rest = info.filter((c) => c !== brand && c !== accent && c.c < 0.06)
  const lightBg = rest.filter((c) => c.l >= 0.93).sort((a, b) => b.l - a.l)[0]
  const darkBg = rest.filter((c) => c.l <= 0.28).sort((a, b) => a.l - b.l)[0]
  const greySeed = lightBg ?? [...rest].sort((a, b) => b.c - a.c)[0]

  let out: Partial<DesignInput> = { palette, brand: brand.hex, accent: accent?.hex ?? null, overrides: { light: {}, dark: {} } }
  if (greySeed) out = { ...out, ...applyPaletteColor(input, greySeed.hex, 'greys') }
  const next = { ...input, ...out } as DesignInput
  if (lightBg) next.overrides = { ...next.overrides, light: { background: lightBg.hex } }
  if (darkBg) next.overrides = { ...next.overrides, dark: { background: darkBg.hex } }
  out.overrides = next.overrides
  // Use the brand colour exactly wherever it stays readable as a link; elsewhere Cloth picks the shade.
  const pinned = buildDesign({ ...next, pinBrand: true })
  out.pinBrand = !pinned.checks.some((c) => c.fg === brand.hex && c.ratio < c.need)
  if (!out.pinBrand) {
    for (const mode of ['light', 'dark'] as const) {
      if (contrast(brand.hex, pinned.roles[mode].background) >= 4.5) next.overrides = { ...next.overrides, [mode]: { ...next.overrides[mode], primary: brand.hex } }
    }
    out.overrides = next.overrides
  }
  return out
}
