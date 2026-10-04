import { open, readFile, readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { WorkspaceEntry, WorkspaceFile } from '@shared/types'

/** Folders that are always noise in a tree (still listed, but dimmed and never searched). */
const NOISE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.venv', 'venv', '__pycache__', 'target', '.cache', 'coverage'])
const TEXT_LIMIT = 1024 * 1024
const IMAGE_LIMIT = 5 * 1024 * 1024
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp' }

/** A path inside `root` (relative, '/'-separated); refuses anything that escapes it. */
export function inside(root: string, rel: string): string {
  const full = resolve(root, ...rel.split('/').filter(Boolean))
  const back = relative(resolve(root), full)
  if (back.startsWith('..') || isAbsolute(back)) throw new Error('That path is outside the workspace')
  return full
}

const ignoreCache = new Map<string, { at: number; ig: Ignore }>()

/** The root .gitignore's rules (refreshed every few seconds). */
async function rootIgnore(root: string): Promise<Ignore> {
  const hit = ignoreCache.get(root)
  if (hit && Date.now() - hit.at < 5000) return hit.ig
  const ig = ignore()
  const text = await readFile(join(root, '.gitignore'), 'utf8').catch(() => '')
  if (text) ig.add(text)
  ignoreCache.set(root, { at: Date.now(), ig })
  return ig
}

/** One folder of the tree: folders first, then files, alphabetically. */
export async function listDir(root: string, rel: string): Promise<WorkspaceEntry[]> {
  const dir = inside(root, rel)
  const ig = await rootIgnore(root)
  const entries = await readdir(dir, { withFileTypes: true })
  const out: WorkspaceEntry[] = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile()) continue
    const path = rel ? `${rel}/${e.name}` : e.name
    const isDir = e.isDirectory()
    let size = 0
    if (!isDir) size = (await stat(join(dir, e.name)).catch(() => null))?.size ?? 0
    let ignored = NOISE.has(e.name)
    if (!ignored) {
      try {
        ignored = ig.ignores(isDir ? `${path}/` : path)
      } catch {
        ignored = false
      }
    }
    out.push({ name: e.name, path, dir: isDir, size, ignored })
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
}

function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return true
  let odd = 0
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) odd++
  return head.length > 0 && odd / head.length > 0.1
}

/** A file for the preview: text (first MB), an image (as data), or just its size. */
export async function readWorkspaceFile(root: string, rel: string): Promise<WorkspaceFile> {
  const full = inside(root, rel)
  const s = await stat(full)
  if (!s.isFile()) throw new Error('Not a file')
  const mime = IMAGES[extname(full).toLowerCase()]
  if (mime) {
    if (s.size > IMAGE_LIMIT) return { path: rel, size: s.size, kind: 'binary' }
    return { path: rel, size: s.size, kind: 'image', mimeType: mime, data: (await readFile(full)).toString('base64') }
  }
  const handle = await open(full, 'r')
  try {
    const bytes = Buffer.alloc(Math.min(s.size, TEXT_LIMIT))
    await handle.read(bytes, 0, bytes.length, 0)
    if (looksBinary(bytes)) return { path: rel, size: s.size, kind: 'binary' }
    return { path: rel, size: s.size, kind: 'text', text: bytes.toString('utf8').replace(/^\uFEFF/, ''), truncated: s.size > TEXT_LIMIT }
  } finally {
    await handle.close()
  }
}
