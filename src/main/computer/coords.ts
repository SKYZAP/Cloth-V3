import type { Point } from './input'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A display as computer use sees it. */
export interface ScreenDisplay {
  id: number
  primary: boolean
  /** Electron's bounds (DIP). */
  bounds: Rect
  scaleFactor: number
  /** Where the display is in input coordinates: physical pixels on Windows, points on macOS. */
  os: Rect
  /** The display's size in real pixels (what a full-size capture has). */
  pixels: { width: number; height: number }
  /** The size of the screenshots the model gets; its coordinates are in this space. */
  shot: { width: number; height: number }
}

export const MAX_EDGE = 1280
export const MAX_PIXELS = 1.15e6

/** The scale that brings a W×H screen down to the model's screenshot size (never up). */
export function shotScale(w: number, h: number): number {
  return Math.min(1, MAX_EDGE / w, Math.sqrt(MAX_PIXELS / (w * h)))
}

export function shotSize(w: number, h: number): { width: number; height: number } {
  const s = shotScale(w, h)
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

type ElectronDisplay = { id: number; bounds: Rect; scaleFactor: number }

/**
 * A display in computer-use terms. On Windows the input space is physical pixels (Electron's
 * dipToScreenRect); on macOS it is points, the same as Electron's bounds.
 */
export function describeDisplay(d: ElectronDisplay, primary: boolean, platform: NodeJS.Platform, dipToScreenRect?: (rect: Rect) => Rect): ScreenDisplay {
  const os = platform === 'win32' && dipToScreenRect ? dipToScreenRect(d.bounds) : { ...d.bounds }
  const pixels = platform === 'win32' ? { width: os.width, height: os.height } : { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) }
  return { id: d.id, primary, bounds: { ...d.bounds }, scaleFactor: d.scaleFactor, os, pixels, shot: shotSize(pixels.width, pixels.height) }
}

/** A point the model gave (screenshot coordinates) in input coordinates; an error message when it's off the screen. */
export function toOs(display: ScreenDisplay, at: readonly number[]): Point | string {
  const [mx, my] = at
  const { width, height } = display.shot
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return 'Coordinates must be two numbers [x, y].'
  if (mx < 0 || my < 0 || mx >= width || my >= height) return `[${mx}, ${my}] is outside the screen. The screenshot is ${width}×${height}: x must be 0–${width - 1} and y 0–${height - 1}.`
  const r = display.os
  const x = r.x + (mx * r.width) / width
  const y = r.y + (my * r.height) / height
  // Never past the display's last pixel.
  return { x: Math.min(r.x + r.width - 1, Math.max(r.x, Math.round(x))), y: Math.min(r.y + r.height - 1, Math.max(r.y, Math.round(y))) }
}

/** An input-space point in the model's screenshot coordinates (null when it's on another display). */
export function fromOs(display: ScreenDisplay, p: Point): [number, number] | null {
  const r = display.os
  if (p.x < r.x || p.y < r.y || p.x >= r.x + r.width || p.y >= r.y + r.height) return null
  return [Math.round(((p.x - r.x) * display.shot.width) / r.width), Math.round(((p.y - r.y) * display.shot.height) / r.height)]
}

/** Check a zoom region ([x0, y0, x1, y1] in screenshot coordinates); an error message when it doesn't fit. */
export function checkRegion(display: ScreenDisplay, region: readonly number[]): string | null {
  if (region.length !== 4 || region.some((n) => !Number.isFinite(n))) return 'region must be four numbers [x0, y0, x1, y1].'
  const [x0, y0, x1, y1] = region
  const { width, height } = display.shot
  if (x0 < 0 || y0 < 0 || x1 > width || y1 > height) return `region must be inside the ${width}×${height} screenshot.`
  if (x1 - x0 < 4 || y1 - y0 < 4) return 'region must be at least 4×4 (x1 > x0 and y1 > y0).'
  return null
}
