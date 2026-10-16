import { existsSync } from 'node:fs'
import { lstat, mkdir, rm, rmdir, symlink, unlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { git, repoRoot } from '../panel/git'

/*
 * Spec → ship builds tickets in parallel: each worker gets its own git worktree (a separate checkout of
 * the repository on its own branch), and its work is merged back into the chat's branch when it ends.
 */

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
  const sub = relative(root, workspace).split(sep).join('/')
  const at = (p: string) => (sub ? `${sub}/${p}` : p)
  const paths = [at('GLOSSARY.md'), at('GLOSSARY-MAP.md'), at('docs/adr'), ...(slug ? [at(`docs/specs/${slug}`)] : [])]
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
 * Start a worker's checkout: a new branch from the chat's branch, in its own folder under `dir`. null when the
 * chat's folder isn't in a git repository or isn't on a branch (the worker then shares the chat's folder).
 */
export async function createWorkerTree(workspace: string, dir: string, opts: { slug: string | null; label: string; id: string; from?: string }): Promise<WorkerTree | null> {
  const root = await repoRoot(workspace)
  if (!root) return null
  const base = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (!base || base === 'HEAD') return null
  await serial(root, () => commitWorkflowDocs(root, workspace, opts.slug))
  const branch = `cloth/${slugPart(opts.slug ?? 'build')}/${slugPart(opts.label)}-${opts.id.slice(-6)}`
  const tree = join(dir, `${slugPart(opts.label)}-${opts.id.slice(-6)}`)
  await mkdir(dir, { recursive: true })
  // Carry on from an earlier worker's unfinished branch (only Cloth's own worker branches).
  let start = base
  if (opts.from) {
    if (!opts.from.startsWith('cloth/') || (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${opts.from}`])).code !== 0) throw new Error(`There is no worker branch called ${opts.from}`)
    start = opts.from
  }
  await serial(root, () => run(root, ['worktree', 'add', '-b', branch, tree, start]))
  const sub = relative(root, workspace)
  const made: WorkerTree = { root, dir: tree, workspace: sub ? join(tree, sub) : tree, branch, base, ...(opts.from ? { from: opts.from } : {}) }
  // Older work catches up with everything merged since, so it can merge back: the merge is left open (and any
  // conflicts marked in the files) for the worker to finish; Cloth's commit at the end concludes it.
  if (opts.from) {
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

/** Remove a worker's checkout (and its branch, once merged). */
export async function removeWorkerTree(t: WorkerTree, dropBranch: boolean): Promise<void> {
  await unlinkDeps(t)
  await serial(t.root, async () => {
    await git(t.root, ['worktree', 'remove', '--force', t.dir])
    await rm(t.dir, { recursive: true, force: true }).catch(() => undefined)
    await git(t.root, ['worktree', 'prune'])
    if (dropBranch) await git(t.root, ['branch', '-D', t.branch])
    if (dropBranch && t.from) await git(t.root, ['branch', '-D', t.from])
  })
}

/** Folders the chat's checkout has that git ignores but a worker needs to build and test (linked, never copied). */
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
