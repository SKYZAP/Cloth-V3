import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/**
 * Risky actions: what still asks for approval in a chat set to Auto (and what an unattended
 * automation refuses). Everything here is a pure function of the command or path, so it is easy to
 * test; `commandRiskResolved` / `pathRiskResolved` add one look at the disk to follow links.
 *
 * A command or path is risky when it
 * - deletes, moves or writes outside the chat's folder (paths are resolved against the command's
 *   folder, `..` and `~` included; Windows paths compare case-insensitively; a path that can't be
 *   worked out, e.g. built from a variable, counts as outside; writing a log or scratch file in
 *   /tmp or /var/tmp is fine);
 * - recursively deletes a broad path: `/`, a drive root, the home folder, a parent of the chat's
 *   folder, or the whole chat's folder itself (`rm -rf .`, `Remove-Item * -Recurse`);
 * - publishes or discards work with git: push (and force push), reset --hard, clean -f, checkout of
 *   paths / restore, config --global / --system;
 * - installs packages: npm / pnpm / yarn / bun add or install with a package name (or -g), pip /
 *   uv / poetry / pipx / conda / gem / cargo / go / composer / dotnet installs, and system package
 *   managers (apt, dnf, yum, pacman, apk, brew, snap, winget, choco, scoop, Install-Module …);
 * - downloads from the network (curl, wget, Invoke-WebRequest / iwr, Invoke-RestMethod / irm,
 *   Start-BitsTransfer, certutil -urlcache, WebClient) to anything but this computer, and above all
 *   pipes a download into a shell (`curl … | sh`, `iex (irm …)`);
 * - runs elevated: sudo, doas, su, pkexec, runas, gsudo, Start-Process -Verb RunAs;
 * - shuts down or restarts the computer;
 * - touches disks or partitions: mkfs, fdisk, parted, diskpart, format, Format-Volume, dd to a device …;
 * - changes system or global settings: setx, registry edits (reg, HKLM:/HKCU:), machine or user
 *   environment variables, npm/yarn/pip config set, execution policy, services, firewall, crontab.
 *
 * Commands wrapped in `bash -c`, `sh -c`, `cmd /c`, `powershell -Command` or `Invoke-Expression`
 * are looked into. The list errs towards asking: a false alarm costs one click.
 */

export interface RiskContext {
  /** The chat's folder, ideally already resolved through links (realpath). */
  root: string
  /** The folder the command runs in (default: root). */
  cwd?: string
  shell: 'bash' | 'powershell'
  /** Path rules: win32 = drive letters and case-insensitive; default from this computer. */
  platform?: 'win32' | 'posix'
  /** The user's home folder, for ~ and $HOME (unknown = treated as outside). */
  home?: string
  /** An earlier `cd` went somewhere that can't be worked out: relative paths count as outside. */
  unknownCwd?: boolean
}

export const RISK = {
  deleteOutside: "Deletes files outside the chat's folder",
  moveOutside: "Moves files outside the chat's folder",
  writeOutside: "Writes outside the chat's folder",
  deleteBroad: (p: string) => `Recursively deletes a broad path (${p})`,
  deleteFolder: "Deletes everything in the chat's folder",
  push: 'Pushes to a remote',
  forcePush: 'Force-pushes to a remote',
  resetHard: 'Discards uncommitted changes (git reset --hard)',
  clean: 'Deletes untracked files (git clean)',
  discard: 'Discards uncommitted changes',
  gitGlobal: 'Changes global git settings',
  install: 'Installs packages',
  installGlobal: 'Installs packages globally',
  download: 'Downloads from the network',
  runDownload: 'Runs a script downloaded from the network',
  elevated: 'Runs with administrator rights',
  shutdown: 'Shuts down or restarts the computer',
  disk: 'Changes disks or partitions',
  registry: 'Changes the registry',
  system: 'Changes system or global settings'
} as const

// ─── Paths ────────────────────────────────────────────────────────────────────

type PathMod = typeof posix

const platformOf = (ctx: { platform?: 'win32' | 'posix' }): 'win32' | 'posix' => ctx.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
const modOf = (platform: 'win32' | 'posix'): PathMod => (platform === 'win32' ? win32 : posix)

/** Whether `p` is `root` or inside it (Windows: ignoring case). */
function within(mod: PathMod, root: string, p: string, win: boolean): boolean {
  const a = win ? root.toLowerCase() : root
  const b = win ? p.toLowerCase() : p
  const rel = mod.relative(a, b)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${mod.sep}`) && !mod.isAbsolute(rel))
}

const same = (mod: PathMod, a: string, b: string, win: boolean) => {
  const x = mod.resolve(a)
  const y = mod.resolve(b)
  return win ? x.toLowerCase() === y.toLowerCase() : x === y
}

const HOME_VARS = /^(\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|%HOMEPATH%|\$env:HOMEPATH)(?=$|[\\/])/i
const NULL_TARGETS = /^(\/dev\/(null|stdout|stderr|tty)|\$null|nul)$/i

/**
 * A path argument as an absolute path, 'provider' for PowerShell provider paths that aren't files
 * (Env:, Variable:, HKLM: — registry is checked on its own), or null when it can't be worked out.
 */
function resolveArg(raw: string, ctx: RiskContext): string | 'provider' | null {
  const platform = platformOf(ctx)
  const mod = modOf(platform)
  let p = raw.trim()
  if (!p) return null
  if (/^file:\/\//i.test(p)) p = p.replace(/^file:\/\/\/?/i, platform === 'win32' ? '' : '/')
  const home = HOME_VARS.exec(p)
  if (home) {
    if (!ctx.home) return null
    p = ctx.home + p.slice(home[0].length)
  } else if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (!ctx.home) return null
    p = ctx.home + p.slice(1)
  } else if (p.startsWith('~')) return null // ~otheruser
  // Variables, subexpressions and command substitutions: can't tell where they point.
  if (/[$`%]/.test(p) || p.includes('$(')) return null
  // PowerShell providers (Env:, HKLM:, Registry::…): two or more letters before the colon.
  if (/^[a-z]{2,}::?/i.test(p) && !/^[a-z]:/i.test(p)) return 'provider'
  if (ctx.unknownCwd && !mod.isAbsolute(p)) return null
  // Globs: a bare * (or *.*) means everything in its folder; any other pattern, some files in it.
  const glob = p.search(/[*?[]/)
  if (glob >= 0) {
    const head = p.slice(0, glob)
    const cut = Math.max(head.lastIndexOf('/'), platform === 'win32' ? head.lastIndexOf('\\') : -1)
    const dir = cut >= 0 ? head.slice(0, cut + 1) || mod.sep : '.'
    const everything = /^(\*|\*\.\*)[\\/]?$/.test(p.slice(cut + 1))
    return mod.resolve(ctx.cwd ?? ctx.root, dir, everything ? '.' : 'glob-match')
  }
  return mod.resolve(ctx.cwd ?? ctx.root, p)
}

type PathKind = 'delete' | 'move' | 'write'

/** Why changing `abs` (an absolute path) is risky for this folder, or null. */
function pathReason(abs: string, kind: PathKind, recursive: boolean, ctx: RiskContext): string | null {
  const win = platformOf(ctx) === 'win32'
  const mod = modOf(platformOf(ctx))
  const root = mod.resolve(ctx.root)
  if (kind === 'delete' && recursive) {
    const fsRoot = mod.parse(abs).root
    const broad = same(mod, abs, fsRoot, win) || (!!ctx.home && same(mod, abs, ctx.home, win)) || (within(mod, abs, root, win) && !same(mod, abs, root, win))
    if (broad) return RISK.deleteBroad(abs)
    if (same(mod, abs, root, win)) return RISK.deleteFolder
  }
  if (within(mod, root, abs, win)) return null
  // Scratch files and logs in the system temp folder (`> /tmp/dev.log`) are fine to write.
  if (kind === 'write' && !win && (within(mod, '/tmp', abs, false) || within(mod, '/var/tmp', abs, false)) && !same(mod, abs, '/tmp', false)) return null
  return kind === 'delete' ? RISK.deleteOutside : kind === 'move' ? RISK.moveOutside : RISK.writeOutside
}

/**
 * Why writing, deleting or moving `path` (relative to `root`, or absolute) is risky: it lies
 * outside the chat's folder, or (recursive deletes) it is a broad path. Pure; see pathRiskResolved.
 */
export function pathRisk(root: string, path: string, kind: PathKind = 'write', opts: { platform?: 'win32' | 'posix'; home?: string; recursive?: boolean } = {}): string | null {
  const ctx: RiskContext = { root, shell: 'bash', platform: opts.platform, home: opts.home }
  const abs = resolveArg(path, ctx)
  if (abs === 'provider') return null
  if (abs === null) return kind === 'delete' ? RISK.deleteOutside : kind === 'move' ? RISK.moveOutside : RISK.writeOutside
  return pathReason(abs, kind, !!opts.recursive, ctx)
}

/** Where `abs` really is: its nearest existing ancestor resolved through links, plus the rest. */
async function real(abs: string): Promise<string> {
  let probe = abs
  const rest: string[] = []
  while (!existsSync(probe)) {
    const parent = posixOrWin(abs).dirname(probe)
    if (parent === probe) return abs
    rest.unshift(posixOrWin(abs).basename(probe))
    probe = parent
  }
  return posixOrWin(abs).join(await realpath(probe).catch(() => probe), ...rest)
}

const posixOrWin = (p: string): PathMod => (/^[a-z]:[\\/]|^\\\\/i.test(p) ? win32 : posix)

/** pathRisk, also following links: a path inside the folder that leads outside it is risky too. */
export async function pathRiskResolved(root: string, path: string, kind: PathKind = 'write', opts: { platform?: 'win32' | 'posix'; home?: string; recursive?: boolean } = {}): Promise<string | null> {
  const lexical = pathRisk(root, path, kind, opts)
  if (lexical) return lexical
  const rootReal = await real(root)
  const abs = resolveArg(path, { root, shell: 'bash', platform: opts.platform, home: opts.home })
  if (typeof abs !== 'string') return null
  return pathReason(await real(abs), kind, !!opts.recursive, { root: rootReal, shell: 'bash', platform: opts.platform, home: opts.home })
}

// ─── Command parsing ──────────────────────────────────────────────────────────

interface Segment {
  words: string[]
  /** Redirect targets (`> file`, `>> file`). */
  redirects: string[]
  /** This segment reads the previous one's output (`a | b`). */
  piped: boolean
}

/** Split a command line into simple commands (on ; && || | & and newlines) and their words, honouring quotes. */
export function parseCommand(command: string, shell: 'bash' | 'powershell'): Segment[] {
  const out: Segment[] = []
  let words: string[] = []
  let redirects: string[] = []
  let word = ''
  let quoted = false
  let piped = false
  let redirectNext = false
  const flushWord = () => {
    if (word || quoted) {
      if (redirectNext) redirects.push(word)
      else words.push(word)
      redirectNext = false
    }
    word = ''
    quoted = false
  }
  const flushSeg = (nextPiped: boolean) => {
    flushWord()
    if (words.length || redirects.length) out.push({ words, redirects, piped })
    words = []
    redirects = []
    redirectNext = false
    piped = nextPiped
  }
  const esc = shell === 'powershell' ? '`' : '\\'
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      word += command.slice(i + 1, end < 0 ? undefined : end)
      quoted = true
      i = end < 0 ? command.length : end
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < command.length && command[j] !== '"') {
        if (command[j] === esc && j + 1 < command.length) {
          word += command[j + 1]
          j += 2
          continue
        }
        word += command[j++]
      }
      quoted = true
      i = j
      continue
    }
    if (c === esc && shell === 'bash' && i + 1 < command.length) {
      word += command[++i]
      continue
    }
    if (c === '\n' || c === ';') {
      flushSeg(false)
      continue
    }
    if (c === '|') {
      if (command[i + 1] === '|') {
        i++
        flushSeg(false)
      } else flushSeg(true)
      continue
    }
    if (c === '&') {
      if (command[i + 1] === '&') {
        i++
        flushSeg(false)
        continue
      }
      // PowerShell's call operator `& "C:\tool.exe"` starts a command; bash's `&` ends one.
      if (shell === 'powershell' && !word) continue
      flushSeg(false)
      continue
    }
    if (c === '>') {
      // An fd prefix (2>, *>) belongs to the redirect, not the word before it.
      if (/^[0-9*]$/.test(word)) word = ''
      flushWord()
      if (command[i + 1] === '>') i++
      if (command[i + 1] === '&') {
        // 2>&1: a stream merge, no file.
        i++
        while (i + 1 < command.length && /[0-9-]/.test(command[i + 1])) i++
        continue
      }
      redirectNext = true
      continue
    }
    if (c === '<' && shell === 'bash' && command[i + 1] === '(') {
      // Process substitution: read as its own command.
      flushSeg(false)
      i++
      continue
    }
    if (/\s/.test(c)) {
      flushWord()
      continue
    }
    if ((c === '(' || c === ')') && !word) {
      // Subshells / PowerShell subexpressions: their insides are commands too.
      flushSeg(false)
      continue
    }
    if (c === ')') {
      flushSeg(false)
      continue
    }
    word += c
  }
  flushSeg(false)
  return out
}

// ─── Command rules ────────────────────────────────────────────────────────────

const prog = (w: string) =>
  w
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '')

const isUrl = (w: string) => /^(https?|ftp):\/\//i.test(w)
const LOCAL_HOST = /^(https?:\/\/)?(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|host\.docker\.internal)([:/]|$)/i
/** A URL, or a bare host curl/wget would fetch (example.com/x), that isn't this computer. */
const remoteUrl = (w: string) => (isUrl(w) || /^www\./i.test(w) || /^[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|co|app|ai|gov|edu|xyz|me|info|cloud)(:\d+)?(\/|$)/i.test(w)) && !LOCAL_HOST.test(w)

const DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'trash-put', 'remove-item', 'ri', 'del', 'erase', 'rd'])
const MOVE = new Set(['mv', 'move-item', 'mi', 'move', 'ren', 'rename', 'rename-item', 'rni'])
const COPY = new Set(['cp', 'copy-item', 'cpi', 'copy', 'xcopy', 'robocopy', 'rsync', 'scp'])
const WRITE = new Set(['touch', 'mkdir', 'md', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'tee', 'tee-object', 'clear-content', 'clc', 'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'set-acl', 'icacls', 'takeown', 'attrib'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'py', 'node', 'perl', 'ruby', 'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression'])
const DOWNLOAD = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'start-bitstransfer', 'aria2c', 'http', 'xh'])
const ELEVATE = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas', 'gsudo'])
const SHUTDOWN = new Set(['shutdown', 'reboot', 'poweroff', 'halt', 'restart-computer', 'stop-computer'])
const DISK = new Set(['fdisk', 'sfdisk', 'gdisk', 'cfdisk', 'parted', 'diskpart', 'wipefs', 'format-volume', 'clear-disk', 'initialize-disk', 'new-partition', 'remove-partition', 'resize-partition', 'set-disk', 'set-partition', 'diskutil', 'mkswap'])
const SYS_PKG = new Set(['apt', 'apt-get', 'aptitude', 'dnf', 'yum', 'zypper', 'brew', 'port', 'snap', 'flatpak', 'winget', 'choco', 'scoop', 'pipx', 'conda', 'mamba', 'gem'])
const SYSTEM = new Set(['setx', 'regedit', 'set-executionpolicy', 'bcdedit', 'netsh', 'new-service', 'set-service', 'remove-service', 'launchctl', 'chsh', 'update-alternatives', 'set-mppreference', 'add-mppreference', 'new-netfirewallrule', 'set-netfirewallprofile', 'set-netfirewallrule', 'ufw', 'iptables', 'sysctl', 'visudo', 'usermod', 'useradd', 'userdel', 'passwd', 'net'])
/** PowerShell parameters whose value is a path. */
const PATH_PARAMS = new Set(['-path', '-literalpath', '-lp', '-pspath', '-destination', '-filepath', '-target', '-name', '-newname'])
/** PowerShell parameters that take a value that isn't a path. */
const VALUE_PARAMS = new Set(['-erroraction', '-ea', '-filter', '-include', '-exclude', '-value', '-encoding', '-itemtype', '-type', '-credential', '-stream', '-verb', '-argumentlist', '-workingdirectory', '-propertytype', '-scope', '-depth', '-outvariable', '-warningaction', '-informationaction', '-inputobject', '-delimiter', '-width'])

interface Args {
  flags: string[]
  /** Positional arguments and values of path parameters. */
  paths: string[]
}

function splitArgs(words: string[], ctx: RiskContext): Args {
  const flags: string[] = []
  const paths: string[] = []
  const ps = ctx.shell === 'powershell'
  const win = platformOf(ctx) === 'win32'
  let rest = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (rest) {
      paths.push(w)
      continue
    }
    if (w === '--') {
      rest = true
      continue
    }
    if (ps && /^-[a-z]/i.test(w)) {
      const name = w.toLowerCase().replace(/:.*$/, '')
      flags.push(name)
      const inline = w.includes(':') ? w.slice(w.indexOf(':') + 1) : null
      if (PATH_PARAMS.has(name)) {
        if (inline) paths.push(inline)
        else if (i + 1 < words.length) paths.push(words[++i])
      } else if (VALUE_PARAMS.has(name) && !inline) i++
      continue
    }
    if (!ps && w.startsWith('-') && w.length > 1) {
      flags.push(w)
      continue
    }
    // cmd.exe switches (/s /q) on Windows.
    if (win && /^\/[a-z?]{1,2}(:\S*)?$/i.test(w)) {
      flags.push(w.toLowerCase())
      continue
    }
    paths.push(w)
  }
  return { flags, paths }
}

const recursiveFlag = (flags: string[], ps: boolean) =>
  flags.some((f) => (ps ? /^-r/i.test(f) : /^-[a-z]*r/i.test(f) || f === '--recursive') || /^\/s$/i.test(f))

/** Why changing these paths is risky (first reason found). */
function pathsReason(paths: string[], kind: PathKind, recursive: boolean, ctx: RiskContext, targets: string[]): string | null {
  for (const raw of paths) {
    if (NULL_TARGETS.test(raw)) continue
    const abs = resolveArg(raw, ctx)
    if (abs === 'provider') continue
    if (abs === null) return kind === 'delete' ? RISK.deleteOutside : kind === 'move' ? RISK.moveOutside : RISK.writeOutside
    targets.push(abs)
    const why = pathReason(abs, kind, recursive, ctx)
    if (why) return why
  }
  return null
}

/** The git subcommand and its arguments, past global options (-C dir, -c k=v, --no-pager…). */
function gitArgs(words: string[]): string[] {
  let i = 1
  while (i < words.length && words[i].startsWith('-')) i += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(words[i]) ? 2 : 1
  return words.slice(i)
}

function gitReason(words: string[]): string | null {
  const [sub, ...rest] = gitArgs(words)
  const lower = rest.map((w) => w.toLowerCase())
  switch (sub?.toLowerCase()) {
    case 'push':
      return lower.some((w) => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror|--delete|-d)$/.test(w) || /^-[a-z]*f[a-z]*$/.test(w) || w.startsWith('+') || /^:[^\s]/.test(w)) ? RISK.forcePush : RISK.push
    case 'reset':
      return lower.includes('--hard') || lower.includes('--merge') || lower.includes('--keep') ? RISK.resetHard : null
    case 'clean':
      return lower.some((w) => w === '--force' || /^-[a-z]*f/.test(w)) ? RISK.clean : null
    case 'checkout':
      return lower.some((w) => w === '--' || w === '.' || w === '-f' || w === '--force') ? RISK.discard : null
    case 'restore':
      return lower.includes('--staged') && !lower.includes('--worktree') && !lower.includes('-w') ? null : RISK.discard
    case 'stash':
      return lower[0] === 'drop' || lower[0] === 'clear' ? RISK.discard : null
    case 'config':
      return lower.some((w) => w === '--global' || w === '--system') ? RISK.gitGlobal : null
    default:
      return null
  }
}

const NODE_PM = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cnpm'])
const NODE_INSTALL = new Set(['install', 'i', 'in', 'ins', 'inst', 'add', 'isntall'])

function installReason(p: string, words: string[], ctx: RiskContext): string | null {
  const { flags, paths } = splitArgs(words.slice(1), { ...ctx, shell: 'bash' })
  const sub = paths[0]?.toLowerCase()
  const global = flags.some((f) => f === '-g' || f === '--global' || f === '--location=global')
  if (NODE_PM.has(p)) {
    if (p === 'yarn' && sub === 'global' && paths[1]?.toLowerCase() === 'add') return RISK.installGlobal
    if (sub === 'config' && paths[1]?.toLowerCase() === 'set') return RISK.system
    if (p === 'npm' && sub === 'set') return RISK.system
    if (!sub || !NODE_INSTALL.has(sub)) return null
    if (global) return RISK.installGlobal
    // A bare `npm install` restores the lockfile's packages; naming one adds it.
    return paths.length > 1 ? RISK.install : null
  }
  if (p === 'pip' || p === 'pip3') return sub === 'install' ? RISK.install : sub === 'config' && paths[1] === 'set' ? RISK.system : null
  if (p === 'python' || p === 'python3' || p === 'py') {
    const m = words.indexOf('-m')
    return m >= 0 && /^pip3?$/.test(words[m + 1] ?? '') && words[m + 2] === 'install' ? RISK.install : null
  }
  if (p === 'uv') return (sub === 'pip' && paths[1] === 'install') || sub === 'add' || (sub === 'tool' && paths[1] === 'install') ? RISK.install : null
  if (p === 'poetry') return sub === 'add' ? RISK.install : null
  if (p === 'cargo') return sub === 'install' ? RISK.install : null
  if (p === 'go') return sub === 'install' || sub === 'get' ? RISK.install : null
  if (p === 'composer') return sub === 'require' || (sub === 'global' && paths[1] === 'require') ? RISK.install : null
  if (p === 'dotnet') return (sub === 'tool' && paths[1] === 'install') || (sub === 'add' && paths[2] === 'package') ? RISK.install : null
  if (p === 'apk') return sub === 'add' ? RISK.install : null
  if (p === 'pacman') return flags.some((f) => /^-S/.test(f)) ? RISK.install : null
  if (p === 'install-module' || p === 'install-package' || p === 'install-script') return RISK.install
  if (SYS_PKG.has(p)) return sub === 'install' || sub === 'reinstall' || sub === 'upgrade' || (p === 'snap' && sub === 'refresh') ? RISK.install : null
  return null
}

const INNER: Record<string, { flag: RegExp; shell: 'bash' | 'powershell' }> = {
  bash: { flag: /^-[a-z]*c$/i, shell: 'bash' },
  sh: { flag: /^-[a-z]*c$/i, shell: 'bash' },
  zsh: { flag: /^-[a-z]*c$/i, shell: 'bash' },
  dash: { flag: /^-[a-z]*c$/i, shell: 'bash' },
  cmd: { flag: /^\/[ck]$/i, shell: 'powershell' },
  powershell: { flag: /^-(c|command|encodedcommand|e|ec)$/i, shell: 'powershell' },
  pwsh: { flag: /^-(c|command|encodedcommand|e|ec)$/i, shell: 'powershell' }
}

interface Found {
  reason: string | null
  /** Paths the command changes, for following links afterwards. */
  targets: { abs: string; kind: PathKind; recursive: boolean }[]
}

const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'])

function analyze(command: string, ctx: RiskContext, depth = 0): Found {
  const targets: Found['targets'] = []
  const text = command.toLowerCase()
  const segments = parseCommand(command, ctx.shell)
  const webClient = /\b(downloadstring|downloadfile|net\.webclient)\b/.test(text) || /certutil(\.exe)?\s+.*-urlcache/.test(text)
  const fetcher = /(^|[\s(|;&$"'])(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(\.exe)?\s/.test(text)
  const remote = webClient || (fetcher && command.split(/[\s"'()|;&]+/).some(remoteUrl))
  // A download handed straight to an interpreter.
  const interpreter = (words: string[]) => SHELLS.has(prog(words.find((w) => !ELEVATE.has(prog(w)) && !w.startsWith('-')) ?? ''))
  const interpreted = segments.some((s, i) => i > 0 && s.piped && interpreter(s.words)) || /\b(iex|invoke-expression)\b/.test(text) || /<\(\s*(curl|wget)/.test(text) || /\$\(\s*(curl|wget|irm|iwr)/.test(text)
  if (remote && interpreted) return { reason: RISK.runDownload, targets }
  let cur = ctx
  for (const seg of segments) {
    // `cd somewhere && rm -rf build`: later paths are relative to where it went.
    const first = seg.words[0] ? prog(seg.words[0]) : ''
    if (CD.has(first)) {
      const arg = seg.words.slice(1).find((w) => !w.startsWith('-'))
      const to = arg === undefined ? (ctx.home ?? null) : arg === '-' ? null : resolveArg(arg, cur)
      cur = typeof to === 'string' && to !== 'provider' ? { ...cur, cwd: to, unknownCwd: false } : { ...cur, unknownCwd: true }
      continue
    }
    const reason = segmentReason(seg, cur, targets, depth)
    if (reason) return { reason, targets }
  }
  if (/\[(system\.)?environment\]::setenvironmentvariable\(.*(machine|user)/.test(text)) return { reason: RISK.system, targets }
  if (webClient) return { reason: RISK.download, targets }
  return { reason: null, targets }
}

function segmentReason(seg: Segment, ctx: RiskContext, targets: Found['targets'], depth: number): string | null {
  const ps = ctx.shell === 'powershell'
  let words = seg.words
  // Redirects write files.
  for (const r of seg.redirects) {
    if (NULL_TARGETS.test(r)) continue
    const abs = resolveArg(r, ctx)
    if (abs === 'provider') continue
    if (abs === null) return RISK.writeOutside
    targets.push({ abs, kind: 'write', recursive: false })
    const why = pathReason(abs, 'write', false, ctx)
    if (why) return why
  }
  // Leading VAR=value assignments and wrappers that run the rest.
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) && !ps) words = words.slice(1)
  if (!words.length) return null
  let p = prog(words[0])
  if (ELEVATE.has(p)) return RISK.elevated
  while (['env', 'nohup', 'time', 'command', 'exec', 'nice', 'timeout', 'xargs', 'stdbuf', 'npx', 'call'].includes(p) && words.length > 1) {
    // npx runs a local tool; the tool itself is what to look at. `timeout 5 cmd`, `nice -n 5 cmd`: skip their options.
    let i = 1
    while (i < words.length && (words[i].startsWith('-') || /^\d+[smhd]?$/.test(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]))) i++
    if (p === 'xargs' && i < words.length && (DELETE.has(prog(words[i])) || MOVE.has(prog(words[i])))) return RISK.deleteOutside
    if (p === 'npx') return null
    words = words.slice(i)
    if (!words.length) return null
    p = prog(words[0])
    if (ELEVATE.has(p)) return RISK.elevated
  }
  const lower = words.map((w) => w.toLowerCase())

  // Commands wrapped in another shell.
  const inner = INNER[p]
  if (inner && depth < 3) {
    const at = lower.findIndex((w, i) => i > 0 && inner.flag.test(w))
    if (at > 0 && at + 1 < words.length) {
      const found = analyze(words.slice(at + 1).join(' '), { ...ctx, shell: inner.shell }, depth + 1)
      targets.push(...found.targets)
      if (found.reason) return found.reason
      return null
    }
  }
  if ((p === 'iex' || p === 'invoke-expression') && depth < 3 && words.length > 1) {
    const found = analyze(words.slice(1).join(' '), ctx, depth + 1)
    targets.push(...found.targets)
    return found.reason
  }

  if (p === 'start-process' || p === 'saps' || (p === 'start' && ps)) {
    const verb = lower.indexOf('-verb')
    if (verb >= 0 && lower[verb + 1] === 'runas') return RISK.elevated
    if (lower.some((w) => w === '-verb:runas')) return RISK.elevated
  }
  if (SHUTDOWN.has(p)) return RISK.shutdown
  if (p === 'systemctl' && /^(reboot|poweroff|halt|suspend|hibernate|kexec)$/.test(lower[1] ?? '')) return RISK.shutdown
  if (p === 'init' && /^[06]$/.test(lower[1] ?? '')) return RISK.shutdown
  if (p === 'systemctl' && /^(enable|disable|mask|unmask|stop|start|restart|daemon-reload|set-default)$/.test(lower[1] ?? '')) return RISK.system
  if (DISK.has(p) || p.startsWith('mkfs')) return RISK.disk
  if (p === 'format' && words.slice(1).some((w) => /^[a-z]:\\?$/i.test(w))) return RISK.disk
  if (p === 'dd') {
    const of = words.find((w) => w.toLowerCase().startsWith('of='))
    if (of && /^of=\/dev\//i.test(of) && !NULL_TARGETS.test(of.slice(3))) return RISK.disk
    if (of) {
      const why = pathsReason([of.slice(3)], 'write', false, ctx, [])
      if (why) return why
    }
    return null
  }
  if (p === 'reg' && /^(add|delete|import|copy|restore|load|unload)$/.test(lower[1] ?? '')) return RISK.registry
  if (/-itemproperty$|^(sp|rp)$/.test(p) || ['set-item', 'si', 'new-item', 'ni', 'remove-item', 'ri', 'rm', 'del', 'rd', 'rmdir', 'erase'].includes(p)) {
    if (words.slice(1).some((w) => /^(hklm|hkcu|hkcr|hku|hkcc):|^registry::/i.test(w))) return RISK.registry
  }
  if (SYSTEM.has(p)) {
    if (p === 'net' && !/^(user|localgroup|share|use|start|stop)$/.test(lower[1] ?? '')) return null
    return RISK.system
  }
  if (p === 'crontab' && words.length > 1 && !lower.includes('-l')) return RISK.system
  if (p === 'defaults' && lower[1] === 'write') return RISK.system
  if (p === 'git') return gitReason(words)
  const install = installReason(p, words, ctx)
  if (install) return install
  if (DOWNLOAD.has(p) || p === 'certutil') {
    if (words.slice(1).some(remoteUrl)) return RISK.download
    if (p === 'certutil' && lower.includes('-urlcache')) return RISK.download
    // A URL that comes from a variable could be anywhere.
    if (p !== 'curl' && p !== 'wget' && words.slice(1).some((w) => /^\$/.test(w))) return RISK.download
  }

  // Deleting, moving, copying and writing files.
  const { flags, paths } = splitArgs(words.slice(1), ctx)
  if (DELETE.has(p)) return trackPaths(paths, 'delete', recursiveFlag(flags, ps), ctx, targets)
  if (MOVE.has(p)) return trackPaths(paths, 'move', false, ctx, targets)
  if (COPY.has(p)) {
    // The destination: -Destination's value, else the last argument (robocopy: the second).
    const named = ps ? lower.findIndex((w) => w === '-destination') : -1
    const dest = named >= 0 && named + 1 < words.length ? [words[named + 1]] : p === 'robocopy' ? paths.slice(1, 2) : paths.slice(-1)
    return trackPaths(dest, 'write', false, ctx, targets)
  }
  if (WRITE.has(p)) {
    // chmod 755 file / chown user file: the first argument is the mode or owner.
    const files = ['chmod', 'chown', 'chgrp'].includes(p) ? paths.slice(1) : ['ln'].includes(p) ? paths.slice(-1) : paths
    return trackPaths(files, 'write', false, ctx, targets)
  }
  if ((p === 'sed' || p === 'perl') && flags.some((f) => /^-[a-z]*i/.test(f) || f.startsWith('--in-place'))) {
    const hasScriptFlag = lower.includes('-e')
    return trackPaths(hasScriptFlag ? paths : paths.slice(1), 'write', false, ctx, targets)
  }
  return null
}

function trackPaths(paths: string[], kind: PathKind, recursive: boolean, ctx: RiskContext, targets: Found['targets']): string | null {
  const abs: string[] = []
  const why = pathsReason(paths, kind, recursive, ctx, abs)
  for (const a of abs) targets.push({ abs: a, kind, recursive })
  return why
}

/** Why running `command` needs a person's go-ahead in Auto mode (shown on the approval card), or null. */
export function commandRisk(command: string, ctx: RiskContext): string | null {
  return analyze(command, ctx).reason
}

/** commandRisk, also following links: changing a path inside the folder that leads outside it is risky too. */
export async function commandRiskResolved(command: string, ctx: RiskContext): Promise<string | null> {
  const found = analyze(command, ctx)
  if (found.reason) return found.reason
  if (!found.targets.length) return null
  const rootReal = await real(modOf(platformOf(ctx)).resolve(ctx.root))
  for (const t of found.targets) {
    const why = pathReason(await real(t.abs), t.kind, t.recursive, { ...ctx, root: rootReal })
    if (why) return why
  }
  return null
}
