import { createRequire } from 'node:module'
import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { Lang, parse, registerDynamicLanguage, type SgNode } from '@ast-grep/napi'

/**
 * Structural (AST) search and rewrite with ast-grep. Patterns are code with metavariables:
 * `$NAME` matches one node, `$$$ARGS` matches a list, e.g. `console.log($$$ARGS)` or
 * `useState($INIT)`. Rewrites reuse the captured metavariables.
 */

const require = createRequire(import.meta.url)

/** Extra tree-sitter grammars shipped as prebuilt parsers. */
const DYNAMIC: Record<string, string> = { python: '@ast-grep/lang-python', go: '@ast-grep/lang-go', rust: '@ast-grep/lang-rust', java: '@ast-grep/lang-java' }

const BUILTIN_EXT: Record<string, string> = {
  '.ts': Lang.TypeScript,
  '.mts': Lang.TypeScript,
  '.cts': Lang.TypeScript,
  '.tsx': Lang.Tsx,
  '.js': Lang.JavaScript,
  '.mjs': Lang.JavaScript,
  '.cjs': Lang.JavaScript,
  '.jsx': Lang.JavaScript,
  '.html': Lang.Html,
  '.htm': Lang.Html,
  '.css': Lang.Css
}
const DYNAMIC_EXT: Record<string, string> = { '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java' }
const ALIASES: Record<string, string> = {
  ts: Lang.TypeScript,
  typescript: Lang.TypeScript,
  tsx: Lang.Tsx,
  js: Lang.JavaScript,
  javascript: Lang.JavaScript,
  jsx: Lang.JavaScript,
  html: Lang.Html,
  css: Lang.Css,
  py: 'python',
  python: 'python',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java'
}

const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', '__pycache__', 'vendor'])
const MAX_FILES = 5000
const MAX_BYTES = 1_000_000

let dynamicLoaded: Set<string> | null = null

/** Register the bundled grammars once; a grammar that fails to load is skipped, not fatal. */
function loadDynamic(): Set<string> {
  if (dynamicLoaded) return dynamicLoaded
  const regs: Parameters<typeof registerDynamicLanguage>[0] = {}
  for (const [name, pkg] of Object.entries(DYNAMIC)) {
    try {
      const mod = require(pkg) as { libraryPath: string; extensions: string[]; languageSymbol?: string; expandoChar?: string }
      // Native libraries can't be loaded from inside app.asar; electron-builder unpacks them next to it.
      const libraryPath = mod.libraryPath.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
      regs[name] = { libraryPath, extensions: mod.extensions, languageSymbol: mod.languageSymbol, expandoChar: mod.expandoChar }
    } catch {
      /* grammar not available on this platform */
    }
  }
  try {
    registerDynamicLanguage(regs)
    dynamicLoaded = new Set(Object.keys(regs))
  } catch {
    dynamicLoaded = new Set()
  }
  return dynamicLoaded
}

export function supportedLanguages(): string[] {
  return ['typescript', 'tsx', 'javascript', 'html', 'css', ...loadDynamic()]
}

export function resolveLanguage(name: string | undefined): string | null {
  if (!name) return null
  const lang = ALIASES[name.toLowerCase()]
  if (!lang) throw new Error(`Unsupported language "${name}". Supported: ${supportedLanguages().join(', ')}`)
  if (Object.values(DYNAMIC_EXT).includes(lang) && !loadDynamic().has(lang)) throw new Error(`The ${lang} grammar is not available on this platform`)
  return lang
}

export function languageOf(file: string): string | null {
  const ext = extname(file).toLowerCase()
  if (BUILTIN_EXT[ext]) return BUILTIN_EXT[ext]
  const dyn = DYNAMIC_EXT[ext]
  return dyn && loadDynamic().has(dyn) ? dyn : null
}

async function* walk(target: string, lang: string | null, signal?: AbortSignal): AsyncGenerator<{ abs: string; lang: string }> {
  let count = 0
  const visit = async function* (dir: string): AsyncGenerator<{ abs: string; lang: string }> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (signal?.aborted || count >= MAX_FILES) return
      if (IGNORED.has(e.name)) continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) yield* visit(abs)
      else if (e.isFile()) {
        const l = languageOf(abs)
        if (!l || (lang && l !== lang)) continue
        count++
        yield { abs, lang: l }
      }
    }
  }
  if ((await stat(target)).isFile()) {
    const l = languageOf(target)
    if (!l) throw new Error(`No AST support for ${extname(target) || 'this file type'}. Supported: ${supportedLanguages().join(', ')}`)
    if (!lang || l === lang) yield { abs: target, lang: l }
    return
  }
  yield* visit(target)
}

function matchesIn(source: string, lang: string, pattern: string): SgNode[] {
  try {
    return parse(lang, source).root().findAll(pattern)
  } catch (err) {
    throw new Error(`Invalid ${lang} pattern: ${err instanceof Error ? err.message : err}`)
  }
}

export interface AstMatch {
  file: string
  line: number
  text: string
}

export async function astSearch(root: string, target: string, opts: { pattern: string; lang: string | null; max: number; signal?: AbortSignal }): Promise<{ matches: AstMatch[]; files: number }> {
  const matches: AstMatch[] = []
  let files = 0
  for await (const f of walk(target, opts.lang, opts.signal)) {
    if ((await stat(f.abs)).size > MAX_BYTES) continue
    files++
    for (const node of matchesIn(await readFile(f.abs, 'utf8'), f.lang, opts.pattern)) {
      const r = node.range()
      matches.push({ file: relative(root, f.abs).split(sep).join('/'), line: r.start.line + 1, text: node.text() })
      if (matches.length >= opts.max) return { matches, files }
    }
  }
  return { matches, files }
}

/** Fill `$NAME` and `$$$NAME` in the rewrite template from a match's captures. */
export function renderRewrite(node: SgNode, template: string, source: string): string {
  return template.replace(/\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g, (whole, multi: string | undefined, single: string | undefined) => {
    if (multi) {
      const nodes = node.getMultipleMatches(multi)
      if (!nodes.length) return ''
      return source.slice(nodes[0].range().start.index, nodes[nodes.length - 1].range().end.index)
    }
    const m = node.getMatch(single!)
    return m ? m.text() : whole
  })
}

export interface AstChange {
  abs: string
  before: string
  after: string
  count: number
}

export async function astRewrite(target: string, opts: { pattern: string; rewrite: string; lang: string | null; signal?: AbortSignal }): Promise<AstChange[]> {
  const out: AstChange[] = []
  for await (const f of walk(target, opts.lang, opts.signal)) {
    if ((await stat(f.abs)).size > MAX_BYTES) continue
    const before = await readFile(f.abs, 'utf8')
    const root = parse(f.lang, before).root()
    let nodes: SgNode[]
    try {
      nodes = root.findAll(opts.pattern)
    } catch (err) {
      throw new Error(`Invalid ${f.lang} pattern: ${err instanceof Error ? err.message : err}`)
    }
    // Nested matches (e.g. a call inside a matching call) would produce overlapping edits: keep the outermost.
    nodes = nodes.filter((n, i) => {
      const r = n.range()
      return !nodes.some((o, j) => j !== i && o.range().start.index <= r.start.index && o.range().end.index >= r.end.index && (o.range().start.index !== r.start.index || o.range().end.index !== r.end.index))
    })
    if (!nodes.length) continue
    const edits = nodes.map((n) => n.replace(renderRewrite(n, opts.rewrite, before)))
    const after = root.commitEdits(edits)
    if (after !== before) out.push({ abs: f.abs, before, after, count: nodes.length })
  }
  return out
}
