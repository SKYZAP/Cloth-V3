import { desktopCapturer, screen, type NativeImage } from 'electron'
import { shotSize, type Rect, type ScreenDisplay, describeDisplay } from './coords'

export * from './coords'

const JPEG_ABOVE = 1024 * 1024

/** Every display, in Electron's order. */
export function listDisplays(): ScreenDisplay[] {
  const primary = screen.getPrimaryDisplay()
  const dip = process.platform === 'win32' ? (r: Rect) => screen.dipToScreenRect(null, r) : undefined
  return screen.getAllDisplays().map((d) => describeDisplay(d, d.id === primary.id, process.platform, dip))
}

export interface Shot {
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  /** A small JPEG data URL for the chat's trace. */
  thumbnail: string
}

async function grab(display: ScreenDisplay, size: { width: number; height: number }): Promise<NativeImage> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source) throw new Error('Could not capture that display')
  const img = source.thumbnail
  if (img.isEmpty()) throw new Error('The screenshot came back empty. On macOS, Cloth needs Screen Recording permission.')
  return img
}

function encode(img: NativeImage): Shot {
  const { width, height } = img.getSize()
  const png = img.toPNG()
  const big = png.length > JPEG_ABOVE
  const data = big ? img.toJPEG(80) : png
  const thumb = width > 320 ? img.resize({ width: 320, quality: 'good' }) : img
  return { data: data.toString('base64'), mimeType: big ? 'image/jpeg' : 'image/png', width, height, thumbnail: `data:image/jpeg;base64,${thumb.toJPEG(70).toString('base64')}` }
}

/** A screenshot of the display at the model's size. */
export async function capture(display: ScreenDisplay): Promise<Shot> {
  let img = await grab(display, display.shot)
  const got = img.getSize()
  // The capturer fits the thumbnail in the asked size: make it exact so coordinates map 1:1.
  if (got.width !== display.shot.width || got.height !== display.shot.height) img = img.resize({ width: display.shot.width, height: display.shot.height, quality: 'best' })
  return encode(img)
}

/** A region of the screenshot captured at full resolution, scaled to fit the model's limits. */
export async function zoom(display: ScreenDisplay, region: readonly number[]): Promise<Shot> {
  const [x0, y0, x1, y1] = region
  const full = await grab(display, display.pixels)
  const size = full.getSize()
  const sx = size.width / display.shot.width
  const sy = size.height / display.shot.height
  const crop = {
    x: Math.round(x0 * sx),
    y: Math.round(y0 * sy),
    width: Math.min(size.width - Math.round(x0 * sx), Math.max(1, Math.round((x1 - x0) * sx))),
    height: Math.min(size.height - Math.round(y0 * sy), Math.max(1, Math.round((y1 - y0) * sy)))
  }
  let img = full.crop(crop)
  const fit = shotSize(crop.width, crop.height)
  if (fit.width !== crop.width) img = img.resize({ width: fit.width, height: fit.height, quality: 'best' })
  return encode(img)
}
