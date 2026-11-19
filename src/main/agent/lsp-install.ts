// Language servers Cloth can install for itself, into its own data folder (`<data>/lsp/servers/<id>`), so code
// intelligence for Go, Rust, C/C++ and Java works without the person setting anything up:
// - rust-analyzer and clangd: the official release builds from GitHub;
// - jdtls: Eclipse's release, started straight on Java (no Python launcher script); it still needs Java 21+;
// - gopls: there are no prebuilt builds, so `go install` builds it with the Go toolchain on this PC.
// A copy installed here is used before one on PATH. Each install writes a small manifest saying what to run.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { downloadFile, USER_AGENT, type Fetch } from '../run/download'
import { unzip } from '../run/zip'
import { untarGz } from '../run/untar'

const gunzipAsync = promisify(gunzip)

export type InstallableServer = 'go' | 'rust' | 'cpp' | 'java'

/** What an installed copy runs: a program (relative to its folder), or jdtls' launcher jar and configuration. */
export interface ServerManifest {
  version: string
  /** Relative path of the executable (gopls, rust-analyzer, clangd). */
  program?: string
  /** jdtls: relative paths of the Equinox launcher jar and the configuration folder for this OS. */
  launcher?: string
  configuration?: string
  installedAt: number
}

const MANIFEST = 'cloth-server.json'
const exe = (name: string, platform = process.platform) => (platform === 'win32' ? `${name}.exe` : name)

export const RUST_RELEASES = 'https://api.github.com/repos/rust-lang/rust-analyzer/releases/latest'
export const CLANGD_RELEASES = 'https://api.github.com/repos/clangd/clangd/releases/latest'
export const JDTLS_LATEST = 'https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz'
export const GOPLS_MODULE = 'golang.org/x/tools/gopls@latest'

/** Where to get what an install needs and can't do itself. */
export const PREREQUISITE = {
  go: { name: 'Go', url: 'https://go.dev/dl/' },
  java: { name: 'Java 21 or newer', url: 'https://adoptium.net/temurin/releases/?version=21' }
} as const

export function serverDir(serversDir: string, id: InstallableServer): string {
  return join(serversDir, id)
}

/** The installed copy's manifest, when there is a complete install. */
export function readManifest(serversDir: string, id: InstallableServer): ServerManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(serverDir(serversDir, id), MANIFEST), 'utf8')) as ServerManifest
    const dir = serverDir(serversDir, id)
    if (m.program && !existsSync(join(dir, m.program))) return null
    if (m.launcher && !existsSync(join(dir, m.launcher))) return null
    return m
  } catch {
    return null
  }
}

/** The installed program (absolute), for gopls, rust-analyzer and clangd. */
export function installedProgram(serversDir: string, id: Exclude<InstallableServer, 'java'>): string | null {
  const m = readManifest(serversDir, id)
  return m?.program ? join(serverDir(serversDir, id), m.program) : null
}

/** jdtls' launcher jar and configuration folder (absolute), when it's installed. */
export function installedJdtls(serversDir: string): { launcher: string; configuration: string } | null {
  const m = readManifest(serversDir, 'java')
  if (!m?.launcher || !m.configuration) return null
  const dir = serverDir(serversDir, 'java')
  return { launcher: join(dir, m.launcher), configuration: join(dir, m.configuration) }
}

/** The Java arguments that start an installed jdtls (the same ones its own launcher script uses). */
export function jdtlsJavaArgs(jdtls: { launcher: string; configuration: string }, data: string): string[] {
  return [
    '-Declipse.application=org.eclipse.jdt.ls.core.id1',
    '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product',
    '-Xms1G',
    '--add-modules=ALL-SYSTEM',
    '--add-opens',
    'java.base/java.util=ALL-UNNAMED',
    '--add-opens',
    'java.base/java.lang=ALL-UNNAMED',
    '-jar',
    jdtls.launcher,
    '-configuration',
    jdtls.configuration,
    '-data',
    data
  ]
}

interface ReleaseAsset {
  name: string
  browser_download_url: string
}
interface Release {
  tag_name: string
  assets: ReleaseAsset[]
}

/** rust-analyzer's build for this computer: a zip on Windows, a gzipped binary elsewhere. */
export function rustAsset(release: Release, platform = process.platform, arch = process.arch): ReleaseAsset | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  if (!cpu) return null
  const name = platform === 'win32' ? `rust-analyzer-${cpu}-pc-windows-msvc.zip` : platform === 'darwin' ? `rust-analyzer-${cpu}-apple-darwin.gz` : platform === 'linux' ? `rust-analyzer-${cpu}-unknown-linux-gnu.gz` : null
  return release.assets.find((a) => a.name === name) ?? null
}

/** clangd's build for this computer (Windows and Linux on x64; one macOS build that runs on both chips). */
export function clangdAsset(release: Release, platform = process.platform, arch = process.arch): ReleaseAsset | null {
  if (platform === 'linux' && arch !== 'x64') return null
  if (platform === 'win32' && arch !== 'x64' && arch !== 'arm64') return null
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : null
  if (!os) return null
  return release.assets.find((a) => a.name === `clangd-${os}-${release.tag_name}.zip`) ?? release.assets.find((a) => new RegExp(`^clangd-${os}-[\\w.]+\\.zip$`).test(a.name)) ?? null
}

/** jdtls' configuration folder for this computer. */
export function jdtlsConfigName(platform = process.platform, arch = process.arch): string {
  const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
  return arch === 'arm64' && os !== 'win' ? `config_${os}_arm` : `config_${os}`
}

function findFile(dir: string, test: (rel: string) => boolean): string | null {
  const walk = (d: string): string | null => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) {
        const hit = walk(full)
        if (hit) return hit
      } else if (test(relative(dir, full).split(sep).join('/'))) return full
    }
    return null
  }
  return existsSync(dir) ? walk(dir) : null
}

async function latestRelease(url: string, fetchFn: Fetch, signal?: AbortSignal): Promise<Release> {
  const res = await fetchFn(url, { signal: signal ?? AbortSignal.timeout(30_000), headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`Couldn't look up the latest release (HTTP ${res.status}). Check the connection and try again.`)
  return (await res.json()) as Release
}

export interface InstallOptions {
  fetch?: Fetch
  signal?: AbortSignal
  /** What it's doing now, for the UI ("Downloading clangd", 40%). */
  onProgress?: (text: string, fraction: number | null) => void
  /** Finds a program on PATH (lsp.ts' findOnPath); a parameter so tests can stub it. */
  findOnPath: (program: string) => string | null
  /** Runs `go install` (a parameter so tests can stub it). */
  run?: (cmd: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<void>
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
}

const runCommand = (cmd: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { env, signal, timeout: 15 * 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-4).join(' ')))
      else resolve()
    })
  })

/** What an install of this server needs from the computer and is missing (null when nothing is). */
export function missingPrerequisite(id: InstallableServer, findOnPath: (program: string) => string | null): (typeof PREREQUISITE)[keyof typeof PREREQUISITE] | null {
  if (id === 'go' && !findOnPath('go')) return PREREQUISITE.go
  return null
}

/**
 * Download (or build) the language server into `<serversDir>/<id>`, replacing any earlier copy. The new copy
 * only takes over once it's complete: it's unpacked beside the old one first.
 */
export async function installServer(serversDir: string, id: InstallableServer, opts: InstallOptions): Promise<ServerManifest> {
  const fetchFn = opts.fetch ?? fetch
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const progress = opts.onProgress ?? (() => undefined)
  const dir = serverDir(serversDir, id)
  const staging = `${dir}.new`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const download = async (url: string, file: string, label: string) =>
    downloadFile(url, join(staging, file), { fetch: fetchFn, signal: opts.signal, onProgress: (got, total) => progress(`Downloading ${label}`, total ? got / total : null) })

  let manifest: ServerManifest
  try {
    if (id === 'go') {
      const go = opts.findOnPath('go')
      if (!go) throw new Error(`gopls is built with Go, and Go isn't installed. Install ${PREREQUISITE.go.name} from ${PREREQUISITE.go.url}, then try again.`)
      progress('Building gopls with go install (this takes a minute or two)', null)
      // GOBIN puts the binary in Cloth's folder; GOFLAGS stops a workspace go.work or vendor setting from interfering.
      await (opts.run ?? runCommand)(go, ['install', GOPLS_MODULE], { ...process.env, GOBIN: staging, GOFLAGS: '-mod=mod', GO111MODULE: 'on' }, opts.signal)
      const program = exe('gopls', platform)
      if (!existsSync(join(staging, program))) throw new Error('go install finished but gopls is not where it should be')
      manifest = { version: 'latest', program, installedAt: Date.now() }
    } else if (id === 'rust') {
      progress('Looking up rust-analyzer', null)
      const release = await latestRelease(RUST_RELEASES, fetchFn, opts.signal)
      const asset = rustAsset(release, platform, arch)
      if (!asset) throw new Error(`rust-analyzer has no build for ${platform} ${arch}. Install it with rustup: rustup component add rust-analyzer`)
      const file = await download(asset.browser_download_url, asset.name, 'rust-analyzer')
      const program = exe('rust-analyzer', platform)
      if (asset.name.endsWith('.zip')) {
        await unzip(file, staging, { signal: opts.signal })
      } else {
        await writeFile(join(staging, program), await gunzipAsync(await readFile(file)))
      }
      await rm(file, { force: true })
      if (!existsSync(join(staging, program))) throw new Error('The rust-analyzer download did not contain the program')
      if (platform !== 'win32') await chmod(join(staging, program), 0o755)
      manifest = { version: release.tag_name, program, installedAt: Date.now() }
    } else if (id === 'cpp') {
      progress('Looking up clangd', null)
      const release = await latestRelease(CLANGD_RELEASES, fetchFn, opts.signal)
      const asset = clangdAsset(release, platform, arch)
      if (!asset) throw new Error(`clangd has no build for ${platform} ${arch}. Install it from your system's package manager (e.g. apt install clangd).`)
      const file = await download(asset.browser_download_url, asset.name, 'clangd')
      progress('Unpacking clangd', null)
      await unzip(file, staging, { signal: opts.signal })
      await rm(file, { force: true })
      const found = findFile(staging, (rel) => rel.endsWith(`/bin/${exe('clangd', platform)}`))
      if (!found) throw new Error('The clangd download did not contain the program')
      if (platform !== 'win32') await chmod(found, 0o755)
      manifest = { version: release.tag_name, program: relative(staging, found).split(sep).join('/'), installedAt: Date.now() }
    } else {
      const file = await download(JDTLS_LATEST, 'jdtls.tar.gz', 'jdtls')
      progress('Unpacking jdtls', null)
      await untarGz(file, staging, { signal: opts.signal })
      await rm(file, { force: true })
      const launcher = findFile(staging, (rel) => /^plugins\/org\.eclipse\.equinox\.launcher_[^/]+\.jar$/.test(rel))
      const configuration = jdtlsConfigName(platform, arch)
      if (!launcher || !existsSync(join(staging, configuration))) throw new Error('The jdtls download is missing its launcher or configuration')
      const version = /launcher_([^/]+)\.jar$/.exec(launcher)?.[1] ?? 'latest'
      manifest = { version, launcher: relative(staging, launcher).split(sep).join('/'), configuration, installedAt: Date.now() }
    }
    await writeFile(join(staging, MANIFEST), JSON.stringify(manifest, null, 2))
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  // Swap in the new copy. A server still running from the old one keeps its files open on Windows: say so.
  await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {
    throw new Error(`The old copy in ${dir} is in use. Close chats using code intelligence for this language and try again.`)
  })
  await rename(staging, dir)
  progress('Installed', 1)
  return manifest
}

/** Remove Cloth's copy (PATH copies are left alone). */
export async function uninstallServer(serversDir: string, id: InstallableServer): Promise<void> {
  await rm(serverDir(serversDir, id), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
}

/** Size on disk of an installed copy, for the Settings list (bytes). */
export function installedSize(serversDir: string, id: InstallableServer): number {
  let total = 0
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  const dir = serverDir(serversDir, id)
  if (existsSync(dir)) walk(dir)
  return total
}
