import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, join, relative, sep } from 'node:path'
import type { LanguageId } from '@shared/onboarding'
import { installedJdtls, installedProgram, jdtlsJavaArgs } from './lsp-install'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { StreamMessageReader, StreamMessageWriter, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node'

/**
 * Code intelligence over the Language Server Protocol. Servers are bundled and start lazily per
 * workspace + language: TypeScript 7's native `tsc --lsp` (TS/JS) and Pyright (Python). gopls,
 * rust-analyzer, clangd and jdtls (Java) run from PATH when installed.
 */

const require = createRequire(import.meta.url)
const IDLE_MS = 10 * 60_000
/** jdtls answers `initialize` slowly on a cold JVM, then imports Maven/Gradle projects before it reports problems. */
const JAVA_START_MS = 120_000
const JAVA_IMPORT_MS = 5 * 60_000
const JAVA_MIN = 21

export interface Diagnostic {
  range: Range
  severity?: number
  message: string
  code?: string | number
  source?: string
}
export interface Range {
  start: { line: number; character: number }
  end: { line: number; character: number }
}
interface Location {
  uri: string
  range: Range
}
interface LocationLink {
  targetUri: string
  targetSelectionRange: Range
}
interface TextEdit {
  range: Range
  newText: string
}
interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
  documentChanges?: { textDocument: { uri: string }; edits: TextEdit[] }[]
}
interface DocumentSymbol {
  name: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
  location?: Location
  containerName?: string
}

type ServerId = 'typescript' | 'python' | 'go' | 'rust' | 'cpp' | 'java'

/** Servers Cloth doesn't ship: run from PATH when found, and only for languages the user works in. */
export const PATH_SERVERS: Record<'go' | 'rust' | 'cpp' | 'java', { program: string; args: string[]; language: LanguageId; url: string }> = {
  go: { program: 'gopls', args: [], language: 'go', url: 'https://pkg.go.dev/golang.org/x/tools/gopls' },
  rust: { program: 'rust-analyzer', args: [], language: 'rust', url: 'https://rust-analyzer.github.io/book/installation.html' },
  cpp: { program: 'clangd', args: [], language: 'cpp', url: 'https://clangd.llvm.org/installation' },
  // Eclipse JDT Language Server. Its launcher also needs Java 21+, and Python to run the launcher script.
  java: { program: 'jdtls', args: [], language: 'java', url: 'https://github.com/eclipse-jdtls/eclipse.jdt.ls#installation' }
}

/** A program's full path when it's on PATH (with Windows' PATHEXT), else null. */
export function findOnPath(program: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, program + ext)
      if (existsSync(full)) return full
    }
  }
  return null
}

const LANGUAGE_IDS: Record<string, { server: ServerId; languageId: string }> = {
  '.ts': { server: 'typescript', languageId: 'typescript' },
  '.mts': { server: 'typescript', languageId: 'typescript' },
  '.cts': { server: 'typescript', languageId: 'typescript' },
  '.tsx': { server: 'typescript', languageId: 'typescriptreact' },
  '.js': { server: 'typescript', languageId: 'javascript' },
  '.mjs': { server: 'typescript', languageId: 'javascript' },
  '.cjs': { server: 'typescript', languageId: 'javascript' },
  '.jsx': { server: 'typescript', languageId: 'javascriptreact' },
  '.py': { server: 'python', languageId: 'python' },
  '.pyi': { server: 'python', languageId: 'python' },
  '.go': { server: 'go', languageId: 'go' },
  '.rs': { server: 'rust', languageId: 'rust' },
  '.c': { server: 'cpp', languageId: 'c' },
  '.h': { server: 'cpp', languageId: 'c' },
  '.cc': { server: 'cpp', languageId: 'cpp' },
  '.cpp': { server: 'cpp', languageId: 'cpp' },
  '.cxx': { server: 'cpp', languageId: 'cpp' },
  '.hpp': { server: 'cpp', languageId: 'cpp' },
  '.java': { server: 'java', languageId: 'java' }
}

export function lspLanguage(file: string): { server: ServerId; languageId: string } | null {
  return LANGUAGE_IDS[extname(file).toLowerCase()] ?? null
}

/** Paths inside app.asar can't be executed; electron-builder unpacks these packages next to it. */
const unpacked = (p: string) => p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)

/** The java that jdtls' launcher will use (JAVA_HOME first, then PATH) and its major version, if it could be read. */
export function findJava(env: NodeJS.ProcessEnv = process.env): { path: string; major: number | null } | null {
  const home = env.JAVA_HOME && join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  const path = home && existsSync(home) ? home : findOnPath('java')
  if (!path) return null
  const out = spawnSync(path, ['-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  return { path, major: javaMajor(`${out.stderr ?? ''}${out.stdout ?? ''}`) }
}

/** `openjdk version "21.0.7"` -> 21; `java version "1.8.0_402"` -> 8. */
export function javaMajor(versionText: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(versionText)
  if (!m) return null
  return m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1])
}

/** jdtls' per-project workspace (index, build state): in Cloth's data folder, never in the user's project. */
export function jdtlsDataDir(base: string, root: string): string {
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  const name = basename(root).replace(/[^\w.-]/g, '_').slice(0, 40) || 'project'
  return join(base, 'jdtls', `${name}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`)
}

function command(id: ServerId, root: string, dataDir: string): { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (id === 'typescript') {
    const exe = process.platform === 'win32' ? 'tsc.exe' : 'tsc'
    // Packaged app: the native compiler ships as an extra resource together with its lib/*.d.ts
    // (electron-builder strips .d.ts files from node_modules).
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resources && existsSync(join(resources, 'typescript', 'lib', exe))) return { cmd: join(resources, 'typescript', 'lib', exe), args: ['--lsp', '--stdio'] }
    const pkg = `@typescript/typescript-${process.platform}-${process.arch}`
    let dir: string
    try {
      dir = dirname(require.resolve(`${pkg}/package.json`))
    } catch {
      throw new Error(`The bundled TypeScript language server isn't available for ${process.platform}-${process.arch}`)
    }
    return { cmd: unpacked(join(dir, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')), args: ['--lsp', '--stdio'] }
  }
  if (id !== 'python') {
    const { program, args } = PATH_SERVERS[id]
    // Cloth's own copy (Settings → Languages, or setup) comes first, then one on PATH.
    const servers = join(dataDir, 'servers')
    const managedJdtls = id === 'java' ? installedJdtls(servers) : null
    const cmd = id === 'java' ? (managedJdtls ? 'java' : findOnPath(program)) : (installedProgram(servers, id) ?? findOnPath(program))
    if (!cmd) throw new Error(`${program} isn't installed. Install it from Settings → Languages to get code intelligence for this language.`)
    if (id === 'java') {
      const java = findJava()
      if (!java) throw new Error(`jdtls needs Java ${JAVA_MIN} or newer, and no Java was found (install a JDK ${JAVA_MIN}+ and put it on PATH or set JAVA_HOME)`)
      if (java.major !== null && java.major < JAVA_MIN) throw new Error(`jdtls needs Java ${JAVA_MIN} or newer, but ${java.path} is Java ${java.major} (install a JDK ${JAVA_MIN}+ and put it first on PATH or set JAVA_HOME)`)
      const data = jdtlsDataDir(dataDir, root)
      mkdirSync(data, { recursive: true })
      if (managedJdtls) return { cmd: java.path, args: jdtlsJavaArgs(managedJdtls, data) }
      return { cmd, args: [...args, '-data', data] }
    }
    // .cmd/.bat shims need a shell on Windows.
    return { cmd, args }
  }
  // Pyright is JavaScript: run it on Electron's own Node.
  return { cmd: process.execPath, args: [unpacked(require.resolve('pyright/langserver.index.js')), '--stdio'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}

/** Servers differ in URI casing/encoding (e.g. `file:///e%3A/...`); compare by normalised path. */
export function uriKey(uri: string): string {
  const p = fileURLToPath(uri)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

class LspServer {
  private conn!: MessageConnection
  private proc!: ChildProcess
  private docs = new Map<string, { uri: string; version: number; text: string }>()
  private pushed = new Map<string, { version: number | null; items: Diagnostic[] }>()
  private waiters = new Set<() => void>()
  private pull = false
  private dead: string | null = null
  /** False while jdtls is still importing the project (its diagnostics until then are incomplete). */
  ready = true
  private readyWaiters = new Set<() => void>()
  lastUsed = Date.now()

  constructor(
    readonly id: ServerId,
    readonly root: string,
    private dataDir: string
  ) {
    if (id === 'java') this.ready = false
  }

  async start(): Promise<void> {
    const { cmd, args, env } = command(this.id, this.root, this.dataDir)
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    // Through a shell the arguments become one command line: quote those with spaces (the jdtls data folder).
    const argv = shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
    this.proc = spawn(shell ? `"${cmd}"` : cmd, argv, { cwd: this.root, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell })
    this.proc.on('exit', (code) => {
      this.dead = `language server exited (${code})`
      this.markReady()
    })
    this.proc.on('error', (err) => {
      this.dead = err.message
      this.markReady()
    })
    this.proc.stderr?.resume()
    this.conn = createMessageConnection(new StreamMessageReader(this.proc.stdout!), new StreamMessageWriter(this.proc.stdin!))
    this.conn.onNotification('textDocument/publishDiagnostics', (p: { uri: string; version?: number; diagnostics: Diagnostic[] }) => {
      this.pushed.set(uriKey(p.uri), { version: p.version ?? null, items: p.diagnostics })
      for (const w of this.waiters) w()
    })
    // jdtls reports `Started` / `ServiceReady` once the Maven/Gradle import is done.
    this.conn.onNotification('language/status', (p: { type?: string }) => {
      if (p.type === 'Started' || p.type === 'ServiceReady') this.markReady()
    })
    // Answer server->client requests (configuration, capability registration, progress) with defaults.
    this.conn.onRequest(() => null)
    this.conn.onNotification(() => undefined)
    this.conn.listen()
    const rootUri = pathToFileURL(this.root).href
    const init = (await this.timed<unknown>(
      this.conn.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false },
            hover: { contentFormat: ['plaintext', 'markdown'] },
            definition: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: false }
          },
          workspace: { workspaceFolders: true, symbol: {} }
        }
      }),
      this.id === 'java' ? JAVA_START_MS : 30_000,
      this.id === 'java' ? 'starting jdtls' : 'starting the language server'
    ).catch((err) => {
      // Don't leave a half-started server running.
      this.proc.kill()
      throw this.dead ? new Error(this.dead) : err
    })) as { capabilities: { diagnosticProvider?: unknown } }
    this.pull = !!init.capabilities.diagnosticProvider
    this.conn.sendNotification('initialized', {})
    if (!this.ready) setTimeout(() => this.markReady(), JAVA_IMPORT_MS).unref()
  }

  /** The project import finished (or we stopped waiting): re-send open files so they're checked against the imported project. */
  private markReady(): void {
    if (this.ready) return
    this.ready = true
    if (!this.dead) {
      for (const [key, doc] of this.docs) {
        doc.version++
        this.pushed.delete(key)
        this.conn.sendNotification('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text: doc.text }] })
      }
    }
    for (const w of this.readyWaiters) w()
    this.readyWaiters.clear()
  }

  /** Wait (up to ms) for jdtls to finish importing the project. */
  private untilReady(ms: number): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      this.readyWaiters.add(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private async timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let t: NodeJS.Timeout | undefined
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(`Timed out ${what}`)), ms)))])
    } finally {
      clearTimeout(t)
    }
  }

  /** Open the file, or send its new contents if it changed on disk since we last looked. */
  async sync(abs: string): Promise<string> {
    if (this.dead) throw new Error(this.dead)
    this.lastUsed = Date.now()
    const text = await readFile(abs, 'utf8')
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs
    const doc = this.docs.get(key)
    const uri = pathToFileURL(abs).href
    if (!doc) {
      this.docs.set(key, { uri, version: 1, text })
      this.conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: lspLanguage(abs)!.languageId, version: 1, text } })
    } else if (doc.text !== text) {
      doc.version++
      doc.text = text
      this.pushed.delete(key)
      this.conn.sendNotification('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] })
    }
    return uri
  }

  /** timeoutMs counts from when the server is ready: a first Java request also waits out the project import. */
  async diagnostics(abs: string, timeoutMs = 10_000): Promise<Diagnostic[]> {
    let uri = await this.sync(abs)
    if (!this.ready) {
      await this.untilReady(JAVA_IMPORT_MS)
      if (this.dead) throw new Error(this.dead)
      uri = await this.sync(abs)
    }
    if (this.pull) {
      const res = (await this.timed(this.conn.sendRequest('textDocument/diagnostic', { textDocument: { uri } }), timeoutMs, 'waiting for diagnostics')) as { items?: Diagnostic[] }
      return res.items ?? []
    }
    // Push model: wait for a report for the current version, then briefly for a settled one.
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs
    const version = this.docs.get(key)!.version
    const fresh = () => {
      const p = this.pushed.get(key)
      return p && (p.version === null || p.version >= version) ? p : null
    }
    const deadline = Date.now() + timeoutMs
    while (!fresh() && Date.now() < deadline) await this.nextPush(deadline - Date.now())
    if (!fresh()) throw new Error('Timed out waiting for diagnostics')
    await this.nextPush(400)
    return fresh()!.items
  }

  private nextPush(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t)
        this.waiters.delete(done)
        resolve()
      }
      const t = setTimeout(done, Math.max(0, ms))
      this.waiters.add(done)
    })
  }

  async request<T>(method: string, params: unknown, what = method): Promise<T> {
    if (this.dead) throw new Error(this.dead)
    this.lastUsed = Date.now()
    return (await this.timed(this.conn.sendRequest(method, params), 30_000, what)) as T
  }

  dispose(): void {
    try {
      void this.conn.sendRequest('shutdown').catch(() => undefined)
      this.conn.sendNotification('exit')
    } catch {
      /* already gone */
    }
    setTimeout(() => this.proc.kill(), 500).unref()
  }
}

/** One server per workspace root and language; started on first use, stopped when idle. */
export class LspManager {
  private servers = new Map<string, Promise<LspServer>>()
  private timer: NodeJS.Timeout | null = null

  /**
   * languages: the ones the user works in (settings.languages); empty = any server found on PATH may run.
   * dataDir: where servers keep per-project state (jdtls' workspaces), normally `<Cloth data>/lsp`.
   */
  constructor(
    private languages: () => LanguageId[] = () => [],
    private dataDir: string = join(tmpdir(), 'cloth-lsp')
  ) {}

  server(root: string, file: string): Promise<LspServer> {
    const lang = lspLanguage(file)
    if (!lang) throw new Error(`No language server for ${extname(file) || 'this file type'} (supported: TypeScript/JavaScript, Python, and Go, Rust, C/C++ or Java when their server is installed)`)
    if (lang.server !== 'typescript' && lang.server !== 'python') {
      const picked = this.languages()
      const { language } = PATH_SERVERS[lang.server]
      if (picked.length && !picked.includes(language)) throw new Error(`Code intelligence for ${extname(file)} files is off: add the language in Settings → Languages`)
    }
    const key = `${lang.server}|${process.platform === 'win32' ? root.toLowerCase() : root}`
    let s = this.servers.get(key)
    if (!s) {
      const server = new LspServer(lang.server, root, this.dataDir)
      s = server.start().then(() => server)
      s.catch(() => this.servers.delete(key))
      this.servers.set(key, s)
      this.timer ??= setInterval(() => this.reap(), 60_000)
      this.timer.unref()
    }
    return s
  }

  private reap(): void {
    for (const [key, p] of this.servers) {
      void p.then((s) => {
        if (Date.now() - s.lastUsed > IDLE_MS) {
          this.servers.delete(key)
          s.dispose()
        }
      }).catch(() => undefined)
    }
  }

  /** Where Cloth installs language servers of its own (lsp-install.ts). */
  get serversDir(): string {
    return join(this.dataDir, 'servers')
  }

  /** Stop every running server for a language (before its copy is replaced or removed). Waits for them to exit. */
  async stopServer(id: ServerId): Promise<void> {
    const stopping: Promise<void>[] = []
    for (const [key, p] of [...this.servers]) {
      if (!key.startsWith(`${id}|`)) continue
      this.servers.delete(key)
      stopping.push(p.then((s) => s.dispose()).catch(() => undefined))
    }
    await Promise.all(stopping)
    // Let the processes exit and release their files (Windows keeps a running .exe locked).
    if (stopping.length) await new Promise((r) => setTimeout(r, 1500))
  }

  disposeAll(): void {
    for (const p of this.servers.values()) void p.then((s) => s.dispose()).catch(() => undefined)
    this.servers.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// ─── Formatting helpers used by the `lsp` tool ────────────────────────────────

const SEVERITY = ['', 'error', 'warning', 'info', 'hint']

export function formatDiagnostics(rel: string, items: Diagnostic[], opts: { errorsOnly?: boolean; max?: number } = {}): string {
  const list = items.filter((d) => !opts.errorsOnly || d.severity === 1).slice(0, opts.max ?? 50)
  if (!list.length) return `${rel}: no ${opts.errorsOnly ? 'errors' : 'problems'}`
  return [`${rel}:`, ...list.map((d) => `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1] ?? 'error'}${d.code !== undefined ? ` ${d.source ?? ''}${d.code}` : ''}: ${d.message.split('\n')[0]}`)].join('\n')
}

/** 0-based position of `symbol` on `line` (1-based), or its first whole-word occurrence in the file. */
export function findPosition(text: string, symbol: string | undefined, line: number | undefined): { line: number; character: number } {
  const lines = text.split(/\r?\n/)
  const word = symbol ? new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`) : null
  if (line !== undefined) {
    const i = Math.min(Math.max(line - 1, 0), lines.length - 1)
    if (!word) return { line: i, character: Math.max(0, lines[i].search(/\S/)) }
    const m = word.exec(lines[i])
    if (m) return { line: i, character: m.index }
    // Models are often off by a line or two: look nearby before giving up.
    for (let d = 1; d <= 3; d++) {
      for (const j of [i - d, i + d]) {
        const mm = j >= 0 && j < lines.length ? word.exec(lines[j]) : null
        if (mm) return { line: j, character: mm.index }
      }
    }
    throw new Error(`"${symbol}" is not on line ${line}`)
  }
  if (!word) throw new Error('Give a symbol name (and ideally its line)')
  for (let i = 0; i < lines.length; i++) {
    const m = word.exec(lines[i])
    if (m) return { line: i, character: m.index }
  }
  throw new Error(`"${symbol}" does not appear in the file`)
}

export function locations(res: Location | Location[] | LocationLink[] | null): Location[] {
  if (!res) return []
  const list = Array.isArray(res) ? res : [res]
  return list.map((l) => ('targetUri' in l ? { uri: l.targetUri, range: l.targetSelectionRange } : l))
}

export async function describeLocations(root: string, locs: Location[], max = 50): Promise<string> {
  const cache = new Map<string, string[]>()
  const out: string[] = []
  for (const l of locs.slice(0, max)) {
    const abs = fileURLToPath(l.uri)
    if (!cache.has(abs)) cache.set(abs, (await readFile(abs, 'utf8').catch(() => '')).split(/\r?\n/))
    const lineText = cache.get(abs)![l.range.start.line]?.trim() ?? ''
    const rel = relative(root, abs)
    const shown = rel.startsWith('..') ? abs : rel.split(sep).join('/')
    out.push(`${shown}:${l.range.start.line + 1}: ${lineText.slice(0, 160)}`)
  }
  if (locs.length > max) out.push(`… ${locs.length - max} more`)
  return out.join('\n')
}

export function hoverText(res: { contents: unknown } | null): string {
  if (!res) return ''
  const c = res.contents as string | { value: string } | (string | { value: string })[]
  const parts = Array.isArray(c) ? c : [c]
  return parts.map((p) => (typeof p === 'string' ? p : p.value)).join('\n\n').trim()
}

const SYMBOL_KIND: Record<number, string> = { 2: 'module', 3: 'namespace', 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'enum member', 23: 'struct', 26: 'type parameter' }

export function outline(symbols: DocumentSymbol[], depth = 0, out: string[] = []): string[] {
  for (const s of symbols) {
    const r = s.selectionRange ?? s.location?.range
    out.push(`${'  '.repeat(depth)}${SYMBOL_KIND[s.kind] ?? 'symbol'} ${s.name} :${(r?.start.line ?? 0) + 1}`)
    if (s.children?.length && depth < 3) outline(s.children, depth + 1, out)
  }
  return out
}

/** Apply LSP text edits to a document's text (edits must not overlap). */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1)
  const offset = (p: { line: number; character: number }) => (lineStarts[p.line] ?? text.length) + p.character
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))
  let out = text
  for (const e of sorted) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end))
  return out
}

export function workspaceEditFiles(edit: WorkspaceEdit | null): { uri: string; edits: TextEdit[] }[] {
  if (!edit) return []
  if (edit.documentChanges?.length) return edit.documentChanges.filter((d) => d.textDocument && d.edits).map((d) => ({ uri: d.textDocument.uri, edits: d.edits }))
  return Object.entries(edit.changes ?? {}).map(([uri, edits]) => ({ uri, edits }))
}

export type { DocumentSymbol, Location, WorkspaceEdit }
