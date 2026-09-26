// Shared helpers for the sidecar staging scripts (download + verify + extract).
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SIDECARS = path.join(ROOT, 'sidecars')
// Downloads are cached across runs (and shared with cloth v1's cache when present).
export const CACHE_DIRS = [path.join(os.tmpdir(), 'cloth-sidecar-cache'), path.join(os.tmpdir(), 'cloth-chroma-cache')]

export const exists = (p) => fsp.access(p).then(() => true, () => false)
export const rimraf = (p) => fsp.rm(p, { recursive: true, force: true })
export const ensureDir = (p) => fsp.mkdir(p, { recursive: true })

export function logger(scope) {
  return (msg) => console.log(`[${scope}] ${msg}`)
}

export async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, dest, log) {
  await ensureDir(path.dirname(dest))
  log(`downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const tmp = `${dest}.partial`
  const out = fs.createWriteStream(tmp)
  let received = 0
  let lastPct = -1
  for await (const chunk of res.body) {
    received += chunk.length
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
    const pct = total ? Math.floor((received / total) * 10) : -1
    if (pct !== lastPct && pct >= 0) {
      lastPct = pct
      log(`  ${(received / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`)
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  await fsp.rename(tmp, dest)
}

/** Download (or reuse a cached copy of) `name` from `url` and verify its sha256. */
export async function fetchVerified(url, name, expectedSha256, log) {
  for (const dir of CACHE_DIRS) {
    const cached = path.join(dir, name)
    if ((await exists(cached)) && (!expectedSha256 || (await sha256(cached)) === expectedSha256)) {
      log(`cache hit: ${name}`)
      return cached
    }
  }
  const dest = path.join(CACHE_DIRS[0], name)
  await rimraf(dest)
  await download(url, dest, log)
  if (expectedSha256) {
    const digest = await sha256(dest)
    if (digest !== expectedSha256) {
      await rimraf(dest)
      throw new Error(`sha256 mismatch for ${name}: expected ${expectedSha256}, got ${digest}`)
    }
  } else {
    log(`WARNING: ${name} has no pinned checksum — downloaded unverified`)
  }
  return dest
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${code}`))))
  })
}

export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export async function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      total += e.isDirectory() ? await dirSize(full) : (await fsp.lstat(full)).size
    } catch {
      /* unreadable entry */
    }
  }
  return total
}

export const isMain = (metaUrl) => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl)
