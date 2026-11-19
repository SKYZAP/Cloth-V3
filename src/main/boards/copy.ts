// Building a ticket without git: the implementer works on a copy of the code folder, and what it changed is
// worked out by comparing the copy with a snapshot taken when it was made. Applying copies those files back,
// refusing (and changing nothing) when the code folder changed the same files in the meantime.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** Folders that are installed or generated, never the work: not copied, and not counted as changes. */
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.cache', '.gradle', '.idea'])
/** Past this many files the folder is too big to copy for one ticket. */
const MAX_FILES = 50_000

/** relative path (with /) → sha1 of the file's contents. */
export type Snapshot = Record<string, string>

const hash = async (file: string) => createHash('sha1').update(await readFile(file)).digest('hex')
const rel = (root: string, file: string) => relative(root, file).split(sep).join('/')

async function walk(root: string, onFile: (abs: string) => Promise<void>): Promise<void> {
  let count = 0
  const visit = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await visit(join(dir, e.name))
      } else if (e.isFile()) {
        if (++count > MAX_FILES) throw new Error(`The code folder has more than ${MAX_FILES.toLocaleString('en')} files, too many to copy for one ticket. Use a git repository, so the build can use a worktree.`)
        await onFile(join(dir, e.name))
      }
    }
  }
  await visit(root)
}

/** Copy `src` into a fresh `dest` (installed and generated folders left out) and return the snapshot. */
export async function copyFolder(src: string, dest: string): Promise<Snapshot> {
  await rm(dest, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
  await mkdir(dest, { recursive: true })
  const snap: Snapshot = {}
  await walk(src, async (abs) => {
    const r = rel(src, abs)
    const to = join(dest, ...r.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await copyFile(abs, to)
    snap[r] = await hash(to)
  })
  return snap
}

export interface CopyChanges {
  changed: string[]
  added: string[]
  removed: string[]
}

export const changeCount = (c: CopyChanges) => c.changed.length + c.added.length + c.removed.length

/** What differs in the copy from the snapshot it was made with. */
export async function changesIn(dir: string, snap: Snapshot): Promise<CopyChanges> {
  const out: CopyChanges = { changed: [], added: [], removed: [] }
  const seen = new Set<string>()
  await walk(dir, async (abs) => {
    const r = rel(dir, abs)
    seen.add(r)
    if (!(r in snap)) out.added.push(r)
    else if ((await hash(abs)) !== snap[r]) out.changed.push(r)
  })
  for (const r of Object.keys(snap)) if (!seen.has(r)) out.removed.push(r)
  return out
}

/**
 * Copy the changes from `dir` into `repo`. Every file it touches must still be as it was when the copy was made
 * (or still absent, for a new file); otherwise nothing is written and the error names the files.
 */
export async function applyCopy(dir: string, repo: string, snap: Snapshot): Promise<number> {
  const c = await changesIn(dir, snap)
  if (!changeCount(c)) throw new Error('There are no changes to apply')
  const clashes: string[] = []
  for (const r of [...c.changed, ...c.removed]) {
    const file = join(repo, ...r.split('/'))
    if (existsSync(file) && (await hash(file)) !== snap[r]) clashes.push(r)
  }
  for (const r of c.added) if (existsSync(join(repo, ...r.split('/')))) clashes.push(r)
  if (clashes.length) throw new Error(`These files changed in ${repo} since the build started, so nothing was applied: ${clashes.slice(0, 8).join(', ')}${clashes.length > 8 ? ` and ${clashes.length - 8} more` : ''}`)
  for (const r of [...c.changed, ...c.added]) {
    const to = join(repo, ...r.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await copyFile(join(dir, ...r.split('/')), to)
  }
  for (const r of c.removed) await rm(join(repo, ...r.split('/')), { force: true })
  return changeCount(c)
}

export async function saveSnapshot(file: string, snap: Snapshot): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(snap))
}

export async function loadSnapshot(file: string): Promise<Snapshot> {
  return JSON.parse(await readFile(file, 'utf8')) as Snapshot
}

/** Whether a folder is inside a git repository (a .git folder or file here or above), without running git. */
export function inGitRepo(folder: string): boolean {
  let dir = folder
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true
    const up = dirname(dir)
    if (up === dir) return false
    dir = up
  }
}
