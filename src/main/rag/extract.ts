import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { fetchWithWebCa } from '../web/transport'

export interface Extracted {
  title: string
  text: string
  /** Chunk as code (no heading detection). */
  code: boolean
  links?: string[]
  /** Came from an HTML page (so it may need JavaScript rendering). */
  html?: boolean
}

/** Renders a URL with a real browser engine and returns the resulting DOM as HTML. */
export type PageRenderer = (url: string, signal?: AbortSignal) => Promise<string>
export type RenderMode = 'auto' | 'always' | 'never'

/**
 * Heuristic for client-rendered apps (React/Angular/Vue docs sites): the static HTML is a shell
 * with almost no text and no in-page links until JavaScript runs.
 */
export function needsRendering(page: Extracted): boolean {
  if (!page.html) return false
  const text = page.text.replace(/\s+/g, ' ').trim()
  return text.length < 250 || ((page.links?.length ?? 0) < 3 && text.length < 1500)
}

/**
 * Fetch a URL for indexing. Plain HTTP first; if the result looks like an unrendered JS shell,
 * re-render with the browser engine. `sticky.render` lets a crawl skip the wasted plain fetch
 * once a site is known to need rendering.
 */
export async function loadUrl(
  url: string,
  opts: { mode?: RenderMode; renderer?: PageRenderer | null; sticky?: { render: boolean }; signal?: AbortSignal; caCertPath?: string } = {}
): Promise<Extracted & { rendered: boolean }> {
  const mode = opts.mode ?? 'auto'
  const renderer = mode === 'never' ? null : opts.renderer ?? null
  if (renderer && (mode === 'always' || opts.sticky?.render)) {
    return { ...extractHtml(await renderer(url, opts.signal), url), rendered: true }
  }
  const page = await fetchUrl(url, opts.signal, opts.caCertPath)
  if (!renderer) return { ...page, rendered: false }
  const rendered = { ...extractHtml(await renderer(url, opts.signal), url), rendered: true }
  if (opts.sticky && !needsRendering(rendered)) opts.sticky.render = true
  return rendered
}

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.cs', '.cpp', '.cc', '.c', '.h',
  '.hpp', '.rb', '.php', '.swift', '.scala', '.sh', '.ps1', '.sql', '.lua', '.dart', '.vue', '.svelte', '.css', '.scss',
  '.toml', '.yaml', '.yml', '.json', '.xml', '.gradle', '.tf', '.proto', '.graphql', '.zig', '.ex', '.exs'
])
const TEXT_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.adoc', '.org', '.csv', '.log', '.ini', '.env.example'])
const RICH_EXT = new Set(['.pdf', '.docx', '.html', '.htm'])
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vscode', 'coverage', '.turbo', '.cache'])
const MAX_FILE_BYTES = 8 * 1024 * 1024

export function isIndexable(path: string): boolean {
  const ext = extname(path).toLowerCase()
  const name = basename(path).toLowerCase()
  return CODE_EXT.has(ext) || TEXT_EXT.has(ext) || RICH_EXT.has(ext) || ['readme', 'license', 'dockerfile', 'makefile'].includes(name)
}

/** Expand files and directories into a flat list of indexable files. */
export async function expandPaths(paths: string[], limit = 5000): Promise<string[]> {
  const out: string[] = []
  const walk = async (p: string): Promise<void> => {
    if (out.length >= limit) return
    const s = await stat(p)
    if (s.isDirectory()) {
      if (IGNORE_DIRS.has(basename(p))) return
      for (const entry of await readdir(p)) {
        if (entry.startsWith('.') && entry !== '.github') continue
        await walk(join(p, entry))
      }
    } else if (s.isFile() && s.size <= MAX_FILE_BYTES && isIndexable(p)) {
      out.push(p)
    }
  }
  for (const p of paths) await walk(p)
  return out
}

export async function extractFile(path: string): Promise<Extracted> {
  const ext = extname(path).toLowerCase()
  const title = basename(path)
  if (ext === '.pdf') {
    const { getDocumentProxy, extractText } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)))
    const { text } = await extractText(pdf, { mergePages: false })
    const pages = (Array.isArray(text) ? text : [text]).map((t, i) => `## Page ${i + 1}\n\n${t.trim()}`)
    return { title, text: pages.join('\n\n'), code: false }
  }
  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default
    const { value } = await mammoth.convertToHtml({ path })
    return { title, text: htmlToMarkdown(value), code: false }
  }
  const raw = await readFile(path, 'utf8')
  if (ext === '.html' || ext === '.htm') {
    const page = extractHtml(raw, `file://${path}`)
    return { ...page, title: page.title || title }
  }
  if (CODE_EXT.has(ext)) return { title, text: `// File: ${path}\n${raw}`, code: true }
  return { title, text: raw, code: false }
}

export async function fetchUrl(url: string, signal?: AbortSignal, caCertPath?: string): Promise<Extracted> {
  const res = await fetchWithWebCa(url, {
    signal: signal ?? AbortSignal.timeout(20_000),
    headers: { 'user-agent': 'Mozilla/5.0 (Cloth; offline developer hub)', accept: 'text/html,text/plain,text/markdown,application/pdf,*/*' },
    redirect: 'follow'
  }, caCertPath)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('application/pdf')) {
    const { getDocumentProxy, extractText } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()))
    const { text } = await extractText(pdf, { mergePages: true })
    return { title: url.split('/').pop() || url, text: String(text), code: false }
  }
  const body = await res.text()
  if (type.includes('text/html') || /^\s*<(!doctype|html)/i.test(body)) return extractHtml(body, res.url || url)
  return { title: url.split('/').pop() || url, text: body, code: false }
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button'])
// Images carry no searchable text (and relative URLs break out of context) — keep only alt text.
turndown.addRule('imageAlt', { filter: 'img', replacement: (_c, node) => ((node as { getAttribute(n: string): string | null }).getAttribute('alt') ?? '').trim() })

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim()
}

// linkedom's DOM is untyped for a Node tsconfig (no DOM lib); keep the `any` contained here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dom = any
const parseDom = (html: string): Dom => (parseHTML(html) as Dom).document

export function extractHtml(html: string, baseUrl: string): Extracted {
  const document = parseDom(html)
  const links = collectLinks(document, baseUrl)
  const pageTitle = document.querySelector('title')?.textContent?.trim() ?? ''

  let article: { title?: string | null; content?: string | null } | null = null
  try {
    // Readability mutates the DOM, so give it its own parse.
    article = new Readability(parseDom(html), { charThreshold: 200 }).parse()
  } catch {
    article = null
  }

  let markdown = article?.content ? htmlToMarkdown(article.content) : ''
  if (markdown.length < 200) {
    for (const sel of ['nav', 'header', 'footer', 'aside', 'script', 'style', '[role=navigation]', '.sidebar', '.toc']) {
      document.querySelectorAll(sel).forEach((el: Dom) => el.remove())
    }
    const root = document.querySelector('main, article, [role=main], .content, #content') ?? document.body
    markdown = htmlToMarkdown(root?.innerHTML ?? html)
  }
  return { title: article?.title?.trim() || pageTitle || baseUrl, text: markdown, code: false, links, html: true }
}

function collectLinks(document: Dom, baseUrl: string): string[] {
  const out = new Set<string>()
  document.querySelectorAll('a[href]').forEach((a: Dom) => {
    try {
      const u = new URL(a.getAttribute('href') ?? '', baseUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return
      u.hash = ''
      out.add(u.toString())
    } catch {
      /* ignore malformed */
    }
  })
  return [...out]
}
