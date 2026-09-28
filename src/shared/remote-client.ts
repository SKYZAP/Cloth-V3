import {
  CLIENT_DIR,
  SERVER_DIR,
  SecureChannel,
  b64url,
  fromB64url,
  randomBytes,
  sessionKey,
  type ClientFrame,
  type PairingPayload,
  type ServerFrame
} from './remote'

export type RemoteState = 'connecting' | 'online' | 'offline' | 'unpaired'

export interface RemoteInfo {
  host: string | null
  desktop: string | null
  platform: string | null
  version: string | null
  error: string | null
  /** True when this 'online' follows a drop, so screens should reload what they show. */
  reconnected: boolean
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void }

const ATTEMPT_TIMEOUT = 6000
const PING_EVERY = 15_000
const PONG_TIMEOUT = 10_000
const QUEUE_WAIT = 25_000

/**
 * The phone's end of the Cloth remote protocol: finds the desktop on any of the paired addresses,
 * authenticates, then carries API calls and events. Reconnects on its own with backoff.
 */
export class RemoteClient {
  state: RemoteState = 'offline'
  info: RemoteInfo = { host: null, desktop: null, platform: null, version: null, error: null, reconnected: false }
  private ws: WebSocket | null = null
  private channel: SecureChannel | null = null
  private seq = 0
  private calls = new Map<number, Pending>()
  private waiting: (() => void)[] = []
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private everOnline = false
  private closed = false
  private sending: Promise<void> = Promise.resolve()

  constructor(
    private pairing: PairingPayload,
    private opts: {
      name: string
      platform: string
      appVersion?: string
      /** Address that worked last time — tried alongside the others. */
      preferHost?: string | null
      onEvent(channel: string, payload: unknown): void
      onState(state: RemoteState, info: RemoteInfo): void
      WebSocketImpl?: typeof WebSocket
    }
  ) {}

  connect(): void {
    this.closed = false
    if (this.state === 'connecting' || this.state === 'online') return
    void this.attempt()
  }

  /** Try again now (e.g. the app came back to the foreground). */
  nudge(): void {
    if (this.closed || this.state === 'online' || this.state === 'unpaired') return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retry = 0
    if (this.state !== 'connecting') void this.attempt()
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.stopHeartbeat()
    this.ws?.close(1000)
    this.ws = null
    this.failCalls('Disconnected')
    this.setState('offline')
  }

  async call(path: string, args: unknown[]): Promise<unknown> {
    if (this.state !== 'online') await this.waitOnline()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject })
      this.send({ t: 'call', id, path, args })
    })
  }

  private waitOnline(): Promise<void> {
    if (this.state === 'unpaired') return Promise.reject(new Error('This phone is no longer paired with your PC'))
    this.nudge()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== done)
        reject(new Error("Can't reach your PC — is Cloth running and on the same network?"))
      }, QUEUE_WAIT)
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      this.waiting.push(done)
    })
  }

  private setState(state: RemoteState, patch: Partial<RemoteInfo> = {}): void {
    this.state = state
    this.info = { ...this.info, ...patch }
    this.opts.onState(state, this.info)
    if (state === 'online') {
      const w = this.waiting
      this.waiting = []
      w.forEach((f) => f())
    }
  }

  private async attempt(): Promise<void> {
    this.setState('connecting', { error: null })
    const hosts = [...new Set([this.opts.preferHost, ...this.pairing.h].filter((h): h is string => !!h))]
    const tries = hosts.map((h) => this.open(h))
    // First address to finish the handshake wins; the rest are closed.
    let winner: { host: string; ws: WebSocket; channel: SecureChannel; ready: Extract<ServerFrame, { t: 'ready' }> } | null = null
    let lastError = 'No addresses to try'
    let unpaired = false
    await new Promise<void>((resolve) => {
      let left = tries.length
      if (!left) resolve()
      for (const t of tries)
        t.then(
          (ok) => {
            if (winner) ok.ws.close(1000)
            else {
              winner = ok
              resolve()
            }
          },
          (err: Error & { unpaired?: boolean }) => {
            lastError = err.message
            if (err.unpaired) unpaired = true
          }
        ).finally(() => --left === 0 && resolve())
    })
    if (this.closed) {
      ;(winner as { ws: WebSocket } | null)?.ws.close(1000)
      return
    }
    if (!winner) {
      if (unpaired) return this.setState('unpaired', { error: lastError })
      this.setState('offline', { error: lastError })
      return this.scheduleRetry()
    }
    const w = winner as { host: string; ws: WebSocket; channel: SecureChannel; ready: Extract<ServerFrame, { t: 'ready' }> }
    this.ws = w.ws
    this.channel = w.channel
    this.retry = 0
    w.ws.onmessage = (e) => void this.receive(w.ws, e.data)
    w.ws.onclose = (e) => this.dropped(w.ws, e.code, e.reason)
    w.ws.onerror = () => undefined
    this.startHeartbeat()
    const reconnected = this.everOnline
    this.everOnline = true
    this.setState('online', { host: w.host, desktop: w.ready.desktop, platform: w.ready.platform, version: w.ready.version, error: null, reconnected })
  }

  private open(host: string): Promise<{ host: string; ws: WebSocket; channel: SecureChannel; ready: Extract<ServerFrame, { t: 'ready' }> }> {
    const WS = this.opts.WebSocketImpl ?? WebSocket
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WS(`ws://${host.includes(':') ? `[${host}]` : host}:${this.pairing.port}/remote?id=${encodeURIComponent(this.pairing.id)}`)
      } catch (err) {
        return reject(err instanceof Error ? err : new Error(String(err)))
      }
      ws.binaryType = 'arraybuffer'
      let channel: SecureChannel | null = null
      let settled = false
      const fail = (msg: string, unpaired = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          /* already closed */
        }
        reject(Object.assign(new Error(msg), { unpaired }))
      }
      const timer = setTimeout(() => fail(`No answer from ${host}`), ATTEMPT_TIMEOUT)
      ws.onerror = () => fail(`Couldn't reach ${host}`)
      ws.onclose = (e) => fail(e.code === 4401 || e.code === 4403 ? e.reason || 'This phone is not paired with this PC' : `Couldn't reach ${host}`, e.code === 4401 || e.code === 4403)
      ws.onmessage = async (e) => {
        try {
          if (!channel) {
            const hello = JSON.parse(String(e.data)) as { t: string; s: string }
            if (hello.t !== 'challenge') throw new Error('Unexpected greeting')
            const nonce = randomBytes(16)
            channel = new SecureChannel(await sessionKey(fromB64url(this.pairing.k), fromB64url(hello.s), nonce), CLIENT_DIR, SERVER_DIR)
            ws.send(JSON.stringify({ t: 'hello', c: b64url(nonce) }))
            ws.send(await channel.seal({ t: 'auth', name: this.opts.name, platform: this.opts.platform, appVersion: this.opts.appVersion } satisfies ClientFrame))
            return
          }
          const frame = await channel.open<ServerFrame>(new Uint8Array(e.data as ArrayBuffer))
          if (frame.t !== 'ready') throw new Error('Unexpected frame')
          settled = true
          clearTimeout(timer)
          ws.onmessage = null
          ws.onclose = null
          ws.onerror = null
          resolve({ host, ws, channel, ready: frame })
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err))
        }
      }
    })
  }

  private async receive(ws: WebSocket, data: unknown): Promise<void> {
    if (ws !== this.ws || !this.channel) return
    let frame: ServerFrame
    try {
      frame = await this.channel.open<ServerFrame>(new Uint8Array(data as ArrayBuffer))
    } catch {
      ws.close(4400)
      return
    }
    if (frame.t === 'pong') {
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = null
    } else if (frame.t === 'result') {
      const p = this.calls.get(frame.id)
      this.calls.delete(frame.id)
      if (p) frame.ok ? p.resolve(frame.value) : p.reject(new Error(frame.error ?? 'Unknown error'))
    } else if (frame.t === 'event') this.opts.onEvent(frame.channel, frame.payload)
  }

  private send(frame: ClientFrame): void {
    const ws = this.ws
    const channel = this.channel
    if (!ws || !channel) return
    const sealed = channel.seal(frame)
    this.sending = this.sending.then(async () => {
      try {
        const bytes = await sealed
        if (ws.readyState === ws.OPEN) ws.send(bytes)
      } catch {
        /* the socket is going away; dropped() handles it */
      }
    })
  }

  private dropped(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return
    this.ws = null
    this.channel = null
    this.stopHeartbeat()
    this.failCalls('Lost the connection to your PC')
    if (this.closed) return
    if (code === 4403 || code === 4401) return this.setState('unpaired', { error: reason || 'This phone was unpaired' })
    this.setState('offline', { error: code === 1001 ? 'Cloth closed on your PC' : 'Connection lost' })
    this.scheduleRetry()
  }

  private failCalls(msg: string): void {
    const calls = [...this.calls.values()]
    this.calls.clear()
    calls.forEach((c) => c.reject(new Error(msg)))
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return
    const delay = Math.min(15_000, 1000 * 2 ** this.retry++)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.closed && this.state !== 'online' && this.state !== 'connecting') void this.attempt()
    }, delay)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      if (this.pongTimer) return
      this.send({ t: 'ping' })
      // A silent socket (Wi-Fi gone, laptop asleep) never closes on its own.
      this.pongTimer = setTimeout(() => {
        const ws = this.ws
        if (!ws) return
        ws.close(4000, 'Heartbeat timeout')
        this.dropped(ws, 4000, 'Heartbeat timeout')
      }, PONG_TIMEOUT)
    }, PING_EVERY)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }
}
