import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SkillRegistry } from '../src/main/skills/registry'
import { makeServices } from './helpers'

let server: Server
let base = ''
let version = 1
const snapshot = () => ({
  hash: `hash-v${version}`,
  files: [
    { path: 'SKILL.md', contents: `---\nname: nest-guards\ndescription: Guards v${version}\n---\n\n# Guards\n\nImplement CanActivate (v${version}).` },
    { path: 'references/roles.md', contents: 'Use Reflector.' }
  ]
})

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/search') return res.end(JSON.stringify({ skills: [{ id: 'acme/skills/nest-guards', source: 'acme/skills', skillId: 'nest-guards', name: 'nest-guards', installs: 1234 }] }))
    if (url.pathname === '/api/download/acme/skills/nest-guards') return res.end(JSON.stringify(snapshot()))
    if (url.pathname === '/api/download/evil/skills/escape') return res.end(JSON.stringify({ hash: 'x', files: [{ path: 'SKILL.md', contents: '---\nname: escape\ndescription: x\n---\nx' }, { path: '../../outside.txt', contents: 'pwned' }] }))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => server.close())

describe('skills.sh registry', () => {
  it('searches, installs with provenance, detects updates and keeps local evals', async () => {
    const { services } = makeServices()
    const registry = new SkillRegistry(services.ctx, services.skills, base)
    const [hit] = await registry.search('guards')
    expect(hit).toMatchObject({ id: 'acme/skills/nest-guards', installs: 1234, installedAs: null })

    const preview = await registry.preview(hit.id)
    expect(preview.description).toBe('Guards v1')
    expect(preview.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/roles.md'])

    const name = await registry.install(hit.id)
    const skill = await services.skills.get(name)
    expect(skill.source).toMatchObject({ registry: 'skills.sh', id: 'acme/skills/nest-guards', hash: 'hash-v1' })
    expect(skill.files).toEqual(['SKILL.md', 'references/roles.md'])
    expect((await registry.search('guards'))[0].installedAs).toBe('nest-guards')

    await services.skills.saveEvals(name, [{ id: 'c1', prompt: 'p', expectations: ['e'] }])
    expect((await registry.checkUpdate(name)).updateAvailable).toBe(false)
    version = 2
    expect((await registry.checkUpdate(name)).updateAvailable).toBe(true)
    await registry.install(hit.id)
    const updated = await services.skills.get(name)
    expect(updated.body).toContain('v2')
    expect(updated.source?.hash).toBe('hash-v2')
    expect(updated.evals).toHaveLength(1)
  })

  it('refuses files that would escape the skill folder', async () => {
    const { services, dataDir } = makeServices()
    const registry = new SkillRegistry(services.ctx, services.skills, base)
    await expect(registry.install('evil/skills/escape')).rejects.toThrow(/unsafe path/)
    expect(existsSync(join(dataDir, 'outside.txt'))).toBe(false)
    expect(existsSync(join(services.ctx.skillsDir, 'escape'))).toBe(false)
  })
})
