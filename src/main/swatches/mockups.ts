import { BOARD_MAX, BOARD_MIN, BOARD_NAME, tweakValues, type MockupBoard, type MockupTweak } from '@shared/swatches'

/** A board as stored: its details and its page. */
export interface StoredBoard extends MockupBoard {
  html: string
}

/** One version of a mockup on disk. */
export interface MockupVersion {
  boards: StoredBoard[]
  /** The design system's name and its CSS (tokens and components), put into every board. */
  design: { name: string; css: string } | null
}

/** A board as the agent sends it; tweaks and interactive are optional. */
export interface BoardInput {
  name?: unknown
  title?: unknown
  width?: unknown
  height?: unknown
  html?: unknown
  interactive?: unknown
  tweaks?: unknown
}

export const BOARDS_MAX = 24
const TWEAKS_MAX = 12
const BOARD_BYTES = 2 * 1024 * 1024
export const MOCKUP_BYTES = 12 * 1024 * 1024

const fail = (msg: string): never => {
  throw new Error(msg)
}

function size(v: unknown, what: string): number {
  const n = typeof v === 'number' ? Math.round(v) : NaN
  if (!(n >= BOARD_MIN && n <= BOARD_MAX)) fail(`${what} must be a number of CSS pixels from ${BOARD_MIN} to ${BOARD_MAX}`)
  return n
}

function tweak(raw: unknown, board: string): MockupTweak {
  const t = (raw ?? {}) as Record<string, unknown>
  const key = typeof t.key === 'string' ? t.key : ''
  if (!/^[A-Za-z][\w]{0,30}$/.test(key)) fail(`Board "${board}": a tweak's key must be a short identifier (letters, digits, _), got ${JSON.stringify(t.key)}`)
  const kind = t.kind
  if (kind !== 'enum' && kind !== 'boolean' && kind !== 'range' && kind !== 'color') fail(`Board "${board}", tweak "${key}": kind must be enum, boolean, range or color`)
  const label = typeof t.label === 'string' && t.label.trim() ? t.label.trim().slice(0, 40) : key
  const out: MockupTweak = { key, label, kind: kind as MockupTweak['kind'], default: false }
  if (kind === 'enum') {
    const options = Array.isArray(t.options) ? t.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.slice(0, 30)) : []
    if (options.length < 2 || options.length > 8) fail(`Board "${board}", tweak "${key}": an enum needs 2 to 8 options`)
    out.options = [...new Set(options)]
    out.default = typeof t.default === 'string' && out.options.includes(t.default) ? t.default : out.options[0]
  } else if (kind === 'boolean') out.default = t.default === true
  else if (kind === 'range') {
    const min = Number(t.min)
    const max = Number(t.max)
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) fail(`Board "${board}", tweak "${key}": a range needs numbers min < max`)
    out.min = min
    out.max = max
    out.step = Number(t.step) > 0 ? Number(t.step) : 1
    const d = Number(t.default)
    out.default = Number.isFinite(d) ? Math.min(max, Math.max(min, d)) : min
  } else {
    if (typeof t.default !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(t.default)) fail(`Board "${board}", tweak "${key}": a color's default must be a hex color like #e54056`)
    out.default = (t.default as string).toLowerCase()
  }
  return out
}

/** Check one board from the agent; a board it already has fills in what this one leaves out (an update of one field). */
export function board(raw: BoardInput, prev?: StoredBoard): StoredBoard {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!BOARD_NAME.test(name)) fail(`A board's name must be a short slug (lowercase letters, digits, hyphens), got ${JSON.stringify(raw.name)}`)
  const html = typeof raw.html === 'string' ? raw.html : (prev?.html ?? '')
  if (!html.trim()) fail(`Board "${name}" has no html: pass its whole page`)
  if (Buffer.byteLength(html) > BOARD_BYTES) fail(`Board "${name}" is over ${BOARD_BYTES / 1024 / 1024} MB`)
  const tweaksRaw = raw.tweaks === undefined ? (prev?.tweaks ?? []) : Array.isArray(raw.tweaks) ? raw.tweaks : fail(`Board "${name}": tweaks must be a list`)
  if (tweaksRaw.length > TWEAKS_MAX) fail(`Board "${name}" has ${tweaksRaw.length} tweaks; at most ${TWEAKS_MAX}`)
  const tweaks = raw.tweaks === undefined ? (prev?.tweaks ?? []) : tweaksRaw.map((t) => tweak(t, name))
  if (new Set(tweaks.map((t) => t.key)).size !== tweaks.length) fail(`Board "${name}" has two tweaks with the same key`)
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : (prev?.title ?? name)
  const width = raw.width === undefined && prev ? prev.width : size(raw.width, `Board "${name}" width`)
  const height = raw.height === undefined && prev ? prev.height : size(raw.height, `Board "${name}" height`)
  const interactive = typeof raw.interactive === 'boolean' ? raw.interactive : tweaks.length > 0 || /<script\b/i.test(html)
  return { name, title, width, height, interactive, tweaks, html }
}

/**
 * The boards of the next version: the previous ones, with boards of the same name replaced (only the fields given),
 * new names added at the end, and `remove` taken out.
 */
export function mergeBoards(prev: StoredBoard[], input: BoardInput[], remove: string[] = []): StoredBoard[] {
  const out = prev.filter((b) => !remove.includes(b.name))
  const seen = new Set<string>()
  for (const raw of input) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (seen.has(name)) fail(`Board "${name}" is given twice`)
    seen.add(name)
    const at = out.findIndex((b) => b.name === name)
    const next = board(raw, at >= 0 ? out[at] : undefined)
    if (at >= 0) out[at] = next
    else out.push(next)
  }
  if (!out.length) fail('A mockup needs at least one board')
  if (out.length > BOARDS_MAX) fail(`A mockup holds at most ${BOARDS_MAX} boards`)
  const bytes = out.reduce((n, b) => n + Buffer.byteLength(b.html), 0)
  if (bytes > MOCKUP_BYTES) fail(`The boards come to ${Math.round(bytes / 1024 / 1024)} MB; the limit is ${MOCKUP_BYTES / 1024 / 1024} MB`)
  return out
}

/** JSON safe inside a <script> element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c')

/**
 * What every board gets first in its <head>: the design system's CSS, and `window.tweaks` (the defaults, then any
 * `#tweaks=` in the address, then what the canvas sends by postMessage, with a `tweaks` event on window each time).
 */
export function boardPage(b: StoredBoard, design: MockupVersion['design']): string {
  const runtime = `<script>(function(){var t=${scriptJson(tweakValues(b))};try{var h=/[#&]tweaks=([^&]*)/.exec(location.hash);if(h){var v=JSON.parse(decodeURIComponent(h[1]));for(var k in v)if(k in t&&typeof v[k]===typeof t[k])t[k]=v[k]}}catch(e){}window.tweaks=t;addEventListener('message',function(e){var m=e.data;if(!m||m.type!=='cloth:tweaks'||!m.values||typeof m.values!=='object')return;for(var k in m.values)if(k in t&&typeof m.values[k]===typeof t[k])t[k]=m.values[k];dispatchEvent(new CustomEvent('tweaks',{detail:t}))})})()</script>`
  const css = design ? `<style data-cloth-design="${design.name.replace(/[^\w .-]/g, '')}">${design.css.replace(/<\/style/gi, '<\\/style')}</style>` : ''
  const head = `${css}${runtime}`
  const m = /<head\b[^>]*>/i.exec(b.html)
  if (m) return b.html.slice(0, m.index + m[0].length) + head + b.html.slice(m.index + m[0].length)
  const doc = /<!doctype[^>]*>/i.exec(b.html)
  if (doc) return b.html.slice(0, doc.index + doc[0].length) + head + b.html.slice(doc.index + doc[0].length)
  return head + b.html
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A mockup opened by its link outside Cloth (a browser, a phone): every board, scaled to fit, each opening full size. */
export function overviewPage(title: string, version: number, boards: StoredBoard[]): string {
  const cards = boards
    .map(
      (b) => `<section><h2><a href="b/${b.name}?v=${version}" target="_blank" rel="noopener">${esc(b.title)}</a><span>${b.width} × ${b.height}</span></h2>
<div class="frame" data-w="${b.width}" data-h="${b.height}"><iframe src="b/${b.name}?v=${version}" title="${esc(b.title)}" loading="lazy" sandbox="allow-scripts allow-forms" width="${b.width}" height="${b.height}"></iframe></div></section>`
    )
    .join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{color-scheme:dark}body{margin:0;background:#0b0b0e;color:#f1f1f4;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:28px 16px 64px}h1{font-size:22px;margin:0 0 4px}p{margin:0 0 24px;color:#94949e}
section{margin:0 0 32px}h2{display:flex;gap:10px;align-items:baseline;font-size:14px;font-weight:500;margin:0 0 8px}h2 a{color:#f1f1f4}h2 span{color:#94949e;font-size:12px}
.frame{position:relative;overflow:hidden;border:1px solid #36363c;border-radius:8px;background:#fff}.frame iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0}
</style></head><body><main><h1>${esc(title)}</h1><p>Mockup · version ${version} · ${boards.length} board${boards.length === 1 ? '' : 's'}</p>
${cards}</main><script>function fit(){document.querySelectorAll('.frame').forEach(function(f){var w=+f.dataset.w,h=+f.dataset.h,s=Math.min(1,f.parentNode.clientWidth/w);f.style.width=w*s+'px';f.style.height=h*s+'px';f.firstElementChild.style.transform='scale('+s+')'})}addEventListener('resize',fit);fit()</script></body></html>`
}
