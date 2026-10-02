import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServices } from './helpers'

// Real Docker: CLOTH_LIVE_DOCKER=1 npx vitest run tests/containers.live.test.ts
describe.skipIf(!process.env.CLOTH_LIVE_DOCKER)('containers (live Docker)', () => {
  it('runs commands in a Linux container on the copy, and applies the result', async () => {
    const { services } = makeServices()
    const c = services.containers
    expect((await c.status(true)).available).toBe(true)
    const folder = mkdtempSync(join(tmpdir(), 'cloth-live-'))
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { build: 'node -e "require(\'fs\').writeFileSync(\'dist.txt\', process.version)"' } }, null, 2))
    const id = `live_${Date.now()}`
    await c.prepare(id, folder)
    const settings = { image: 'node:22-alpine', network: true }
    try {
      let out = ''
      const run = async (cmd: string, cwd = '') => {
        out = ''
        const r = await c.exec(id, settings, cmd, cwd, { onData: (d) => (out += d.toString()), timeout: 600 })
        return { code: r.exitCode, out }
      }
      expect(await run('uname -s && cat /etc/os-release | head -1')).toMatchObject({ code: 0, out: expect.stringContaining('Linux') })
      expect((await run('npm run build --silent && cat dist.txt')).out).toMatch(/v22\./)
      expect((await run('exit 3')).code).toBe(3)

      const { changes } = await c.changes(id)
      expect(changes.map((x) => [x.path, x.kind])).toEqual([['dist.txt', 'create']])
      expect(() => readFileSync(join(folder, 'dist.txt'))).toThrow()
      await c.apply(id)
      expect(readFileSync(join(folder, 'dist.txt'), 'utf8')).toMatch(/^v22\./)

      // Offline: the same container is recreated without a network.
      expect((await c.exec(id, { ...settings, network: false }, 'wget -q -T 3 -O- https://registry.npmjs.org >/dev/null', '', { onData: () => undefined, timeout: 60 })).exitCode).not.toBe(0)
    } finally {
      await c.remove(id)
    }
  }, 900_000)
})
