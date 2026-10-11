import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Ctx } from '../src/main/core/context'
import { ContainerService, type DockerRun } from '../src/main/agent/containers'
import { NO_FORWARDER_INSTALL, NO_FORWARDER_OFFLINE, PortService, parseProcNet, type DockerSpawn } from '../src/main/agent/ports'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, '0')
const row = (addr: string, port: number, state = '0A') => `   0: ${addr}:${hex(port)} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0`
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const proc = (...ports: number[]) => [HEADER, ...ports.map((p) => row('00000000', p))].join('\n') + '\n'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

function makeCtx() {
  const events: { channel: string; payload: unknown }[] = []
  const ctx = { dataDir: mkdtempSync(join(tmpdir(), 'cloth-ports-')), emit: (channel: string, payload: unknown) => events.push({ channel, payload }), log: () => undefined } as unknown as Ctx
  return { ctx, events }
}

/** The docker CLI as port forwarding sees it: listening ports, which forwarders the image has, and whether installing one works. */
function fakeDocker() {
  const state = { proc: proc(), tools: ['socat'] as string[], installWorks: true, created: false, running: false }
  const calls: string[][] = []
  const run: DockerRun = async (args) => {
    calls.push(args)
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    switch (args[0]) {
      case 'version':
        return ok('27.1.1\n')
      case 'inspect':
        return state.created ? ok(`${state.running}\n`) : { code: 1, stdout: '', stderr: 'No such object' }
      case 'run':
      case 'start':
        state.created = state.running = true
        return ok('abc\n')
      case 'stop':
        state.running = false
        return ok()
      case 'rm':
        state.created = state.running = false
        return ok()
      case 'exec':
        if (args.includes('/proc/net/tcp')) return state.running ? ok(state.proc) : { code: 1, stdout: '', stderr: 'container abc is not running' }
        if (args[1] === '-u') {
          if (!state.installWorks) return { code: 100, stdout: '', stderr: 'E: Unable to locate package socat' }
          state.tools = ['socat']
          return ok()
        }
        if (args.at(-1)!.startsWith('for t in')) return ok(state.tools.map((t) => `${t}\n`).join(''))
        return ok()
      default:
        return ok()
    }
  }
  return { run, calls, state }
}

async function echoServer(): Promise<Server> {
  const server = createServer((s) => s.pipe(s))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(() => new Promise((r) => server.close(r)))
  return server
}
const portOf = (s: Server) => (s.address() as AddressInfo).port

/** Stands in for `docker exec -i`: every "forwarder" connects to `to` on this PC. */
function fakeSpawn(to: () => number) {
  const spawned: string[][] = []
  const spawn: DockerSpawn = (args) => {
    spawned.push(args)
    const sock = connect(to(), '127.0.0.1')
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdin.pipe(sock)
    sock.pipe(stdout)
    const ee = new EventEmitter()
    sock.on('close', () => ee.emit('close'))
    sock.on('error', () => undefined)
    return { stdin, stdout, kill: () => sock.destroy(), on: (e: string, fn: (...a: any[]) => void) => ee.on(e, fn) }
  }
  return { spawn, spawned }
}

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = portOf(s)
  await new Promise((r) => s.close(r))
  return port
}

/** Send `text` through localhost:port and read back what comes out. */
function roundTrip(port: number, text: string, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host)
    let got = ''
    sock.on('data', (d) => {
      got += d.toString()
      if (got.length >= text.length) sock.end()
    })
    sock.on('close', () => resolve(got))
    sock.on('error', reject)
    sock.write(text)
  })
}

function refused(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, host)
    sock.on('connect', () => (sock.destroy(), resolve(false)))
    sock.on('error', () => resolve(true))
  })
}

function service(opts: { network?: boolean } = {}) {
  const { ctx, events } = makeCtx()
  const docker = fakeDocker()
  docker.state.running = docker.state.created = true
  let target = 0
  const sp = fakeSpawn(() => target)
  const ports = new PortService(ctx, docker.run, sp.spawn, 1e9)
  cleanup.push(() => ports.stopped())
  ports.started('s1', 'cloth-s1', { image: 'node:22', network: opts.network ?? false })
  return { ports, docker, events, spawned: sp.spawned, setTarget: (p: number) => (target = p) }
}

describe('parseProcNet', () => {
  it('keeps listening sockets, dedupes ports and picks where to connect inside the container', () => {
    const text = [
      HEADER,
      row('00000000', 8000),
      row('0100007F', 5173),
      row('0100007F', 8000, '01'), // an established connection, not a listener
      row('0200A8C0', 3000),
      HEADER,
      row('00000000000000000000000000000000', 8000),
      row('00000000000000000000000001000000', 3001),
      row('0000000000000000FFFF00000100007F', 3002),
      row('000080FE000000000000000001000000', 3003),
      row('00000000000000000000000001000000', 4000, '06')
    ].join('\n')
    expect(parseProcNet(text)).toEqual([
      { port: 3000, host: '192.168.0.2' },
      { port: 3001, host: '::1' },
      { port: 3002, host: '127.0.0.1' },
      { port: 3003, host: 'fe80::1' },
      { port: 5173, host: '127.0.0.1' },
      { port: 8000, host: '127.0.0.1' }
    ])
    // Bound to both loopbacks: IPv4 wins.
    expect(parseProcNet([row('00000000000000000000000001000000', 9000), row('0100007F', 9000)].join('\n'))).toEqual([{ port: 9000, host: '127.0.0.1' }])
    expect(parseProcNet('')).toEqual([])
  })
})

describe('port forwarding', () => {
  it('opens each listening port on 127.0.0.1, same number first, and pipes connections into the container', async () => {
    const echo = await echoServer()
    const { ports, events, spawned, setTarget, docker } = service()
    setTarget(portOf(echo))
    const free = await freePort()
    // The echo server holds its own port number on this PC: that one falls back to another port.
    docker.state.proc = proc(free, portOf(echo))
    await ports.scan('s1')

    const list = ports.list('s1')
    const same = list.find((p) => p.port === free)!
    const moved = list.find((p) => p.port === portOf(echo))!
    expect(same).toEqual({ port: free, hostPort: free, url: `http://localhost:${free}` })
    expect(moved.hostPort).not.toBe(portOf(echo))
    expect(moved.url).toBe(`http://localhost:${moved.hostPort}`)
    expect(events.at(-1)).toEqual({ channel: 'containers', payload: { sessionId: 's1', ports: list } })

    expect(await roundTrip(free, 'hello through the container')).toBe('hello through the container')
    expect(await roundTrip(moved.hostPort!, 'second')).toBe('second')
    expect(spawned[0]).toEqual(['exec', '-i', 'cloth-s1', 'socat', '-', `TCP:127.0.0.1:${free}`])

    // Not reachable from other machines.
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)
    if (lan) expect(await refused(free, lan.address)).toBe(true)

    // The server stopped listening: its port on this PC closes.
    docker.state.proc = proc(portOf(echo))
    await ports.scan('s1')
    expect(ports.list('s1').map((p) => p.port)).toEqual([portOf(echo)])
    expect(await refused(free)).toBe(true)
  })

  it('uses the first forwarder the image has, and explains when there is none', async () => {
    const echo = await echoServer()
    const a = service()
    a.setTarget(portOf(echo))
    a.docker.state.tools = ['node', 'python3']
    const p1 = await freePort()
    a.docker.state.proc = proc(p1)
    await a.ports.scan('s1')
    expect(await roundTrip(p1, 'x')).toBe('x')
    expect(a.spawned[0].slice(3, 5)).toEqual(['node', '-e'])
    expect(a.spawned[0].slice(-2)).toEqual(['127.0.0.1', String(p1)])

    const b = service()
    b.docker.state.tools = ['python3', 'python']
    b.docker.state.proc = proc(await freePort())
    await b.ports.scan('s1')
    b.setTarget(portOf(echo))
    await roundTrip(b.ports.list('s1')[0].hostPort!, 'y')
    expect(b.spawned[0].slice(3, 5)).toEqual(['python3', '-c'])

    // Offline with nothing to forward with: an error, no install.
    const c = service({ network: false })
    c.docker.state.tools = []
    c.docker.state.proc = proc(4321)
    await c.ports.scan('s1')
    expect(c.ports.list('s1')).toEqual([{ port: 4321, hostPort: null, url: null, error: NO_FORWARDER_OFFLINE }])
    expect(c.docker.calls.some((x) => x[1] === '-u')).toBe(false)
    // The probe is cached.
    c.docker.state.proc = proc(4321, 4322)
    await c.ports.scan('s1')
    expect(c.docker.calls.filter((x) => x.at(-1)!.startsWith('for t in'))).toHaveLength(1)
  })

  it('installs socat when the image has no forwarder and the container is online', async () => {
    const echo = await echoServer()
    const d = service({ network: true })
    d.setTarget(portOf(echo))
    d.docker.state.tools = []
    const p = await freePort()
    d.docker.state.proc = proc(p)
    await d.ports.scan('s1')
    const install = d.docker.calls.find((x) => x[1] === '-u')!
    expect(install.slice(0, 3)).toEqual(['exec', '-u', '0'])
    expect(install.at(-1)).toContain('apk add --no-cache socat')
    expect(install.at(-1)).toContain('apt-get update && apt-get install -y socat')
    expect(install.at(-1)).toContain('dnf install -y socat')
    expect(d.ports.list('s1')[0].hostPort).toBe(p)
    expect(await roundTrip(p, 'z')).toBe('z')
    expect(d.spawned[0][3]).toBe('socat')

    const e = service({ network: true })
    e.docker.state.tools = []
    e.docker.state.installWorks = false
    e.docker.state.proc = proc(4321)
    await e.ports.scan('s1')
    expect(e.ports.list('s1')[0].error).toBe(NO_FORWARDER_INSTALL)
  })
})

describe('port forwarding and the container', () => {
  async function setup(idleMs = 1e9) {
    const { ctx, events } = makeCtx()
    const docker = fakeDocker()
    const echo = await echoServer()
    const sp = fakeSpawn(() => portOf(echo))
    const containers = new ContainerService(ctx, docker.run, idleMs)
    const ports = new PortService(ctx, docker.run, sp.spawn, 1e9)
    containers.watcher = ports
    cleanup.push(() => containers.stopAll())
    const settings = { image: 'node:22', network: false }
    return { containers, ports, docker, events, settings }
  }

  it('looks for servers after each command and closes them with the container', async () => {
    const { containers, ports, docker, settings } = await setup()
    const p = await freePort()
    docker.state.proc = proc(p)
    await containers.exec('s1', settings, 'npm run dev &', '', { onData: () => undefined })
    for (let i = 0; i < 50 && !ports.list('s1').length; i++) await wait(10)
    expect(ports.list('s1')[0].hostPort).toBe(p)

    await containers.reset('s1')
    expect(ports.list('s1')).toEqual([])
    expect(await refused(p)).toBe(true)

    await containers.ensureRunning('s1', settings)
    await ports.scan('s1')
    expect(ports.list('s1')).toHaveLength(1)
    await containers.remove('s1')
    expect(ports.list('s1')).toEqual([])
    expect(await refused(p)).toBe(true)

    await containers.ensureRunning('s1', settings)
    await ports.scan('s1')
    await containers.stopAll()
    expect(ports.list('s1')).toEqual([])
    expect(await refused(p)).toBe(true)
  })

  it('keeps the container running while it serves something', async () => {
    const { containers, ports, docker, settings } = await setup(40)
    const stops = () => docker.calls.filter((a) => a[0] === 'stop')
    docker.state.proc = proc(await freePort())
    await containers.ensureRunning('s1', settings)
    await ports.scan('s1')
    expect(ports.busy('s1')).toBe(true)
    await wait(150)
    expect(stops()).toHaveLength(0)

    docker.state.proc = proc()
    await ports.scan('s1')
    await wait(150)
    expect(stops()).toHaveLength(1)
    // Stopped: no more polling for it.
    expect(ports.list('s1')).toEqual([])
    await ports.scan('s1')
    expect(docker.calls.filter((a) => a.includes('/proc/net/tcp')).length).toBe(2)
  })

  it('stops watching when the container is no longer running', async () => {
    const { containers, ports, docker, settings, events } = await setup()
    docker.state.proc = proc(await freePort())
    await containers.ensureRunning('s1', settings)
    await ports.scan('s1')
    docker.state.running = false
    await ports.scan('s1')
    expect(ports.list('s1')).toEqual([])
    expect(events.at(-1)).toEqual({ channel: 'containers', payload: { sessionId: 's1', ports: [] } })
  })
})
