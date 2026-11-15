import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPendingReset, scheduleReset } from '../src/main/core/reset'

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-reset-'))
  writeFileSync(join(dir, 'cloth.db'), 'x')
  writeFileSync(join(dir, 'lockfile'), '')
  for (const d of ['chats', 'Local Storage', 'models', 'runtimes', 'boards']) {
    mkdirSync(join(dir, d))
    writeFileSync(join(dir, d, 'f'), 'x')
  }
  return dir
}

describe('Reset Cloth', () => {
  it('does nothing without a pending reset', () => {
    const dir = dataDir()
    expect(runPendingReset(dir)).toBeNull()
    expect(existsSync(join(dir, 'cloth.db'))).toBe(true)
  })

  it('wipes the data folder on the next start, except the lock', () => {
    const dir = dataDir()
    scheduleReset(dir, { keepModels: false })
    const r = runPendingReset(dir)
    expect(r?.failed).toEqual([])
    expect(readdirSync(dir)).toEqual(['lockfile'])
    // Only once.
    expect(runPendingReset(dir)).toBeNull()
  })

  it('can keep downloaded models and their runtimes', () => {
    const dir = dataDir()
    scheduleReset(dir, { keepModels: true })
    runPendingReset(dir)
    expect(readdirSync(dir).sort()).toEqual(['lockfile', 'models', 'runtimes'])
  })
})
