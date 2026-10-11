import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { plainSecrets } from '../src/main/core/context'
import { createServices } from '../src/main/services'
import { downloadFile } from '../src/main/run/download'
import {
  BONSAI_MODEL_FILE,
  BONSAI_MMPROJ_FILE,
  DEVICE_ERROR,
  FORMAT_ERROR,
  RunService,
  buildCommand,
  explainFailure,
  hfHubCache,
  parseDevices,
  parseTokensPerSecond,
  pickRuntimeAssets,
  resolveServer,
  splitArgs,
  type RunChild,
  type RunDeps
} from '../src/main/run/run'
import type { Runner, RunEvent } from '../src/shared/types'
import { REPO } from './helpers'

// ─── Harness ──────────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter implements RunChild {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  constructor(public pid = 4242) {
    super()
  }
  kill(): boolean {
    this.exit(null)
    return true
  }
  exit(code: number | null): void {
    if (this.killed) return
    this.killed = true
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('exit', code, null))
  }
}

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

function tmp(prefix = 'cloth-run-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function setup(deps: Partial<RunDeps> = {}) {
  const dataDir = tmp()
  const events: { channel: string; payload: unknown }[] = []
  const spawned: { file: string; args: string[]; cwd: string; child: FakeChild }[] = []
  const home = tmp('cloth-home-')
  const s = createServices({
    dataDir,
    secrets: plainSecrets,
    dbFile: ':memory:',
    sidecarsDir: join(REPO, 'sidecars'),
    examplesDir: join(REPO, 'resources', 'examples'),
    emit: (channel, payload) => events.push({ channel, payload }),
    run: {
      spawn: (file, args, opts) => {
        const child = new FakeChild()
        spawned.push({ file, args, cwd: opts.cwd, child })
        return child
      },
      kill: async (child) => void child.kill(),
      portFree: async () => true,
      exec: async () => ({ stdout: '', stderr: '', code: 0 }),
      home,
      env: {},
      healthIntervalMs: 20,
      ...deps
    }
  })
  cleanup.push(() => s.runs.stopAll())
  const runEvents = () => events.filter((e) => e.channel === 'runs').map((e) => e.payload as RunEvent)
  return { s, runs: s.runs, dataDir, home, spawned, runEvents }
}

/** A fake llama-server install: an exe file and a model file. */
function fakeInstall(): { server: string; model: string; dir: string } {
  const dir = tmp('cloth-llama-')
  const server = join(dir, 'bin', 'llama-server.exe')
  mkdirSync(dirname(server), { recursive: true })
  writeFileSync(server, 'MZ')
  const model = join(dir, 'model.gguf')
  writeFileSync(model, 'GGUF')
  return { server, model, dir }
}

async function until<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  cleanup.push(() => new Promise((r) => server.close(() => r(undefined))))
  return { server, port, url: `http://127.0.0.1:${port}` }
}

/** /health answers 503 "Loading model" a few times, then {"status":"ok"}. */
async function healthServer(loadingFor = 2) {
  let calls = 0
  return listen((req, res) => {
    if (req.url === '/health') {
      calls++
      if (calls <= loadingFor) {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"code":503,"message":"Loading model"}}')
      } else res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
      return
    }
    res.writeHead(404).end()
  })
}

function runner(over: Partial<Runner> = {}): Runner {
  return {
    id: 'r1',
    name: 'Test',
    builtin: null,
    serverPath: 'C:\\llama\\llama-server.exe',
    modelPath: 'C:\\models\\m.gguf',
    mmprojPath: null,
    device: null,
    gpuLayers: 99,
    contextSize: 4096,
    port: 8090,
    flashAttention: true,
    sampling: {},
    extraArgs: '',
    alias: 'm',
    useInChats: true,
    createdAt: 0,
    updatedAt: 0,
    ...over
  }
}

// ─── Args ─────────────────────────────────────────────────────────────────────

describe('llama-server command', () => {
  it('splits extra args with quotes and keeps Windows backslashes', () => {
    expect(splitArgs(`--jinja --chat-template-file "C:\\My Templates\\t.jinja" --x 'a b' -n 5 ""`)).toEqual([
      '--jinja',
      '--chat-template-file',
      'C:\\My Templates\\t.jinja',
      '--x',
      'a b',
      '-n',
      '5',
      ''
    ])
    expect(splitArgs('   ')).toEqual([])
    expect(splitArgs('--a=b"c d"')).toEqual(['--a=bc d'])
  })

  it('builds the full argument list, by full path, from its own folder', () => {
    const server = join('C:', 'llama prism', 'llama-server.exe')
    const cmd = buildCommand(
      runner({
        modelPath: 'D:\\m\\Bonsai.gguf',
        mmprojPath: 'D:\\m\\mmproj.gguf',
        device: 'ROCm0',
        gpuLayers: 99,
        contextSize: 32768,
        port: 8090,
        alias: 'bonsai-2-27b',
        sampling: { temp: 1, topP: 0.95, topK: 20, minP: 0.05 },
        extraArgs: '--jinja --reasoning-format "deepseek legacy"'
      }),
      server
    )
    expect(cmd.file).toBe(server)
    expect(cmd.cwd).toBe(dirname(server))
    expect(cmd.args).toEqual([
      '-m', 'D:\\m\\Bonsai.gguf',
      '--mmproj', 'D:\\m\\mmproj.gguf',
      '--device', 'ROCm0',
      '-ngl', '99', '-fa', 'on', '-c', '32768',
      '--host', '127.0.0.1', '--port', '8090', '--alias', 'bonsai-2-27b',
      '--temp', '1', '--top-p', '0.95', '--top-k', '20', '--min-p', '0.05',
      '--jinja', '--reasoning-format', 'deepseek legacy'
    ])
  })

  it('leaves out device, projector and sampling when unset', () => {
    const cmd = buildCommand(runner({ flashAttention: false }), '/opt/llama/llama-server')
    expect(cmd.args).not.toContain('--device')
    expect(cmd.args).not.toContain('--mmproj')
    expect(cmd.args).not.toContain('--temp')
    expect(cmd.args.slice(cmd.args.indexOf('-fa'), cmd.args.indexOf('-fa') + 2)).toEqual(['-fa', 'off'])
  })

  it('resolves a folder to the llama-server inside it', () => {
    const { server, dir } = fakeInstall()
    expect(resolveServer(join(dir, 'bin'), 'win32')).toBe(server)
    expect(resolveServer(server, 'win32')).toBe(server)
    expect(resolveServer(join(dir, 'nope'), 'win32')).toBeNull()
    expect(resolveServer(null)).toBeNull()
  })
})

// ─── Parsing ──────────────────────────────────────────────────────────────────

describe('log parsing', () => {
  it('reads tokens per second', () => {
    expect(parseTokensPerSecond('slot print_timing: id 0 | tg = 41.7 t/s')).toBe(41.7)
    expect(parseTokensPerSecond('{"predicted_per_second": 23.5, "x": 1}')).toBe(23.5)
    expect(parseTokensPerSecond('       eval time =    1234.56 ms /   100 tokens (   12.35 ms per token,    80.97 tokens per second)')).toBe(80.97)
    expect(parseTokensPerSecond('prompt eval time =     500.00 ms /   200 tokens (    2.50 ms per token,   400.00 tokens per second)')).toBeNull()
    expect(parseTokensPerSecond('main: server is listening')).toBeNull()
  })

  it('explains common failures', () => {
    expect(explainFailure(['llama_model_load: error loading model: invalid ggml type 43'], 1)).toBe(FORMAT_ERROR)
    expect(explainFailure(['error: invalid device: ROCm3'], 1)).toBe(DEVICE_ERROR)
    expect(explainFailure(["couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8090"], 1, 8090)).toMatch(/Port 8090 is already in use/)
    expect(explainFailure(['loading', 'error: failed to open model file'], 1)).toBe('llama-server stopped (exit code 1): error: failed to open model file')
  })

  it('parses --list-devices', () => {
    const out = [
      'ggml_vulkan: Found 1 Vulkan devices:',
      'Available devices:',
      '  ROCm0: AMD Radeon RX 7900 XTX (24560 MiB, 24402 MiB free)',
      '  Vulkan0: AMD Radeon(TM) Graphics (12288 MiB, 11000 MiB free)'
    ].join('\r\n')
    expect(parseDevices(out)).toEqual([
      { id: 'ROCm0', description: 'AMD Radeon RX 7900 XTX', totalMiB: 24560, freeMiB: 24402 },
      { id: 'Vulkan0', description: 'AMD Radeon(TM) Graphics', totalMiB: 12288, freeMiB: 11000 }
    ])
  })

  it('picks the Windows build per backend from a release', () => {
    const release = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'prism-release.json'), 'utf8'))
    const opts = pickRuntimeAssets(release)
    expect(opts.tag).toBe('b6810')
    expect(opts.source).toContain('/releases/tag/b6810')
    expect(opts.assets.map((a) => [a.backend, a.name, a.size])).toEqual([
      ['hip-radeon', 'llama-prism-b6810-bin-win-hip-radeon-x64.zip', 287000000],
      ['vulkan', 'llama-prism-b6810-bin-win-vulkan-x64.zip', 27000000],
      ['cuda-12.4', 'llama-prism-b6810-bin-win-cuda-12.4-x64.zip', 152000000],
      ['cpu', 'llama-prism-b6810-bin-win-cpu-x64.zip', 14500000]
    ])
  })
})

// ─── Runners ──────────────────────────────────────────────────────────────────

describe('runners', () => {
  it('seeds the built-in Bonsai runner once; it can be edited but not deleted', async () => {
    const { runs, s } = setup()
    const all = runs.list()
    expect(all).toHaveLength(1)
    const b = all[0]
    expect(b).toMatchObject({
      name: 'Bonsai 2 27B',
      builtin: 'bonsai-2-27b',
      alias: 'bonsai-2-27b',
      port: 8090,
      gpuLayers: 99,
      contextSize: 32768,
      flashAttention: true,
      sampling: { temp: 1, topP: 0.95, topK: 20, minP: 0.05 },
      extraArgs: '--jinja',
      useInChats: true
    })
    expect(runs.update(b.id, { device: 'Vulkan0', contextSize: 16384 })).toMatchObject({ device: 'Vulkan0', contextSize: 16384, name: 'Bonsai 2 27B' })
    await expect(runs.remove(b.id)).rejects.toThrow(/built in/)
    // A second service on the same database doesn't seed again.
    expect(new RunService(s.ctx, s.providers, { home: tmp(), env: {} }).list()).toHaveLength(1)

    const mine = runs.create({ name: 'Qwen 3 8B' })
    expect(mine).toMatchObject({ builtin: null, alias: 'qwen-3-8b', port: 8091 })
    expect(() => runs.update(mine.id, { port: 70000 })).toThrow(/Port/)
    await runs.remove(mine.id)
    expect(runs.list()).toHaveLength(1)
  })

  it('detects the model in an HF cache (HF_HUB_CACHE) and llama-prism in the home folder, and fills the built-in', () => {
    const hub = tmp('cloth-hub-')
    const snap = join(hub, 'models--prism-ml--Ternary-Bonsai-2-27B-gguf', 'snapshots', 'abc123')
    mkdirSync(snap, { recursive: true })
    writeFileSync(join(snap, BONSAI_MODEL_FILE), 'GGUF')
    writeFileSync(join(snap, BONSAI_MMPROJ_FILE), 'GGUF')
    const home = tmp('cloth-home-')
    mkdirSync(join(home, 'llama-prism'))
    writeFileSync(join(home, 'llama-prism', 'llama-server.exe'), 'MZ')
    const { runs } = setup({ home, env: { HF_HUB_CACHE: hub }, platform: 'win32' })
    expect(runs.detect()).toEqual({
      runtime: { found: true, path: join(home, 'llama-prism', 'llama-server.exe') },
      model: { found: true, path: join(snap, BONSAI_MODEL_FILE), mmprojPath: join(snap, BONSAI_MMPROJ_FILE) }
    })
    const b = runs.list()[0]
    expect(b.serverPath).toBe(join(home, 'llama-prism', 'llama-server.exe'))
    expect(b.modelPath).toBe(join(snap, BONSAI_MODEL_FILE))
    expect(b.mmprojPath).toBe(join(snap, BONSAI_MMPROJ_FILE))
  })

  it('prefers a llama.cpp Cloth downloaded, finds models in its models folder, and reports nothing when absent', () => {
    const { runs, dataDir } = setup({ platform: 'win32' })
    expect(runs.detect()).toEqual({ runtime: { found: false, path: null }, model: { found: false, path: null, mmprojPath: null } })
    const exe = join(dataDir, 'runtimes', 'prism-llama', 'b6810', 'llama-server.exe')
    mkdirSync(dirname(exe), { recursive: true })
    writeFileSync(exe, 'MZ')
    mkdirSync(join(dataDir, 'models'))
    writeFileSync(join(dataDir, 'models', BONSAI_MODEL_FILE), 'GGUF')
    const d = runs.detect()
    expect(d.runtime).toEqual({ found: true, path: exe, version: 'b6810' })
    expect(d.model).toEqual({ found: true, path: join(dataDir, 'models', BONSAI_MODEL_FILE), mmprojPath: null })
  })

  it('finds the HF cache from HF_HUB_CACHE, then HF_HOME, then the home folder', () => {
    expect(hfHubCache({ HF_HUB_CACHE: '/x/hub', HF_HOME: '/y' }, '/h')).toBe('/x/hub')
    expect(hfHubCache({ HF_HOME: '/y' }, '/h')).toBe(join('/y', 'hub'))
    expect(hfHubCache({}, '/h')).toBe(join('/h', '.cache', 'huggingface', 'hub'))
  })
})

// ─── Process ─────────────────────────────────────────────────────────────────

describe('running llama-server', () => {
  it('goes starting → running on /health ok, exposes the model to chats, and stopped removes it', async () => {
    const health = await healthServer(2)
    const { runs, s, spawned, runEvents } = setup()
    const { server, model } = fakeInstall()
    const r = runs.create({ name: 'Local Qwen', serverPath: dirname(server), modelPath: model, port: health.port, alias: 'qwen-local', contextSize: 8192 })

    const st = await runs.start(r.id)
    expect(st).toMatchObject({ state: 'starting', pid: 4242, url: `http://127.0.0.1:${health.port}` })
    expect(spawned[0].file).toBe(server)
    expect(spawned[0].cwd).toBe(dirname(server))
    expect(s.providers.list().some((p) => p.runnerId === r.id)).toBe(false)

    await until(() => runs.statusOf(r.id).state === 'running')
    const pid = RunService.providerId(r.id)
    const provider = s.providers.list().find((p) => p.id === pid)!
    expect(provider).toMatchObject({ name: 'Local Qwen', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${health.port}/v1`, hasApiKey: false, local: true, runnerId: r.id })
    expect(provider.models.map((m) => [m.id, m.contextWindow])).toEqual([['qwen-local', 8192]])
    const { model: m } = s.providers.resolve({ providerId: pid, modelId: 'qwen-local' })
    expect(m.baseUrl).toBe(`http://127.0.0.1:${health.port}/v1`)
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(s.providers.pricing(pid, 'qwen-local')).toBeNull()
    expect(() => s.providers.update(pid, { name: 'x' })).toThrow(/Run page/)

    // Renaming while running updates the picker.
    runs.update(r.id, { name: 'Qwen on GPU' })
    expect(s.providers.get(pid).name).toBe('Qwen on GPU')

    expect(runEvents().filter((e) => e.type === 'status').map((e) => (e as { status: { state: string } }).status.state)).toContain('running')

    await runs.stop(r.id)
    expect(runs.statusOf(r.id).state).toBe('stopped')
    expect(s.providers.list().some((p) => p.id === pid)).toBe(false)
    expect(() => s.providers.resolve({ providerId: pid, modelId: 'qwen-local' })).toThrow('Start Qwen on GPU on the Run page first.')
  })

  it('does not expose a runner that is not used in chats', async () => {
    const health = await healthServer(0)
    const { runs, s } = setup()
    const { server, model } = fakeInstall()
    const r = runs.create({ name: 'Hidden', serverPath: server, modelPath: model, port: health.port, useInChats: false })
    await runs.start(r.id)
    await until(() => runs.statusOf(r.id).state === 'running')
    expect(s.providers.list().some((p) => p.runnerId === r.id)).toBe(false)
  })

  it('keeps the last 2000 log lines, streams them as events and tracks tokens per second', async () => {
    const health = await healthServer(0)
    const { runs, spawned, runEvents } = setup()
    const { server, model } = fakeInstall()
    const r = runs.create({ name: 'Logs', serverPath: server, modelPath: model, port: health.port })
    await runs.start(r.id)
    const child = spawned[0].child
    child.stderr.write('main: loading model\nprompt eval time = 10 ms / 5 tokens (2 ms per token, 500.00 tokens per second)\n')
    child.stderr.write('       eval time =  1000.00 ms /  42 tokens ( 23.81 ms per token,    42.00 tokens per second)\npartial li')
    child.stdout.write(Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n') + '\n')
    child.stderr.write('ne done\n')
    await until(() => runs.logsOf(r.id).at(-1) === 'partial line done')
    const logs = runs.logsOf(r.id)
    expect(logs).toHaveLength(2000)
    expect(logs.at(-2)).toBe('line 2499')
    expect(runs.statusOf(r.id).lastTokensPerSecond).toBe(42)
    expect(runEvents().some((e) => e.type === 'log' && e.id === r.id && e.lines.includes('main: loading model'))).toBe(true)
  })

  it('maps a crash to a plain error and keeps the logs', async () => {
    const health = await healthServer(1000)
    const { runs, spawned } = setup()
    const { server, model } = fakeInstall()
    const r = runs.create({ name: 'Bad', serverPath: server, modelPath: model, port: health.port })
    await runs.start(r.id)
    spawned[0].child.stderr.write('llama_model_load: error loading model: invalid ggml type 42 (NONE)\n')
    spawned[0].child.exit(1)
    await until(() => runs.statusOf(r.id).state === 'error')
    expect(runs.statusOf(r.id).error).toBe(FORMAT_ERROR)
    expect(runs.logsOf(r.id).some((l) => l.includes('invalid ggml type'))).toBe(true)
  })

  it('refuses to start without a server/model, on a port another runner uses, or a port taken by another program', async () => {
    const health = await healthServer(0)
    const { runs } = setup()
    const { server, model } = fakeInstall()
    const empty = runs.create({ name: 'Empty' })
    expect((await runs.start(empty.id)).error).toMatch(/Choose llama-server/)
    runs.update(empty.id, { serverPath: server })
    expect((await runs.start(empty.id)).error).toMatch(/Choose a model file/)

    const a = runs.create({ name: 'A', serverPath: server, modelPath: model, port: health.port })
    const b = runs.create({ name: 'B', serverPath: server, modelPath: model, port: health.port, alias: 'b' })
    await runs.start(a.id)
    const st = await runs.start(b.id)
    expect(st.state).toBe('error')
    expect(st.error).toBe(`Port ${health.port} is used by A, which is running. Stop it or pick a different port.`)

    // The real port probe: something else listens there.
    const blocker = createNetServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    cleanup.push(() => new Promise((r) => blocker.close(() => r(undefined))))
    const { runs: runs2 } = setup({ portFree: undefined })
    const c = runs2.create({ name: 'C', serverPath: server, modelPath: model, port: (blocker.address() as AddressInfo).port })
    const st2 = await runs2.start(c.id)
    expect(st2.error).toMatch(/already in use by another program/)
  })

  it('lists devices from the runner\'s server', async () => {
    const { server } = fakeInstall()
    const calls: string[][] = []
    const { runs } = setup({
      exec: async (file, args) => {
        calls.push([file, ...args])
        return { stdout: '', stderr: 'Available devices:\n  ROCm0: AMD Radeon RX 7900 XTX (24560 MiB, 24402 MiB free)\n', code: 0 }
      }
    })
    const r = runs.create({ name: 'Dev', serverPath: dirname(server) })
    expect(await runs.devices(r.id)).toEqual([{ id: 'ROCm0', description: 'AMD Radeon RX 7900 XTX', totalMiB: 24560, freeMiB: 24402 }])
    expect(calls[0]).toEqual([server, '--list-devices'])
  })
})

// ─── Downloads ───────────────────────────────────────────────────────────────

/** Serves files with HEAD and Range support; records Range headers. */
async function fileServer(files: Record<string, Buffer | string>) {
  const ranges: (string | undefined)[] = []
  const srv = await listen((req, res) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0])
    const body = files[path]
    if (body === undefined) return void res.writeHead(404).end()
    if (typeof body === 'string') return void res.writeHead(200, { 'content-type': 'application/json' }).end(body)
    ranges.push(req.headers.range)
    if (req.method === 'HEAD') return void res.writeHead(200, { 'content-length': body.length }).end()
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    if (m) {
      const start = Number(m[1])
      if (start >= body.length) return void res.writeHead(416).end()
      res.writeHead(206, { 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` })
      return void res.end(body.subarray(start))
    }
    res.writeHead(200, { 'content-length': body.length }).end(body)
  })
  return { ...srv, ranges }
}

/** A small zip (deflated entries) built in memory. */
function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text)
    const comp = deflateRawSync(data)
    const nameBuf = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, comp)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

describe('downloads', () => {
  it('resumes a partial download with a Range request', async () => {
    const data = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 251))
    const srv = await fileServer({ '/f.bin': data })
    const dir = tmp()
    const dest = join(dir, 'f.bin')
    writeFileSync(`${dest}.part`, data.subarray(0, 40_000))
    const progress: [number, number][] = []
    await downloadFile(`${srv.url}/f.bin`, dest, { onProgress: (r, t) => progress.push([r, t]) })
    expect(srv.ranges.at(-1)).toBe('bytes=40000-')
    expect(readFileSync(dest).equals(data)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(progress[0]).toEqual([40_000, 100_000])
    expect(progress.at(-1)).toEqual([100_000, 100_000])
  })

  it('downloads the Bonsai model into the data folder, resuming, and sets the runner paths', async () => {
    const model = Buffer.alloc(50_000, 7)
    const base = '/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main'
    const srv = await fileServer({ [`${base}/${BONSAI_MODEL_FILE}`]: model })
    const { runs, dataDir, runEvents } = setup({ hfBase: srv.url })
    mkdirSync(join(dataDir, 'models'), { recursive: true })
    writeFileSync(join(dataDir, 'models', `${BONSAI_MODEL_FILE}.part`), model.subarray(0, 10_000))
    const info = await runs.modelDownloadInfo()
    expect(info.files).toEqual([{ name: BONSAI_MODEL_FILE, url: `${srv.url}${base}/${BONSAI_MODEL_FILE}`, size: 50_000, present: 10_000, optional: false }])

    const b = runs.list()[0]
    const updated = await runs.downloadModel(b.id)
    expect(updated.modelPath).toBe(join(dataDir, 'models', BONSAI_MODEL_FILE))
    expect(updated.mmprojPath).toBeNull()
    expect(readFileSync(updated.modelPath!).equals(model)).toBe(true)
    expect(srv.ranges).toContain('bytes=10000-')
    const progress = runEvents().filter((e) => e.type === 'progress')
    expect(progress.at(-1)).toMatchObject({ kind: 'model', id: b.id, state: 'done', received: 50_000, total: 50_000 })
  })

  it('downloads and unpacks a PrismML build on Windows, and refuses elsewhere', async () => {
    const zip = makeZip({ 'llama-server.exe': 'MZ fake', 'ggml-hip.dll': 'dll', 'sub/readme.txt': 'hi' })
    const release = {
      tag_name: 'b6810',
      assets: [{ name: 'llama-prism-b6810-bin-win-vulkan-x64.zip', size: zip.length, browser_download_url: '' }]
    }
    const srv = await listen((req, res) => {
      if (req.url === '/latest') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(release))
      if (req.url === '/vulkan.zip') return void res.writeHead(200, { 'content-length': zip.length }).end(zip)
      res.writeHead(404).end()
    })
    release.assets[0].browser_download_url = `${srv.url}/vulkan.zip`
    const { runs, dataDir, runEvents } = setup({ platform: 'win32', releasesUrl: `${srv.url}/latest` })
    const opts = await runs.runtimeOptions()
    expect(opts.assets).toEqual([{ backend: 'vulkan', name: 'llama-prism-b6810-bin-win-vulkan-x64.zip', size: zip.length, url: `${srv.url}/vulkan.zip` }])
    const b = runs.list()[0]
    await expect(runs.downloadRuntime(b.id, 'cpu')).rejects.toThrow(/no cpu build/)
    const updated = await runs.downloadRuntime(b.id, 'vulkan')
    const exe = join(dataDir, 'runtimes', 'prism-llama', 'b6810', 'llama-server.exe')
    expect(updated.serverPath).toBe(exe)
    expect(readFileSync(exe, 'utf8')).toBe('MZ fake')
    expect(readFileSync(join(dirname(exe), 'sub', 'readme.txt'), 'utf8')).toBe('hi')
    expect(runEvents().filter((e) => e.type === 'progress').at(-1)).toMatchObject({ kind: 'runtime', state: 'done' })

    const { runs: mac } = setup({ platform: 'darwin' })
    await expect(mac.runtimeOptions()).rejects.toThrow(/only supported on Windows/)
    await expect(mac.downloadRuntime(mac.list()[0].id, 'cpu')).rejects.toThrow(/only supported on Windows/)
  })

  it('cancels a download', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const srv = await listen((req, res) => {
      if (req.method === 'HEAD') return void res.writeHead(req.url?.includes('mmproj') ? 404 : 200, { 'content-length': 1_000_000 }).end()
      res.writeHead(200, { 'content-length': 1_000_000 })
      res.write(Buffer.alloc(1000))
      void gate.then(() => res.destroy())
    })
    cleanup.push(() => release())
    const { runs, runEvents } = setup({ hfBase: srv.url })
    const b = runs.list()[0]
    const p = runs.downloadModel(b.id)
    await until(() => runEvents().some((e) => e.type === 'progress' && e.state === 'downloading'))
    runs.cancelDownload(b.id)
    await expect(p).rejects.toThrow('Download cancelled')
    expect(runEvents().filter((e) => e.type === 'progress').at(-1)).toMatchObject({ state: 'cancelled' })
  })
})
