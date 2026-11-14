import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { languageServers, mcpFromCodexToml, OnboardingService, scanFolder } from '../src/main/onboarding'
import { makeServices } from './helpers'

const tmp = () => mkdtempSync(join(tmpdir(), 'cloth-onboarding-'))
const write = (file: string, text = '') => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

describe('scanFolder', () => {
  it('counts languages, reads frameworks and finds projects inside', async () => {
    const root = tmp()
    write(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    write(join(root, 'AGENTS.md'), '# rules')
    write(join(root, 'web', 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }))
    for (let i = 0; i < 6; i++) write(join(root, 'web', 'src', `c${i}.tsx`))
    write(join(root, 'web', 'src', 'types.d.ts'))
    write(join(root, 'api', 'pyproject.toml'), '[project]\ndependencies = ["fastapi>=0.110"]\n')
    for (let i = 0; i < 3; i++) write(join(root, 'api', `m${i}.py`))
    for (let i = 0; i < 50; i++) write(join(root, 'web', 'node_modules', 'x', `f${i}.js`))

    const scan = await scanFolder(root)
    expect(scan.git).toEqual({ branch: 'main' })
    expect(scan.instructions).toBe('AGENTS.md')
    expect(scan.languages.map((l) => [l.id, l.files])).toEqual([
      ['typescript', 6],
      ['python', 3]
    ])
    expect(scan.frameworks.sort()).toEqual(['FastAPI', 'React'])
    expect(scan.subprojects.sort()).toEqual(['api', 'web'])
  })

  it('rejects a folder that is gone', async () => {
    await expect(scanFolder(join(tmp(), 'missing'))).rejects.toThrow(/no longer exists/)
  })
})

describe('languageServers', () => {
  it('reports the bundled servers and languages without one', () => {
    const list = languageServers(['typescript', 'python', 'java'])
    expect(list.map((l) => l.status)).toEqual(['bundled', 'bundled', 'none'])
  })
})

describe('mcpFromCodexToml', () => {
  it('reads stdio and http servers with their env', () => {
    const servers = mcpFromCodexToml(
      [
        'model = "o3"',
        '[mcp_servers.context7]',
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        '[mcp_servers.context7.env]',
        'API_KEY = "secret"',
        '[mcp_servers."remote"]',
        "url = 'https://example.com/mcp'",
        '[profiles.fast]',
        'command = "ignored"'
      ].join('\n')
    )
    expect(servers).toEqual([
      { name: 'context7', config: { transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { API_KEY: 'secret' } } },
      { name: 'remote', config: { transport: 'http', command: '', args: [], env: {}, url: 'https://example.com/mcp' } }
    ])
  })
})

describe('OnboardingService imports', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA }
  let home: string
  beforeEach(() => {
    home = tmp()
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.APPDATA = join(home, 'AppData', 'Roaming')
    write(join(home, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\n---\nYou review code carefully.\n')
    write(join(home, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidies code\n---\nTidy it.\n')
    write(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'ghp_secret' } } } }))
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('lists what other tools have without sending MCP secrets', async () => {
    const { services } = makeServices()
    const sources = await new OnboardingService(services).sources()
    const claude = sources.find((s) => s.id === 'claude-code')!
    expect(claude.skills.map((s) => s.name)).toEqual(['tidy'])
    expect(claude.agents.map((a) => a.name)).toEqual(['reviewer'])
    const cursor = sources.find((s) => s.id === 'cursor')!
    expect(cursor.mcp).toEqual([{ name: 'github', summary: 'npx -y gh-mcp', imported: false }])
    expect(JSON.stringify(sources)).not.toContain('ghp_secret')
  })

  it('imports skills, agents and MCP servers (switched off), and nothing it did not find', async () => {
    const { services } = makeServices()
    const ob = new OnboardingService(services)
    const [claude] = await ob.sources()
    const r = await ob.importItems({ skills: [claude.skills[0].dir, join(home, 'elsewhere')], agents: [claude.agents[0].file, join(home, 'x.md')], mcp: [{ source: 'cursor', name: 'github' }, { source: 'cursor', name: 'nope' }] })
    expect(r).toEqual({ skills: ['tidy'], agents: ['reviewer'], mcp: ['github'], errors: [] })
    expect(services.agents.list().find((a) => a.name === 'reviewer')?.instructions).toBe('You review code carefully.')
    const client = services.settings.get().mcpClients.find((c) => c.name === 'github')!
    expect(client).toMatchObject({ command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'ghp_secret' }, enabled: false, defaultOn: false, approval: 'ask' })
    // A second import of the same server adds nothing.
    expect((await ob.importItems({ skills: [], agents: [], mcp: [{ source: 'cursor', name: 'github' }] })).mcp).toEqual([])
  })

  it('needs a model before building the best-practice library', async () => {
    const { services } = makeServices()
    await expect(new OnboardingService(services).bestPractices({ languages: ['python'], frameworks: [], cadence: 'monthly' })).rejects.toThrow(/Connect a model/)
  })
})

describe('main working folder', () => {
  it('is where new chats open, unless a folder, project or container is asked for', () => {
    const { services } = makeServices()
    const folder = tmp()
    services.settings.update({ defaultWorkspace: folder })
    expect(services.chat.create({}).workspace).toBe(folder)
    expect(services.chat.create({ workspace: null }).workspace).toBeNull()
    const project = services.projects.create({ name: 'P' })
    expect(services.chat.create({ projectId: project.id }).workspace).toBeNull()
    services.settings.update({ defaultWorkspace: join(folder, 'gone') })
    expect(services.chat.create({}).workspace).toBeNull()
  })
})
