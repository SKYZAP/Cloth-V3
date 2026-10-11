import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  ModelDownloadInfo,
  ModelInfo,
  Provider,
  RunDetection,
  RunDevice,
  RunEvent,
  Runner,
  RunnerBuiltin,
  RunnerInput,
  RunnerPatch,
  RunnerStatus,
  RuntimeBackend,
  RuntimeOptions
} from '@shared/types'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import { isReasoningModelId, type ProviderService } from '../providers/providers'
import { killTree, run } from '../web/process'
import { downloadFile, remoteSize, USER_AGENT, type Fetch } from './download'
import { unzip } from './zip'

// ─── Constants ────────────────────────────────────────────────────────────────

export const PRISM_RELEASES_LATEST = 'https://api.github.com/repos/PrismML-Eng/llama.cpp/releases/latest'
export const BONSAI_REPO = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
export const BONSAI_MODEL_FILE = 'Ternary-Bonsai-2-27B-PQ2_0.gguf'
export const BONSAI_MMPROJ_FILE = 'Ternary-Bonsai-2-27B-mmproj-BF16.gguf'
export const RUNTIME_BACKENDS: RuntimeBackend[] = ['hip-radeon', 'vulkan', 'cuda-12.4', 'cpu']

const LOG_LINES = 2000
const HEALTH_TIMEOUT_MS = 10 * 60_000
const HEALTH_INTERVAL_MS = 500
/** Provider ids for runners exposed to chats. */
const PROVIDER_PREFIX = 'run-'

export const FORMAT_ERROR = "This llama.cpp can't read this model's format. Use the build it needs (e.g. PrismML's for Bonsai)."
export const DEVICE_ERROR = "That GPU isn't available to this llama.cpp build."

type RunnerConfig = Omit<Runner, 'id' | 'name' | 'builtin' | 'createdAt' | 'updatedAt'>

const BUILTINS: Record<RunnerBuiltin, { name: string; config: RunnerConfig }> = {
  'bonsai-2-27b': {
    name: 'Bonsai 2 27B',
    config: {
      serverPath: null,
      modelPath: null,
      mmprojPath: null,
      device: null,
      gpuLayers: 99,
      contextSize: 32768,
      port: 8090,
      flashAttention: true,
      sampling: { temp: 1.0, topP: 0.95, topK: 20, minP: 0.05 },
      extraArgs: '--jinja',
      alias: 'bonsai-2-27b',
      useInChats: true
    }
  }
}

const DEFAULTS: RunnerConfig = {
  serverPath: null,
  modelPath: null,
  mmprojPath: null,
  device: null,
  gpuLayers: 99,
  contextSize: 8192,
  port: 8091,
  flashAttention: true,
  sampling: {},
  extraArgs: '',
  alias: 'local-model',
  useInChats: true
}

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

/** Split a command line into arguments; "double" and 'single' quotes group words. Backslashes are literal (Windows paths). */
export function splitArgs(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur)
      cur = ''
      started = false
    } else {
      cur += ch
      started = true
    }
  }
  if (started) out.push(cur)
  return out
}

const exeName = (platform: NodeJS.Platform) => (platform === 'win32' ? 'llama-server.exe' : 'llama-server')

/** The llama-server executable for a configured path (the file itself, or a folder holding it), or null. */
export function resolveServer(serverPath: string | null, platform: NodeJS.Platform = process.platform): string | null {
  if (!serverPath?.trim()) return null
  const p = serverPath.trim()
  try {
    const st = statSync(p)
    if (st.isFile()) return p
    if (st.isDirectory()) {
      for (const name of [exeName(platform), 'llama-server.exe', 'llama-server']) {
        const f = join(p, name)
        if (existsSync(f) && statSync(f).isFile()) return f
      }
    }
  } catch {
    /* missing */
  }
  return null
}

/** The command that starts a runner: always the full path, run from its own folder. */
export function buildCommand(runner: Runner, server: string): { file: string; args: string[]; cwd: string } {
  if (!runner.modelPath) throw new Error(`${runner.name} has no model file set`)
  const args = ['-m', runner.modelPath]
  if (runner.mmprojPath) args.push('--mmproj', runner.mmprojPath)
  if (runner.device) args.push('--device', runner.device)
  args.push('-ngl', String(runner.gpuLayers), '-fa', runner.flashAttention ? 'on' : 'off', '-c', String(runner.contextSize))
  args.push('--host', '127.0.0.1', '--port', String(runner.port), '--alias', runner.alias)
  const s = runner.sampling ?? {}
  if (s.temp !== undefined && s.temp !== null) args.push('--temp', String(s.temp))
  if (s.topP !== undefined && s.topP !== null) args.push('--top-p', String(s.topP))
  if (s.topK !== undefined && s.topK !== null) args.push('--top-k', String(s.topK))
  if (s.minP !== undefined && s.minP !== null) args.push('--min-p', String(s.minP))
  args.push(...splitArgs(runner.extraArgs ?? ''))
  return { file: server, args, cwd: dirname(server) }
}

/** Generation speed from a llama-server log line, or null. */
export function parseTokensPerSecond(line: string): number | null {
  const m =
    /\btg\s*=\s*([\d.]+)\s*t\/s/i.exec(line) ??
    /predicted_per_second["'\s:=]+([\d.]+)/.exec(line) ??
    /(?<!prompt )\beval time\s*=.*?([\d.]+)\s+tokens per second/i.exec(line)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** A plain-language reason a llama-server run failed, from its last log lines. */
export function explainFailure(lines: string[], code: number | null, port?: number): string {
  const text = lines.join('\n')
  if (/invalid ggml type|unknown ggml type|ggml type \d+ .*invalid|unsupported (?:ggml )?type/i.test(text)) return FORMAT_ERROR
  if (/invalid device|unknown device|device .*not found|no device named/i.test(text)) return DEVICE_ERROR
  if (/couldn't bind|could not bind|address already in use|bind.*(failed|error)|EADDRINUSE/i.test(text)) {
    return `${port ? `Port ${port}` : 'The port'} is already in use by another program. Pick a different port.`
  }
  const errs = lines.filter((l) => /error|failed|exception|abort|cannot|can't|unable/i.test(l))
  const tail = (errs.length ? errs : lines).slice(-3).map((l) => l.trim()).filter(Boolean)
  return `llama-server stopped${code !== null ? ` (exit code ${code})` : ''}${tail.length ? `: ${tail.join(' | ')}` : ''}`
}

/** `llama-server --list-devices` output → devices. */
export function parseDevices(text: string): RunDevice[] {
  const out: RunDevice[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][\w-]*?\d+)\s*:\s*(.+?)\s*\(\s*(\d+)\s*MiB\s*,\s*(\d+)\s*MiB free\s*\)\s*$/.exec(line)
    if (m) out.push({ id: m[1], description: m[2], totalMiB: Number(m[3]), freeMiB: Number(m[4]) })
  }
  return out
}

interface ReleaseJson {
  tag_name?: string
  html_url?: string
  assets?: { name: string; size: number; browser_download_url: string }[]
}

/** The Windows build per backend in a PrismML release (`llama-prism-<tag>-bin-win-<backend>-x64.zip`). */
export function pickRuntimeAssets(release: ReleaseJson): RuntimeOptions {
  const tag = release.tag_name ?? ''
  if (!tag) throw new Error('The release has no tag')
  const assets: RuntimeOptions['assets'] = []
  for (const backend of RUNTIME_BACKENDS) {
    const exact = `llama-prism-${tag}-bin-win-${backend}-x64.zip`
    const loose = new RegExp(`^llama-prism-.+-bin-win-${backend.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-x64\\.zip$`)
    const a = release.assets?.find((x) => x.name === exact) ?? release.assets?.find((x) => loose.test(x.name))
    if (a) assets.push({ backend, name: a.name, size: a.size, url: a.browser_download_url })
  }
  return { tag, source: release.html_url ?? `https://github.com/PrismML-Eng/llama.cpp/releases/tag/${tag}`, assets }
}

/** Hugging Face hub cache folder: HF_HUB_CACHE, else HF_HOME/hub, else ~/.cache/huggingface/hub. */
export function hfHubCache(env: NodeJS.ProcessEnv, home: string): string {
  if (env.HF_HUB_CACHE?.trim()) return env.HF_HUB_CACHE.trim()
  if (env.HF_HOME?.trim()) return join(env.HF_HOME.trim(), 'hub')
  return join(home, '.cache', 'huggingface', 'hub')
}

// ─── Process plumbing ────────────────────────────────────────────────────────

/** What RunService needs from a spawned process (a ChildProcess fits). */
export interface RunChild {
  pid?: number
  stdout: Readable | null
  stderr: Readable | null
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type RunSpawn = (file: string, args: string[], opts: { cwd: string }) => RunChild

export interface RunDeps {
  spawn: RunSpawn
  /** Kill a process tree. */
  kill: (child: RunChild) => Promise<void>
  fetch: Fetch
  /** Runs `<server> --list-devices`. */
  exec: (file: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>
  /** Whether nothing listens on 127.0.0.1:port. */
  portFree: (port: number) => Promise<boolean>
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  releasesUrl: string
  /** Base for model files: `<base>/<repo>/resolve/main/<file>`. */
  hfBase: string
  healthTimeoutMs: number
  healthIntervalMs: number
}

export function defaultRunDeps(): RunDeps {
  return {
    spawn: (file, args, opts) =>
      nodeSpawn(file, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }),
    kill: async (child) => {
      if (child.pid) await killTree(child.pid)
      else child.kill()
    },
    fetch: (...a) => fetch(...a),
    exec: (file, args, cwd) => run(file, args, { timeoutMs: 60_000, cwd }),
    portFree,
    platform: process.platform,
    home: homedir(),
    env: process.env,
    releasesUrl: PRISM_RELEASES_LATEST,
    hfBase: 'https://huggingface.co',
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
    healthIntervalMs: HEALTH_INTERVAL_MS
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

interface Live {
  child: RunChild
  status: RunnerStatus
  stopping: boolean
  partial: { out: string; err: string }
}

interface RunnerRow {
  id: string
  name: string
  builtin: string | null
  config: string
  created_at: number
  updated_at: number
}

// ─── Service ─────────────────────────────────────────────────────────────────

/** Runs local models with llama.cpp's llama-server ("Run" page). */
export class RunService {
  private deps: RunDeps
  private live = new Map<string, Live>()
  /** Last status of runners that aren't running (errors stay visible). */
  private last = new Map<string, RunnerStatus>()
  private logs = new Map<string, string[]>()
  private downloads = new Map<string, AbortController>()
  private seeded = false

  constructor(
    private ctx: Ctx,
    private providers: ProviderService,
    deps: Partial<RunDeps> = {}
  ) {
    // Leave out undefined overrides so they fall back to the defaults.
    this.deps = { ...defaultRunDeps(), ...(Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)) as Partial<RunDeps>) }
    providers.missingHint = (id) => this.missingHint(id)
  }

  // ── Runners ──

  list(): Runner[] {
    this.seed()
    this.autofill()
    return (this.ctx.db.prepare('SELECT * FROM runners ORDER BY builtin IS NULL, created_at').all() as unknown as RunnerRow[]).map(toRunner)
  }

  get(id: string): Runner {
    this.seed()
    const row = this.ctx.db.prepare('SELECT * FROM runners WHERE id = ?').get(id) as RunnerRow | undefined
    if (!row) throw new Error(`Unknown runner ${id}`)
    return toRunner(row)
  }

  create(input: RunnerInput): Runner {
    this.seed()
    const taken = new Set(this.list().map((r) => r.port))
    let port = DEFAULTS.port
    while (taken.has(port)) port++
    const name = input.name?.trim() || 'Local model'
    const config = validate({ ...DEFAULTS, port, alias: slug(name) || DEFAULTS.alias, ...pickConfig(input) })
    const id = newId('rnr_')
    const now = Date.now()
    this.ctx.db.prepare('INSERT INTO runners (id, name, builtin, config, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)').run(id, name, JSON.stringify(config), now, now)
    this.emitStatus(id)
    return this.get(id)
  }

  update(id: string, patch: RunnerPatch): Runner {
    const cur = this.get(id)
    const { id: _i, name: _n, builtin: _b, createdAt: _c, updatedAt: _u, ...config } = cur
    const next = validate({ ...config, ...pickConfig(patch) })
    const name = patch.name?.trim() || cur.name
    this.ctx.db.prepare('UPDATE runners SET name = ?, config = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(next), Date.now(), id)
    const runner = this.get(id)
    // Name, alias or chat use apply to the picker at once; server settings on the next start.
    if (this.live.get(id)?.status.state === 'running') this.expose(runner)
    this.emitStatus(id)
    return runner
  }

  async remove(id: string): Promise<void> {
    const cur = this.get(id)
    if (cur.builtin) throw new Error(`${cur.name} is built in; you can edit it but not delete it`)
    this.cancelDownload(id)
    await this.stop(id)
    this.ctx.db.prepare('DELETE FROM runners WHERE id = ?').run(id)
    this.last.delete(id)
    this.logs.delete(id)
  }

  // ── Status / logs ──

  status(): RunnerStatus[] {
    return this.list().map((r) => this.statusOf(r.id))
  }

  statusOf(id: string): RunnerStatus {
    return { ...(this.live.get(id)?.status ?? this.last.get(id) ?? { id, state: 'stopped' }) }
  }

  logsOf(id: string): string[] {
    return [...(this.logs.get(id) ?? [])]
  }

  // ── Process ──

  async start(id: string): Promise<RunnerStatus> {
    const runner = this.get(id)
    const cur = this.live.get(id)
    if (cur) return { ...cur.status }
    const server = resolveServer(runner.serverPath, this.deps.platform)
    if (!server) {
      return this.fail(id, runner.serverPath ? `llama-server not found at ${runner.serverPath}` : `Choose llama-server for ${runner.name} first (or download PrismML's build)`)
    }
    if (!runner.modelPath) return this.fail(id, `Choose a model file (.gguf) for ${runner.name} first`)
    if (!existsSync(runner.modelPath)) return this.fail(id, `Model file not found: ${runner.modelPath}`)
    if (runner.mmprojPath && !existsSync(runner.mmprojPath)) return this.fail(id, `Vision projector not found: ${runner.mmprojPath}`)
    for (const otherId of this.live.keys()) {
      if (otherId === id) continue
      const o = this.get(otherId)
      if (o.port === runner.port) return this.fail(id, `Port ${runner.port} is used by ${o.name}, which is running. Stop it or pick a different port.`)
    }
    if (!(await this.deps.portFree(runner.port))) return this.fail(id, `Port ${runner.port} is already in use by another program. Pick a different port.`)
    if (this.live.has(id)) return this.statusOf(id)

    const { file, args, cwd } = buildCommand(runner, server)
    this.logs.set(id, [])
    this.pushLines(id, [`> ${file} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`])
    let child: RunChild
    try {
      child = this.deps.spawn(file, args, { cwd })
    } catch (err) {
      return this.fail(id, `Couldn't start llama-server: ${errorMessage(err)}`)
    }
    const url = `http://127.0.0.1:${runner.port}`
    const live: Live = { child, stopping: false, partial: { out: '', err: '' }, status: { id, state: 'starting', pid: child.pid, url, startedAt: Date.now() } }
    this.live.set(id, live)
    this.last.delete(id)
    const onData = (key: 'out' | 'err') => (buf: Buffer | string) => {
      const text = live.partial[key] + buf.toString()
      const parts = text.split(/\r?\n/)
      live.partial[key] = parts.pop() ?? ''
      this.onLines(id, live, parts.filter((l) => l.trim()))
    }
    child.stdout?.on('data', onData('out'))
    child.stderr?.on('data', onData('err'))
    let spawnError: string | null = null
    child.on('error', (err) => {
      spawnError = (err as NodeJS.ErrnoException).code === 'ENOENT' ? `llama-server not found at ${file}` : `Couldn't start llama-server: ${err.message}`
      // A process that never started emits no exit.
      if (!child.pid) this.onExit(id, live, null, spawnError)
    })
    child.on('exit', (code) => this.onExit(id, live, code, spawnError))
    this.ctx.log('run', `starting ${runner.name}: ${file}`)
    this.emitStatus(id)
    void this.waitHealthy(id, live, url)
    return { ...live.status }
  }

  async stop(id: string): Promise<RunnerStatus> {
    const live = this.live.get(id)
    if (!live) return this.statusOf(id)
    live.stopping = true
    await this.deps.kill(live.child)
    // The exit handler settles the state; make sure it's settled even if no exit arrives.
    if (this.live.get(id) === live) this.onExit(id, live, null, null)
    return this.statusOf(id)
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.downloads.keys()]) this.cancelDownload(id)
    await Promise.allSettled([...this.live.keys()].map((id) => this.stop(id)))
  }

  /** Devices this runner's llama-server can use. */
  async devices(id: string): Promise<RunDevice[]> {
    const runner = this.get(id)
    const server = resolveServer(runner.serverPath, this.deps.platform)
    if (!server) throw new Error(runner.serverPath ? `llama-server not found at ${runner.serverPath}` : `Choose llama-server for ${runner.name} first`)
    const { stdout, stderr } = await this.deps.exec(server, ['--list-devices'], dirname(server))
    return parseDevices(`${stdout}\n${stderr}`)
  }

  private onLines(id: string, live: Live, lines: string[]): void {
    if (!lines.length) return
    this.pushLines(id, lines)
    for (const l of lines) {
      const tps = parseTokensPerSecond(l)
      if (tps !== null) {
        live.status.lastTokensPerSecond = tps
        if (this.live.get(id) === live) this.emitStatus(id)
      }
    }
  }

  private pushLines(id: string, lines: string[]): void {
    const buf = this.logs.get(id) ?? []
    buf.push(...lines)
    if (buf.length > LOG_LINES) buf.splice(0, buf.length - LOG_LINES)
    this.logs.set(id, buf)
    this.ctx.emit('runs', { type: 'log', id, lines } satisfies RunEvent)
  }

  private onExit(id: string, live: Live, code: number | null, spawnError: string | null): void {
    if (this.live.get(id) !== live) return
    for (const key of ['out', 'err'] as const) {
      if (live.partial[key].trim()) this.onLines(id, live, [live.partial[key]])
      live.partial[key] = ''
    }
    this.live.delete(id)
    this.unexpose(id)
    const base = { id, lastTokensPerSecond: live.status.lastTokensPerSecond }
    if (live.stopping || (code === 0 && !spawnError)) {
      this.last.set(id, { ...base, state: 'stopped' })
    } else {
      let port: number | undefined
      try {
        port = this.get(id).port
      } catch {
        /* removed */
      }
      this.last.set(id, { ...base, state: 'error', error: spawnError ?? explainFailure((this.logs.get(id) ?? []).slice(-40), code, port) })
    }
    this.ctx.log('run', `runner ${id} exited (${code ?? 'killed'})`)
    this.emitStatus(id)
  }

  private async waitHealthy(id: string, live: Live, url: string): Promise<void> {
    const deadline = Date.now() + this.deps.healthTimeoutMs
    while (Date.now() < deadline) {
      if (this.live.get(id) !== live) return
      try {
        const res = await this.deps.fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as { status?: string }
          if (body.status === 'ok') {
            if (this.live.get(id) !== live) return
            live.status.state = 'running'
            this.ctx.log('run', `${id} ready on ${url}`)
            try {
              this.expose(this.get(id))
            } catch {
              /* removed meanwhile */
            }
            this.emitStatus(id)
            return
          }
        } else await res.body?.cancel()
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, this.deps.healthIntervalMs))
    }
    if (this.live.get(id) !== live) return
    this.pushLines(id, [`Cloth: llama-server did not report ready within ${Math.round(this.deps.healthTimeoutMs / 1000)}s; stopping it.`])
    live.stopping = true
    await this.deps.kill(live.child)
    if (this.live.get(id) === live) this.onExit(id, live, null, null)
    this.last.set(id, { id, state: 'error', error: `llama-server did not become ready within ${Math.round(this.deps.healthTimeoutMs / 60_000) || 1} min` })
    this.emitStatus(id)
  }

  private fail(id: string, error: string): RunnerStatus {
    this.last.set(id, { id, state: 'error', error })
    this.emitStatus(id)
    return this.statusOf(id)
  }

  private emitStatus(id: string): void {
    this.ctx.emit('runs', { type: 'status', status: this.statusOf(id) } satisfies RunEvent)
  }

  // ── Chats ──

  static providerId(runnerId: string): string {
    return PROVIDER_PREFIX + runnerId
  }

  private expose(runner: Runner): void {
    const pid = RunService.providerId(runner.id)
    if (!runner.useInChats) return this.providers.removeTransient(pid)
    const model: ModelInfo = {
      id: runner.alias,
      name: runner.name,
      contextWindow: runner.contextSize,
      maxTokens: Math.min(8192, runner.contextSize),
      reasoning: isReasoningModelId(runner.alias),
      vision: !!runner.mmprojPath,
      embedding: false,
      contextSource: 'server'
    }
    const provider: Provider = {
      id: pid,
      name: runner.name,
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${runner.port}/v1`,
      hasApiKey: false,
      headers: {},
      models: [model],
      enabled: true,
      createdAt: this.live.get(runner.id)?.status.startedAt ?? Date.now(),
      local: true,
      runnerId: runner.id
    }
    this.providers.setTransient(provider)
  }

  private unexpose(runnerId: string): void {
    this.providers.removeTransient(RunService.providerId(runnerId))
  }

  private missingHint(providerId: string): string | null {
    if (!providerId.startsWith(PROVIDER_PREFIX)) return null
    const id = providerId.slice(PROVIDER_PREFIX.length)
    try {
      return `Start ${this.get(id).name} on the Run page first.`
    } catch {
      return 'That local model was removed from the Run page. Pick another model.'
    }
  }

  // ── Detection ──

  detect(): RunDetection {
    return { runtime: this.detectRuntime(), model: this.detectModel() }
  }

  private runtimesDir(): string {
    return join(this.ctx.dataDir, 'runtimes', 'prism-llama')
  }

  private modelsDir(): string {
    return join(this.ctx.dataDir, 'models')
  }

  private detectRuntime(): RunDetection['runtime'] {
    const exe = exeName(this.deps.platform)
    // Cloth's own downloads, newest first.
    const root = this.runtimesDir()
    const tags = safeReaddir(root)
      .filter((t) => isDir(join(root, t)))
      .sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)
    for (const tag of tags) {
      const found = findFile(join(root, tag), exe, 2)
      if (found) return { found: true, path: found, version: tag }
    }
    const prism = join(this.deps.home, 'llama-prism', exe)
    if (existsSync(prism)) return { found: true, path: prism }
    return { found: false, path: null }
  }

  private detectModel(): RunDetection['model'] {
    const snapshots = join(hfHubCache(this.deps.env, this.deps.home), `models--${BONSAI_REPO.replace('/', '--')}`, 'snapshots')
    const dirs = [...safeReaddir(snapshots).map((s) => join(snapshots, s)), this.modelsDir()]
    for (const dir of dirs) {
      const model = join(dir, BONSAI_MODEL_FILE)
      if (!existsSync(model)) continue
      // The projector next to the model, else one anywhere we look.
      const mm = [dir, ...dirs].map((d) => join(d, BONSAI_MMPROJ_FILE)).find((p) => existsSync(p)) ?? null
      return { found: true, path: model, mmprojPath: mm }
    }
    return { found: false, path: null, mmprojPath: null }
  }

  /** Fill the built-in runner's empty paths from what's on disk. */
  private autofill(): void {
    const row = this.ctx.db.prepare("SELECT * FROM runners WHERE builtin = 'bonsai-2-27b'").get() as RunnerRow | undefined
    if (!row) return
    const r = toRunner(row)
    if (r.serverPath && r.modelPath && r.mmprojPath) return
    const d = this.detect()
    const patch: RunnerPatch = {}
    if (!r.serverPath && d.runtime.path) patch.serverPath = d.runtime.path
    if (!r.modelPath && d.model.path) patch.modelPath = d.model.path
    if (!r.mmprojPath && d.model.mmprojPath && (r.modelPath ?? d.model.path)) patch.mmprojPath = d.model.mmprojPath
    if (!Object.keys(patch).length) return
    const { id: _i, name: _n, builtin: _b, createdAt: _c, updatedAt: _u, ...config } = r
    this.ctx.db.prepare('UPDATE runners SET config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...config, ...patch }), Date.now(), r.id)
  }

  private seed(): void {
    if (this.seeded) return
    this.seeded = true
    for (const [kind, b] of Object.entries(BUILTINS) as [RunnerBuiltin, (typeof BUILTINS)[RunnerBuiltin]][]) {
      const have = this.ctx.db.prepare('SELECT id FROM runners WHERE builtin = ?').get(kind)
      if (have) continue
      const now = Date.now()
      this.ctx.db.prepare('INSERT INTO runners (id, name, builtin, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('rnr_'), b.name, kind, JSON.stringify(b.config), now, now)
    }
  }

  // ── Downloads ──

  async runtimeOptions(): Promise<RuntimeOptions> {
    this.requireWindows()
    const res = await this.deps.fetch(this.deps.releasesUrl, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT } })
    if (!res.ok) throw new Error(`Couldn't read PrismML's releases (HTTP ${res.status})`)
    return pickRuntimeAssets((await res.json()) as ReleaseJson)
  }

  async downloadRuntime(id: string, backend: RuntimeBackend): Promise<Runner> {
    this.requireWindows()
    if (!RUNTIME_BACKENDS.includes(backend)) throw new Error(`Unknown build ${backend}`)
    this.get(id)
    return this.download(id, 'runtime', async (signal, progress) => {
      const opts = await this.runtimeOptions()
      const asset = opts.assets.find((a) => a.backend === backend)
      if (!asset) throw new Error(`PrismML's ${opts.tag} release has no ${backend} build for Windows`)
      const dir = join(this.runtimesDir(), safeName(opts.tag))
      const zip = join(this.runtimesDir(), `${safeName(opts.tag)}-${backend}.zip`)
      await downloadFile(asset.url, zip, { fetch: this.deps.fetch, signal, expectedSize: asset.size, onProgress: (r, t) => progress({ file: asset.name, received: r, total: t || asset.size, state: 'downloading' }) })
      progress({ file: asset.name, received: asset.size, total: asset.size, state: 'extracting' })
      await unzip(zip, dir, { signal })
      await rm(zip, { force: true })
      const exe = findFile(dir, exeName(this.deps.platform), 3)
      if (!exe) throw new Error(`The download didn't contain ${exeName(this.deps.platform)}`)
      return this.update(id, { serverPath: exe })
    })
  }

  private modelFiles(): { name: string; url: string; optional: boolean }[] {
    const base = `${this.deps.hfBase.replace(/\/+$/, '')}/${BONSAI_REPO}/resolve/main`
    return [
      { name: BONSAI_MODEL_FILE, url: `${base}/${BONSAI_MODEL_FILE}`, optional: false },
      { name: BONSAI_MMPROJ_FILE, url: `${base}/${BONSAI_MMPROJ_FILE}`, optional: true }
    ]
  }

  async modelDownloadInfo(): Promise<ModelDownloadInfo> {
    const dir = this.modelsDir()
    const files: ModelDownloadInfo['files'] = []
    for (const f of this.modelFiles()) {
      const size = await remoteSize(f.url, this.deps.fetch)
      if (size === null) {
        if (f.optional) continue
        throw new Error(`${f.name} isn't available on Hugging Face`)
      }
      const done = join(dir, f.name)
      const present = existsSync(done) ? statSync(done).size : existsSync(`${done}.part`) ? statSync(`${done}.part`).size : 0
      files.push({ ...f, size, present })
    }
    return { dir, source: `https://huggingface.co/${BONSAI_REPO}`, files }
  }

  async downloadModel(id: string): Promise<Runner> {
    this.get(id)
    return this.download(id, 'model', async (signal, progress) => {
      const info = await this.modelDownloadInfo()
      const total = info.files.reduce((n, f) => n + f.size, 0)
      let before = 0
      const paths: Record<string, string> = {}
      for (const f of info.files) {
        const dest = join(info.dir, f.name)
        if (!(existsSync(dest) && (!f.size || statSync(dest).size === f.size))) {
          await downloadFile(f.url, dest, {
            fetch: this.deps.fetch,
            signal,
            expectedSize: f.size || undefined,
            onProgress: (r) => progress({ file: f.name, received: before + r, total, state: 'downloading' })
          })
        }
        before += f.size || statSync(dest).size
        paths[f.name] = dest
      }
      return this.update(id, { modelPath: paths[BONSAI_MODEL_FILE], ...(paths[BONSAI_MMPROJ_FILE] ? { mmprojPath: paths[BONSAI_MMPROJ_FILE] } : {}) })
    })
  }

  cancelDownload(id: string): void {
    this.downloads.get(id)?.abort()
  }

  private async download(
    id: string,
    kind: 'runtime' | 'model',
    work: (signal: AbortSignal, progress: (p: { file?: string; received: number; total: number; state: 'downloading' | 'extracting' }) => void) => Promise<Runner>
  ): Promise<Runner> {
    if (this.downloads.has(id)) throw new Error('A download for this runner is already running')
    const ac = new AbortController()
    this.downloads.set(id, ac)
    let last = { file: undefined as string | undefined, received: 0, total: 0 }
    const emit = (e: Omit<Extract<RunEvent, { type: 'progress' }>, 'type' | 'kind' | 'id'>) => this.ctx.emit('runs', { type: 'progress', kind, id, ...e } satisfies RunEvent)
    try {
      const runner = await work(ac.signal, (p) => {
        last = { file: p.file, received: p.received, total: p.total }
        emit(p)
      })
      emit({ ...last, received: last.total || last.received, state: 'done' })
      return runner
    } catch (err) {
      if (ac.signal.aborted) {
        emit({ ...last, state: 'cancelled' })
        throw new Error('Download cancelled')
      }
      emit({ ...last, state: 'error', error: errorMessage(err) })
      throw err
    } finally {
      this.downloads.delete(id)
    }
  }

  private requireWindows(): void {
    if (this.deps.platform !== 'win32') throw new Error("Downloading PrismML's llama.cpp is only supported on Windows here yet. Build it yourself and choose llama-server.")
  }
}

// ─── Row mapping & utils ─────────────────────────────────────────────────────

function toRunner(r: RunnerRow): Runner {
  const builtin = (r.builtin as RunnerBuiltin | null) ?? null
  const base = builtin ? BUILTINS[builtin]?.config ?? DEFAULTS : DEFAULTS
  const config = { ...base, ...json<Partial<RunnerConfig>>(r.config, {}) }
  return { id: r.id, name: r.name, builtin, ...config, sampling: { ...(config.sampling ?? {}) }, createdAt: r.created_at, updatedAt: r.updated_at }
}

const CONFIG_KEYS: (keyof RunnerConfig)[] = ['serverPath', 'modelPath', 'mmprojPath', 'device', 'gpuLayers', 'contextSize', 'port', 'flashAttention', 'sampling', 'extraArgs', 'alias', 'useInChats']

function pickConfig(input: RunnerPatch): Partial<RunnerConfig> {
  const out: Partial<RunnerConfig> = {}
  for (const k of CONFIG_KEYS) if (input[k] !== undefined) (out as Record<string, unknown>)[k] = input[k]
  return out
}

function validate(c: RunnerConfig): RunnerConfig {
  const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null)
  const out: RunnerConfig = {
    ...c,
    serverPath: blank(c.serverPath),
    modelPath: blank(c.modelPath),
    mmprojPath: blank(c.mmprojPath),
    device: blank(c.device),
    extraArgs: (c.extraArgs ?? '').trim(),
    alias: (c.alias ?? '').trim(),
    sampling: Object.fromEntries(Object.entries(c.sampling ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)))
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('Port must be a whole number from 1 to 65535')
  if (!Number.isInteger(out.contextSize) || out.contextSize < 0) throw new Error('Context size must be a whole number (0 = the model’s own)')
  if (!Number.isInteger(out.gpuLayers) || out.gpuLayers < -1) throw new Error('GPU layers must be a whole number (-1 = auto)')
  if (!out.alias) throw new Error('Give the model an alias (the id chats use)')
  if (/\s/.test(out.alias)) throw new Error('The alias can’t contain spaces')
  return out
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '_')
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** A file by name in a folder or its subfolders (up to `depth` levels). */
function findFile(dir: string, name: string, depth: number): string | null {
  const direct = join(dir, name)
  if (existsSync(direct)) return direct
  if (depth <= 0) return null
  for (const sub of safeReaddir(dir)) {
    const p = join(dir, sub)
    if (isDir(p)) {
      const found = findFile(p, name, depth - 1)
      if (found) return found
    }
  }
  return null
}
