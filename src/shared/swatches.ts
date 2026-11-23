/**
 * Swatches: pages a chat makes (a report, a dashboard, a diagram, a small app) that open in Cloth and, when you
 * turn on network sharing, on any phone or computer on the same network, by a link nobody can guess.
 */
/** mockup: a set of boards (screens) the agent designs, shown on a canvas with Play, Tweaks and PNG export. */
export type SwatchFormat = 'html' | 'markdown' | 'svg' | 'mockup'

export interface Swatch {
  id: string
  title: string
  format: SwatchFormat
  /** The chat that made it (null when made elsewhere, or that chat was deleted). */
  sessionId: string | null
  createdAt: number
  updatedAt: number
  /** Goes up by one each time the agent republishes it. */
  version: number
  bytes: number
  /** A mockup's boards (its latest version). */
  boards?: number
}

export interface SwatchLink {
  /** Shown next to the link: "This PC", "Wi-Fi", "Tailscale" … */
  label: string
  url: string
  kind: 'local' | 'lan' | 'tailscale' | 'other'
}

export interface SwatchServerStatus {
  running: boolean
  port: number
  /** Reachable from other devices (else only from this PC). */
  network: boolean
  error: string | null
}

/** What a publish_swatch or publish_mockup call left on the chat's tool card. */
export interface SwatchTrace {
  id: string
  title: string
  version: number
  format: SwatchFormat
  /** A mockup's boards, by name. */
  boards?: { name: string; title: string }[]
}

/** A control a board declares: the canvas's Tweaks panel shows it, and the board reads the value from `window.tweaks`. */
export interface MockupTweak {
  key: string
  label: string
  kind: 'enum' | 'boolean' | 'range' | 'color'
  options?: string[]
  min?: number
  max?: number
  step?: number
  default: string | number | boolean
}

/** One board (screen) of a mockup. */
export interface MockupBoard {
  /** Short slug, unique in the mockup: how the agent and links name it. */
  name: string
  title: string
  width: number
  height: number
  /** It has working controls or animation: the canvas offers Play. */
  interactive: boolean
  tweaks: MockupTweak[]
}

/** A mockup at one version, without the boards' markup. */
export interface MockupInfo {
  id: string
  version: number
  /** Every version still kept, oldest first. */
  versions: number[]
  boards: MockupBoard[]
  /** The design system its boards get as CSS variables (from the chat's project), if any. */
  design: string | null
}

export const BOARD_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Board sizes the agent may use, in CSS px. */
export const BOARD_MIN = 200
export const BOARD_MAX = 4000

/** A board's tweak values with the defaults filled in, from what the canvas holds. */
export function tweakValues(board: Pick<MockupBoard, 'tweaks'>, set: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const t of board.tweaks) {
    const v = set[t.key]
    out[t.key] = typeof v === typeof t.default && (t.kind !== 'enum' || (t.options ?? []).includes(v as string)) ? (v as string | number | boolean) : t.default
  }
  return out
}

export type SwatchEvent = { type: 'changed'; id: string | null } | { type: 'status'; status: SwatchServerStatus } | { type: 'thumbs'; id: string }

/** A short, safe file name for downloading a swatch. */
export function swatchFileName(s: Pick<Swatch, 'title' | 'format'>): string {
  const base = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'swatch'
  return `${base}.${s.format === 'markdown' ? 'md' : s.format === 'mockup' ? 'json' : s.format}`
}
