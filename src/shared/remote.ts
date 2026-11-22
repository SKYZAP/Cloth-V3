/**
 * Cloth remote protocol — how the phone app talks to the desktop.
 *
 * Transport is a plain WebSocket (home Wi-Fi or Tailscale); privacy and integrity come from this layer:
 * each paired device holds a 32-byte key shared once through the pairing QR code. Every connection
 * derives a fresh session key (HKDF over a server challenge + client nonce), and every frame is
 * AES-256-GCM with a per-direction counter as the IV, so frames can't be read, forged or replayed.
 *
 * Runs on Web Crypto only, so the same code works in Electron's main process and in the phone's WebView.
 */

export const REMOTE_VERSION = 1
export const DEFAULT_REMOTE_PORT = 7812

/** What the pairing QR code carries (as a cloth://pair?d=<base64url json> link). */
export interface PairingPayload {
  v: number
  /** Device id the desktop created for this phone. */
  id: string
  /** Shared key, base64url (32 bytes). */
  k: string
  port: number
  /** Addresses to try, best first (LAN, Tailscale). */
  h: string[]
  /** Desktop's name, shown on the phone. */
  n: string
}

/** Client → server after authenticating. */
export type ClientFrame =
  | { t: 'auth'; name: string; platform: string; appVersion?: string }
  | { t: 'call'; id: number; path: string; args: unknown[] }
  | { t: 'ping' }

/** Server → client. */
export type ServerFrame =
  | { t: 'ready'; desktop: string; version: string; platform: string; deviceId: string }
  | { t: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'event'; channel: string; payload: unknown }
  | { t: 'pong' }

export const CLIENT_DIR = 1
export const SERVER_DIR = 2

const te = new TextEncoder()
const td = new TextDecoder()

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

export function encodePairing(p: PairingPayload): string {
  return `cloth://pair?d=${b64url(te.encode(JSON.stringify(p)))}`
}

/** Accepts the full link or just the code after d=. */
export function decodePairing(text: string): PairingPayload {
  const raw = text.trim()
  const m = /[?&]d=([A-Za-z0-9_-]+)/.exec(raw)
  const code = m ? m[1] : raw
  let p: PairingPayload
  try {
    p = JSON.parse(td.decode(fromB64url(code))) as PairingPayload
  } catch {
    throw new Error("That isn't a Cloth pairing code")
  }
  if (!p || typeof p.id !== 'string' || typeof p.k !== 'string' || !Array.isArray(p.h) || typeof p.port !== 'number') throw new Error("That isn't a Cloth pairing code")
  if (p.v > REMOTE_VERSION) throw new Error('This pairing code is from a newer Cloth — update the app')
  return p
}

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

/** HKDF info string for the per-connection key. */
export const SESSION_INFO = 'cloth-remote-v1'

/** HKDF salt for the per-connection key: challenge ‖ clientNonce. */
export function sessionSalt(challenge: Uint8Array, clientNonce: Uint8Array): Uint8Array {
  const salt = new Uint8Array(challenge.length + clientNonce.length)
  salt.set(challenge)
  salt.set(clientNonce, challenge.length)
  return salt
}

/** Per-connection AES-GCM key: HKDF-SHA256(deviceKey, salt = challenge ‖ clientNonce). */
export async function sessionKey(deviceKey: Uint8Array, challenge: Uint8Array, clientNonce: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', buf(deviceKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(sessionSalt(challenge, clientNonce)), info: buf(te.encode(SESSION_INFO)) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/**
 * AES-256-GCM under the session key. Output (and decrypt input) is ciphertext ‖ 16-byte tag, the
 * Web Crypto layout. The phone uses Web Crypto; the desktop uses node:crypto (see main/remote/cipher.ts),
 * because Web Crypto jobs in Electron's main process can abort the whole app.
 */
export interface SessionCipher {
  encrypt(iv: Uint8Array, plain: Uint8Array): Promise<Uint8Array>
  decrypt(iv: Uint8Array, sealed: Uint8Array): Promise<Uint8Array>
}

export function webCryptoCipher(key: CryptoKey): SessionCipher {
  return {
    encrypt: async (iv, plain) => new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(plain))),
    decrypt: async (iv, sealed) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(sealed)))
  }
}

function iv(dir: number, counter: number): Uint8Array {
  const out = new Uint8Array(12)
  out[0] = dir
  new DataView(out.buffer).setBigUint64(4, BigInt(counter))
  return out
}

/**
 * One direction-aware end of an encrypted session. Frames on the wire are
 * [8-byte counter][ciphertext+tag]; the receiver insists counters arrive strictly in order.
 */
export class SecureChannel {
  private sent = 0
  private received = 0
  // Web Crypto is async: chain each direction so frames are sealed/opened strictly in order.
  private sealing: Promise<unknown> = Promise.resolve()
  private opening: Promise<unknown> = Promise.resolve()

  private cipher: SessionCipher

  constructor(
    key: CryptoKey | SessionCipher,
    private sendDir: number,
    private recvDir: number
  ) {
    this.cipher = 'encrypt' in key ? key : webCryptoCipher(key)
  }

  /**
   * Encrypts a frame; callers must send results in the order seal() was called (it resolves in order).
   * A value that can't be serialised (too large for a string, circular) throws here, before it takes a
   * counter, so the stream stays intact. A rejected promise means a counter was spent: the stream is broken.
   */
  seal(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const plain = te.encode(JSON.stringify(value))
    const n = ++this.sent
    const next = this.sealing.then(async () => {
      const ct = await this.cipher.encrypt(iv(this.sendDir, n), plain)
      const out = new Uint8Array(8 + ct.length)
      new DataView(out.buffer).setBigUint64(0, BigInt(n))
      out.set(ct, 8)
      return out
    })
    this.sealing = next.catch(() => undefined)
    return next
  }

  open<T>(frame: Uint8Array): Promise<T> {
    const next = this.opening.then(async () => {
      if (frame.length < 8 + 16) throw new Error('Frame too short')
      const n = Number(new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0))
      if (n !== this.received + 1) throw new Error('Out-of-order or replayed frame')
      const pt = await this.cipher.decrypt(iv(this.recvDir, n), frame.subarray(8))
      this.received = n
      return JSON.parse(td.decode(pt)) as T
    })
    this.opening = next.catch(() => undefined)
    return next
  }
}

/**
 * API calls a phone may make. Desktop-only calls (native file dialogs, opening things on the PC's
 * screen) are replaced on the phone; pairing management stays on the desktop.
 */
export function remoteAllowed(path: string): boolean {
  if (['app.reset', 'app.pickPaths', 'app.openPath', 'app.showInFolder', 'app.openExternal', 'images.open', 'images.saveAs', 'swatches.saveAs', 'panel.open', 'panel.reveal'].includes(path)) return false
  if (path.startsWith('remote.')) return ['remote.listDir', 'remote.roots', 'remote.imageData', 'remote.status'].includes(path)
  return true
}
