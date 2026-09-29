import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { WebResult } from '@shared/types'
import type { Ctx } from '../core/context'
import { webCaBundlePath, fetchWithWebCa } from './transport'
import { killTree } from './process'

const START_TIMEOUT_MS = 45_000

/**
 * Manages the bundled SearXNG sidecar (standalone CPython + SearXNG source staged by
 * scripts/stage-searxng.mjs). Started lazily on first use and bound to 127.0.0.1 only.
 */
export class SearxngSidecar {
  private child: ChildProcess | null = null
  private url: string | null = null
  private starting: Promise<string> | null = null
  private lastError: string | null = null
  private logTail: string[] = []
  private caCertPath: string | null = null

  constructor(private ctx: Ctx) {}

  get root(): string {
    return join(this.ctx.sidecarsDir, 'searxng')
  }

  private get python(): string {
    return process.platform === 'win32' ? join(this.root, 'python', 'python.exe') : join(this.root, 'python', 'bin', 'python3.12')
  }

  bundled(): boolean {
    return existsSync(this.python) && existsSync(join(this.root, 'src', 'searxng', 'searx'))
  }

  version(): string | null {
    try {
      const v = JSON.parse(readFileSync(join(this.root, 'VERSION'), 'utf8')) as { searxng?: string; python?: string }
      return v.searxng ? `${v.searxng.slice(0, 10)} · py${v.python}` : null
    } catch {
      return null
    }
  }

  status() {
    return { running: !!this.child && !!this.url, starting: !!this.starting, url: this.url, error: this.lastError }
  }

  /** Start the sidecar if needed and return its base URL. */
  ensure(caCertPath?: string): Promise<string> {
    const requestedCertPath = caCertPath?.trim() || null
    if (this.child && this.url && this.caCertPath === requestedCertPath) return Promise.resolve(this.url)
    if (this.starting) return this.starting.then(() => this.ensure(caCertPath))
    this.starting = (async () => {
      if (this.child) await this.stop()
      return this.start(requestedCertPath)
    })().finally(() => {
      this.starting = null
      this.ctx.emit('web', { type: 'status' })
    })
    this.ctx.emit('web', { type: 'status' })
    return this.starting
  }

  private async start(caCertPath: string | null): Promise<string> {
    if (!this.bundled()) throw new Error('SearXNG is not bundled with this build — run `npm run sidecars`, or set an external SearXNG URL in Settings')
    this.lastError = null
    this.logTail = []
    const port = await freePort(8888)
    const dir = join(this.ctx.dataDir, 'searxng')
    mkdirSync(dir, { recursive: true })
    const secretFile = join(dir, 'secret')
    let secret = existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : ''
    if (secret.length < 32) {
      secret = randomBytes(32).toString('hex')
      writeFileSync(secretFile, secret, { mode: 0o600 })
    }
    const template = readFileSync(join(this.root, 'settings.yml'), 'utf8')
    const settingsFile = join(dir, 'settings.yml')
    writeFileSync(settingsFile, template.replaceAll('__PORT__', String(port)).replace('__SECRET__', secret))
    const src = join(this.root, 'src', 'searxng')
    const caBundlePath = caCertPath ? webCaBundlePath(caCertPath, dir) : null
    const child = spawn(this.python, ['-m', 'searx.webapp'], {
      cwd: src,
      env: {
        ...process.env,
        PYTHONPATH: src,
        SEARXNG_SETTINGS_PATH: settingsFile,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        ...(caBundlePath ? { SSL_CERT_FILE: caBundlePath, REQUESTS_CA_BUNDLE: caBundlePath, CURL_CA_BUNDLE: caBundlePath } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.caCertPath = caCertPath
    const capture = (buf: Buffer) => {
      this.logTail = [...this.logTail, ...buf.toString().split(/\r?\n/).filter(Boolean)].slice(-40)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null
        this.url = null
        if (code) this.lastError = `SearXNG exited with code ${code}: ${this.logTail.slice(-3).join(' | ')}`
        this.ctx.emit('web', { type: 'status' })
      }
    })

    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.child) throw new Error(this.lastError ?? 'SearXNG exited during startup')
      try {
        const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          this.url = url
          this.ctx.log('web', `SearXNG ready on ${url}`)
          return url
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    await this.stop()
    this.lastError = `SearXNG did not become ready within ${START_TIMEOUT_MS / 1000}s`
    throw new Error(this.lastError)
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.url = null
    this.caCertPath = null
    if (child?.pid) await killTree(child.pid)
  }
}

export async function searxngSearch(baseUrl: string, query: string, k: number, signal?: AbortSignal, caCertPath?: string): Promise<WebResult[]> {
  const url = new URL('/search', baseUrl.replace(/\/+$/, '') + '/')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('language', 'en')
  url.searchParams.set('safesearch', '1')
  url.searchParams.set('categories', 'general,it')
  const res = await fetchWithWebCa(url, { signal: signal ?? AbortSignal.timeout(20_000), headers: { accept: 'application/json' } }, caCertPath)
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}${res.status === 403 ? ' — enable the json format in its settings.yml' : ''}`)
  const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string; engine?: string }[]; unresponsive_engines?: [string, string][] }
  const seen = new Set<string>()
  const all: WebResult[] = []
  for (const r of body.results ?? []) {
    if (!r.url || seen.has(r.url)) continue
    seen.add(r.url)
    all.push({ title: r.title?.trim() || r.url, url: r.url, snippet: (r.content ?? '').trim(), engine: r.engine })
  }
  const ranked = rerankByOverlap(query, all)
  if (!ranked.length && body.unresponsive_engines?.length) {
    throw new Error(`No relevant results — upstream engines refused: ${body.unresponsive_engines.map(([e, why]) => `${e} (${why})`).join(', ')}`)
  }
  return ranked.slice(0, k)
}

const STOP = new Set('the a an and or of to in for on with how what why is are do does can use using vs'.split(' '))

/**
 * Metasearch engines sometimes return junk when an upstream engine serves bot-defence pages.
 * Keep results that share at least one query term (title, snippet or URL), ordered by overlap,
 * preserving SearXNG's order among ties.
 */
export function rerankByOverlap(query: string, results: WebResult[]): WebResult[] {
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t)))]
  if (!terms.length) return results
  return results
    .map((r, i) => {
      const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase()
      return { r, i, hits: terms.filter((t) => hay.includes(t)).length }
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .map((x) => x.r)
}

function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.once('error', reject)
      srv.listen(port, '127.0.0.1', () => {
        const addr = srv.address()
        const p = typeof addr === 'object' && addr ? addr.port : port
        srv.close(() => resolve(p))
      })
    })
  return tryPort(preferred).catch(() => tryPort(0))
}
