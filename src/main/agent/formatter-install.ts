// Formatters and linters Cloth can install for itself, into `<data>/formatters/<id>`, from each project's GitHub
// releases: Ruff, Biome, golangci-lint (single programs) and google-java-format (a jar, run with Java).
// A copy here is used only where a folder has none of its own (formatters.ts).
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { FormatToolId, FormatToolStatus } from '@shared/formatters'
import { FORMAT_TOOLS } from '@shared/formatters'
import { downloadFile, USER_AGENT, type Fetch } from '../run/download'
import { unzip } from '../run/zip'
import { untarGz } from '../run/untar'
import { findJava, findOnPath } from './lsp'

export type InstallableFormatter = 'ruff' | 'biome' | 'golangci-lint' | 'google-java-format'
export const INSTALLABLE: InstallableFormatter[] = ['ruff', 'biome', 'golangci-lint', 'google-java-format']

const RELEASES: Record<InstallableFormatter, string> = {
  ruff: 'https://api.github.com/repos/astral-sh/ruff/releases/latest',
  // Biome's repository releases several packages; the CLI's tags start with @biomejs/biome@.
  biome: 'https://api.github.com/repos/biomejs/biome/releases?per_page=30',
  'golangci-lint': 'https://api.github.com/repos/golangci/golangci-lint/releases/latest',
  'google-java-format': 'https://api.github.com/repos/google/google-java-format/releases/latest'
}
const MANIFEST = 'cloth-formatter.json'

interface Asset {
  name: string
  browser_download_url: string
}
interface Release {
  tag_name: string
  assets: Asset[]
}
interface Manifest {
  version: string
  /** Relative to the tool's folder. */
  program: string
  installedAt: number
}

const exe = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name)

/** The release file for this computer, or null when the project doesn't build one for it. */
export function formatterAsset(id: InstallableFormatter, release: Release, platform: NodeJS.Platform = process.platform, arch: string = process.arch): Asset | null {
  const find = (test: (n: string) => boolean) => release.assets.find((a) => test(a.name)) ?? null
  if (id === 'google-java-format') return find((n) => /^google-java-format-[\d.]+-all-deps\.jar$/.test(n))
  if (id === 'ruff') {
    const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
    if (!cpu) return null
    const target = platform === 'win32' ? `${cpu}-pc-windows-msvc.zip` : platform === 'darwin' ? `${cpu}-apple-darwin.tar.gz` : platform === 'linux' ? `${cpu}-unknown-linux-gnu.tar.gz` : null
    return target ? find((n) => n === `ruff-${target}`) : null
  }
  if (id === 'biome') {
    const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
    const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null
    return os && cpu ? find((n) => n === `biome-${os}-${cpu}${os === 'win32' ? '.exe' : ''}`) : null
  }
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null
  return os && cpu ? find((n) => new RegExp(`^golangci-lint-[\\d.]+-${os}-${cpu}\\.(zip|tar\\.gz)$`).test(n)) : null
}

/** The newest release of Biome's command-line program among the repository's releases. */
export function biomeRelease(list: Release[]): Release | null {
  return list.find((r) => r.tag_name.startsWith('@biomejs/biome@') || r.tag_name.startsWith('cli/v')) ?? null
}

export const formatterDir = (toolsDir: string, id: FormatToolId) => join(toolsDir, id)

function readManifest(toolsDir: string, id: FormatToolId): Manifest | null {
  try {
    const m = JSON.parse(readFileSync(join(formatterDir(toolsDir, id), MANIFEST), 'utf8')) as Manifest
    return existsSync(join(formatterDir(toolsDir, id), m.program)) ? m : null
  } catch {
    return null
  }
}

/** Cloth's installed copy of a tool (absolute path to the program or jar), or null. */
export function installedFormatter(toolsDir: string, id: FormatToolId): string | null {
  const m = readManifest(toolsDir, id)
  return m ? join(formatterDir(toolsDir, id), m.program) : null
}

function findFile(dir: string, test: (name: string) => boolean): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findFile(full, test)
      if (hit) return hit
    } else if (test(e.name)) return full
  }
  return null
}

export interface FormatterInstallOptions {
  fetch?: Fetch
  signal?: AbortSignal
  onProgress?: (text: string, fraction: number | null) => void
  platform?: NodeJS.Platform
  arch?: string
}

export async function installFormatter(toolsDir: string, id: InstallableFormatter, opts: FormatterInstallOptions = {}): Promise<Manifest> {
  const fetchFn = opts.fetch ?? fetch
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const progress = opts.onProgress ?? (() => undefined)
  const name = FORMAT_TOOLS.find((t) => t.id === id)!.name
  const dir = formatterDir(toolsDir, id)
  const staging = `${dir}.new`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    progress(`Looking up ${name}`, null)
    const res = await fetchFn(RELEASES[id], { signal: opts.signal ?? AbortSignal.timeout(30_000), headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`Couldn't look up the latest ${name} (HTTP ${res.status}). Check the connection and try again.`)
    const body = (await res.json()) as Release | Release[]
    const release = Array.isArray(body) ? biomeRelease(body) : body
    const asset = release && formatterAsset(id, release, platform, arch)
    if (!release || !asset) throw new Error(`${name} has no download for ${platform} ${arch}.`)
    const file = join(staging, asset.name)
    await downloadFile(asset.browser_download_url, file, { fetch: fetchFn, signal: opts.signal, onProgress: (got, total) => progress(`Downloading ${name}`, total ? got / total : null) })
    let program: string
    if (/\.zip$/i.test(asset.name) || /\.tar\.gz$/i.test(asset.name)) {
      progress(`Unpacking ${name}`, null)
      if (/\.zip$/i.test(asset.name)) await unzip(file, staging, { signal: opts.signal })
      else await untarGz(file, staging, { signal: opts.signal })
      await rm(file, { force: true })
      const found = findFile(staging, (n) => n === exe(id, platform))
      if (!found) throw new Error(`The ${name} download did not contain the program`)
      program = relative(staging, found).split(sep).join('/')
    } else if (asset.name.endsWith('.jar')) {
      program = asset.name
    } else {
      program = exe(id, platform)
      await rename(file, join(staging, program))
    }
    if (platform !== 'win32' && !program.endsWith('.jar')) await chmod(join(staging, program), 0o755)
    const version = release.tag_name.replace(/^@biomejs\/biome@|^cli\/|^v/, '')
    const manifest: Manifest = { version, program, installedAt: Date.now() }
    await writeFile(join(staging, MANIFEST), JSON.stringify(manifest, null, 2))
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {
      throw new Error(`The old copy in ${dir} is in use. Try again once nothing is running it.`)
    })
    await rename(staging, dir)
    progress('Installed', 1)
    return manifest
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

/** Remove Cloth's copy (copies elsewhere on this PC are left alone). */
export async function uninstallFormatter(toolsDir: string, id: InstallableFormatter): Promise<void> {
  await rm(formatterDir(toolsDir, id), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
}

const TOOLCHAIN: Partial<Record<FormatToolId, { program: string; name: string; url: string }>> = {
  gofmt: { program: 'gofmt', name: 'Go', url: 'https://go.dev/dl/' },
  rustfmt: { program: 'rustfmt', name: 'Rust', url: 'https://rustup.rs/' },
  clippy: { program: 'cargo-clippy', name: 'Rust', url: 'https://rustup.rs/' }
}
const HOW_TO: Partial<Record<FormatToolId, string>> = {
  black: 'https://black.readthedocs.io/en/stable/getting_started.html',
  'clang-format': 'https://clang.llvm.org/docs/ClangFormat.html'
}

/** Where each tool stands on this PC (not in any one folder: a folder's own copy is found when it runs). */
export function formatterStatuses(toolsDir: string | null, java: () => { major: number | null } | null = findJava): FormatToolStatus[] {
  return FORMAT_TOOLS.map((t): FormatToolStatus => {
    if (t.id === 'prettier') return { id: t.id, status: 'bundled' }
    if (t.id === 'eslint') return { id: t.id, status: 'project' }
    const chain = TOOLCHAIN[t.id]
    if (chain) {
      const found = findOnPath(chain.program)
      return found ? { id: t.id, status: 'found', program: t.id === 'clippy' ? 'cargo clippy' : chain.program } : { id: t.id, status: 'toolchain', needs: { name: chain.name, url: chain.url } }
    }
    const installable = (INSTALLABLE as FormatToolId[]).includes(t.id)
    const needsJava = t.id === 'google-java-format' ? (() => {
      const j = java()
      return !j || (j.major !== null && j.major < 21) ? { name: 'Java 21 or newer', url: 'https://adoptium.net/temurin/releases/?version=21' } : null
    })() : null
    const manifest = toolsDir && installable ? readManifest(toolsDir, t.id) : null
    if (manifest) return { id: t.id, status: 'installed', program: t.name, version: manifest.version, installable: true, needs: needsJava }
    const program = t.id === 'google-java-format' ? 'google-java-format' : t.id
    if (findOnPath(program)) return { id: t.id, status: 'found', program, installable: installable && !!toolsDir, needs: needsJava }
    return { id: t.id, status: 'missing', program, installable: installable && !!toolsDir, url: HOW_TO[t.id], needs: needsJava }
  })
}
