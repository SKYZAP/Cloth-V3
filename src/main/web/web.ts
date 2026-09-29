import type { WebEngine, WebResult, WebSearchResult, WebStatus } from '@shared/types'
import type { Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import { fetchUrl } from '../rag/extract'
import { Obscura } from './obscura'
import { SearxngSidecar, searxngSearch } from './searxng'

const MAX_PAGE_CHARS = 24_000

export class WebService {
  readonly searxng: SearxngSidecar
  readonly obscura: Obscura

  constructor(
    ctx: Ctx,
    private settings: SettingsService
  ) {
    this.searxng = new SearxngSidecar(ctx)
    this.obscura = new Obscura(ctx, () => this.settings.get().obscuraPath, () => this.settings.get().webCaCertPath)
  }

  status(): WebStatus {
    const s = this.settings.get()
    const side = this.searxng.status()
    const obscuraPath = this.obscura.path()
    return {
      engine: s.webEngine,
      searxng: {
        bundled: this.searxng.bundled(),
        external: s.searxngUrl.trim() || null,
        running: side.running,
        starting: side.starting,
        url: s.searxngUrl.trim() || side.url,
        error: side.error,
        version: this.searxng.version()
      },
      obscura: {
        available: !!obscuraPath,
        path: obscuraPath,
        version: obscuraPath ? this.obscura.version() : null,
        error: obscuraPath ? null : s.obscuraPath ? `Not found: ${s.obscuraPath}` : 'Not bundled in this build'
      }
    }
  }

  /** Warm up the selected engine (SearXNG takes a few seconds to boot). */
  warm(): void {
    const s = this.settings.get()
    if (s.webEngine === 'searxng' && !s.searxngUrl.trim() && this.searxng.bundled()) void this.searxng.ensure(s.webCaCertPath).catch(() => undefined)
  }

  async search(query: string, opts: { k?: number; engine?: WebEngine; signal?: AbortSignal } = {}): Promise<WebSearchResult> {
    const s = this.settings.get()
    const engine = opts.engine ?? s.webEngine
    const k = Math.max(1, Math.min(opts.k ?? s.webResults, 20))
    const started = Date.now()
    let results: WebResult[]
    if (engine === 'searxng') {
      const base = s.searxngUrl.trim() || (await this.searxng.ensure(s.webCaCertPath))
      results = await searxngSearch(base, query, k, opts.signal, s.searxngUrl.trim() ? s.webCaCertPath : undefined)
    } else {
      results = await this.obscura.search(query, k, opts.signal)
    }
    return { engine, query, results, tookMs: Date.now() - started }
  }

  /** Fetch a page as Markdown — through Obscura when it is the engine (JS rendering + stealth), else plain HTTP + Readability. */
  async fetchPage(url: string, signal?: AbortSignal): Promise<{ title: string; markdown: string; via: string }> {
    const s = this.settings.get()
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be fetched')
    if (!s.webAllowPrivate && isPrivateHost(u.hostname)) throw new Error('Fetching localhost / private network addresses is disabled (Settings → Web search)')
    if (s.webEngine === 'obscura' && this.obscura.path()) {
      const md = await this.obscura.fetchPage(url, { signal, allowPrivate: s.webAllowPrivate })
      const title = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? u.hostname
      return { title, markdown: truncate(md), via: 'obscura' }
    }
    const page = await fetchUrl(url, signal, s.webCaCertPath)
    return { title: page.title, markdown: truncate(page.text), via: 'http' }
  }

  async stop(): Promise<void> {
    await this.searxng.stop()
  }
}

function truncate(s: string): string {
  return s.length > MAX_PAGE_CHARS ? `${s.slice(0, MAX_PAGE_CHARS)}\n\n… (truncated, ${s.length} chars total)` : s
}

export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '0.0.0.0') return true
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0
  }
  return /^(fc|fd|fe80)/.test(h)
}
