import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { DockerRun } from '../src/main/agent/containers'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

/** Stands in for the docker CLI: records calls, keeps container state, and acts out `exec` against the mounted copy. */
function fakeDocker(opts: { installed?: boolean; running?: boolean } = {}) {
  const calls: string[][] = []
  const containers = new Map<string, { running: boolean; mount: string }>()
  const run: DockerRun = async (args, o) => {
    calls.push(args)
    if (opts.installed === false) throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    switch (args[0]) {
      case 'version':
        return opts.running === false ? { code: 1, stdout: '', stderr: 'cannot connect' } : ok('27.1.1\n')
      case 'inspect': {
        const c = containers.get(args.at(-1)!)
        return c ? ok(`${c.running}\n`) : { code: 1, stdout: '', stderr: 'No such object' }
      }
      case 'run': {
        const name = args[args.indexOf('--name') + 1]
        const mount = args[args.indexOf('-v') + 1].replace(/:\/workspace$/, '')
        containers.set(name, { running: true, mount })
        return ok('abc123\n')
      }
      case 'rm':
        containers.delete(args.at(-1)!)
        return ok()
      case 'exec': {
        // ['exec','-i','-w',wd,name,'sh','-c',script,'sh',command]
        const c = containers.get(args[4])!
        const command = args.at(-1)!
        const m = /^echo (.+) > (.+)$/.exec(command)
        if (m) writeFileSync(join(c.mount, m[2]), `${m[1]}\n`)
        o?.onData?.(Buffer.from(`ran in ${args[3]}: ${command}\n`))
        return ok()
      }
      default:
        return ok()
    }
  }
  return { run, calls, containers }
}

function project() {
  const folder = mkdtempSync(join(tmpdir(), 'cloth-folder-'))
  writeFileSync(join(folder, 'README.md'), '# App\n')
  mkdirSync(join(folder, 'src'))
  writeFileSync(join(folder, 'src', 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(folder, 'src', 'old.ts'), 'export const old = true\n')
  mkdirSync(join(folder, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(folder, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1')
  mkdirSync(join(folder, '.git'))
  writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return folder
}

describe('container copies', () => {
  it('copies the folder (not dependencies), reports changes, and applies or discards them', async () => {
    const docker = fakeDocker()
    const { services } = makeServices({ docker: docker.run })
    const c = services.containers
    const folder = project()
    const copy = await c.prepare('ses_1', folder)
    expect(readFileSync(join(copy, 'src', 'app.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(existsSync(join(copy, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(copy, 'node_modules'))).toBe(false)
    expect((await c.changes('ses_1')).changes).toEqual([])

    // The agent works in the copy; the real folder is untouched.
    writeFileSync(join(copy, 'src', 'app.ts'), 'export const a = 2\n')
    writeFileSync(join(copy, 'src', 'new.ts'), 'export const b = 3\n')
    writeFileSync(join(copy, '.git', 'HEAD'), 'ref: refs/heads/agent\n')
    const { rmSync } = await import('node:fs')
    rmSync(join(copy, 'src', 'old.ts'))
    expect(readFileSync(join(folder, 'src', 'app.ts'), 'utf8')).toBe('export const a = 1\n')

    const { changes } = await c.changes('ses_1')
    expect(changes.map((x) => [x.path, x.kind, x.conflict])).toEqual([
      ['src/app.ts', 'modify', false],
      ['src/new.ts', 'create', false],
      ['src/old.ts', 'delete', false]
    ])
    expect(changes[0].diff).toContain('-export const a = 1')
    expect(changes[0].diff).toContain('+export const a = 2')

    // The user edits the same file on their PC: applying it would overwrite that.
    writeFileSync(join(folder, 'src', 'app.ts'), 'export const a = 10\n')
    expect((await c.changes('ses_1')).changes[0].conflict).toBe(true)

    const left = await c.apply('ses_1', ['src/new.ts', 'src/old.ts'])
    expect(readFileSync(join(folder, 'src', 'new.ts'), 'utf8')).toBe('export const b = 3\n')
    expect(existsSync(join(folder, 'src', 'old.ts'))).toBe(false)
    expect(left.changes.map((x) => x.path)).toEqual(['src/app.ts'])

    // Discarding brings the copy back to what the real folder has now.
    expect((await c.discard('ses_1')).changes).toEqual([])
    expect(readFileSync(join(copy, 'src', 'app.ts'), 'utf8')).toBe('export const a = 10\n')
  })

  it('leaves out what .gitignore excludes, and only re-reads files whose size or time changed', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const c = services.containers
    const folder = project()
    writeFileSync(join(folder, '.gitignore'), 'dist/\n*.log\n')
    writeFileSync(join(folder, 'debug.log'), 'noise')
    mkdirSync(join(folder, 'dist'))
    writeFileSync(join(folder, 'dist', 'bundle.js'), 'built')
    writeFileSync(join(folder, 'src', '.gitignore'), 'secret.txt\n')
    writeFileSync(join(folder, 'src', 'secret.txt'), 'token')
    const copy = await c.prepare('ses_g', folder)
    expect(existsSync(join(copy, 'debug.log'))).toBe(false)
    expect(existsSync(join(copy, 'dist'))).toBe(false)
    expect(existsSync(join(copy, 'src', 'secret.txt'))).toBe(false)
    expect(existsSync(join(copy, 'src', 'app.ts'))).toBe(true)

    // Build output the agent makes is ignored too; a real source change is not.
    mkdirSync(join(copy, 'dist'))
    writeFileSync(join(copy, 'dist', 'app.js'), 'console.log(1)')
    writeFileSync(join(copy, 'build.log'), 'ok')
    writeFileSync(join(copy, 'src', 'extra.ts'), 'export {}\n')
    expect((await c.changes('ses_g')).changes.map((x) => x.path)).toEqual(['src/extra.ts'])

    // The cache is trusted while size and time match (a wrong hash in it shows up as a change)…
    const cacheFile = join(copy, '..', 'stat-cache.json')
    const cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
    cache['README.md'][2] = 'not-the-real-hash'
    writeFileSync(cacheFile, JSON.stringify(cache))
    expect((await c.changes('ses_g')).changes.map((x) => x.path)).toEqual(['README.md', 'src/extra.ts'])
    // …and a file whose time changed is read again.
    const { utimesSync } = await import('node:fs')
    utimesSync(join(copy, 'README.md'), new Date(), new Date(Date.now() + 5000))
    expect((await c.changes('ses_g')).changes.map((x) => x.path)).toEqual(['src/extra.ts'])
  })

  it('starts the container on first use, recreates it when its settings change, and explains a missing Docker', async () => {
    const docker = fakeDocker()
    const { services } = makeServices({ docker: docker.run })
    await services.containers.prepare('ses_2', null)
    const out: string[] = []
    await services.containers.exec('ses_2', { image: 'node:22', network: true }, 'ls', 'src', { onData: (d) => out.push(String(d)) })
    const run = docker.calls.find((a) => a[0] === 'run')!
    expect(run).toEqual(expect.arrayContaining(['--name', 'cloth-ses_2', '-v', '/workspace/node_modules', 'node:22', 'sleep', 'infinity']))
    expect(run).not.toContain('--network')
    expect(out.join('')).toContain('ran in /workspace/src: ls')

    await services.containers.exec('ses_2', { image: 'node:22', network: true }, 'pwd', '', { onData: () => undefined })
    expect(docker.calls.filter((a) => a[0] === 'run')).toHaveLength(1)

    await services.containers.exec('ses_2', { image: 'python:3.12', network: false }, 'pwd', '', { onData: () => undefined })
    const runs = docker.calls.filter((a) => a[0] === 'run')
    expect(runs).toHaveLength(2)
    expect(runs[1]).toEqual(expect.arrayContaining(['--network', 'none', 'python:3.12']))

    const missing = makeServices({ docker: fakeDocker({ installed: false }).run }).services.containers
    expect((await missing.status()).error).toMatch(/isn’t installed/)
    const stopped = makeServices({ docker: fakeDocker({ running: false }).run }).services.containers
    expect((await stopped.status()).error).toMatch(/isn’t running/)
    await stopped.prepare('ses_3', null)
    await expect(stopped.exec('ses_3', { image: 'node:22', network: true }, 'ls', '', { onData: () => undefined })).rejects.toThrow(/isn’t running/)
  })

  it('a container chat edits the copy and runs bash in the container, leaving the real folder alone', async () => {
    const docker = fakeDocker()
    const { services } = makeServices({ docker: docker.run })
    const folder = project()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const chat = services.chat.create({
      model: { providerId: provider.id, modelId: 'faux-1' },
      workspace: folder,
      fileAccess: 'write',
      shell: true,
      autoApprove: 'all',
      knowledgeEnabled: false,
      skillsEnabled: false,
      customTools: false,
      subagents: false,
      codeIntel: false,
      container: { image: 'node:22', network: true }
    })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let system = ''
    faux.setResponses([
      (ctx) => {
        system = JSON.stringify(ctx)
        return fauxAssistantMessage([fauxToolCall('write', { path: 'src/app.ts', content: 'export const a = 42\n' }), fauxToolCall('bash', { command: 'echo built > out.txt' })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('Done: changed src/app.ts and built.')
    ])
    await services.chat.send(chat.id, 'Change a to 42 and build')
    for (let i = 0; i < 300 && services.chat.isRunning(chat.id); i++) await wait(10)

    expect(system).toContain('Linux container (image node:22)')
    expect(readFileSync(join(folder, 'src', 'app.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(docker.calls.some((a) => a[0] === 'exec' && a.at(-1) === 'echo built > out.txt')).toBe(true)
    const { changes } = await services.containers.changes(chat.id)
    expect(changes.map((x) => [x.path, x.kind])).toEqual([
      ['out.txt', 'create'],
      ['src/app.ts', 'modify']
    ])
    await services.containers.apply(chat.id)
    expect(readFileSync(join(folder, 'src', 'app.ts'), 'utf8')).toBe('export const a = 42\n')

    services.chat.remove(chat.id)
    await wait(50)
    expect(docker.calls.some((a) => a[0] === 'rm' && a.includes('-f'))).toBe(true)
  })
})
