import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { DockerRun } from '../src/main/agent/containers'
import { createApi } from '../src/main/api'
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
        // A stop: ['exec',name,'sh','-c',script,'sh',pidFile]
        if (args[1] !== '-i') return ok()
        // ['exec','-i','-w',wd,name,'sh','-c',script,'sh',pidFile,command]
        const c = containers.get(args[4])!
        const command = args.at(-1)!
        if (command === 'python -m http.server') {
          // Runs until the docker client is killed.
          await new Promise((r) => (o?.signal?.aborted ? r(null) : o?.signal?.addEventListener('abort', r, { once: true })))
          return { code: null, stdout: '', stderr: '' }
        }
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

  it('creates the container once when several commands start at the same time', async () => {
    const docker = fakeDocker()
    const { services } = makeServices({ docker: docker.run })
    await services.containers.prepare('ses_par', null)
    const settings = { image: 'node:22-alpine', network: false }
    await Promise.all(['node index.js', 'uname -a', 'pwd'].map((cmd) => services.containers.exec('ses_par', settings, cmd, '', { onData: () => undefined })))
    expect(docker.calls.filter((a) => a[0] === 'run')).toHaveLength(1)
    expect(docker.calls.filter((a) => a[0] === 'exec')).toHaveLength(3)
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
    expect(docker.calls).toContainEqual(['rm', '-f', '-v', `cloth-${chat.id.toLowerCase()}`])
  })

  it('removes the dependency volumes with the container', async () => {
    const docker = fakeDocker()
    const { services } = makeServices({ docker: docker.run })
    await services.containers.prepare('ses_v', null)
    await services.containers.exec('ses_v', { image: 'node:22', network: true }, 'pwd', '', { onData: () => undefined })
    await services.containers.exec('ses_v', { image: 'python:3.12', network: true }, 'pwd', '', { onData: () => undefined })
    await services.containers.reset('ses_v')
    await services.containers.remove('ses_v')
    const rms = docker.calls.filter((a) => a[0] === 'rm')
    expect(rms).toHaveLength(3)
    for (const a of rms) expect(a).toEqual(['rm', '-f', '-v', 'cloth-ses_v'])
  })

  it('stops a command inside the container when it times out or is aborted, and leaves finished ones alone', async () => {
    const docker = fakeDocker()
    const { services } = makeServices({ docker: docker.run })
    await services.containers.prepare('ses_k', null)
    const settings = { image: 'alpine', network: false }
    const stops = () => docker.calls.filter((a) => a[0] === 'exec' && a[1] !== '-i')
    const pidFileOf = (command: string) => docker.calls.filter((a) => a[0] === 'exec' && a.at(-1) === command).at(-1)!.at(-2)!

    await services.containers.exec('ses_k', settings, 'nohup node server.js > /tmp/s.log 2>&1 &', '', { onData: () => undefined, timeout: 60 })
    expect(stops()).toHaveLength(0)

    await expect(services.containers.exec('ses_k', settings, 'python -m http.server', '', { onData: () => undefined, timeout: 0.05 })).rejects.toThrow('timeout:0.05')
    const pidFile = pidFileOf('python -m http.server')
    expect(pidFile).toMatch(/^\/tmp\/\.cloth-cmd-[0-9a-f]+$/)
    expect(stops()).toHaveLength(1)
    // The stop reads the pid the command recorded and kills its process group, then cleans up.
    const [stop] = stops()
    expect(stop.slice(0, 4)).toEqual(['exec', 'cloth-ses_k', 'sh', '-c'])
    expect(stop.at(-1)).toBe(pidFile)
    expect(stop[4]).toContain('kill -TERM "$x"')
    expect(stop[4]).toContain('kill -KILL "$x"')
    expect(stop[4]).toContain('rm -f "$1"')
    // …and the command's wrapper records that pid in the same file.
    const run = docker.calls.find((a) => a[0] === 'exec' && a.at(-1) === 'python -m http.server')!
    expect(run[7]).toContain('echo $$ > "$1"')

    const ctl = new AbortController()
    const pending = services.containers.exec('ses_k', settings, 'python -m http.server', '', { onData: () => undefined, signal: ctl.signal })
    await wait(20)
    ctl.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(stops()).toHaveLength(2)
    expect(stops()[1].at(-1)).toBe(pidFileOf('python -m http.server'))
    expect(stops()[1].at(-1)).not.toBe(pidFile)
  })

  it('gives shell commands a default timeout and explains what to do when it hits', async () => {
    const { buildWorkspaceTools, DEFAULT_COMMAND_TIMEOUT } = await import('../src/main/agent/workspace')
    const root = mkdtempSync(join(tmpdir(), 'cloth-ws-'))
    const seen: (number | undefined)[] = []
    const tools = buildWorkspaceTools({
      root,
      sessionId: null,
      access: 'read',
      shell: true,
      approvals: null,
      checkpoints: null,
      autoApprove: () => 'all',
      shellExec: async (_command, _cwd, options) => {
        seen.push(options.timeout)
        options.onData(Buffer.from('Serving HTTP on 0.0.0.0 port 8000\n'))
        throw new Error(`timeout:${options.timeout}`)
      }
    })
    const bash = tools.find((t) => t.name === 'bash')!
    const err = await bash.execute('call_1', { command: 'python -m http.server' }).catch((e: Error) => e)
    expect(DEFAULT_COMMAND_TIMEOUT).toBe(300)
    expect(seen).toEqual([300])
    expect((err as Error).message).toContain('Serving HTTP on 0.0.0.0 port 8000')
    expect((err as Error).message).toContain('The command was stopped after 5 minutes')
    expect((err as Error).message).toContain('nohup npm run dev > /tmp/server.log 2>&1 &')
    expect((err as Error).message).toContain('pass a larger timeout')

    // A timeout the model gives is kept.
    await bash.execute('call_2', { command: 'make', timeout: 1200 }).catch(() => undefined)
    expect(seen).toEqual([300, 1200])
  })
})

type Services = ReturnType<typeof makeServices>['services']
type Reply = Parameters<ReturnType<typeof registerFauxProvider>['setResponses']>[0][number]

/** A chat with scripted model replies, in a container or (container: null) on this PC. */
function scriptedChat(services: Services, workspace: string | null, container: { image: string; network: boolean } | null, replies: Reply[]) {
  const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const chat = services.chat.create({
    model: { providerId: provider.id, modelId: 'faux-1' },
    workspace,
    fileAccess: 'write',
    shell: true,
    autoApprove: 'all',
    knowledgeEnabled: false,
    skillsEnabled: false,
    customTools: false,
    subagents: false,
    codeIntel: false,
    container
  })
  faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
  faux.setResponses(replies)
  return chat
}

async function turn(services: Services, id: string, text: string) {
  await services.chat.send(id, text)
  for (let i = 0; i < 300 && services.chat.isRunning(id); i++) await wait(10)
}

const writes = (files: Record<string, string>) => fauxAssistantMessage(Object.entries(files).map(([path, content]) => fauxToolCall('write', { path, content })), { stopReason: 'toolUse' })
const IMAGE = { image: 'node:22', network: true }
const kinds = (r: { changes: { path: string; kind: string }[] }) => r.changes.map((x) => [x.path, x.kind])

describe("a container chat's folder", () => {
  it('folder first, then the container: changes apply to that folder', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const api = createApi(services)
    const folder = project()
    const chat = scriptedChat(services, folder, null, [writes({ 'src/app.ts': 'export const a = 7\n' }), fauxAssistantMessage('Done.')])
    await api.chat.update(chat.id, { container: IMAGE, fileAccess: 'write', shell: true })
    await turn(services, chat.id, 'Set a to 7')

    const pending = await api.containers.changes(chat.id)
    expect(pending.folder).toBe(folder)
    expect(kinds(pending)).toEqual([['src/app.ts', 'modify']])
    expect((await api.containers.apply(chat.id)).changes).toEqual([])
    expect(readFileSync(join(folder, 'src', 'app.ts'), 'utf8')).toBe('export const a = 7\n')
  })

  it('container first, folder picked after the agent worked: its changes apply to the folder picked', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const api = createApi(services)
    const folder = project()
    const chat = scriptedChat(services, null, IMAGE, [writes({ 'notes.md': '# Notes\n', 'src/app.ts': 'export const a = 8\n' }), fauxAssistantMessage('Done.')])
    await turn(services, chat.id, 'Write notes')
    expect((await api.containers.changes(chat.id)).folder).toBeNull()

    await api.chat.update(chat.id, { workspace: folder })
    const pending = await api.containers.changes(chat.id)
    expect(pending.folder).toBe(folder)
    // Measured against the folder now: app.ts exists there, so it is a change to it.
    expect(kinds(pending)).toEqual([
      ['notes.md', 'create'],
      ['src/app.ts', 'modify']
    ])
    expect(pending.changes[1].diff).toContain('-export const a = 1')
    // The copy holds the folder's files as well, for the agent's next turn.
    expect(readFileSync(join(services.containers.copyDir(chat.id), 'README.md'), 'utf8')).toBe('# App\n')

    await api.containers.apply(chat.id)
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('# Notes\n')
    expect(readFileSync(join(folder, 'src', 'app.ts'), 'utf8')).toBe('export const a = 8\n')
  })

  it('another folder while changes wait: they are carried over and apply there, not to the old folder', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const api = createApi(services)
    const first = project()
    const second = project()
    writeFileSync(join(second, 'README.md'), '# Second\n')
    writeFileSync(join(second, 'src', 'app.ts'), 'export const a = 100\n')
    const chat = scriptedChat(services, first, IMAGE, [
      fauxAssistantMessage([fauxToolCall('write', { path: 'src/app.ts', content: 'export const a = 2\n' }), fauxToolCall('write', { path: 'src/new.ts', content: 'export const n = 1\n' }), fauxToolCall('bash', { command: 'echo built > out.txt' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.')
    ])
    await turn(services, chat.id, 'Work')
    const { rmSync } = await import('node:fs')
    rmSync(join(services.containers.copyDir(chat.id), 'src', 'old.ts'))
    const all = [
      ['out.txt', 'create'],
      ['src/app.ts', 'modify'],
      ['src/new.ts', 'create'],
      ['src/old.ts', 'delete']
    ]
    expect(kinds(await api.containers.changes(chat.id))).toEqual(all)

    await api.chat.update(chat.id, { workspace: second })
    const moved = await api.containers.changes(chat.id)
    expect(moved.folder).toBe(second)
    expect(kinds(moved)).toEqual(all)
    // Diffs are against the new folder, which nobody changed since: no conflicts.
    expect(moved.changes[1].diff).toContain('-export const a = 100')
    expect(moved.changes.some((c) => c.conflict)).toBe(false)
    expect(readFileSync(join(services.containers.copyDir(chat.id), 'README.md'), 'utf8')).toBe('# Second\n')

    await api.containers.apply(chat.id)
    expect(readFileSync(join(second, 'src', 'app.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(readFileSync(join(second, 'out.txt'), 'utf8')).toBe('built\n')
    expect(existsSync(join(second, 'src', 'old.ts'))).toBe(false)
    // The folder the chat no longer uses is left alone.
    expect(readFileSync(join(first, 'src', 'app.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(existsSync(join(first, 'src', 'new.ts'))).toBe(false)
    expect(existsSync(join(first, 'src', 'old.ts'))).toBe(true)
  })

  it('another folder with nothing waiting: the copy is made again from it, and the next turn works there', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const api = createApi(services)
    const first = project()
    const second = project()
    writeFileSync(join(first, 'first-only.md'), 'x\n')
    writeFileSync(join(second, 'README.md'), '# Second\n')
    const chat = scriptedChat(services, first, IMAGE, [fauxAssistantMessage('Nothing to change.'), writes({ 'README.md': '# Second, edited\n' }), fauxAssistantMessage('Done.')])
    await turn(services, chat.id, 'Look around')
    const copy = services.containers.copyDir(chat.id)
    expect(readFileSync(join(copy, 'README.md'), 'utf8')).toBe('# App\n')
    const { statSync } = await import('node:fs')
    const mounted = statSync(copy).ino

    await api.chat.update(chat.id, { workspace: second })
    expect(kinds(await api.containers.changes(chat.id))).toEqual([])
    expect(readFileSync(join(copy, 'README.md'), 'utf8')).toBe('# Second\n')
    expect(existsSync(join(copy, 'first-only.md'))).toBe(false)
    // Emptied and filled in place, not removed: the running container's mount still points at it.
    expect(statSync(copy).ino).toBe(mounted)

    await turn(services, chat.id, 'Edit the readme')
    expect(kinds(await api.containers.changes(chat.id))).toEqual([['README.md', 'modify']])
    await api.containers.apply(chat.id)
    expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('# Second, edited\n')
    expect(readFileSync(join(first, 'README.md'), 'utf8')).toBe('# App\n')
  })

  it('a turn after the folder changed moves the copy too, keeping what waits for review', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const first = project()
    const second = project()
    const chat = scriptedChat(services, null, IMAGE, [writes({ 'plan.md': 'step 1\n' }), fauxAssistantMessage('Planned.'), writes({ 'src/app.ts': 'export const a = 3\n' }), fauxAssistantMessage('Done.')])
    await turn(services, chat.id, 'Plan')
    // The folder is picked, then changed again, without the changes being looked at in between.
    services.chat.update(chat.id, { workspace: first })
    services.chat.update(chat.id, { workspace: second })
    await turn(services, chat.id, 'Do it')
    const api = createApi(services)
    const pending = await api.containers.changes(chat.id)
    expect(pending.folder).toBe(second)
    expect(kinds(pending)).toEqual([
      ['plan.md', 'create'],
      ['src/app.ts', 'modify']
    ])
    await api.containers.apply(chat.id)
    expect(readFileSync(join(second, 'plan.md'), 'utf8')).toBe('step 1\n')
    expect(readFileSync(join(second, 'src', 'app.ts'), 'utf8')).toBe('export const a = 3\n')
    expect(existsSync(join(first, 'plan.md'))).toBe(false)
  })

  it('changes asked for while the copy is being made again wait for it', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const c = services.containers
    const first = project()
    const second = project()
    writeFileSync(join(second, 'README.md'), '# Second\n')
    const copy = await c.prepare('ses_race', first)
    writeFileSync(join(copy, 'src', 'app.ts'), 'export const a = 5\n')
    const [, seen] = await Promise.all([c.prepare('ses_race', second), c.changes('ses_race', second)])
    expect(seen.folder).toBe(second)
    expect(kinds(seen)).toEqual([['src/app.ts', 'modify']])
    expect(readFileSync(join(copy, 'README.md'), 'utf8')).toBe('# Second\n')
  })

  it('a move to another folder that stops halfway is finished on the next try, without made-up deletions', async () => {
    const { services } = makeServices({ docker: fakeDocker().run })
    const c = services.containers
    const first = project()
    const second = project()
    const copy = await c.prepare('ses_halt', first)
    writeFileSync(join(copy, 'src', 'app.ts'), 'export const a = 6\n')
    writeFileSync(join(copy, 'src', 'new.ts'), 'export const n = 6\n')
    // The second folder has a folder where the copy keeps a file: copying stops partway through.
    mkdirSync(join(second, 'src', 'new.ts'))
    writeFileSync(join(second, 'src', 'new.ts', 'inner.ts'), '')
    await expect(c.changes('ses_halt', second)).rejects.toThrow()

    // Back to the first folder: the copy is whole again, with just the changes that were waiting.
    const back = await c.changes('ses_halt', first)
    expect(back.folder).toBe(first)
    expect(kinds(back)).toEqual([
      ['src/app.ts', 'modify'],
      ['src/new.ts', 'create']
    ])
    expect(readFileSync(join(copy, 'src', 'old.ts'), 'utf8')).toBe('export const old = true\n')
    expect(readFileSync(join(copy, 'src', 'app.ts'), 'utf8')).toBe('export const a = 6\n')
  })
})
