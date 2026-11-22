import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { git, repoRoot } from '../panel/git'

/*
 * Spec → Ship builds tickets in parallel: each worker gets its own git worktree (a separate checkout of
 * the repository on its own branch), and its work is merged back into the chat's branch when it ends.
 */

/** Where workers' checkouts live. */
export const WORKTREES_DIR = join(tmpdir(), 'cloth-worktrees')

/**
 * Checkouts whose folder couldn't be removed yet, with their repository: on Windows a folder stays while a process
 * still holds a file in it (a test runner or watcher a worker started). They are tried again when the next worker
 * starts and when the workflow finishes.
 */
const leftovers = new Map<string, string>()

/** Delete a checkout's folder, retrying while Windows reports it busy; remembered for later when it still won't go. */
async function removeDir(dir: string, root: string): Promise<boolean> {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined)
  if (existsSync(dir)) {
    leftovers.set(dir, root)
    return false
  }
  leftovers.delete(dir)
  return true
}

/** Try again to delete checkouts that couldn't be removed earlier (all of them, or one repository's). Returns those still left. */
export async function sweepLeftovers(root?: string): Promise<string[]> {
  for (const [dir, r] of [...leftovers]) if (!root || r === root) await removeDir(dir, r)
  return [...leftovers].filter(([, r]) => !root || r === root).map(([d]) => d)
}

/** A worker's private checkout. */
export interface WorkerTree {
  /** The repository's top folder (the chat's checkout). */
  root: string
  /** The worktree's top folder. */
  dir: string
  /** Where the worker works: the worktree, or the same subfolder of it the chat's folder is of the repository. */
  workspace: string
  /** The worker's branch, and the branch it merges into. */
  branch: string
  base: string
  /** The unfinished branch it carried on from, dropped once this one merges. */
  from?: string
  /** The branch it was asked to carry on from didn't exist, so it started from the base. */
  missingFrom?: string
  /** Carrying on from an older branch: the base is merged in first; these files came out with conflicts to resolve. */
  conflicts?: string[]
}

export interface MergeResult {
  merged: boolean
  /** Files the worker changed (repository-relative). */
  files: string[]
  /** Why it didn't merge, and where the work is kept. */
  error?: string
  conflicts?: string[]
}

const run = async (cwd: string, args: string[]) => {
  const r = await git(cwd, args, { timeoutMs: 120_000 })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`)
  return r.stdout
}

// Merges into one repository happen one at a time.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(root: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(root) ?? Promise.resolve()
  const next = prev.then(job, job)
  queues.set(
    root,
    next.catch(() => undefined)
  )
  return next
}

/**
 * A path as git reports it: links resolved (macOS's /var is /private/var) and Windows short names expanded (RUNNER~1).
 * A path that doesn't exist (yet, or any more) is resolved through its nearest existing parent.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync.native(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs))
  }
}

/** The same path for comparing: canonical, and case-insensitive on Windows. */
const samePathKey = (p: string) => (process.platform === 'win32' ? canonicalPath(p).toLowerCase() : canonicalPath(p))

/** The folder's path inside the repository ('' at its top), with both sides resolved the way git resolves them. */
const subfolder = (root: string, workspace: string) => relative(canonicalPath(root), canonicalPath(workspace))

const slugPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'work'

/**
 * Commit the workflow's documents (glossary, decision records, this spec's folder) on the chat's branch if they
 * have uncommitted changes, so worktrees start from them. Nothing else the person has uncommitted is touched.
 */
export async function commitWorkflowDocs(root: string, workspace: string, slug: string | null): Promise<boolean> {
  const sub = subfolder(root, workspace).split(sep).join('/')
  const at = (p: string) => (sub ? `${sub}/${p}` : p)
  const paths = [at('GLOSSARY.md'), at('GLOSSARY-MAP.md'), at('docs/adr'), at('docs/verify'), ...(slug ? [at(`docs/specs/${slug}`)] : [])]
  const existing = paths.filter((p) => existsSync(join(root, p)))
  if (!existing.length) return false
  const dirty = (await run(root, ['status', '--porcelain', '--untracked-files=all', '--', ...existing])).trim()
  if (!dirty) return false
  await run(root, ['add', '-A', '--', ...existing])
  // A commit limited to these paths: anything else the person has staged stays staged, uncommitted.
  await run(root, ['-c', 'user.name=Cloth', '-c', 'user.email=cloth@localhost', 'commit', '-m', `Spec${slug ? `: ${slug}` : ''} (glossary, decisions, spec and tickets)`, '--', ...existing])
  return true
}

/**
 * Once the workflow is done, commit what it left uncommitted on the chat's branch: its documents and the files the chat
 * changed itself (workspace-relative; workers' work is already merged). Anything else the person has uncommitted is left
 * alone. Returns the commit's short hash, or null when nothing was left to commit.
 */
export async function commitWorkflowFinish(workspace: string, slug: string | null, files: string[]): Promise<string | null> {
  const root = await repoRoot(workspace)
  if (!root) return null
  const sub = subfolder(root, workspace).split(sep).join('/')
  const at = (p: string) => (sub ? `${sub}/${p}` : p)
  const paths = [...new Set(['GLOSSARY.md', 'GLOSSARY-MAP.md', 'docs/adr', 'docs/verify', 'docs/specs/README.md', 'docs/specs/FINDINGS.md', ...(slug ? [`docs/specs/${slug}`] : []), ...files].map((p) => at(p.replace(/\\/g, '/').replace(/^\.\//, ''))))]
  return serial(root, async () => {
    // Paths are repository-relative in porcelain output; -z keeps odd names unquoted. Gone files count too.
    const out = (await run(root, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', ...paths])).split('\0').filter(Boolean)
    const dirty = out.map((l) => l.slice(3))
    if (!dirty.length) return null
    await run(root, ['add', '-A', '--', ...dirty])
    await run(root, ['-c', 'user.name=Cloth', '-c', 'user.email=cloth@localhost', 'commit', '-m', `Spec → Ship${slug ? `: ${slug}` : ''} done (final changes)`, '--', ...dirty])
    return (await run(root, ['rev-parse', '--short', 'HEAD'])).trim()
  })
}

/**
 * Start a worker's checkout: a new branch from the chat's branch, in its own folder under `dir`. null when the
 * chat's folder isn't in a git repository or isn't on a branch (the worker then shares the chat's folder).
 */
export async function createWorkerTree(workspace: string, dir: string, opts: { slug: string | null; label: string; id: string; from?: string }): Promise<WorkerTree | null> {
  const root = await repoRoot(workspace)
  if (!root) return null
  const base = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (!base || base === 'HEAD') return null
  await sweepLeftovers()
  await serial(root, () => commitWorkflowDocs(root, workspace, opts.slug))
  const branch = `cloth/${slugPart(opts.slug ?? 'build')}/${slugPart(opts.label)}-${opts.id.slice(-6)}`
  const tree = join(dir, `${slugPart(opts.label)}-${opts.id.slice(-6)}`)
  await mkdir(dir, { recursive: true })
  // Carry on from an earlier worker's unfinished branch (only Cloth's own worker branches).
  // A branch that is gone (an earlier worker that changed nothing leaves none) starts fresh from the base instead:
  // the worker still gets its own copy rather than the chat's folder.
  let from = opts.from
  let missingFrom: string | undefined
  if (from && (!from.startsWith('cloth/') || (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${from}`])).code !== 0)) {
    missingFrom = from
    from = undefined
  }
  const start = from ?? base
  await serial(root, () => run(root, ['worktree', 'add', '-b', branch, tree, start]))
  const sub = subfolder(root, workspace)
  const made: WorkerTree = { root, dir: tree, workspace: sub ? join(tree, sub) : tree, branch, base, ...(from ? { from } : {}), ...(missingFrom ? { missingFrom } : {}) }
  // Older work catches up with everything merged since, so it can merge back: the merge is left open (and any
  // conflicts marked in the files) for the worker to finish; Cloth's commit at the end concludes it.
  if (from) {
    const m = await git(tree, ['-c', 'user.name=Cloth', '-c', 'user.email=cloth@localhost', 'merge', '--no-ff', '--no-commit', base], { timeoutMs: 120_000 })
    if (m.code !== 0) {
      const conflicts = (await git(tree, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((f) => f.trim()).filter(Boolean)
      if (conflicts.length) made.conflicts = conflicts
    }
  }
  await linkDeps(made)
  return made
}

/**
 * Finish a worker: commit what it changed on its branch, merge that into the chat's branch, and remove the checkout.
 * A merge that conflicts is aborted (the chat's folder is left as it was) and the branch is kept so nothing is lost.
 */
export async function finishWorkerTree(t: WorkerTree, message: string): Promise<MergeResult> {
  await unlinkDeps(t)
  await run(t.dir, ['add', '-A'])
  const staged = (await run(t.dir, ['diff', '--cached', '--name-only'])).trim()
  if (staged) await run(t.dir, ['-c', 'user.name=Cloth', '-c', 'user.email=cloth@localhost', 'commit', '-m', message])
  // Everything the branch adds over its base, including commits the worker made itself.
  const ahead = Number((await run(t.root, ['rev-list', '--count', `${t.base}..${t.branch}`])).trim()) || 0
  const files = ahead ? (await run(t.root, ['diff', '--name-only', `${t.base}...${t.branch}`])).split('\n').map((f) => f.trim()).filter(Boolean) : []
  const result = await serial(t.root, async (): Promise<MergeResult> => {
    if (!ahead) return { merged: true, files }
    const current = (await git(t.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    if (current !== t.base) return { merged: false, files, error: `The chat's folder is now on branch ${current}, not ${t.base}; the work is kept on branch ${t.branch}.` }
    const m = await git(t.root, ['-c', 'user.name=Cloth', '-c', 'user.email=cloth@localhost', 'merge', '--no-ff', '-m', `Merge ${t.branch}: ${message}`, t.branch], { timeoutMs: 120_000 })
    if (m.code === 0) return { merged: true, files }
    const conflicts = (await git(t.root, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((f) => f.trim()).filter(Boolean)
    await git(t.root, ['merge', '--abort'])
    const why = conflicts.length ? `it conflicts with changes already merged in ${conflicts.join(', ')}` : (m.stderr || m.stdout).trim().split('\n').slice(-2).join(' ')
    return { merged: false, files, conflicts, error: `Couldn't merge into ${t.base}: ${why}. The work is kept on branch ${t.branch}.` }
  })
  await removeWorkerTree(t, result.merged)
  return result
}

/**
 * Bring what the chat's checkout has uncommitted (changed, new and deleted files) into a fresh tree, so a verifier
 * checks the change as it stands rather than the last commit. Returns how many files it carried over.
 */
export async function copyWorkingChanges(t: WorkerTree): Promise<number> {
  const out = (await run(t.root, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'])).split('\0').filter(Boolean)
  let n = 0
  for (const line of out) {
    const rel = line.slice(3)
    if (!rel || rel.endsWith('/')) continue
    const from = join(t.root, rel)
    const to = join(t.dir, rel)
    if (line[0] === 'D' || line[1] === 'D' || !existsSync(from)) await rm(to, { force: true }).catch(() => undefined)
    else {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    }
    n++
  }
  return n
}

/** Remove a worker's checkout (and its branch, once merged). */
export async function removeWorkerTree(t: WorkerTree, dropBranch: boolean): Promise<void> {
  await unlinkDeps(t)
  await serial(t.root, async () => {
    await git(t.root, ['worktree', 'remove', '--force', t.dir])
    await removeDir(t.dir, t.root)
    await git(t.root, ['worktree', 'prune'])
    if (dropBranch) await git(t.root, ['branch', '-D', t.branch])
    if (dropBranch && t.from) await git(t.root, ['branch', '-D', t.from])
  })
}

/** Folders the chat's checkout has that git ignores but a worker needs to build and test (linked, never copied). The file
 * tools may read through these links (DEPENDENCY_DIRS in workspace.ts). */
const DEPS = ['node_modules']

/** Link the checkout's dependencies into a worker's tree: a junction on Windows, a symlink elsewhere. */
async function linkDeps(t: WorkerTree): Promise<void> {
  const sub = relative(t.dir, t.workspace)
  for (const base of new Set(['', sub])) {
    for (const d of DEPS) {
      const from = join(t.root, base, d)
      const to = join(t.dir, base, d)
      if (existsSync(from) && !existsSync(to)) await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir').catch(() => undefined)
    }
  }
}

/** Remove the links (only the links: never what they point to). */
async function unlinkDeps(t: WorkerTree): Promise<void> {
  const sub = relative(t.dir, t.workspace)
  for (const base of new Set(['', sub])) {
    for (const d of DEPS) {
      const to = join(t.dir, base, d)
      const st = await lstat(to).catch(() => null)
      if (!st?.isSymbolicLink()) continue
      await unlink(to).catch(() => rmdir(to).catch(() => undefined))
    }
  }
}

/** A worker that failed or was stopped: keep what it did on its branch (unmerged) and remove the checkout. */
export async function parkWorkerTree(t: WorkerTree, message: string): Promise<string | null> {
  await unlinkDeps(t)
  await git(t.dir, ['add', '-A'])
  await git(t.dir, ['-c', 'user.name=Cloth', '-c', 'user.email=cloth@localhost', 'commit', '-m', `Unfinished: ${message}`])
  // Kept when it holds anything over its base, whether committed now or by the worker.
  const kept = Number((await git(t.root, ['rev-list', '--count', `${t.base}..${t.branch}`])).stdout.trim()) > 0
  await removeWorkerTree(t, !kept)
  return kept ? t.branch : null
}

export interface WorkflowCleanup {
  /** Checkout folders removed. */
  trees: number
  /** Worker branches deleted that were already merged. */
  merged: string[]
  /** Worker branches deleted with work that never merged, and the commit each pointed at (restore with `git branch <name> <commit>`). */
  unmerged: { branch: string; commit: string }[]
  /** Folders that still couldn't be deleted (tried again later). */
  left: string[]
}

/**
 * Spec → Ship's last step: remove every checkout and worker branch the feature left behind. Its checkouts (registered
 * with git, or folders under `dir` whose .git file points into this repository) are removed, and its `cloth/<slug>/…`
 * branches deleted. A branch whose work never merged is listed with its commit, so it can still be brought back.
 */
export async function cleanupWorkflow(workspace: string, slug: string | null, dir = WORKTREES_DIR): Promise<WorkflowCleanup | null> {
  const root = await repoRoot(workspace)
  if (!root) return null
  const prefix = `cloth/${slugPart(slug ?? 'build')}/`
  return serial(root, async () => {
    let trees = 0
    // Checkouts git still knows about, on this feature's branches.
    const listed = (await git(root, ['worktree', 'list', '--porcelain'])).stdout.split(/\r?\n\r?\n/)
    const live = new Set<string>()
    for (const block of listed) {
      const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim()
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim()
      if (!path) continue
      // Checkouts git lists for other branches (another feature's workers, the chat's own) are live and stay.
      if (!branch?.startsWith(prefix)) {
        live.add(samePathKey(path))
        continue
      }
      await git(root, ['worktree', 'remove', '--force', path])
      if (await removeDir(resolve(path), root)) trees++
    }
    // Folders git has forgotten but that are still on disk: their .git file points into this repository.
    const gitDir = samePathKey(join(root, '.git'))
    const folders = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) : []
    for (const folder of folders) {
      let points: string | null = null
      try {
        points = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(folder, '.git'), 'utf8'))?.[1]?.trim() ?? null
      } catch {
        /* no .git file: git already emptied it */
      }
      if (live.has(samePathKey(folder))) continue
      const ours = points ? samePathKey(resolve(folder, points)).startsWith(gitDir) : leftovers.get(folder) === root
      if (ours && (await removeDir(folder, root))) trees++
    }
    await git(root, ['worktree', 'prune'])
    // The feature's worker branches.
    const refs = (await git(root, ['for-each-ref', '--format=%(refname:short) %(objectname:short)', `refs/heads/${prefix}`])).stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    const merged: string[] = []
    const unmerged: { branch: string; commit: string }[] = []
    for (const line of refs) {
      const [branch, commit] = line.split(' ')
      const isMerged = (await git(root, ['merge-base', '--is-ancestor', branch, 'HEAD'])).code === 0
      if ((await git(root, ['branch', '-D', branch])).code !== 0) continue
      if (isMerged) merged.push(branch)
      else unmerged.push({ branch, commit })
    }
    return { trees, merged, unmerged, left: await sweepLeftovers(root) }
  })
}

/** A line for the feature's decision log about worker branches deleted unmerged (null when there were none). */
export function cleanupLogLine(c: WorkflowCleanup): string | null {
  if (!c.unmerged.length) return null
  const list = c.unmerged.map((u) => `\`${u.branch}\` (${u.commit})`).join(', ')
  return `| Done | Deleted worker branches whose work never merged: ${list} | The shipped change is on the chat's branch; these were superseded or abandoned during Build or Review | Restore one with \`git branch <name> <commit>\` |`
}

/** Append a line to the feature's decision log, when the feature has one. */
export async function appendFeatureLog(workspace: string, slug: string | null, line: string): Promise<void> {
  if (!slug) return
  const file = join(workspace, 'docs', 'specs', slug, 'log.md')
  if (!existsSync(file)) return
  await appendFile(file, `${readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n'}${line}\n`)
}
