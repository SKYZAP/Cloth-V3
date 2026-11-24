import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { marked } from 'marked'
import type { MockupInfo, Swatch, SwatchFormat, SwatchLink, SwatchServerStatus } from '@shared/swatches'
import { boardPage, mergeBoards, overviewPage, type BoardInput, type MockupVersion, type StoredBoard } from './mockups'
import { renderPage, shrinkPng, type RenderPage } from './render'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import { hostAddresses } from '../remote/server'

/** A swatch on disk: its details and the secret in its link. */
interface Stored extends Swatch {
  key: string
}

export const SWATCH_LIMIT = 5 * 1024 * 1024
/** Formats publish takes; a mockup comes from publishMockup. */
const FORMATS: SwatchFormat[] = ['html', 'markdown', 'svg']
const EXT: Record<SwatchFormat, string> = { html: 'html', markdown: 'md', svg: 'svg', mockup: 'json' }
/** Versions of a mockup kept on disk (older ones are deleted). */
const MOCKUP_VERSIONS = 20
const THUMB_PX = 560
/** The size a page is rendered at for its card: a desktop window. */
const COVER_W = 1280
const COVER_H = 800

/**
 * Every swatch page runs sandboxed: an opaque origin, so it can't read Cloth's or another swatch's data, and
 * markdown and SVG can't run scripts at all. HTML may load libraries from the web (charts, maps), as a page would.
 * No frame-ancestors: `frame-ancestors *` doesn't match the installed app's file:// page, which then can't show
 * swatches at all. Any page may frame one; the link's key is what keeps it private.
 */
const CSP: Record<SwatchFormat, string> = {
  html: "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  markdown: "sandbox allow-popups; default-src 'none'; img-src https: data:; style-src 'unsafe-inline'",
  svg: "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  // The overview a mockup's link opens: its boards in frames, each a board page with the html policy.
  mockup: "sandbox allow-scripts allow-popups; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src *"
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A markdown swatch as a readable page, light or dark with the viewer's device. */
export function markdownPage(title: string, md: string): string {
  const body = marked.parse(md, { async: false, gfm: true }) as string
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>
:root{color-scheme:light dark;--bg:#fbfbfc;--fg:#17171a;--muted:#5b5b66;--line:#e3e3e8;--code:#f1f1f4;--accent:#b01c36}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--fg:#f1f1f4;--muted:#bdbdc5;--line:#36363c;--code:#1e1e22;--accent:#f88d96}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:40px 16px 72px}
h1,h2,h3{line-height:1.25;margin:1.6em 0 .5em}h1{font-size:1.9rem;margin-top:0}h2{font-size:1.35rem}h3{font-size:1.1rem}
p,ul,ol,table,pre,blockquote{margin:0 0 1em}a{color:var(--accent)}img{max-width:100%}
code{font:.88em ui-monospace,"Cascadia Code",monospace;background:var(--code);border-radius:4px;padding:.1em .35em}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto}pre code{background:none;padding:0}
blockquote{border-left:3px solid var(--line);margin-left:0;padding-left:14px;color:var(--muted)}
table{border-collapse:collapse;display:block;overflow-x:auto}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
</style></head><body><main>${body}</main></body></html>`
}

/** True when the request comes from this PC. */
function local(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class SwatchService {
  private server: Server | null = null
  private error: string | null = null
  private boundPort = 0
  private op: Promise<unknown> = Promise.resolve()
  /** Thumbnails being made, by mockup id and version. */
  private thumbing = new Map<string, Promise<void>>()
  /** Versions whose thumbnails were tried already: one that failed isn't tried again (each try ends in an event that asks again). */
  private thumbsTried = new Set<string>()
  /** The design system a chat's mockups follow (its project's), set once the services are built. */
  designFor: (sessionId: string | null) => MockupVersion['design'] = () => null
  /** Scales a rendered page down for its card (Electron's image tools; swapped out in tests). */
  private shrink = shrinkPng

  constructor(
    private ctx: Ctx,
    private settings: SettingsService,
    private render: RenderPage = renderPage
  ) {}

  private get dir(): string {
    return join(this.ctx.dataDir, 'swatches')
  }

  private read(id: string): Stored | null {
    if (!/^sw[a-f0-9]{16}$/.test(id)) return null
    try {
      return JSON.parse(readFileSync(join(this.dir, id, 'meta.json'), 'utf8')) as Stored
    } catch {
      return null
    }
  }

  private write(s: Stored, content?: string): void {
    const dir = join(this.dir, s.id)
    mkdirSync(dir, { recursive: true })
    if (content !== undefined) {
      for (const f of FORMATS) if (f !== s.format) rmSync(join(dir, `content.${EXT[f]}`), { force: true })
      writeFileSync(join(dir, `content.${EXT[s.format]}`), content)
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(s))
  }

  private public(s: Stored): Swatch {
    const { key: _key, ...rest } = s
    return rest
  }

  list(): Swatch[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .map((id) => this.read(id))
      .filter((s): s is Stored => !!s)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => this.public(s))
  }

  get(id: string): Swatch {
    const s = this.read(id)
    if (!s) throw new Error('That swatch no longer exists')
    return this.public(s)
  }

  content(id: string): string {
    const s = this.read(id)
    if (!s) throw new Error('That swatch no longer exists')
    if (s.format === 'mockup') return JSON.stringify(this.version(s), null, 2)
    return readFileSync(join(this.dir, id, `content.${EXT[s.format]}`), 'utf8')
  }

  /** Make a swatch, or a new version of one (by id). */
  publish(input: { title?: string; content: string; format?: string; sessionId?: string | null; id?: string | null }): Swatch {
    const bytes = Buffer.byteLength(input.content)
    if (!input.content.trim()) throw new Error('The swatch is empty: pass its full content')
    if (bytes > SWATCH_LIMIT) throw new Error(`The swatch is ${Math.round(bytes / 1024)} KB; the limit is ${SWATCH_LIMIT / 1024 / 1024} MB`)
    const format = (FORMATS as string[]).includes(String(input.format)) ? (input.format as SwatchFormat) : guessFormat(input.content)
    const now = Date.now()
    const prev = input.id ? this.read(input.id) : null
    if (input.id && !prev) throw new Error(`There's no swatch ${input.id}. Leave id out to make a new one.`)
    if (prev?.format === 'mockup') throw new Error(`${input.id} is a mockup: change it with publish_mockup`)
    const title = (input.title ?? '').trim().slice(0, 120) || prev?.title || 'Untitled swatch'
    const s: Stored = prev
      ? { ...prev, title, format, updatedAt: now, version: prev.version + 1, bytes }
      : { id: newId('sw'), key: randomBytes(18).toString('base64url'), title, format, sessionId: input.sessionId ?? null, createdAt: now, updatedAt: now, version: 1, bytes }
    this.write(s, input.content)
    this.ctx.emit('swatches', { type: 'changed', id: s.id })
    return this.public(s)
  }

  // ─── Mockups ──────────────────────────────────────────────────────────────────

  private versionFile(id: string, v: number): string {
    return join(this.dir, id, `mockup.v${v}.json`)
  }

  /** The versions of a mockup still on disk, oldest first. */
  private versions(id: string): number[] {
    try {
      return readdirSync(join(this.dir, id))
        .map((f) => /^mockup\.v(\d+)\.json$/.exec(f)?.[1])
        .filter((v): v is string => !!v)
        .map(Number)
        .sort((a, b) => a - b)
    } catch {
      return []
    }
  }

  private version(s: Stored, v = s.version): MockupVersion {
    try {
      return JSON.parse(readFileSync(this.versionFile(s.id, v), 'utf8')) as MockupVersion
    } catch {
      throw new Error(v === s.version ? 'That mockup no longer exists' : `Version ${v} of that mockup is no longer kept`)
    }
  }

  private mockupOf(id: string): Stored {
    const s = this.read(id)
    if (!s) throw new Error(`There's no mockup ${id}`)
    if (s.format !== 'mockup') throw new Error(`${id} is not a mockup`)
    return s
  }

  /**
   * Make a mockup, or its next version (by id): boards given replace those of the same name (only the fields given),
   * new names are added, `remove` takes boards out. The chat's project design goes into every board as CSS.
   */
  publishMockup(input: { title?: string; id?: string | null; sessionId?: string | null; boards: BoardInput[]; remove?: string[] }): { swatch: Swatch; mockup: MockupInfo } {
    const now = Date.now()
    const prev = input.id ? this.read(input.id) : null
    if (input.id && !prev) throw new Error(`There's no mockup ${input.id}. Leave id out to make a new one.`)
    if (prev && prev.format !== 'mockup') throw new Error(`${input.id} is a ${prev.format} swatch, not a mockup: change it with publish_swatch`)
    const before = prev ? this.version(prev).boards : []
    const boards = mergeBoards(before, input.boards ?? [], input.remove ?? [])
    const design = this.designFor(input.sessionId ?? prev?.sessionId ?? null)
    const title = (input.title ?? '').trim().slice(0, 120) || prev?.title || 'Untitled mockup'
    const bytes = boards.reduce((n, b) => n + Buffer.byteLength(b.html), 0)
    const s: Stored = prev
      ? { ...prev, title, updatedAt: now, version: prev.version + 1, bytes, boards: boards.length }
      : { id: newId('sw'), key: randomBytes(18).toString('base64url'), title, format: 'mockup', sessionId: input.sessionId ?? null, createdAt: now, updatedAt: now, version: 1, bytes, boards: boards.length }
    mkdirSync(join(this.dir, s.id), { recursive: true })
    writeFileSync(this.versionFile(s.id, s.version), JSON.stringify({ boards, design } satisfies MockupVersion))
    for (const old of this.versions(s.id).slice(0, -MOCKUP_VERSIONS)) {
      rmSync(this.versionFile(s.id, old), { force: true })
      rmSync(join(this.dir, s.id, 'thumbs', `v${old}`), { recursive: true, force: true })
    }
    this.write(s)
    this.ctx.emit('swatches', { type: 'changed', id: s.id })
    return { swatch: this.public(s), mockup: this.mockup(s.id) }
  }

  /** A mockup at a version (default: its latest), without the boards' markup. */
  mockup(id: string, v?: number): MockupInfo {
    const s = this.mockupOf(id)
    const at = v ?? s.version
    const ver = this.version(s, at)
    return { id, version: at, versions: this.versions(id), boards: ver.boards.map(({ html: _html, ...b }) => b), design: ver.design?.name ?? null }
  }

  private board(id: string, name: string, v?: number): { s: Stored; at: number; board: StoredBoard } {
    const s = this.mockupOf(id)
    const at = v ?? s.version
    const ver = this.version(s, at)
    const board = ver.boards.find((b) => b.name === name)
    if (!board) throw new Error(`The mockup has no board "${name}". Its boards: ${ver.boards.map((b) => b.name).join(', ')}`)
    return { s, at, board }
  }

  /** The local address of one board (as served, with the design and tweaks put in), with tweak values in its hash. */
  boardUrl(id: string, name: string, v?: number, tweaks?: Record<string, unknown>): string {
    const { s, at } = this.board(id, name, v)
    if (!this.server) throw new Error(this.error ?? 'The swatch server is not running')
    const hash = tweaks && Object.keys(tweaks).length ? `#tweaks=${encodeURIComponent(JSON.stringify(tweaks))}` : ''
    return `http://127.0.0.1:${this.boundPort}/s/${s.id}/${s.key}/b/${name}?v=${at}${hash}`
  }

  /** A board rendered to a PNG, at its size or another width (a phone, say), with tweak values set. */
  async snapshot(id: string, name: string, opts: { width?: number; height?: number; tweaks?: Record<string, unknown>; version?: number; maxSide?: number } = {}): Promise<{ png: Buffer; width: number; height: number }> {
    const { board } = this.board(id, name, opts.version)
    const width = Math.round(opts.width ?? board.width)
    const height = Math.round(opts.height ?? board.height)
    const png = await this.render(this.boardUrl(id, name, opts.version, opts.tweaks), width, height)
    return { png: opts.maxSide ? await this.shrink(png, opts.maxSide) : png, width, height }
  }

  /**
   * A picture of the swatch for its card in the library, as a data URL: a mockup's first board, or the page as it
   * renders at a desktop size. Null until made: it's made in the background, then a 'thumbs' event says to ask again.
   */
  cover(id: string): string | null {
    const s = this.read(id)
    if (!s) return null
    if (s.format === 'mockup') {
      const first = this.version(s, s.version).boards[0]
      return first ? (this.thumbs(id)[first.name] ?? null) : null
    }
    const dir = join(this.dir, id, 'thumbs')
    const file = join(dir, `cover-v${s.version}.png`)
    try {
      return `data:image/png;base64,${readFileSync(file).toString('base64')}`
    } catch {
      // Not made yet.
    }
    const key = `${id}:cover:${s.version}`
    if (this.server && !this.thumbing.has(key) && !this.thumbsTried.has(key)) {
      this.thumbsTried.add(key)
      const url = `http://127.0.0.1:${this.boundPort}/s/${s.id}/${s.key}`
      const job = (async () => {
        try {
          const png = await this.shrink(await this.render(url, COVER_W, COVER_H), THUMB_PX)
          mkdirSync(dir, { recursive: true })
          for (const old of readdirSync(dir)) if (/^cover-v\d+\.png$/.test(old)) rmSync(join(dir, old), { force: true })
          writeFileSync(file, png)
        } catch (err) {
          this.ctx.log('swatches', `cover of ${id} failed`, err)
        }
      })().finally(() => {
        this.thumbing.delete(key)
        this.ctx.emit('swatches', { type: 'thumbs', id })
      })
      this.thumbing.set(key, job)
    }
    return null
  }

  /**
   * Each board's thumbnail at a version, as data URLs (null where not made yet). Missing ones are made in the
   * background, one board at a time, then a 'thumbs' event says to ask again.
   */
  thumbs(id: string, v?: number): Record<string, string | null> {
    const s = this.mockupOf(id)
    const at = v ?? s.version
    const ver = this.version(s, at)
    const dir = join(this.dir, id, 'thumbs', `v${at}`)
    const out: Record<string, string | null> = {}
    const missing: string[] = []
    for (const b of ver.boards) {
      try {
        out[b.name] = `data:image/png;base64,${readFileSync(join(dir, `${b.name}.png`)).toString('base64')}`
      } catch {
        out[b.name] = null
        missing.push(b.name)
      }
    }
    const key = `${id}:${at}`
    if (missing.length && this.server && !this.thumbing.has(key) && !this.thumbsTried.has(key)) {
      this.thumbsTried.add(key)
      const job = (async () => {
        mkdirSync(dir, { recursive: true })
        for (const name of missing) {
          try {
            const { png } = await this.snapshot(id, name, { version: at, maxSide: THUMB_PX })
            writeFileSync(join(dir, `${name}.png`), png)
          } catch (err) {
            this.ctx.log('swatches', `thumbnail of ${id}/${name} failed`, err)
          }
        }
      })().finally(() => {
        this.thumbing.delete(key)
        this.ctx.emit('swatches', { type: 'thumbs', id })
      })
      this.thumbing.set(key, job)
    }
    return out
  }

  /** A mockup's link: its overview, one board (/b/<name>, ?v= for an older version), or its source as JSON. */
  private serveMockup(req: IncomingMessage, res: ServerResponse, s: Stored, rest: string, url: URL, common: Record<string, string>, notFound: () => void): void {
    const v = Number(url.searchParams.get('v')) || s.version
    let ver: MockupVersion
    try {
      ver = this.version(s, v)
    } catch {
      return notFound()
    }
    const body = (type: string, text: string, csp?: string) => void res.writeHead(200, { ...common, 'content-type': type, ...(csp ? { 'content-security-policy': csp } : {}) }).end(req.method === 'HEAD' ? undefined : text)
    if (rest === '/source') return body('application/json; charset=utf-8', JSON.stringify(ver, null, 2))
    if (rest.startsWith('/b/')) {
      const b = ver.boards.find((x) => x.name === rest.slice(3))
      return b ? body('text/html; charset=utf-8', boardPage(b, ver.design), CSP.html) : notFound()
    }
    return body('text/html; charset=utf-8', overviewPage(s.title, v, ver.boards, `/s/${s.id}/${s.key}`), CSP.mockup)
  }

  rename(id: string, title: string): Swatch {
    const s = this.read(id)
    if (!s) throw new Error('That swatch no longer exists')
    s.title = title.trim().slice(0, 120) || s.title
    this.write(s)
    this.ctx.emit('swatches', { type: 'changed', id })
    return this.public(s)
  }

  /** A new secret for its link: links handed out before stop working. */
  newLink(id: string): SwatchLink[] {
    const s = this.read(id)
    if (!s) throw new Error('That swatch no longer exists')
    s.key = randomBytes(18).toString('base64url')
    this.write(s)
    this.ctx.emit('swatches', { type: 'changed', id })
    return this.links(id)
  }

  remove(id: string): void {
    if (!this.read(id)) return
    rmSync(join(this.dir, id), { recursive: true, force: true })
    this.ctx.emit('swatches', { type: 'changed', id })
  }

  /** Where it can be opened: on this PC, and from other devices when network sharing is on. */
  links(id: string): SwatchLink[] {
    const s = this.read(id)
    if (!s) throw new Error('That swatch no longer exists')
    const port = this.boundPort || this.settings.get().swatchPort
    const path = `/s/${s.id}/${s.key}`
    const out: SwatchLink[] = [{ label: 'This computer', url: `http://127.0.0.1:${port}${path}`, kind: 'local' }]
    if (this.server && this.settings.get().swatchNetwork) for (const h of hostAddresses()) out.push({ label: h.label, url: `http://${h.address}:${port}${path}`, kind: h.kind })
    return out
  }

  status(): SwatchServerStatus {
    return { running: !!this.server, port: this.boundPort || this.settings.get().swatchPort, network: !!this.server && this.settings.get().swatchNetwork, error: this.error }
  }

  restart(): Promise<SwatchServerStatus> {
    const next = this.op.then(async () => {
      await this.shutdown()
      await this.start()
      return this.status()
    })
    this.op = next.catch(() => undefined)
    return next
  }

  stop(): Promise<void> {
    const next = this.op.then(() => this.shutdown())
    this.op = next.catch(() => undefined)
    return next
  }

  private async shutdown(): Promise<void> {
    const srv = this.server
    this.server = null
    this.boundPort = 0
    if (srv) await new Promise<void>((r) => srv.close(() => r()))
  }

  private async start(): Promise<void> {
    const { swatchPort: port, swatchNetwork: network } = this.settings.get()
    this.error = null
    const srv = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve) => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Pick another in Settings › Swatches.` : errorMessage(err)
        resolve()
      })
      // Only this PC can connect unless network sharing is on.
      srv.listen(port, network ? '0.0.0.0' : '127.0.0.1', () => {
        this.server = srv
        this.boundPort = port
        resolve()
      })
    })
    this.ctx.emit('swatches', { type: 'status', status: this.status() })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const notFound = () => void res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('This swatch link is not valid, or the swatch was deleted.')
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end()
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"name":"cloth-swatches"}')
    const m = /^\/s\/(sw[a-f0-9]{16})\/([\w-]{16,64})(\/source|\/b\/[a-z0-9][a-z0-9-]{0,39})?$/.exec(url.pathname)
    const s = m ? this.read(m[1]) : null
    if (!m || !s || !sameKey(m[2], s.key)) return notFound()
    // Network sharing turned off since the server started: only this PC.
    if (!local(req) && !this.settings.get().swatchNetwork) return notFound()
    const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
    if (s.format === 'mockup') return this.serveMockup(req, res, s, m[3] ?? '', url, common, notFound)
    if (m[3]?.startsWith('/b/')) return notFound()
    let content: string
    try {
      content = readFileSync(join(this.dir, s.id, `content.${EXT[s.format]}`), 'utf8')
    } catch {
      return notFound()
    }
    if (m[3]) {
      const name = `${s.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'swatch'}.${EXT[s.format]}`
      return void res.writeHead(200, { ...common, 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `inline; filename="${name}"` }).end(req.method === 'HEAD' ? undefined : content)
    }
    const type = s.format === 'svg' ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8'
    const body = s.format === 'markdown' ? markdownPage(s.title, content) : content
    res.writeHead(200, { ...common, 'content-type': type, 'content-security-policy': CSP[s.format] }).end(req.method === 'HEAD' ? undefined : body)
  }
}

/** The format of content given without one: an <svg> document, an HTML page, else markdown. */
export function guessFormat(content: string): SwatchFormat {
  const head = content.trimStart().slice(0, 400).toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg'
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /^<(head|body|div|main|section|style|script)\b/.test(head)) return 'html'
  return 'markdown'
}
