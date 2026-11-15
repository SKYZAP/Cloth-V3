/**
 * Swatches: pages a chat makes (a report, a dashboard, a diagram, a small app) that open in Cloth and, when you
 * turn on network sharing, on any phone or computer on the same network, by a link nobody can guess.
 */
export type SwatchFormat = 'html' | 'markdown' | 'svg'

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

/** What a publish_swatch call left on the chat's tool card. */
export interface SwatchTrace {
  id: string
  title: string
  version: number
  format: SwatchFormat
}

export type SwatchEvent = { type: 'changed'; id: string | null } | { type: 'status'; status: SwatchServerStatus }

/** A short, safe file name for downloading a swatch. */
export function swatchFileName(s: Pick<Swatch, 'title' | 'format'>): string {
  const base = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'swatch'
  return `${base}.${s.format === 'markdown' ? 'md' : s.format}`
}
