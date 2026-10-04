import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import type { GitCommit, GitFile, GitStatus } from '@shared/types'
import { inside } from './files'

const MAX_DIFF = 400 * 1024

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** Runs git in `cwd`; never prompts (no credential or editor windows). */
export function git(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: opts.timeoutMs ?? 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) })
      }
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

async function must(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<string> {
  const r = await git(cwd, args, opts)
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`)
  return r.stdout
}

/** The repository's top folder, or null when `folder` isn't in a git repository (or git isn't installed). */
export async function repoRoot(folder: string): Promise<string | null> {
  const r = await git(folder, ['rev-parse', '--show-toplevel']).catch(() => null)
  return r && r.code === 0 ? r.stdout.trim() : null
}

/** `git status --porcelain=v2 -z`, read into files and branch info. */
export function parseStatus(out: string): Omit<GitStatus, 'repo' | 'root'> {
  const status: Omit<GitStatus, 'repo' | 'root'> = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# branch.head ')) status.branch = line.slice(14) === '(detached)' ? null : line.slice(14)
    else if (line.startsWith('# branch.upstream ')) status.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        status.ahead = Number(m[1])
        status.behind = Number(m[2])
      }
    } else if (line[0] === '1' || line[0] === '2' || line[0] === 'u') {
      const fields = line.split(' ')
      const xy = fields[1]
      // Ordinary: 8 fields before the path; rename/copy: 9 (then the old path in the next record); unmerged: 10.
      const skip = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10
      const path = fields.slice(skip).join(' ')
      const from = line[0] === '2' ? parts[++i] : undefined
      const conflicted = line[0] === 'u'
      status.files.push({ path, ...(from ? { from } : {}), index: xy[0], worktree: xy[1], staged: !conflicted && xy[0] !== '.', unstaged: conflicted || xy[1] !== '.', untracked: false, conflicted })
    } else if (line[0] === '?') {
      status.files.push({ path: line.slice(2), index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflicted: false })
    }
  }
  return status
}

export async function gitStatus(folder: string): Promise<GitStatus> {
  const root = await repoRoot(folder)
  if (!root) return { repo: false, root: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const out = await must(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])
  return { repo: true, root, ...parseStatus(out) }
}

/** A file's diff: staged (index vs HEAD) or not (worktree vs index); untracked files show as all-new. */
export async function gitDiff(root: string, file: GitFile, staged: boolean): Promise<string> {
  let out: string
  if (file.untracked) {
    const text = await readFile(inside(root, file.path), 'utf8').catch(() => null)
    if (text === null) return ''
    if (text.includes('\0')) return `Binary file ${file.path}`
    const lines = text.replace(/\n$/, '').split('\n')
    out = [`--- /dev/null`, `+++ b/${file.path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n')
  } else {
    out = await must(root, ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', file.path, ...(file.from ? [file.from] : [])])
  }
  return out.length > MAX_DIFF ? `${out.slice(0, MAX_DIFF)}\n… (diff truncated)` : out
}

export async function gitStage(root: string, paths: string[]): Promise<void> {
  if (paths.length) await must(root, ['add', '-A', '--', ...paths])
}

export async function gitUnstage(root: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  // A repository without commits has no HEAD to restore from.
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
  if (head.code === 0) await must(root, ['restore', '--staged', '--', ...paths])
  else await must(root, ['rm', '--cached', '-r', '-q', '--', ...paths])
}

/** Throw away changes: tracked files go back to the index; untracked files are deleted. */
export async function gitDiscard(root: string, files: GitFile[]): Promise<void> {
  const tracked = files.filter((f) => !f.untracked).map((f) => f.path)
  if (tracked.length) await must(root, ['restore', '--worktree', '--', ...tracked])
  for (const f of files.filter((x) => x.untracked)) await rm(inside(root, f.path), { force: true })
}

export async function gitCommit(root: string, message: string, all: boolean): Promise<string> {
  if (!message.trim()) throw new Error('Write a commit message')
  if (all) await must(root, ['add', '-A'])
  // The message goes in on stdin: no quoting problems with multi-line messages.
  const r = await git(root, ['commit', '-F', '-'], { timeoutMs: 60_000, input: `${message.trim()}\n` })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || 'git commit failed')
  return (await must(root, ['rev-parse', '--short', 'HEAD'])).trim()
}

export async function gitLog(root: string, n = 15): Promise<GitCommit[]> {
  const r = await git(root, ['log', `-n${n}`, '--pretty=format:%h%x1f%s%x1f%an%x1f%ar'])
  if (r.code !== 0) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, when] = l.split('\x1f')
      return { hash, subject, author, when }
    })
}

export async function gitPush(root: string): Promise<string> {
  const r = await git(root, ['push'], { timeoutMs: 120_000 })
  if (r.code !== 0) {
    // A new branch has no upstream yet: publish it to origin.
    if (/no upstream branch|has no upstream/i.test(r.stderr)) {
      const branch = (await must(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      return (await must(root, ['push', '-u', 'origin', branch], { timeoutMs: 120_000 })).trim()
    }
    throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' '))
  }
  return (r.stderr || r.stdout).trim()
}

export async function gitPull(root: string): Promise<string> {
  return (await must(root, ['pull', '--ff-only'], { timeoutMs: 120_000 })).trim()
}

/** What a commit message should describe: the staged diff, or everything when nothing is staged. */
export async function diffForMessage(root: string, all: boolean): Promise<string> {
  const stat = await must(root, ['diff', '--stat', ...(all ? ['HEAD'] : ['--cached'])]).catch(() => '')
  const body = await must(root, ['diff', '--no-color', ...(all ? ['HEAD'] : ['--cached'])]).catch(() => '')
  return `${stat}\n${body}`.slice(0, 14_000)
}
