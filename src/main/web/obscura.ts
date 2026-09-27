import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import type { WebResult } from '@shared/types'
import type { Ctx } from '../core/context'
import { run } from './process'

const SERP = 'https://html.duckduckgo.com/html/'

/**
 * Obscura (https://github.com/h4ckf0r0day/obscura) is a stealthy headless browser. We invoke its
 * `fetch` CLI per request — no long-running CDP server — and scrape the DuckDuckGo HTML results page.
 */
export class Obscura {
  constructor(
    private ctx: Ctx,
    private customPath: () => string
  ) {}

  path(): string | null {
    const custom = this.customPath().trim()
    if (custom) return existsSync(custom) ? custom : null
    const bundled = join(this.ctx.sidecarsDir, 'obscura', process.platform === 'win32' ? 'obscura.exe' : 'obscura')
    return existsSync(bundled) ? bundled : null
  }

  version(): string | null {
    try {
      const v = JSON.parse(readFileSync(join(this.ctx.sidecarsDir, 'obscura', 'VERSION'), 'utf8')) as { version?: string; variant?: string }
      return v.version ? `${v.version} (${v.variant})` : null
    } catch {
      return this.customPath() ? 'custom binary' : null
    }
  }

  private bin(): string {
    const p = this.path()
    if (!p) throw new Error(this.customPath() ? `Obscura binary not found at ${this.customPath()}` : 'Obscura is not bundled with this build — run `npm run sidecars` or set a custom binary path in Settings')
    return p
  }

  private async fetch(url: string, dump: 'html' | 'markdown' | 'text', opts: { signal?: AbortSignal; allowPrivate?: boolean; timeoutS?: number } = {}): Promise<string> {
    const timeoutS = opts.timeoutS ?? 25
    const args = ['--stealth', ...(opts.allowPrivate ? ['--allow-private-network'] : []), 'fetch', url, '--dump', dump, '--quiet', '--timeout', String(timeoutS)]
    const { stdout, stderr, code } = await run(this.bin(), args, { timeoutMs: (timeoutS + 15) * 1000, signal: opts.signal })
    if (code !== 0 && !stdout.trim()) throw new Error(`Obscura failed (exit ${code}): ${stderr.trim().split('\n').slice(-2).join(' ') || 'no output'}`)
    return stdout
  }

  async search(query: string, k: number, signal?: AbortSignal): Promise<WebResult[]> {
    const url = new URL(SERP)
    url.searchParams.set('q', query)
    const html = await this.fetch(url.toString(), 'html', { signal })
    const results = parseDuckDuckGo(html).slice(0, k)
    if (!results.length && /anomaly|captcha|unusual traffic/i.test(html)) throw new Error('DuckDuckGo served a bot challenge — try again shortly or switch to SearXNG')
    // A genuine empty result page says so; anything else is a block or an unexpected page.
    if (!results.length && !/no-results|No results\./i.test(html)) {
      throw new Error('DuckDuckGo returned no result list (likely rate-limiting after many searches) — try again shortly or switch to SearXNG')
    }
    return results
  }

  /** Rendered DOM as HTML (JavaScript executed) — used to index client-rendered docs sites. */
  renderHtml(url: string, signal?: AbortSignal): Promise<string> {
    return this.fetch(url, 'html', { signal, allowPrivate: true, timeoutS: 30 })
  }

  fetchPage(url: string, opts: { signal?: AbortSignal; allowPrivate?: boolean } = {}): Promise<string> {
    return this.fetch(url, 'markdown', opts)
  }
}

export function parseDuckDuckGo(html: string): WebResult[] {
  const { document } = parseHTML(html) as unknown as { document: any }
  const out: WebResult[] = []
  const seen = new Set<string>()
  for (const el of document.querySelectorAll('.result')) {
    if (String(el.getAttribute('class') ?? '').includes('result--ad')) continue
    const a = el.querySelector('.result__a, .result__title a')
    const href = a?.getAttribute('href') ?? ''
    const url = resolveDdgUrl(href)
    if (!url || seen.has(url) || /duckduckgo\.com\/y\.js/.test(url)) continue
    seen.add(url)
    out.push({
      title: (a?.textContent ?? '').trim() || url,
      url,
      snippet: (el.querySelector('.result__snippet')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      engine: 'duckduckgo'
    })
  }
  return out
}

function resolveDdgUrl(href: string): string | null {
  if (!href) return null
  try {
    const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com')
    if (u.pathname === '/l/' && u.searchParams.get('uddg')) return decodeURIComponent(u.searchParams.get('uddg')!)
    return u.protocol.startsWith('http') ? u.toString() : null
  } catch {
    return null
  }
}
