import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const MARK = '__CLOTH_PATH__'

/** Folders macOS and Linux tools are commonly installed in (Homebrew on Apple silicon and Intel, MacPorts, system). */
const COMMON_DIRS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** The user's login shell: $SHELL, else zsh (macOS's default since Catalina), else bash. */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL && existsSync(env.SHELL)) return env.SHELL
  return existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash'
}

/** What the agent should know about the host's command line, so it writes commands that work there. */
export function hostShellNote(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin')
    return "This computer runs macOS. Commands run in /bin/bash (version 3.2: no associative arrays, mapfile or ${var,,}); the user's own terminal is zsh. The tools are BSD, not GNU: `sed -i ''` (not `sed -i`), no `grep -P`, `readlink -f` only on macOS 12.3+, `stat -f` instead of `stat -c`, `date -v` instead of `date -d`. Install packages with Homebrew (`brew install …`); use `open` to open files or URLs and `pbcopy`/`pbpaste` for the clipboard."
  if (platform === 'linux') return 'This computer runs Linux; commands run in bash with GNU tools.'
  return null
}

/** The PATH printed between the markers (shell startup files may print other things around it). */
export function parseMarkedPath(stdout: string): string | null {
  const start = stdout.indexOf(MARK)
  const end = stdout.lastIndexOf(MARK)
  if (start < 0 || end <= start) return null
  const path = stdout.slice(start + MARK.length, end).trim()
  return path || null
}

/**
 * Entries of `primary` first, then the rest of `fallback`, then common install folders that exist; no duplicates.
 * Only used on macOS and Linux, so it splits on the POSIX `:` whatever platform runs it (the tests run on Windows too).
 */
export function mergePath(primary: string | null | undefined, fallback: string | null | undefined, exists: (p: string) => boolean = existsSync): string {
  const DELIM = ':'
  const out: string[] = []
  const add = (p: string) => {
    if (p && !out.includes(p)) out.push(p)
  }
  for (const p of (primary ?? '').split(DELIM)) add(p)
  for (const p of (fallback ?? '').split(DELIM)) add(p)
  for (const p of COMMON_DIRS) if (exists(p)) add(p)
  return out.join(DELIM)
}

/**
 * Apps opened from Finder, the Dock or Spotlight get launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so Homebrew, nvm, pyenv, Docker Desktop and the like aren't found by the agent's commands, git, LSP or
 * containers. Ask the user's login shell (zsh or bash, reading ~/.zprofile, ~/.zshrc, ~/.bash_profile …)
 * for its PATH and use that. Windows gets its PATH from the registry, so nothing is needed there.
 */
export async function loadLoginShellPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, timeoutMs = 5000): Promise<void> {
  if (platform === 'win32') return
  const shell = loginShell(env)
  // -i so ~/.zshrc / ~/.bashrc run too (nvm and many installers add themselves there); -l for the profile files.
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
      { timeout: timeoutMs, encoding: 'utf8', env: { ...env, TERM: 'dumb', CLOTH_SHELL_ENV: '1' }, maxBuffer: 4 * 1024 * 1024 },
      (_err, out) => resolve(String(out ?? ''))
    )
  })
  env.PATH = mergePath(parseMarkedPath(stdout), env.PATH)
  if (!env.SHELL) env.SHELL = shell
}
