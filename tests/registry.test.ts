import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mapAuditApi, parseAuditsPage, SkillRegistry, SOURCE_FILE } from '../src/main/skills/registry'
import { makeServices } from './helpers'

const PAGE = readFileSync(join(__dirname, 'fixtures', 'skills-sh', 'skill-page.html'), 'utf8')

let server: Server
let base = ''
let version = 1
let pageMode: 'ok' | 'error' = 'ok'
const hits = { page: 0, api: 0, download: 0, search: 0 }
const skillMd = (v: number) => `---\nname: nest-guards\ndescription: Guards v${v}\n---\n\n# Guards\n\nImplement CanActivate (v${v}).`
const snapshot = () => ({
  hash: `hash-v${version}`,
  files: [
    { path: 'SKILL.md', contents: skillMd(version) },
    { path: 'references/roles.md', contents: 'Use Reflector.\nThen compare roles.' }
  ]
})

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/search') {
      hits.search++
      return res.end(JSON.stringify({ skills: [{ id: 'acme/skills/nest-guards', source: 'acme/skills', skillId: 'nest-guards', name: 'nest-guards', installs: 1234 }] }))
    }
    if (url.pathname === '/api/download/acme/skills/nest-guards') {
      hits.download++
      return res.end(JSON.stringify(snapshot()))
    }
    // Another set with a skill of the same name.
    if (url.pathname === '/api/download/other/agent-skills/nest-guards') return res.end(JSON.stringify({ hash: 'other-1', files: [{ path: 'SKILL.md', contents: '---\nname: nest-guards\ndescription: Other guards\n---\n\n# Other' }] }))
    if (url.pathname === '/api/download/evil/skills/escape') return res.end(JSON.stringify({ hash: 'x', files: [{ path: 'SKILL.md', contents: '---\nname: escape\ndescription: x\n---\nx' }, { path: '../../outside.txt', contents: 'pwned' }] }))
    if (url.pathname === '/acme/skills/nest-guards') {
      hits.page++
      if (pageMode === 'error') {
        res.statusCode = 500
        return res.end('oops')
      }
      res.setHeader('content-type', 'text/html')
      return res.end(PAGE)
    }
    if (url.pathname === '/tele/audit') {
      hits.api++
      if (url.searchParams.get('source') !== 'acme/skills' || url.searchParams.get('skills') !== 'nest-guards') return res.end('{}')
      return res.end(
        JSON.stringify({
          'nest-guards': {
            ath: { risk: 'safe', analyzedAt: '2026-09-15T08:00:05.922Z' },
            socket: { risk: 'high', alerts: 2, score: 40, analyzedAt: '2026-09-15T08:00:19.647Z' },
            snyk: { risk: 'medium', analyzedAt: '2026-09-15T07:59:46.904821+00:00' }
          }
        })
      )
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => server.close())
beforeEach(() => {
  version = 1
  pageMode = 'ok'
  Object.assign(hits, { page: 0, api: 0, download: 0, search: 0 })
})

/** A hub skill written straight to disk, as if copied from another tool. */
function hubSkill(skillsDir: string, name: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(skillsDir, name, ...path.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents)
  }
}

function lockFile(skills: Record<string, { source: string; skillPath: string }>): string {
  const file = join(mkdtempSync(join(tmpdir(), 'cloth-lock-')), '.skill-lock.json')
  writeFileSync(file, JSON.stringify({ version: 3, skills }))
  return file
}

const crlf = (s: string) => `﻿${s.replace(/\n/g, '\r\n')}`

describe('skills.sh registry', () => {
  it('searches, installs with provenance, detects updates and keeps a local evals.json', async () => {
    const { services } = makeServices()
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => '')
    const [hit] = await registry.search('guards')
    expect(hit).toMatchObject({ id: 'acme/skills/nest-guards', installs: 1234, installedAs: null })

    const preview = await registry.preview(hit.id)
    expect(preview.description).toBe('Guards v1')
    expect(preview.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/roles.md'])

    const name = await registry.install(hit.id)
    const skill = await services.skills.get(name)
    expect(skill.source).toMatchObject({ registry: 'skills.sh', id: 'acme/skills/nest-guards', hash: 'hash-v1', linkedBy: 'install' })
    expect(skill.files).toEqual(['SKILL.md', 'references/roles.md'])
    expect((await registry.search('guards'))[0].installedAs).toBe('nest-guards')

    const evals = JSON.stringify({ cases: [{ id: 'c1', prompt: 'p', expectations: ['e'] }] })
    await services.skills.writeFile(name, 'evals.json', evals)
    expect((await registry.checkUpdate(name)).updateAvailable).toBe(false)
    version = 2
    expect((await registry.checkUpdate(name)).updateAvailable).toBe(true)
    // The diff shows what the update changes, and leaves out evals.json.
    await services.skills.writeFile(name, 'notes.md', 'mine')
    const diff = await registry.updateDiff(name)
    expect(diff.map((f) => [f.path, f.kind])).toEqual([
      ['SKILL.md', 'changed'],
      ['notes.md', 'removed']
    ])
    expect(diff[0].diff).toContain('+Implement CanActivate (v2).')
    await registry.install(hit.id)
    const updated = await services.skills.get(name)
    expect(updated.body).toContain('v2')
    expect(updated.source?.hash).toBe('hash-v2')
    expect(readFileSync(join(updated.dir, 'evals.json'), 'utf8')).toBe(evals)
  })

  it('installs same-named skills from different sets side by side, the later one under its set name', async () => {
    const { services } = makeServices()
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => '')
    expect(await registry.install('acme/skills/nest-guards')).toBe('nest-guards')
    expect(await registry.install('other/agent-skills/nest-guards')).toBe('agent-skills-nest-guards')
    // Both are kept, each linked to its own set, and the groups list each under its set.
    expect((await services.skills.get('nest-guards')).description).toBe('Guards v1')
    expect(await services.skills.get('agent-skills-nest-guards')).toMatchObject({ description: 'Other guards', source: { id: 'other/agent-skills/nest-guards' } })
    expect((await registry.groups()).map((g) => [g.repo, g.skills])).toEqual(
      expect.arrayContaining([
        ['acme/skills', ['nest-guards']],
        ['other/agent-skills', ['agent-skills-nest-guards']]
      ])
    )
    // Installing either again updates it in its own folder rather than adding a third copy.
    expect(await registry.install('other/agent-skills/nest-guards')).toBe('agent-skills-nest-guards')
    expect(await registry.install('acme/skills/nest-guards')).toBe('nest-guards')
    expect((await services.skills.list()).map((s) => s.name)).toEqual(['agent-skills-nest-guards', 'nest-guards'])
  })

  it('names a clashing set skill by owner and then a number when its set name is taken too', async () => {
    const { setQualifiedName } = await import('../src/main/skills/registry')
    const taken = new Set(['pdf', 'agent-skills-pdf'])
    expect(setQualifiedName('pdf', 'acme/agent-skills/pdf', (n) => taken.has(n))).toBe('acme-agent-skills-pdf')
    taken.add('acme-agent-skills-pdf')
    expect(setQualifiedName('pdf', 'acme/agent-skills/pdf', (n) => taken.has(n))).toBe('acme-agent-skills-pdf-2')
  })

  it('refuses files that would escape the skill folder', async () => {
    const { services, dataDir } = makeServices()
    const registry = new SkillRegistry(services.ctx, services.skills, base)
    await expect(registry.install('evil/skills/escape')).rejects.toThrow(/unsafe path/)
    expect(existsSync(join(dataDir, 'outside.txt'))).toBe(false)
    expect(existsSync(join(services.ctx.skillsDir, 'escape'))).toBe(false)
  })

  it('registrySearch_whenCustomCaSelected_shouldTrustPrivateRegistryCertificate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cloth-skills-ca-'))
    const keyPath = join(directory, 'server.key')
    const certPath = join(directory, 'ca.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'])
    const tlsServer = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ skills: [] }))
    })
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = tlsServer.address()
      if (!address || typeof address === 'string') throw new Error('Skills TLS test server failed to bind')
      const { services } = makeServices()
      const registry = new SkillRegistry(services.ctx, services.skills, `https://127.0.0.1:${address.port}`, () => certPath)
      await expect(registry.search('guards')).resolves.toEqual([])
    } finally {
      await new Promise<void>((resolve, reject) => tlsServer.close((error) => error ? reject(error) : resolve()))
    }
  })
})

describe('skills.sh security audits', () => {
  it('parses the SECURITY AUDITS entries of a skill page', () => {
    expect(parseAuditsPage(PAGE, 'acme/skills/nest-guards')).toEqual([
      { provider: 'Gen Agent Trust Hub', status: 'pass', reportUrl: 'https://skills.sh/acme/skills/nest-guards/security/agent-trust-hub' },
      { provider: 'Socket', status: 'fail', reportUrl: 'https://skills.sh/acme/skills/nest-guards/security/socket' },
      { provider: 'Snyk', status: 'warn', reportUrl: 'https://skills.sh/acme/skills/nest-guards/security/snyk' },
      { provider: 'Zero & Leaks', status: 'pending', reportUrl: 'https://skills.sh/acme/skills/nest-guards/security/zero-leaks' }
    ])
    expect(parseAuditsPage(PAGE, 'acme/skills/other')).toEqual([])
    expect(parseAuditsPage('<html><body>nothing here</body></html>', 'acme/skills/nest-guards')).toEqual([])
  })

  it('maps the audit API risk levels', () => {
    const id = 'acme/skills/nest-guards'
    expect(mapAuditApi({ ath: { risk: 'low' }, socket: { risk: 'critical', alerts: 3 }, snyk: { risk: 'weird', analyzedAt: 't' } }, id)).toEqual([
      { provider: 'Gen Agent Trust Hub', status: 'pass', reportUrl: `https://skills.sh/${id}/security/agent-trust-hub` },
      { provider: 'Socket', status: 'fail', alerts: 3, reportUrl: `https://skills.sh/${id}/security/socket` },
      { provider: 'Snyk', status: 'unknown', analyzedAt: 't', reportUrl: `https://skills.sh/${id}/security/snyk` }
    ])
    expect(mapAuditApi({ snyk: { risk: 'medium' } }, id)[0].status).toBe('warn')
    expect(mapAuditApi({ ath: { risk: 'safe' } }, id)[0].status).toBe('pass')
    expect(mapAuditApi({ socket: { risk: 'high' } }, id)[0].status).toBe('fail')
    expect(mapAuditApi(undefined, id)).toEqual([])
  })

  it('reads audits from the page, caches them for a day, and falls back to the API', async () => {
    const { services } = makeServices()
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => '')
    const name = await registry.install('acme/skills/nest-guards')

    const first = await registry.audits(name)
    expect(first).toMatchObject({ source: 'page' })
    expect(first?.audits.map((a) => a.status)).toEqual(['pass', 'fail', 'warn', 'pending'])
    expect(services.ctx.kv.get('skillAudit:acme/skills/nest-guards', null)).toEqual(first)

    expect(await registry.audits(name)).toEqual(first)
    expect(hits.page).toBe(1)
    await registry.audits(name, { refresh: true })
    expect(hits.page).toBe(2)

    // A stale cache is refreshed; the page failing falls back to the audit API.
    services.ctx.kv.set('skillAudit:acme/skills/nest-guards', { ...first, fetchedAt: Date.now() - 25 * 60 * 60_000 })
    pageMode = 'error'
    const fallback = await registry.audits(name)
    expect(hits.api).toBe(1)
    expect(fallback).toMatchObject({ source: 'api' })
    expect(fallback?.audits).toEqual([
      { provider: 'Gen Agent Trust Hub', status: 'pass', analyzedAt: '2026-09-15T08:00:05.922Z', reportUrl: 'https://skills.sh/acme/skills/nest-guards/security/agent-trust-hub' },
      { provider: 'Socket', status: 'fail', alerts: 2, analyzedAt: '2026-09-15T08:00:19.647Z', reportUrl: 'https://skills.sh/acme/skills/nest-guards/security/socket' },
      { provider: 'Snyk', status: 'warn', analyzedAt: '2026-09-15T07:59:46.904821+00:00', reportUrl: 'https://skills.sh/acme/skills/nest-guards/security/snyk' }
    ])
  })

  it('returns null for unlinked skills and when skills.sh is unreachable', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'local-only', description: 'x', body: 'y' })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => '')
    expect(await registry.audits('local-only')).toBeNull()
    expect(hits.page + hits.api).toBe(0)

    const name = await registry.install('acme/skills/nest-guards')
    const offline = new SkillRegistry(services.ctx, services.skills, 'http://127.0.0.1:1', () => '', () => '')
    await expect(offline.audits(name)).resolves.toBeNull()
  })
})

describe('linking hub skills to skills.sh', () => {
  it('links a skill from the skills CLI lock file when SKILL.md matches (ignoring CRLF and BOM)', async () => {
    const { services } = makeServices()
    hubSkill(services.ctx.skillsDir, 'nest-guards', { 'SKILL.md': crlf(skillMd(1)), 'references/roles.md': 'Use Reflector.\nThen compare roles.' })
    const lock = lockFile({ 'nest-guards': { source: 'acme/skills', skillPath: 'skills/nest-guards/SKILL.md' } })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => lock)

    // Nothing is fetched until the status is asked for.
    await services.skills.list()
    expect(hits.download).toBe(0)

    const status = await registry.status('nest-guards')
    expect(status).toMatchObject({ updateAvailable: false, latest: 'hash-v1', linked: { id: 'acme/skills/nest-guards', hash: 'hash-v1', linkedBy: 'lock' } })
    expect((await services.skills.get('nest-guards')).source).toMatchObject({ linkedBy: 'lock', hash: 'hash-v1' })

    version = 2
    const fresh = new SkillRegistry(services.ctx, services.skills, base, () => '', () => lock)
    expect((await fresh.status('nest-guards')).updateAvailable).toBe(true)
  })

  it('does not link from the lock file when SKILL.md differs', async () => {
    const { services } = makeServices()
    hubSkill(services.ctx.skillsDir, 'nest-guards', { 'SKILL.md': skillMd(1).replace('CanActivate', 'something else') })
    const lock = lockFile({ 'nest-guards': { source: 'acme/skills', skillPath: 'skills/nest-guards/SKILL.md' } })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => lock)
    expect(await registry.status('nest-guards')).toEqual({ linked: null, updateAvailable: false, latest: null })
    expect(existsSync(join(services.ctx.skillsDir, 'nest-guards', SOURCE_FILE))).toBe(false)
    // The mismatch is remembered for a while rather than downloaded again.
    await registry.status('nest-guards')
    expect(hits.download).toBe(1)

    // A skill without a lock entry never touches the network.
    hubSkill(services.ctx.skillsDir, 'other', { 'SKILL.md': '---\nname: other\ndescription: x\n---\ny' })
    expect((await registry.status('other')).linked).toBeNull()
    expect(hits.download).toBe(1)
  })

  it('finds candidates, links and unlinks by hand', async () => {
    const { services } = makeServices()
    hubSkill(services.ctx.skillsDir, 'nest-guards', { 'SKILL.md': skillMd(1).replace('(v1)', '(my edit)') })
    hubSkill(services.ctx.skillsDir, 'copy', { 'SKILL.md': crlf(skillMd(1)), 'references/roles.md': 'Use Reflector.\nThen compare roles.', 'extra.md': 'local only' })
    const lock = lockFile({ 'nest-guards': { source: 'acme/skills', skillPath: 'skills/nest-guards/SKILL.md' } })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => lock)

    expect(await registry.linkCandidates('nest-guards')).toEqual([{ id: 'acme/skills/nest-guards', installs: 1234, identical: false }])
    expect(await registry.linkCandidates('copy')).toEqual([{ id: 'acme/skills/nest-guards', installs: 1234, identical: true }])

    const edited = await registry.link('nest-guards', 'acme/skills/nest-guards')
    expect(edited).toMatchObject({ id: 'acme/skills/nest-guards', hash: null, linkedBy: 'user' })
    expect((await registry.status('nest-guards')).updateAvailable).toBe(true)
    expect((await registry.link('copy', 'acme/skills/nest-guards')).hash).toBe('hash-v1')
    expect((await registry.status('copy')).updateAvailable).toBe(false)

    await registry.unlink('nest-guards')
    expect(existsSync(join(services.ctx.skillsDir, 'nest-guards', SOURCE_FILE))).toBe(false)
    expect((await services.skills.get('nest-guards')).source).toBeNull()
    // Unlinked by the user: the lock file does not link it again, even once SKILL.md matches.
    writeFileSync(join(services.ctx.skillsDir, 'nest-guards', 'SKILL.md'), skillMd(1))
    expect((await registry.status('nest-guards')).linked).toBeNull()
    await registry.link('nest-guards', 'acme/skills/nest-guards')
    expect((await registry.status('nest-guards')).linked).toMatchObject({ linkedBy: 'user', hash: null })
  })

  it('updates into the existing folder, keeping evals.json and the link', async () => {
    const { services } = makeServices()
    const evals = '{"cases":[{"id":"c1","prompt":"p","expectations":["e"]}]}'
    hubSkill(services.ctx.skillsDir, 'my-guards', { 'SKILL.md': skillMd(1), 'evals.json': evals })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => '')
    await registry.link('my-guards', 'acme/skills/nest-guards')

    version = 2
    expect(await registry.update('my-guards')).toBe('my-guards')
    const skill = await services.skills.get('my-guards')
    expect(skill.body).toContain('(v2)')
    expect(skill.files).toEqual(['SKILL.md', 'evals.json', 'references/roles.md'])
    expect(readFileSync(join(skill.dir, 'evals.json'), 'utf8')).toBe(evals)
    expect(skill.source).toMatchObject({ id: 'acme/skills/nest-guards', hash: 'hash-v2', linkedBy: 'user' })
    expect(existsSync(join(services.ctx.skillsDir, 'nest-guards'))).toBe(false)
    expect((await registry.status('my-guards')).updateAvailable).toBe(false)
  })

  it('diffs ignoring CRLF and BOM, and reuses the cached download', async () => {
    const { services } = makeServices()
    hubSkill(services.ctx.skillsDir, 'nest-guards', { 'SKILL.md': crlf(skillMd(1)), 'references/roles.md': crlf('Use Reflector.\nThen compare roles.') })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => '')
    await registry.link('nest-guards', 'acme/skills/nest-guards')
    expect(await registry.updateDiff('nest-guards')).toEqual([])

    writeFileSync(join(services.ctx.skillsDir, 'nest-guards', 'references', 'roles.md'), 'Use Reflector.\r\nThen check roles.\r\n')
    const diff = await registry.updateDiff('nest-guards')
    expect(diff.map((f) => [f.path, f.kind])).toEqual([['references/roles.md', 'changed']])
    expect(diff[0].diff).not.toContain('\r')
    expect(diff[0].diff).toContain('+Then compare roles.')
    expect(hits.download).toBe(1)
  })
})

describe('skill groups', () => {
  it('groups hub skills by the repository they came from: their link first, else the lock file', async () => {
    const { services } = makeServices()
    const md = (name: string) => `---
name: ${name}
description: ${name}
---

Body.`
    for (const name of ['minimal-ui', 'brutal-ui', 'mine', 'guards']) hubSkill(services.ctx.skillsDir, name, { 'SKILL.md': md(name) })
    writeFileSync(join(services.ctx.skillsDir, 'guards', SOURCE_FILE), JSON.stringify({ registry: 'skills.sh', id: 'acme/skills/guards', hash: null, installedAt: 1, url: 'x' }))
    const lock = lockFile({
      'minimal-ui': { source: 'leon/taste-skill', skillPath: 'skills/minimalist-skill/SKILL.md' },
      'brutal-ui': { source: '/Leon/Taste-Skill/', skillPath: 'skills/brutalist-skill/SKILL.md' },
      // The link wins over the lock file.
      guards: { source: 'other/repo', skillPath: 'guards/SKILL.md' }
    })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => lock)
    const groups = await registry.groups()
    expect(groups).toEqual(
      expect.arrayContaining([
        // One set however each source writes the owner's case.
        { repo: 'Leon/Taste-Skill', url: 'https://github.com/Leon/Taste-Skill', skills: ['brutal-ui', 'minimal-ui'] },
        { repo: 'acme/skills', url: 'https://github.com/acme/skills', skills: ['guards'] }
      ])
    )
    // A skill written here is in no group.
    expect(groups.flatMap((g) => g.skills)).not.toContain('mine')
    expect(hits.download).toBe(0)
  })

  it('counts a skill the skills CLI installed as installed in search, whatever the owner’s case', async () => {
    const { services } = makeServices()
    hubSkill(services.ctx.skillsDir, 'nest-guards', { 'SKILL.md': skillMd(1).replace('CanActivate', 'local edit') })
    const lock = lockFile({ 'nest-guards': { source: 'Acme/skills', skillPath: 'skills/guards/SKILL.md' } })
    const registry = new SkillRegistry(services.ctx, services.skills, base, () => '', () => lock)
    expect((await registry.search('guards'))[0].installedAs).toBe('nest-guards')
  })
})
