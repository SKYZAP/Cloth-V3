import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServices } from './helpers'

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25))
}

describe('knowledge sources', () => {
  it('syncs a folder: new files come in, missing ones go, unchanged ones stay', async () => {
    const { services } = makeServices()
    const dir = mkdtempSync(join(tmpdir(), 'cloth-sync-'))
    writeFileSync(join(dir, 'a.md'), '# Alpha\n\nAlpha notes about deploys.')
    writeFileSync(join(dir, 'b.md'), '# Beta\n\nBeta notes about billing.')
    const col = services.rag.createCollection({ name: 'Notes', embedding: null })
    await services.rag.ingestPaths(col.id, [dir])
    const titles = () => services.rag.listDocuments(col.id).filter((d) => d.status === 'ready').map((d) => d.title).sort()
    await until(() => titles().length === 2)
    expect(titles()).toEqual(['a.md', 'b.md'])

    rmSync(join(dir, 'b.md'))
    writeFileSync(join(dir, 'c.md'), '# Gamma\n\nGamma notes about search.')
    const r = await services.rag.syncSource(col.id, dir)
    expect(r.removed).toBe(1)
    await until(() => titles().join() === 'a.md,c.md')
    expect(titles()).toEqual(['a.md', 'c.md'])
    // Another folder's documents are left alone.
    expect(await services.rag.syncSource(col.id, join(dir, 'elsewhere'))).toEqual({ removed: 0, queued: 0 })
  })
})
