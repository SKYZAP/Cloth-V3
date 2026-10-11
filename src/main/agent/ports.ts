import { spawn } from 'node:child_process'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import type { ContainerPort, ContainerSettings } from '@shared/types'
import type { Ctx } from '../core/context'
import type { ContainerWatcher, DockerRun } from './containers'

/** A running `docker exec -i` whose stdin and stdout carry one connection. */
export interface DockerStream {
  stdin: Writable
  stdout: Readable
  kill(): void
  on(event: 'close', fn: () => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

export type DockerSpawn = (args: string[]) => DockerStream

export function dockerSpawn(bin = 'docker'): DockerSpawn {
  return (args) => spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as DockerStream
}

/** A port listening inside the container and the address to reach it at from inside. */
export interface Listening {
  port: number
  host: string
}

/** /proc/net/tcp addresses are 32-bit words in host (little-endian) byte order. */
function decode(hex: string): string {
  const bytes: number[] = []
  for (let w = 0; w < hex.length; w += 8) for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(hex.slice(w + i, w + i + 2), 16))
  if (bytes.length === 4) return bytes.join('.')
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join('.')
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  // Longest run of zero groups becomes '::'.
  let best = [-1, 0]
  for (let i = 0; i < 8; i++) {
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > best[1]) best = [i, j - i]
    i = j
  }
  if (best[1] < 2) return groups.join(':')
  return `${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`
}

/** Where to connect from inside the container to reach a server bound to these addresses. */
function target(addrs: string[]): string {
  if (addrs.some((a) => a === '0.0.0.0' || a === '::' || a.startsWith('127.'))) return '127.0.0.1'
  if (addrs.includes('::1')) return '::1'
  return addrs[0]
}

/** The listening TCP ports in the text of /proc/net/tcp and /proc/net/tcp6. */
export function parseProcNet(text: string): Listening[] {
  const byPort = new Map<number, string[]>()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4 || !/^\d+:$/.test(f[0]) || f[3] !== '0A') continue
    const [addr, portHex] = f[1].split(':')
    const port = parseInt(portHex, 16)
    if (!port || !addr) continue
    const list = byPort.get(port) ?? []
    list.push(decode(addr))
    byPort.set(port, list)
  }
  return [...byPort].sort((a, b) => a[0] - b[0]).map(([port, addrs]) => ({ port, host: target(addrs) }))
}

export type Forwarder = 'socat' | 'nc' | 'node' | 'python3' | 'python'
const FORWARDERS: Forwarder[] = ['socat', 'nc', 'node', 'python3', 'python']

const NODE_PIPE = "const s=require('net').connect(+process.argv[2],process.argv[1]);process.stdin.pipe(s).pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0))"
// os.read/os.write so it runs on python 2 as well.
const PY_PIPE = [
  'import os,socket,sys,threading',
  's=socket.create_connection((sys.argv[1],int(sys.argv[2])))',
  'def up():',
  ' while 1:',
  '  d=os.read(0,65536)',
  '  if not d: break',
  '  s.sendall(d)',
  ' try: s.shutdown(socket.SHUT_WR)',
  ' except Exception: pass',
  't=threading.Thread(target=up);t.daemon=True;t.start()',
  'while 1:',
  ' d=s.recv(65536)',
  ' if not d: break',
  ' while d: d=d[os.write(1,d):]'
].join('\n')

/** The command (inside the container) that pipes its stdin/stdout to host:port. */
export function forwarderCommand(tool: Forwarder, host: string, port: number): string[] {
  switch (tool) {
    case 'socat':
      return ['socat', '-', host.includes(':') ? `TCP6:[${host}]:${port}` : `TCP:${host}:${port}`]
    case 'nc':
      return ['nc', host, String(port)]
    case 'node':
      return ['node', '-e', NODE_PIPE, host, String(port)]
    default:
      return [tool, '-c', PY_PIPE, host, String(port)]
  }
}

const PROBE = `for t in ${FORWARDERS.join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done`
const INSTALL =
  'if command -v apk >/dev/null 2>&1; then apk add --no-cache socat; ' +
  'elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y socat; ' +
  'elif command -v dnf >/dev/null 2>&1; then dnf install -y socat; ' +
  'elif command -v yum >/dev/null 2>&1; then yum install -y socat; else exit 127; fi'
export const NO_FORWARDER_OFFLINE = "Can't open servers here: the container has no socat, nc, node or python, and it's offline."
export const NO_FORWARDER_INSTALL = "Can't open servers here: the container has no socat, nc, node or python, and installing socat failed."

interface Forward {
  port: number
  host: string
  server: Server | null
  hostPort: number | null
  error?: string
  conns: Set<() => void>
}

interface Watched {
  name: string
  network: boolean
  ports: Map<number, Forward>
  poll: NodeJS.Timeout
  forwarder: Promise<{ tool: Forwarder } | { error: string }> | null
  scanning: Promise<void> | null
  again: boolean
}

/**
 * Servers started inside a chat's container, opened on this PC: Docker Desktop can't route to container
 * addresses, so each listening port gets a listener on the host's 127.0.0.1 that pipes every connection
 * into the container through `docker exec -i`.
 */
export class PortService implements ContainerWatcher {
  private chats = new Map<string, Watched>()

  constructor(
    private ctx: Ctx,
    private docker: DockerRun,
    private spawn: DockerSpawn,
    private pollMs = 10_000
  ) {}

  list(sessionId: string): ContainerPort[] {
    return [...(this.chats.get(sessionId)?.ports.values() ?? [])]
      .sort((a, b) => a.port - b.port)
      .map((f) => ({ port: f.port, hostPort: f.hostPort, url: f.hostPort ? `http://localhost:${f.hostPort}` : null, ...(f.error ? { error: f.error } : {}) }))
  }

  started(sessionId: string, name: string, settings: ContainerSettings): void {
    const c = this.chats.get(sessionId)
    if (c && c.name === name) {
      c.network = settings.network
      return
    }
    if (c) this.stopped(sessionId)
    const poll = setInterval(() => void this.scan(sessionId), this.pollMs)
    poll.unref?.()
    this.chats.set(sessionId, { name, network: settings.network, ports: new Map(), poll, forwarder: null, scanning: null, again: false })
  }

  ran(sessionId: string): void {
    void this.scan(sessionId)
    // A server started in the background usually isn't listening yet when its command returns.
    const t = setTimeout(() => void this.scan(sessionId), 2000)
    t.unref?.()
  }

  busy(sessionId: string): boolean {
    return !!this.chats.get(sessionId)?.ports.size
  }

  stopped(sessionId?: string): void {
    for (const id of sessionId === undefined ? [...this.chats.keys()] : [sessionId]) {
      const c = this.chats.get(id)
      if (!c) continue
      clearInterval(c.poll)
      this.chats.delete(id)
      for (const f of c.ports.values()) this.close(f)
      if (c.ports.size) this.emit(id)
    }
  }

  /** Look for listening ports now (the poll does this too). */
  scan(sessionId: string): Promise<void> {
    const c = this.chats.get(sessionId)
    if (!c) return Promise.resolve()
    if (c.scanning) {
      c.again = true
      return c.scanning
    }
    c.scanning = (async () => {
      do {
        c.again = false
        await this.scanOnce(sessionId, c)
      } while (c.again && this.chats.get(sessionId) === c)
    })().finally(() => (c.scanning = null))
    return c.scanning
  }

  private async scanOnce(sessionId: string, c: Watched): Promise<void> {
    const r = await this.docker(['exec', c.name, 'cat', '/proc/net/tcp', '/proc/net/tcp6'], { timeout: 15 }).catch(() => null)
    if (this.chats.get(sessionId) !== c || !r) return
    // tcp6 is missing when IPv6 is off: cat fails but still prints tcp.
    if (r.code !== 0 && !r.stdout.trim()) {
      if (/not running|no such container/i.test(r.stderr)) this.stopped(sessionId)
      return
    }
    const now = new Map(parseProcNet(r.stdout).map((l) => [l.port, l.host]))
    let changed = false
    for (const [port, f] of c.ports) {
      if (now.has(port)) f.host = now.get(port)!
      else {
        this.close(f)
        c.ports.delete(port)
        changed = true
      }
    }
    const added: Forward[] = []
    for (const [port, host] of now) if (!c.ports.has(port)) added.push({ port, host, server: null, hostPort: null, conns: new Set() })
    if (added.length) {
      for (const f of added) c.ports.set(f.port, f)
      changed = true
      const fw = await (c.forwarder ??= this.findForwarder(c))
      for (const f of added) {
        if (this.chats.get(sessionId) !== c || c.ports.get(f.port) !== f) continue
        if ('error' in fw) f.error = fw.error
        else await this.listen(c, f, fw.tool)
        // Stopped while the listener was opening.
        if (this.chats.get(sessionId) !== c || c.ports.get(f.port) !== f) this.close(f)
      }
    }
    if (changed && this.chats.get(sessionId) === c) this.emit(sessionId)
  }

  /** What the image has to pipe a connection with; socat is installed when nothing is there and the container is online. */
  private async findForwarder(c: Watched): Promise<{ tool: Forwarder } | { error: string }> {
    const look = async () => {
      const r = await this.docker(['exec', c.name, 'sh', '-c', PROBE], { timeout: 15 }).catch(() => null)
      const have = new Set(r?.stdout.split(/\s+/) ?? [])
      return FORWARDERS.find((t) => have.has(t)) ?? null
    }
    const found = await look()
    if (found) return { tool: found }
    if (!c.network) return { error: NO_FORWARDER_OFFLINE }
    await this.docker(['exec', '-u', '0', '-e', 'DEBIAN_FRONTEND=noninteractive', c.name, 'sh', '-c', INSTALL], { timeout: 300 }).catch(() => null)
    const installed = await look()
    return installed ? { tool: installed } : { error: NO_FORWARDER_INSTALL }
  }

  private async listen(c: Watched, f: Forward, tool: Forwarder): Promise<void> {
    const server = createServer({ allowHalfOpen: true }, (sock) => this.pipe(c, f, tool, sock))
    const open = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const failed = (err: Error) => {
          server.off('listening', ok)
          reject(err)
        }
        const ok = () => {
          server.off('error', failed)
          resolve((server.address() as AddressInfo).port)
        }
        server.once('error', failed)
        server.once('listening', ok)
        server.listen({ host: '127.0.0.1', port })
      })
    try {
      try {
        f.hostPort = await open(f.port)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err
        f.hostPort = await open(0)
      }
      f.server = server
    } catch (err) {
      f.error = `Couldn't open a port on this PC: ${(err as Error).message}`
    }
  }

  private pipe(c: Watched, f: Forward, tool: Forwarder, sock: Socket): void {
    const child = this.spawn(['exec', '-i', c.name, ...forwarderCommand(tool, f.host, f.port)])
    let done = false
    const end = () => {
      if (done) return
      done = true
      f.conns.delete(end)
      sock.destroy()
      child.kill()
    }
    f.conns.add(end)
    sock.pipe(child.stdin)
    child.stdout.pipe(sock)
    sock.on('error', end)
    sock.on('close', end)
    child.stdin.on('error', end)
    child.on('error', end)
    child.on('close', () => sock.end())
  }

  private close(f: Forward): void {
    for (const end of [...f.conns]) end()
    f.server?.close()
    f.server = null
  }

  private emit(sessionId: string): void {
    this.ctx.emit('containers', { sessionId, ports: this.list(sessionId) })
  }
}
