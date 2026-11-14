import { describe, expect, it } from 'vitest'
import { versionIn } from '../src/main/deps'
import { makeServices } from './helpers'

describe('dependencies', () => {
  it('reads a version out of what a program prints', () => {
    expect(versionIn('git version 2.47.1.windows.1')).toBe('2.47.1')
    expect(versionIn('gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0')).toBe('2.62.0')
    expect(versionIn('v22.12.0')).toBe('22.12.0')
    expect(versionIn('Docker version 27.3.1, build ce12230')).toBe('27.3.1')
    expect(versionIn(null)).toBeNull()
  })

  it('lists what Cloth ships and what it uses from the PC, each with what it is for', async () => {
    const { services } = makeServices()
    const report = await services.deps.list()
    const ids = report.items.map((d) => d.id)
    expect(ids.slice(0, 3)).toEqual(['obscura', 'searxng', 'openspec'])
    expect(ids).toEqual(expect.arrayContaining(['git', 'gh', 'docker', 'node', 'python', 'bash']))
    // Shipped programs come from the staged sidecars; one not staged says how to get it.
    for (const d of report.items.filter((x) => x.source === 'bundled')) {
      if (d.status === 'ok') expect(d.version).toBeTruthy()
      else expect(d.detail).toContain('npm run sidecars')
    }
    // The tests themselves run through git, so it's found, with a version.
    expect(report.items.find((d) => d.id === 'git')).toMatchObject({ source: 'system', status: 'ok', version: expect.stringMatching(/^\d+\.\d+/) })
    for (const d of report.items) expect(d.usedFor.length).toBeGreaterThan(10)
    // The result is kept until asked again.
    expect(await services.deps.list()).toBe(report)
    expect((await services.deps.refresh()).checkedAt).toBeGreaterThanOrEqual(report.checkedAt)
  }, 60_000)
})
