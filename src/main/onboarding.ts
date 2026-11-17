import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import type { McpClientConfig } from '@shared/types'
import type { BestPracticeCadence, FolderScan, ImportResult, ImportSelection, ImportSource, ImportSourceId, LanguageId, LanguageServerInfo } from '@shared/onboarding'
import { LANGUAGES } from '@shared/onboarding'
import { oauthOf } from '@shared/mcp-config'
import { newId } from './core/context'
import { findOnPath, PATH_SERVERS } from './agent/lsp'
import { parseSkillMd, slugify } from './skills/skills'
import type { Services } from './services'

/*
 * First-run setup's main-process side: a quick look through the chosen folder, which language servers
 * can run, what other coding tools on this PC have that Cloth can copy, and the best-practice library.
 * MCP servers' environment values and headers never go to the renderer: it gets names, and imports by name.
 */

const EXT_LANG: Record<string, LanguageId> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.c': 'cpp', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.java': 'java', '.kt': 'java', '.cs': 'csharp', '.php': 'php', '.rb': 'ruby'
}
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'coverage', 'bin', 'obj', '.idea', '.vscode', 'release'])
const PROJECT_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'CMakeLists.txt']
const MAX_FILES = 6000
const MAX_DEPTH = 6

/** Words in a project file that name a framework the setup offers. */
const FRAMEWORK_HINTS: [RegExp, string][] = [
  [/"react"\s*:/, 'React'], [/"next"\s*:/, 'Next.js'], [/"electron"\s*:/, 'Electron'], [/"vue"\s*:/, 'Vue'], [/"svelte"\s*:/, 'Svelte'],
  [/"@angular\/core"\s*:/, 'Angular'], [/"express"\s*:/, 'Express'], [/"@types\/node"\s*:/, 'Node.js'],
  [/\bfastapi\b/i, 'FastAPI'], [/\bdjango\b/i, 'Django'], [/\bflask\b/i, 'Flask'], [/\bpandas\b/i, 'pandas'], [/\btorch\b/i, 'PyTorch'],
  [/gin-gonic\/gin/, 'Gin'], [/labstack\/echo/, 'Echo'], [/^\s*tokio\s*=/m, 'Tokio'], [/^\s*axum\s*=/m, 'Axum'], [/^\s*tauri\s*=/m, 'Tauri'],
  [/spring-boot/, 'Spring Boot'], [/laravel\/framework/, 'Laravel'], [/symfony\//, 'Symfony'], [/['"]rails['"]/, 'Rails'], [/find_package\(Qt/, 'Qt']
]

export async function scanFolder(path: string): Promise<FolderScan> {
  const root = resolve(path)
  if (!existsSync(root)) throw new Error('That folder no longer exists')
  const counts = new Map<LanguageId, number>()
  const frameworks = new Set<string>()
  let seen = 0
  let partial = false

  const readHints = async (file: string) => {
    try {
      const text = await readFile(file, 'utf8')
      for (const [re, name] of FRAMEWORK_HINTS) if (re.test(text)) frameworks.add(name)
    } catch {
      /* unreadable */
    }
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || partial) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (seen >= MAX_FILES) {
        partial = true
        return
      }
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1)
        continue
      }
      if (!e.isFile()) continue
      seen++
      if (PROJECT_FILES.includes(e.name) || e.name.endsWith('.csproj')) {
        if (e.name.endsWith('.csproj')) frameworks.add('.NET')
        if (e.name === 'CMakeLists.txt') frameworks.add('CMake')
        if (depth <= 3) await readHints(join(dir, e.name))
      }
      const lang = EXT_LANG[extname(e.name).toLowerCase()]
      if (lang && !e.name.endsWith('.d.ts')) counts.set(lang, (counts.get(lang) ?? 0) + 1)
    }
  }
  await walk(root, 0)

  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const languages = [...counts.entries()]
    .map(([id, files]) => ({ id, files, share: total ? files / total : 0 }))
    .filter((l) => l.share >= 0.02 || l.files >= 5)
    .sort((a, b) => b.files - a.files)

  let git: FolderScan['git'] = null
  if (existsSync(join(root, '.git'))) {
    let branch: string | null = null
    try {
      branch = /ref:\s*refs\/heads\/(.+)/.exec(readFileSync(join(root, '.git', 'HEAD'), 'utf8'))?.[1]?.trim() ?? null
    } catch {
      /* a worktree's .git is a file; the branch stays unknown */
    }
    git = { branch }
  }
  const instructions = ['AGENTS.md', 'CLAUDE.md'].find((f) => existsSync(join(root, f))) ?? null

  const subprojects: string[] = []
  try {
    for (const e of await readdir(root, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      if (PROJECT_FILES.some((f) => existsSync(join(root, e.name, f)))) subprojects.push(e.name)
    }
  } catch {
    /* unreadable */
  }
  // Only offer frameworks of languages that are actually there.
  const offered = new Set(LANGUAGES.filter((l) => languages.some((x) => x.id === l.id)).flatMap((l) => l.frameworks))
  return { path: root, git, instructions, languages, frameworks: [...frameworks].filter((f) => offered.has(f)), subprojects: subprojects.slice(0, 12), partial }
}

export function languageServers(ids: LanguageId[]): LanguageServerInfo[] {
  return ids.map((id) => {
    if (id === 'typescript' || id === 'javascript') return { id, status: 'bundled', program: 'tsc --lsp' }
    if (id === 'python') return { id, status: 'bundled', program: 'pyright' }
    const server = Object.values(PATH_SERVERS).find((s) => s.language === id)
    if (!server) return { id, status: 'none', program: null }
    return findOnPath(server.program) ? { id, status: 'found', program: server.program } : { id, status: 'missing', program: server.program, url: server.url }
  })
}

// ─── Importing from other coding tools ────────────────────────────────────────

interface RawMcp {
  name: string
  config: Pick<McpClientConfig, 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'oauth'>
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const stringMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string') as [string, string][]) : {}

/** `mcpServers` in Claude Code, Claude Desktop and Cursor's JSON files. */
function mcpFromJson(obj: Record<string, unknown> | null): RawMcp[] {
  const servers = obj?.mcpServers
  if (!servers || typeof servers !== 'object') return []
  const out: RawMcp[] = []
  for (const [name, raw] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== 'object') continue
    const url = typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : null
    const oauth = oauthOf(raw.oauth) ?? undefined
    if (url) out.push({ name, config: { transport: 'http', command: '', args: [], env: {}, url, headers: stringMap(raw.headers), ...(oauth ? { oauth } : {}) } })
    else if (typeof raw.command === 'string') out.push({ name, config: { transport: 'stdio', command: raw.command, args: strings(raw.args), env: stringMap(raw.env) } })
  }
  return out
}

/** `[mcp_servers.<name>]` tables in Codex's config.toml (strings, string arrays and an env table). */
export function mcpFromCodexToml(text: string): RawMcp[] {
  const servers = new Map<string, RawMcp>()
  let current: { server: RawMcp; table: 'main' | 'env' | 'headers' } | null = null
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const header = /^\[([^\]]+)\]$/.exec(t)
    if (header) {
      const m = /^mcp_servers\.("?)([^".]+)\1(?:\.(env|headers|http_headers))?$/.exec(header[1].trim())
      if (!m) {
        current = null
        continue
      }
      const name = m[2]
      const server = servers.get(name) ?? { name, config: { transport: 'stdio', command: '', args: [], env: {} } }
      servers.set(name, server)
      current = { server, table: m[3] === 'env' ? 'env' : m[3] ? 'headers' : 'main' }
      continue
    }
    if (!current) continue
    const kv = /^([A-Za-z0-9_-]+|"[^"]+")\s*=\s*(.+)$/.exec(t)
    if (!kv) continue
    const key = kv[1].replace(/^"|"$/g, '')
    let value: unknown
    try {
      value = JSON.parse(kv[2].replace(/'([^']*)'/g, (_, s: string) => JSON.stringify(s)))
    } catch {
      continue
    }
    const c = current.server.config
    if (current.table === 'env' && typeof value === 'string') c.env[key] = value
    else if (current.table === 'headers' && typeof value === 'string') c.headers = { ...c.headers, [key]: value }
    else if (key === 'command' && typeof value === 'string') c.command = value
    else if (key === 'args') c.args = strings(value)
    else if (key === 'url' && typeof value === 'string') {
      c.transport = 'http'
      c.url = value
    } else if (key === 'env') c.env = { ...c.env, ...stringMap(value) }
  }
  return [...servers.values()].filter((s) => s.config.command || s.config.url)
}

function claudeDesktopConfig(): string {
  const home = homedir()
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  return join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

const summary = (m: RawMcp) => (m.config.transport === 'http' ? m.config.url ?? '' : [m.config.command, ...m.config.args].join(' ')).slice(0, 120)

async function agentFiles(dir: string): Promise<{ name: string; description: string; file: string; body: string; model: string | null }[]> {
  if (!existsSync(dir)) return []
  const out = []
  for (const f of await readdir(dir).catch(() => [])) {
    if (!f.endsWith('.md')) continue
    const file = join(dir, f)
    try {
      const { frontmatter, body } = parseSkillMd(await readFile(file, 'utf8'))
      if (!body.trim()) continue
      out.push({ name: String(frontmatter.name ?? basename(f, '.md')), description: String(frontmatter.description ?? ''), file, body: body.trim(), model: typeof frontmatter.model === 'string' ? frontmatter.model : null })
    } catch {
      /* unreadable */
    }
  }
  return out
}

export class OnboardingService {
  constructor(private s: Services) {}

  /** Each tool's MCP servers, with their full configs (main process only). */
  private mcpBySource(): Map<ImportSourceId, RawMcp[]> {
    const home = homedir()
    const map = new Map<ImportSourceId, RawMcp[]>()
    map.set('claude-code', mcpFromJson(readJson(join(home, '.claude.json'))))
    map.set('claude-desktop', mcpFromJson(readJson(claudeDesktopConfig())))
    map.set('cursor', mcpFromJson(readJson(join(home, '.cursor', 'mcp.json'))))
    let codex: RawMcp[] = []
    try {
      codex = mcpFromCodexToml(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'))
    } catch {
      /* not there */
    }
    map.set('codex', codex)
    return map
  }

  private async allAgents() {
    return agentFiles(join(homedir(), '.claude', 'agents'))
  }

  async sources(): Promise<ImportSource[]> {
    const home = homedir()
    const meta: Record<ImportSourceId, { name: string; path: string }> = {
      'claude-code': { name: 'Claude Code', path: join(home, '.claude') },
      'claude-desktop': { name: 'Claude Desktop', path: claudeDesktopConfig() },
      cursor: { name: 'Cursor', path: join(home, '.cursor') },
      codex: { name: 'Codex', path: join(home, '.codex') },
      agents: { name: 'Shared agent skills', path: join(home, '.agents') },
      omp: { name: 'oh-my-pi', path: join(home, '.omp') }
    }
    const sourceOf = (dir: string): ImportSourceId | null => {
      const d = dir.toLowerCase()
      if (d.startsWith(join(home, '.claude').toLowerCase())) return 'claude-code'
      if (d.startsWith(join(home, '.codex').toLowerCase())) return 'codex'
      if (d.startsWith(join(home, '.cursor').toLowerCase())) return 'cursor'
      if (d.startsWith(join(home, '.agents').toLowerCase())) return 'agents'
      if (d.startsWith(join(home, '.omp').toLowerCase())) return 'omp'
      return null
    }
    const out = new Map<ImportSourceId, ImportSource>()
    const get = (id: ImportSourceId) => {
      let src = out.get(id)
      if (!src) out.set(id, (src = { id, ...meta[id], skills: [], agents: [], mcp: [] }))
      return src
    }
    for (const sk of await this.s.skills.discover().catch(() => [])) {
      const id = sourceOf(sk.dir)
      if (id) get(id).skills.push({ name: sk.name, description: sk.description, dir: sk.dir, imported: sk.imported })
    }
    const agentNames = new Set(this.s.agents.list().map((a) => a.name.toLowerCase()))
    for (const a of await this.allAgents()) get('claude-code').agents.push({ name: a.name, description: a.description, file: a.file, imported: agentNames.has(a.name.toLowerCase()) })
    const existing = new Set(this.s.settings.get().mcpClients.map((c) => c.name.toLowerCase()))
    for (const [id, servers] of this.mcpBySource()) for (const m of servers) get(id).mcp.push({ name: m.name, summary: summary(m), imported: existing.has(slugify(m.name)) || existing.has(m.name.toLowerCase()) })
    const order: ImportSourceId[] = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'agents', 'omp']
    return order.map((id) => out.get(id)).filter((s): s is ImportSource => !!s && s.skills.length + s.agents.length + s.mcp.length > 0)
  }

  /** Copies what was picked. Only items found by sources() can be imported, never arbitrary paths. */
  async importItems(sel: ImportSelection): Promise<ImportResult> {
    const result: ImportResult = { skills: [], agents: [], mcp: [], errors: [] }
    const known = await this.sources()
    const skillDirs = new Set(known.flatMap((s) => s.skills.map((k) => k.dir)))
    for (const dir of sel.skills ?? []) {
      if (!skillDirs.has(dir)) continue
      try {
        result.skills.push(...(await this.s.skills.importFrom(dir)))
      } catch (err) {
        result.errors.push(`${basename(dir)}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const agents = await this.allAgents()
    for (const file of sel.agents ?? []) {
      const a = agents.find((x) => x.file === file)
      if (!a) continue
      try {
        result.agents.push(this.s.agents.create({ name: a.name, purpose: a.description || `Imported from Claude Code (${basename(file)})`, instructions: a.body }).name)
      } catch (err) {
        result.errors.push(`${a.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (sel.mcp?.length) {
      const bySource = this.mcpBySource()
      const clients = [...this.s.settings.get().mcpClients]
      const taken = new Set(clients.map((c) => c.name.toLowerCase()))
      for (const { source, name } of sel.mcp) {
        const raw = bySource.get(source)?.find((m) => m.name === name)
        if (!raw) continue
        const slug = slugify(name) || 'server'
        if (taken.has(slug)) continue
        taken.add(slug)
        // Switched off: they run programs on this PC, so each is turned on from the MCP page after a look.
        clients.push({ id: newId('mcp_'), name: slug, ...raw.config, enabled: false, defaultOn: false, approval: 'ask' })
        result.mcp.push(slug)
      }
      if (result.mcp.length) this.s.settings.update({ mcpClients: clients })
    }
    return result
  }

  /**
   * The best-practice library: a Knowledge collection and an automation that searches the web for current
   * guidance on the languages and frameworks and saves it there. Running setup again updates both.
   * Runs once straight away.
   */
  async bestPractices(input: { languages: LanguageId[]; frameworks: string[]; cadence: BestPracticeCadence }): Promise<{ collectionId: string; workflowId: string }> {
    const settings = this.s.settings.get()
    if (!settings.defaultModel) throw new Error('Connect a model first: the library is written by your default model')
    const names = [...input.languages.map((id) => LANGUAGES.find((l) => l.id === id)?.name ?? id), ...input.frameworks]
    if (!names.length) throw new Error('Pick at least one language')
    const prev = settings.onboarding?.bestPractices
    const collection = (prev && this.s.rag.listCollections().find((c) => c.id === prev.collectionId)) || this.s.rag.createCollection({ name: 'Best practices', description: `Current good practice for ${names.join(', ')}, kept up to date by an automation.` })
    const prompt = [
      `Keep the "Best practices" knowledge collection current for these languages and frameworks: ${names.join(', ')}.`,
      '',
      'For each one:',
      '1. Search the web for current, authoritative guidance (official docs, style guides, release notes from the last two years). Prefer primary sources over blog posts.',
      '2. Read the best two or three pages with web_fetch.',
      '3. Write one concise reference note: idiomatic style, project layout, testing, error handling, security pitfalls, performance, and what changed in recent versions. Cite each source URL.',
      '4. Save it with save_to_knowledge, titled "<name> best practices", replacing the older note of the same title.',
      '',
      'Skip anything you cannot verify from a source. Finish with a one-line summary of what you updated.'
    ].join('\n')
    const cron = input.cadence === 'weekly' ? '0 9 * * 1' : input.cadence === 'monthly' ? '0 9 1 * *' : null
    const automation = { prompt, agentId: null, tools: ['web_search', 'web_fetch'], servers: [], collectionIds: [collection.id], skills: [], watch: null, commands: null }
    const existing = prev ? this.s.workflows.list().find((w) => w.id === prev.workflowId) : undefined
    const wf = existing
      ? this.s.workflows.saveAutomation(existing.id, { automation, cron, cronEnabled: !!cron })
      : this.s.workflows.createAutomation({ name: 'Refresh best practices', automation, cron, cronEnabled: !!cron })
    void this.s.workflows.run(wf.id, undefined).catch(() => undefined)
    return { collectionId: collection.id, workflowId: wf.id }
  }
}
