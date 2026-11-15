import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reset Cloth: everything in the data folder goes, so it starts as new. The database and the window's own
 * storage are open while Cloth runs, so the reset is only marked here; the next start wipes the folder
 * before anything opens it (see runPendingReset).
 */
const MARKER = 'reset-pending.json'
/** Downloaded models and the llama.cpp builds that run them: gigabytes, so a reset can keep them. */
export const MODEL_DIRS = ['models', 'runtimes']
/** Chromium's lock on the folder: in use from the moment the app starts. */
const NEVER = new Set([MARKER, 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'])

export function scheduleReset(dataDir: string, opts: { keepModels: boolean }): void {
  writeFileSync(join(dataDir, MARKER), JSON.stringify({ keep: opts.keepModels ? MODEL_DIRS : [], at: Date.now() }))
}

/** Wipes the data folder when a reset is pending. Returns what was removed and what couldn't be (null: no reset). */
export function runPendingReset(dataDir: string): { removed: string[]; failed: string[] } | null {
  const marker = join(dataDir, MARKER)
  if (!existsSync(marker)) return null
  let keep: string[] = []
  try {
    const saved = JSON.parse(readFileSync(marker, 'utf8')) as { keep?: unknown }
    keep = Array.isArray(saved.keep) ? saved.keep.map(String).filter((k) => MODEL_DIRS.includes(k)) : []
  } catch {
    /* an unreadable marker still resets everything */
  }
  const removed: string[] = []
  const failed: string[] = []
  for (const name of readdirSync(dataDir)) {
    if (NEVER.has(name) || keep.includes(name)) continue
    try {
      rmSync(join(dataDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      removed.push(name)
    } catch {
      failed.push(name)
    }
  }
  rmSync(marker, { force: true })
  return { removed, failed }
}
