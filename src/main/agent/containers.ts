import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import ignore, { type Ignore } from 'ignore'
import { dirname, join, posix, sep } from 'node:path'
import type { ContainerChange, ContainerChanges, ContainerSettings, ContainerStatus } from '@shared/types'
import type { Ctx } from '../core/context'
import { makeDiff } from './workspace'

export interface DockerResult {
  code: number | null
  stdout: string
  stderr: string
}

export type DockerRun = (args: string[], opts?: { onData?: (chunk: Buffer) => void; signal?: AbortSignal; timeout?: number }) => Promise<DockerResult>

/** Runs the docker CLI. Rejects only when docker itself can't be started (ENOENT). */
export function dockerCli(bin = 'docker'): DockerRun {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | null = null
      const kill = () => child.kill()
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
        opts.onData?.(d)
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
        opts.onData?.(d)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', kill)
        resolve({ code, stdout, stderr })
      })
      opts.signal?.addEventListener('abort', kill, { once: true })
      if (opts.timeout) timer = setTimeout(kill, opts.timeout * 1000)
    })
}

/** Not copied into the container (rebuilt there instead); the heavy ones get their own volume. Files the folder's .gitignore excludes aren't copied either. */
const COPY_SKIP = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'target', '.cache', '.pnpm-store'])
/** Never offered back to the real folder. */
const DIFF_SKIP = new Set([...COPY_SKIP, '.git'])
const DEP_VOLUMES = ['/workspace/node_modules', '/workspace/.venv']
const MAX_FILES = 200_000
const MAX_TEXT = 2_000_000

/** Copy files as last seen: [size, mtimeMs, sha1]. */
type StatCache = Record<string, [number, number, string]>

interface Manifest {
  folder: string | null
  /** Each copied file's hash when the copy was made: the baseline changes are measured from. */
  files: Record<string, string>
}

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex')
const safe = (s: string) => s.replace(/[^\w.-]/g, '_')
const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0)

interface Walked {
  rel: string
  size: number
  mtimeMs: number
}

/** A .gitignore and the folder (relative, '' = root) its patterns are relative to. */
type Rules = { base: string; ig: Ignore }[]

/** Files under `root` (posix relative paths), skipping `skip` folders and whatever the .gitignore files exclude. */
async function walk(root: string, skip: Set<string>, rel = '', rules: Rules = [], out: Walked[] = []): Promise<Walked[]> {
  const dir = join(root, ...rel.split('/').filter(Boolean))
  const own = await readFile(join(dir, '.gitignore'), 'utf8').catch(() => null)
  const here = own ? [...rules, { base: rel, ig: ignore().add(own) }] : rules
  const ignored = (r: string, isDir: boolean) =>
    here.some(({ base, ig }) => {
      const sub = base ? r.slice(base.length + 1) : r
      return !!sub && ig.ignores(isDir ? `${sub}/` : sub)
    })
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (skip.has(e.name)) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (!ignored(r, true)) await walk(root, skip, r, here, out)
    } else if (e.isFile() && !ignored(r, false)) {
      const s = await stat(join(dir, e.name)).catch(() => null)
      if (s) out.push({ rel: r, size: s.size, mtimeMs: s.mtimeMs })
    }
    if (out.length > MAX_FILES) throw new Error(`The folder has more than ${MAX_FILES.toLocaleString()} files — too many to copy into a container`)
  }
  return out
}

const hashOf = async (abs: string): Promise<string | null> => (existsSync(abs) ? sha1(await readFile(abs)) : null)

/**
 * Linux containers for chats: each chat works on a private copy of its folder (kept under the data
 * folder and mounted at /workspace), runs commands inside the container, and nothing reaches the
 * real folder until the user applies it.
 */
export class ContainerService {
  private idle = new Map<string, NodeJS.Timeout>()
  private cached: { at: number; status: ContainerStatus } | null = null

  constructor(
    private ctx: Ctx,
    private docker: DockerRun = dockerCli(),
    private idleMs = 10 * 60_000
  ) {}

  private root(sessionId: string): string {
    return join(this.ctx.dataDir, 'containers', safe(sessionId))
  }
  copyDir(sessionId: string): string {
    return join(this.root(sessionId), 'workspace')
  }
  private name(sessionId: string): string {
    return `cloth-${safe(sessionId).toLowerCase()}`
  }

  async status(force = false): Promise<ContainerStatus> {
    if (!force && this.cached && Date.now() - this.cached.at < 15_000) return this.cached.status
    let status: ContainerStatus
    try {
      const r = await this.docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15 })
      status =
        r.code === 0 && r.stdout.trim()
          ? { available: true, version: r.stdout.trim(), error: null }
          : { available: false, version: null, error: 'Docker isn’t running — start Docker Desktop (or the Docker service) and try again.' }
    } catch {
      status = { available: false, version: null, error: 'Docker isn’t installed. Install Docker Desktop to run agents in a container.' }
    }
    this.cached = { at: Date.now(), status }
    return status
  }

  /** Make the chat's private copy of `folder` (once; again if the folder changed). Returns its path. */
  async prepare(sessionId: string, folder: string | null): Promise<string> {
    const copy = this.copyDir(sessionId)
    const current = await this.manifest(sessionId)
    if (current && current.folder === folder && existsSync(copy)) return copy
    await rm(copy, { recursive: true, force: true })
    await mkdir(copy, { recursive: true })
    const files: Record<string, string> = {}
    const cache: StatCache = {}
    if (folder) {
      for (const { rel } of await walk(folder, COPY_SKIP)) {
        const src = join(folder, ...rel.split('/'))
        const dest = join(copy, ...rel.split('/'))
        await mkdir(dirname(dest), { recursive: true })
        await copyFile(src, dest)
        if (rel.split('/').some((part) => DIFF_SKIP.has(part))) continue
        const hash = sha1(await readFile(dest))
        files[rel] = hash
        const s = await stat(dest)
        cache[rel] = [s.size, s.mtimeMs, hash]
      }
    }
    await this.saveManifest(sessionId, { folder, files })
    await this.saveCache(sessionId, cache)
    return copy
  }

  /** Start (or create) the chat's container. Settings changed since it was made: it is recreated. */
  async ensureRunning(sessionId: string, settings: ContainerSettings): Promise<void> {
    const status = await this.status()
    if (!status.available) throw new Error(status.error ?? 'Docker is not available')
    const name = this.name(sessionId)
    const want = JSON.stringify({ image: settings.image, network: settings.network })
    const settingsFile = join(this.root(sessionId), 'container.json')
    const had = existsSync(settingsFile) ? await readFile(settingsFile, 'utf8') : null
    const inspect = await this.docker(['inspect', '-f', '{{.State.Running}}', name])
    if (inspect.code === 0 && had === want) {
      if (inspect.stdout.trim() !== 'true') {
        const started = await this.docker(['start', name])
        if (started.code !== 0) throw new Error(`Couldn't start the container: ${started.stderr.trim()}`)
      }
    } else {
      if (inspect.code === 0) await this.docker(['rm', '-f', name])
      const args = ['run', '-d', '--name', name, '--label', `cloth.session=${sessionId}`, '-v', `${this.copyDir(sessionId)}:/workspace`]
      for (const v of DEP_VOLUMES) args.push('-v', v)
      if (!settings.network) args.push('--network', 'none')
      args.push('-w', '/workspace', settings.image, 'sleep', 'infinity')
      // The first run may pull the image, which can take a while.
      const run = await this.docker(args, { timeout: 15 * 60 })
      if (run.code !== 0) throw new Error(`Couldn't start a ${settings.image} container: ${(run.stderr || run.stdout).trim().split('\n').at(-1)}`)
      await mkdir(this.root(sessionId), { recursive: true })
      await writeFile(settingsFile, want)
    }
    this.touch(sessionId)
  }

  /** Run a shell command in the chat's container, with `cwd` relative to /workspace. */
  async exec(
    sessionId: string,
    settings: ContainerSettings,
    command: string,
    cwd: string,
    opts: { onData: (chunk: Buffer) => void; signal?: AbortSignal; timeout?: number }
  ): Promise<{ exitCode: number | null }> {
    await this.ensureRunning(sessionId, settings)
    const wd = posix.join('/workspace', cwd.split(sep).join('/'))
    // bash when the image has it (most do), plain sh otherwise (alpine).
    const shell = 'if command -v bash >/dev/null 2>&1; then exec bash -lc "$1"; else exec sh -lc "$1"; fi'
    const r = await this.docker(['exec', '-i', '-w', wd, this.name(sessionId), 'sh', '-c', shell, 'sh', command], opts)
    this.touch(sessionId)
    return { exitCode: r.code }
  }

  /** Files that differ between the copy and the real folder, measured from when the copy was made. */
  async changes(sessionId: string): Promise<ContainerChanges> {
    const m = await this.manifest(sessionId)
    if (!m) return { folder: null, changes: [] }
    const copy = this.copyDir(sessionId)
    // Only files whose size or modified time changed since the last look are read and hashed again.
    const cache = await this.cache(sessionId)
    const fresh: StatCache = {}
    const now = new Map<string, string>()
    for (const f of await walk(copy, DIFF_SKIP)) {
      const hit = cache[f.rel]
      const hash = hit && hit[0] === f.size && hit[1] === f.mtimeMs ? hit[2] : sha1(await readFile(join(copy, ...f.rel.split('/'))))
      fresh[f.rel] = [f.size, f.mtimeMs, hash]
      now.set(f.rel, hash)
    }
    await this.saveCache(sessionId, fresh)
    const paths = [...new Set([...Object.keys(m.files), ...now.keys()])].sort()
    const out: ContainerChange[] = []
    for (const rel of paths) {
      const base = m.files[rel]
      const cur = now.get(rel)
      if (base === cur) continue
      const kind: ContainerChange['kind'] = base === undefined ? 'create' : cur === undefined ? 'delete' : 'modify'
      const realAbs = m.folder ? join(m.folder, ...rel.split('/')) : null
      const realHash = realAbs ? await hashOf(realAbs) : null
      const conflict = !!realAbs && realHash !== (base ?? null) && realHash !== (cur ?? null)
      const before = realAbs && existsSync(realAbs) ? await readFile(realAbs) : null
      const after = cur !== undefined ? await readFile(join(copy, ...rel.split('/'))) : null
      if ((before && isBinary(before)) || (after && isBinary(after)) || (before?.length ?? 0) > MAX_TEXT || (after?.length ?? 0) > MAX_TEXT) {
        out.push({ path: rel, kind, diff: '', added: 0, removed: 0, conflict, binary: true })
        continue
      }
      const d = makeDiff(rel, before === null ? null : before.toString('utf8'), after === null ? '' : after.toString('utf8'))
      out.push({ path: rel, kind, conflict, ...d })
    }
    return { folder: m.folder, changes: out }
  }

  /** Copy changes (all, or just `paths`) from the container copy into the real folder. */
  async apply(sessionId: string, paths?: string[]): Promise<ContainerChanges> {
    const m = await this.manifest(sessionId)
    if (!m?.folder) throw new Error('This chat has no folder to apply changes to')
    const { changes } = await this.changes(sessionId)
    for (const c of changes.filter((x) => !paths || paths.includes(x.path))) {
      const real = join(m.folder, ...c.path.split('/'))
      const copied = join(this.copyDir(sessionId), ...c.path.split('/'))
      if (c.kind === 'delete') {
        await rm(real, { force: true })
        delete m.files[c.path]
      } else {
        await mkdir(dirname(real), { recursive: true })
        await copyFile(copied, real)
        m.files[c.path] = sha1(await readFile(copied))
      }
    }
    await this.saveManifest(sessionId, m)
    return this.changes(sessionId)
  }

  /** Undo changes in the copy (all, or just `paths`), back to what the real folder has now. */
  async discard(sessionId: string, paths?: string[]): Promise<ContainerChanges> {
    const m = await this.manifest(sessionId)
    if (!m) return { folder: null, changes: [] }
    const { changes } = await this.changes(sessionId)
    for (const c of changes.filter((x) => !paths || paths.includes(x.path))) {
      const copied = join(this.copyDir(sessionId), ...c.path.split('/'))
      const real = m.folder ? join(m.folder, ...c.path.split('/')) : null
      if (real && existsSync(real)) {
        await mkdir(dirname(copied), { recursive: true })
        await copyFile(real, copied)
        m.files[c.path] = sha1(await readFile(copied))
      } else {
        await rm(copied, { force: true })
        delete m.files[c.path]
      }
    }
    await this.saveManifest(sessionId, m)
    return this.changes(sessionId)
  }

  /** Throw the container away (the copy is kept); the next command starts a fresh one. */
  async reset(sessionId: string): Promise<void> {
    await this.docker(['rm', '-f', this.name(sessionId)]).catch(() => undefined)
    await rm(join(this.root(sessionId), 'container.json'), { force: true })
  }

  /** The chat was deleted: remove its container and copy. */
  async remove(sessionId: string): Promise<void> {
    this.clearIdle(sessionId)
    if (existsSync(this.root(sessionId))) await this.docker(['rm', '-f', this.name(sessionId)]).catch(() => undefined)
    await rm(this.root(sessionId), { recursive: true, force: true })
  }

  /** Stop every container Cloth started (on quit); copies stay for next time. */
  async stopAll(): Promise<void> {
    for (const t of this.idle.values()) clearTimeout(t)
    this.idle.clear()
    const r = await this.docker(['ps', '-q', '--filter', 'label=cloth.session']).catch(() => null)
    const ids = r?.stdout.split(/\s+/).filter(Boolean) ?? []
    if (ids.length) await this.docker(['stop', '-t', '2', ...ids]).catch(() => undefined)
  }

  /** The chat's container name (for `docker exec` from a terminal). */
  containerName(sessionId: string): string {
    return this.name(sessionId)
  }

  /** Something is still using the container (an open terminal): push back the idle stop. */
  keepAlive(sessionId: string): void {
    this.touch(sessionId)
  }

  private touch(sessionId: string): void {
    this.clearIdle(sessionId)
    const t = setTimeout(() => {
      this.idle.delete(sessionId)
      void this.docker(['stop', '-t', '2', this.name(sessionId)]).catch(() => undefined)
    }, this.idleMs)
    t.unref?.()
    this.idle.set(sessionId, t)
  }

  private clearIdle(sessionId: string): void {
    const t = this.idle.get(sessionId)
    if (t) clearTimeout(t)
    this.idle.delete(sessionId)
  }

  private async manifest(sessionId: string): Promise<Manifest | null> {
    try {
      return JSON.parse(await readFile(join(this.root(sessionId), 'manifest.json'), 'utf8')) as Manifest
    } catch {
      return null
    }
  }

  private async cache(sessionId: string): Promise<StatCache> {
    try {
      return JSON.parse(await readFile(join(this.root(sessionId), 'stat-cache.json'), 'utf8')) as StatCache
    } catch {
      return {}
    }
  }

  private async saveCache(sessionId: string, c: StatCache): Promise<void> {
    await mkdir(this.root(sessionId), { recursive: true })
    await writeFile(join(this.root(sessionId), 'stat-cache.json'), JSON.stringify(c))
  }

  private async saveManifest(sessionId: string, m: Manifest): Promise<void> {
    await mkdir(this.root(sessionId), { recursive: true })
    await writeFile(join(this.root(sessionId), 'manifest.json'), JSON.stringify(m))
  }
}
