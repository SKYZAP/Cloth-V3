import { createServer, type Server } from 'node:http'
import { hostname, homedir, networkInterfaces } from 'node:os'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import type { RemoteDevice, RemoteDirEntry, RemoteHostAddress, RemotePairing, RemoteStatus } from '@shared/types'
import {
  CLIENT_DIR,
  REMOTE_VERSION,
  SERVER_DIR,
  SecureChannel,
  b64url,
  encodePairing,
  fromB64url,
  randomBytes,
  remoteAllowed,
  type ClientFrame,
  type ServerFrame
} from '@shared/remote'
import { errorMessage, newId, type Ctx } from '../core/context'
import { nodeSessionCipher } from './cipher'
import type { SettingsService } from '../core/settings'

/** Runs an API call by path, the same way the desktop window's IPC does. */
export type Dispatch = (path: string, args: unknown[]) => Promise<unknown>

interface StoredDevice {
  id: string
  name: string
  platform: string
  /** Shared key, encrypted with the OS keychain (base64). */
  key: string
  createdAt: number
  lastSeenAt: number | null
  pending: boolean
  expiresAt: number | null
}

interface Client {
  ws: WebSocket
  deviceId: string
  channel: SecureChannel
  /** Latest streaming chat message per id, flushed together (phones don't need every token). */
  pending: Map<string, ServerFrame>
  flushTimer: NodeJS.Timeout | null
  sending: Promise<void>
}

const PAIRING_TTL = 10 * 60_000
const HANDSHAKE_TIMEOUT = 10_000
const COALESCE_MS = 80
const MAX_ENTRIES = 3000

/**
 * The phone app's way in: a WebSocket server on the LAN / Tailscale interfaces. Off until enabled in
 * Settings. Only devices paired through a QR code (which carries their key) can talk to it.
 */
export class RemoteHost {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private error: string | null = null
  private clients = new Set<Client>()
  private dispatch: Dispatch | null = null
  private keepAwake: (on: boolean) => void = () => {}
  /** Restarts run one at a time (settings changes and pairing can both trigger one). */
  private op: Promise<unknown> = Promise.resolve()
  private version = ''

  constructor(
    private ctx: Ctx,
    private settings: SettingsService
  ) {}

  attach(opts: { dispatch: Dispatch; keepAwake?: (on: boolean) => void; version?: string }): void {
    this.dispatch = opts.dispatch
    this.version = opts.version ?? ''
    if (opts.keepAwake) this.keepAwake = opts.keepAwake
  }

  // ─── Devices ────────────────────────────────────────────────────────────────

  private devices(): StoredDevice[] {
    const now = Date.now()
    const all = this.ctx.kv.get<StoredDevice[]>('remoteDevices', [])
    const live = all.filter((d) => !d.pending || (d.expiresAt ?? 0) > now)
    if (live.length !== all.length) this.ctx.kv.set('remoteDevices', live)
    return live
  }

  private saveDevices(list: StoredDevice[]): void {
    this.ctx.kv.set('remoteDevices', list)
    this.emitStatus()
  }

  private deviceKey(d: StoredDevice): Uint8Array {
    return fromB64url(this.ctx.secrets.decrypt(Buffer.from(d.key, 'base64')))
  }

  status(): RemoteStatus {
    const s = this.settings.get()
    const connected = new Set([...this.clients].map((c) => c.deviceId))
    return {
      enabled: s.remoteEnabled,
      running: !!this.server?.listening,
      port: s.remotePort,
      error: this.error,
      hosts: hostAddresses(),
      keepAwake: s.remoteKeepAwake,
      devices: this.devices().map(
        (d): RemoteDevice => ({ id: d.id, name: d.name, platform: d.platform, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, pending: d.pending, connected: connected.has(d.id) })
      )
    }
  }

  private emitStatus(): void {
    this.ctx.emit('remote', this.status())
  }

  /** Creates a pending device and the link its QR code carries. Turns the server on if it's off. */
  async pair(): Promise<RemotePairing> {
    // Enabling triggers a restart through the settings listener; wait for it rather than racing it.
    if (!this.settings.get().remoteEnabled) this.settings.update({ remoteEnabled: true })
    await this.op
    if (!this.server?.listening) await this.restart()
    if (!this.server?.listening) throw new Error(this.error ?? 'The phone connection server is not running')
    const key = randomBytes(32)
    const id = newId('dev_')
    const expiresAt = Date.now() + PAIRING_TTL
    const device: StoredDevice = {
      id,
      name: 'New phone',
      platform: 'unknown',
      key: Buffer.from(this.ctx.secrets.encrypt(b64url(key))).toString('base64'),
      createdAt: Date.now(),
      lastSeenAt: null,
      pending: true,
      expiresAt
    }
    // Only one QR code is live at a time.
    this.saveDevices([...this.devices().filter((d) => !d.pending), device])
    const hosts = hostAddresses()
    const link = encodePairing({ v: REMOTE_VERSION, id, k: b64url(key), port: this.settings.get().remotePort, h: hosts.map((h) => h.address), n: hostname() })
    return { deviceId: id, link, expiresAt, hosts }
  }

  cancelPairing(deviceId: string): RemoteStatus {
    this.saveDevices(this.devices().filter((d) => !(d.id === deviceId && d.pending)))
    return this.status()
  }

  revoke(deviceId: string): RemoteStatus {
    this.saveDevices(this.devices().filter((d) => d.id !== deviceId))
    for (const c of this.clients) if (c.deviceId === deviceId) c.ws.close(4403, 'This phone was unpaired')
    return this.status()
  }

  rename(deviceId: string, name: string): RemoteStatus {
    const clean = name.trim().slice(0, 60)
    if (clean) this.saveDevices(this.devices().map((d) => (d.id === deviceId ? { ...d, name: clean } : d)))
    return this.status()
  }

  // ─── Phone-side helpers ─────────────────────────────────────────────────────

  async roots(): Promise<RemoteDirEntry[]> {
    const out: RemoteDirEntry[] = [{ name: 'Home', path: homedir(), dir: true }]
    if (process.platform === 'win32') {
      for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${l}:\\`)) out.push({ name: `${l}:`, path: `${l}:\\`, dir: true })
    } else out.push({ name: '/', path: '/', dir: true })
    return out
  }

  async listDir(path: string): Promise<{ path: string; parent: string | null; entries: RemoteDirEntry[] }> {
    const info = await stat(path)
    if (!info.isDirectory()) throw new Error('Not a folder')
    const dirents = await readdir(path, { withFileTypes: true })
    const entries: RemoteDirEntry[] = []
    for (const d of dirents.slice(0, MAX_ENTRIES)) {
      const full = join(path, d.name)
      const dir = d.isDirectory() || (d.isSymbolicLink() && (await stat(full).then((s) => s.isDirectory()).catch(() => false)))
      entries.push({ name: d.name, path: full, dir })
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    const parent = parse(path).root === path ? null : dirname(path)
    return { path, parent, entries }
  }

  async imageData(file: { file: string; mime: string } | null): Promise<{ mime: string; data: string } | null> {
    if (!file) return null
    return { mime: file.mime, data: (await readFile(file.file)).toString('base64') }
  }

  // ─── Server ─────────────────────────────────────────────────────────────────

  restart(): Promise<RemoteStatus> {
    const next = this.op.then(async () => {
      await this.shutdown()
      const s = this.settings.get()
      if (s.remoteEnabled) await this.start(s.remotePort)
      return this.status()
    })
    this.op = next.catch(() => undefined)
    return next
  }

  stop(): Promise<void> {
    const next = this.op.then(() => this.shutdown())
    this.op = next.catch(() => undefined)
    return next
  }

  private async shutdown(): Promise<void> {
    for (const c of this.clients) c.ws.close(1001, 'Cloth is shutting down')
    this.clients.clear()
    this.keepAwake(false)
    const wss = this.wss
    const srv = this.server
    this.wss = null
    this.server = null
    wss?.close()
    if (srv) await new Promise<void>((r) => srv.close(() => r()))
    this.emitStatus()
  }

  private async start(port: number): Promise<void> {
    this.error = null
    const srv = createServer((req, res) => {
      if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'cloth', v: REMOTE_VERSION }))
      res.writeHead(404).end('Not found')
    })
    const wss = new WebSocketServer({ server: srv, path: '/remote', maxPayload: 64 * 1024 * 1024 })
    wss.on('error', () => undefined) // listen errors surface through srv below
    wss.on('connection', (ws, req) => this.accept(ws, new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''))
    await new Promise<void>((resolve) => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : errorMessage(err)
        this.server = null
        resolve()
      })
      srv.listen(port, '0.0.0.0', () => {
        this.server = srv
        this.wss = wss
        resolve()
      })
    })
    if (!this.server) wss.close()
    this.emitStatus()
  }

  private accept(ws: WebSocket, deviceId: string): void {
    const device = this.devices().find((d) => d.id === deviceId)
    if (!device) return void ws.close(4401, 'This phone is not paired with this PC')
    const challenge = randomBytes(16)
    let channel: SecureChannel | null = null
    let client: Client | null = null
    const timeout = setTimeout(() => !client && ws.close(4408, 'Handshake timed out'), HANDSHAKE_TIMEOUT)
    ws.send(JSON.stringify({ t: 'challenge', s: b64url(challenge), v: REMOTE_VERSION }))

    // Frames are handled strictly one after another: the hello's key derivation is async, and the
    // phone sends its auth frame right behind it.
    let queue: Promise<void> = Promise.resolve()
    ws.on('message', (data: RawData, isBinary: boolean) => {
      queue = queue.then(async () => {
        try {
          if (!channel) {
            // Step 1: the phone's nonce (plain text). Both sides derive the session key from it.
            if (isBinary) throw new Error('Expected hello')
            const hello = JSON.parse(data.toString()) as { t: string; c?: string }
            if (hello.t !== 'hello' || typeof hello.c !== 'string') throw new Error('Expected hello')
            channel = new SecureChannel(nodeSessionCipher(this.deviceKey(device), challenge, fromB64url(hello.c)), SERVER_DIR, CLIENT_DIR)
            return
          }
          if (!isBinary) throw new Error('Expected an encrypted frame')
          const frame = await channel.open<ClientFrame>(toBytes(data))
          if (!client) {
            // Step 2: the first encrypted frame proves the phone holds the key.
            if (frame.t !== 'auth') throw new Error('Expected auth')
            clearTimeout(timeout)
            client = { ws, deviceId, channel, pending: new Map(), flushTimer: null, sending: Promise.resolve() }
            this.clients.add(client)
            this.touch(deviceId, frame)
            this.send(client, { t: 'ready', desktop: hostname(), version: this.appVersion(), platform: process.platform, deviceId })
            this.keepAwake(this.settings.get().remoteKeepAwake && this.clients.size > 0)
            this.ctx.log('remote', `phone connected: ${frame.name}`)
            this.emitStatus()
            return
          }
          if (frame.t === 'ping') return this.send(client, { t: 'pong' })
          if (frame.t === 'call') void this.call(client, frame)
        } catch (err) {
          // Any failure before or during the session: drop the connection without detail.
          this.ctx.log('remote', `rejected frame from ${deviceId}: ${errorMessage(err)}`)
          ws.close(client ? 4400 : 4401, client ? 'Bad frame' : 'Authentication failed')
        }
      })
    })
    ws.on('close', () => {
      clearTimeout(timeout)
      if (!client) return
      if (client.flushTimer) clearTimeout(client.flushTimer)
      this.clients.delete(client)
      this.touch(deviceId)
      this.keepAwake(this.settings.get().remoteKeepAwake && this.clients.size > 0)
      this.emitStatus()
    })
    ws.on('error', () => ws.terminate())
  }

  private appVersion(): string {
    return this.version
  }

  private touch(deviceId: string, auth?: { name: string; platform: string }): void {
    const list = this.devices()
    const d = list.find((x) => x.id === deviceId)
    if (!d) return
    d.lastSeenAt = Date.now()
    if (auth) {
      if (d.pending) d.name = auth.name.slice(0, 60) || 'Phone'
      d.platform = auth.platform
      d.pending = false
      d.expiresAt = null
    }
    this.ctx.kv.set('remoteDevices', list)
  }

  private async call(client: Client, frame: Extract<ClientFrame, { t: 'call' }>): Promise<void> {
    const path = String(frame.path)
    let reply: ServerFrame
    try {
      if (!remoteAllowed(path)) throw new Error(`${path} is only available on the desktop`)
      if (!this.dispatch) throw new Error('Cloth is still starting')
      reply = { t: 'result', id: frame.id, ok: true, value: await this.dispatch(path, Array.isArray(frame.args) ? frame.args : []) }
    } catch (err) {
      reply = { t: 'result', id: frame.id, ok: false, error: errorMessage(err) }
    }
    // Events emitted while the call ran must reach the phone before its result.
    this.flush(client)
    this.send(client, reply)
  }

  /** Forwards a desktop event to every connected phone. Streaming chat updates are coalesced. */
  broadcast(channel: string, payload: unknown): void {
    if (!this.clients.size) return
    const frame: ServerFrame = { t: 'event', channel, payload }
    const p = payload as { type?: string; message?: { id?: string } }
    const coalesce = channel === 'chat' && p?.type === 'message' && typeof p.message?.id === 'string'
    for (const c of this.clients) {
      if (coalesce) {
        c.pending.set(p.message!.id!, frame)
        if (!c.flushTimer) c.flushTimer = setTimeout(() => this.flush(c), COALESCE_MS)
      } else {
        this.flush(c)
        this.send(c, frame)
      }
    }
  }

  private flush(c: Client): void {
    if (c.flushTimer) clearTimeout(c.flushTimer)
    c.flushTimer = null
    const frames = [...c.pending.values()]
    c.pending.clear()
    for (const f of frames) this.send(c, f)
  }

  private send(c: Client, frame: ServerFrame): void {
    let sealed: Promise<Uint8Array>
    try {
      sealed = c.channel.seal(frame)
    } catch (err) {
      // Couldn't serialise (too large for one string, or not JSON): nothing was spent, so the stream is
      // intact. A call still gets an answer; an event is dropped.
      this.ctx.log('remote', `can't send ${frame.t}: ${errorMessage(err)}`)
      if (frame.t === 'result') this.send(c, { t: 'result', id: frame.id, ok: false, error: `The reply could not be sent to the phone: ${errorMessage(err)}` })
      return
    }
    c.sending = c.sending.then(async () => {
      try {
        const bytes = await sealed
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(bytes)
      } catch (err) {
        // A frame number was spent without a frame, so the phone would refuse everything after it.
        // Drop the link; the phone reconnects with a fresh session.
        this.ctx.log('remote', `send failed: ${errorMessage(err)}`)
        c.ws.close(1011, 'Encryption failed')
      }
    })
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/** IPv4 addresses a phone could reach, best first: Wi-Fi/Ethernet, then Tailscale, then the rest. */
export function hostAddresses(): RemoteHostAddress[] {
  const out: RemoteHostAddress[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      const [o1, o2] = a.address.split('.').map(Number)
      const tailscale = /tailscale/i.test(name) || (o1 === 100 && o2 >= 64 && o2 <= 127)
      const virtual = /vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|br-|veth|utun|zerotier/i.test(name)
      const privateLan = o1 === 10 || (o1 === 192 && o2 === 168) || (o1 === 172 && o2 >= 16 && o2 <= 31)
      if (tailscale) out.push({ address: a.address, label: 'Tailscale', kind: 'tailscale' })
      else if (privateLan && !virtual) out.push({ address: a.address, label: /wi-?fi|wlan|wireless|en0/i.test(name) ? 'Wi-Fi' : name, kind: 'lan' })
      else out.push({ address: a.address, label: name, kind: 'other' })
    }
  }
  const rank = { lan: 0, tailscale: 1, other: 2 }
  return out.sort((a, b) => rank[a.kind] - rank[b.kind])
}
