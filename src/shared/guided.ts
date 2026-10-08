// The plain choices behind the guided setup and the Simple editor. Each one writes several of a design's
// settings at once, so someone who isn't a designer picks a feel instead of a type scale.
import { DEFAULT_KIT, type KitSettings } from './kit'
import { hexToOklch, oklchToHex, type DesignInput } from './design'

export const SWATCHES: { color: string; name: string }[] = [
  { color: '#059669', name: 'Emerald' },
  { color: '#5f8f6f', name: 'Sage' },
  { color: '#0f8a84', name: 'Teal' },
  { color: '#2f6f9f', name: 'Lake' },
  { color: '#4f46e5', name: 'Indigo' },
  { color: '#7a4a78', name: 'Plum' },
  { color: '#c2456b', name: 'Rose' },
  { color: '#c46a45', name: 'Clay' },
  { color: '#c98f1e', name: 'Marigold' },
  { color: '#2b2f3a', name: 'Ink' }
]

export type TextFeel = 'clean' | 'friendly' | 'modern' | 'classic' | 'elegant' | 'technical'

export const TEXT_FEELS: Record<TextFeel, { label: string; hint: string; fontHeading: string; fontSans: string; fontMono: string; headingWeight: number; headingTracking: number }> = {
  clean: { label: 'Clean', hint: 'Neutral and modern', fontHeading: 'Inter', fontSans: 'Inter', fontMono: 'JetBrains Mono', headingWeight: 650, headingTracking: -0.02 },
  friendly: { label: 'Friendly', hint: 'Rounded and warm', fontHeading: 'Outfit', fontSans: 'Nunito Sans', fontMono: 'Fira Code', headingWeight: 700, headingTracking: -0.01 },
  modern: { label: 'Bold', hint: 'Confident, geometric headlines', fontHeading: 'Sora', fontSans: 'Plus Jakarta Sans', fontMono: 'Fira Code', headingWeight: 700, headingTracking: -0.025 },
  classic: { label: 'Classic', hint: 'Serif headings, easy reading', fontHeading: 'Fraunces', fontSans: 'Source Sans 3', fontMono: 'IBM Plex Mono', headingWeight: 600, headingTracking: -0.015 },
  elegant: { label: 'Elegant', hint: 'Refined and quiet', fontHeading: 'Playfair Display', fontSans: 'Manrope', fontMono: 'IBM Plex Mono', headingWeight: 600, headingTracking: 0 },
  technical: { label: 'Technical', hint: 'Precise, a little geeky', fontHeading: 'Space Grotesk', fontSans: 'IBM Plex Sans', fontMono: 'IBM Plex Mono', headingWeight: 600, headingTracking: -0.02 }
}
export const TEXT_FEEL_IDS = Object.keys(TEXT_FEELS) as TextFeel[]

/** The feel whose fonts the design uses, or null when its fonts were picked by hand. */
export function textFeelOf(input: DesignInput): TextFeel | null {
  return TEXT_FEEL_IDS.find((id) => TEXT_FEELS[id].fontHeading === input.fontHeading && TEXT_FEELS[id].fontSans === input.fontSans) ?? null
}

export function withTextFeel(input: DesignInput, id: TextFeel): DesignInput {
  const { label: _l, hint: _h, ...fonts } = TEXT_FEELS[id]
  return { ...input, ...fonts }
}

export type Corners = 'sharp' | 'soft' | 'rounded' | 'pill'

export const CORNERS: Record<Corners, { label: string; short: string; radius: number }> = {
  sharp: { label: 'Sharp', short: 'Sharp', radius: 2 },
  soft: { label: 'Slightly rounded', short: 'Soft', radius: 6 },
  rounded: { label: 'Rounded', short: 'Round', radius: 12 },
  pill: { label: 'Round buttons', short: 'Pill', radius: 12 }
}
export const CORNER_IDS = Object.keys(CORNERS) as Corners[]

export function cornersOf(input: DesignInput): Corners {
  if (input.kit.button.radius === 'full') return 'pill'
  return input.radius <= 3 ? 'sharp' : input.radius <= 8 ? 'soft' : 'rounded'
}

export function withCorners(input: DesignInput, id: Corners): DesignInput {
  const pill = id === 'pill'
  // Buttons follow the base radius unless they're pills; a pill system also rounds its badges.
  const button: KitSettings['button'] = { ...input.kit.button, radius: pill ? 'full' : input.kit.button.radius === 'full' ? DEFAULT_KIT.button.radius : input.kit.button.radius }
  const badge: KitSettings['badge'] = { ...input.kit.badge, radius: pill ? 'full' : input.kit.badge.radius }
  return { ...input, radius: CORNERS[id].radius, kit: { ...input.kit, button, badge } }
}

export const SPACINGS: Record<DesignInput['density'], string> = { compact: 'Compact', comfortable: 'Comfortable', spacious: 'Roomy' }

export const MODES: Record<DesignInput['mode'], { label: string; hint: string }> = {
  light: { label: 'Light', hint: 'Dark text on a light background' },
  dark: { label: 'Dark', hint: 'Light text on a dark background' },
  both: { label: 'Both', hint: "Follows each person's device setting" }
}

/** The same design with a nearby colour, the next text feel and different corners: "try a variation". */
export function variation(input: DesignInput, seed = Math.random()): DesignInput {
  const lch = hexToOklch(input.brand)
  const shift = (seed < 0.5 ? -1 : 1) * (18 + Math.round(seed * 20))
  const brand = oklchToHex({ ...lch, h: (lch.h + shift + 360) % 360 })
  const feel = textFeelOf(input)
  const nextFeel = TEXT_FEEL_IDS[(TEXT_FEEL_IDS.indexOf(feel ?? 'clean') + 1 + Math.floor(seed * 2)) % TEXT_FEEL_IDS.length]
  const corners = CORNER_IDS[(CORNER_IDS.indexOf(cornersOf(input)) + 1) % CORNER_IDS.length]
  return withCorners(withTextFeel({ ...input, brand }, nextFeel), corners)
}
