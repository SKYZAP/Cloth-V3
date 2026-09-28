import { create } from 'zustand'
import { RemoteClient, type RemoteInfo, type RemoteState } from '@shared/remote-client'
import { decodePairing, type PairingPayload } from '@shared/remote'
import { deviceName, getPref, native, onResume, openExternal, setPref, shareImage } from './native'

/**
 * The phone's window.cloth: the same invoke/onEvent bridge the desktop preload exposes, carried over
 * the encrypted remote connection instead of Electron IPC. installBridge() runs from the phone entry
 * (./install) before anything else loads.
 */

const PAIRING_KEY = 'cloth.pairing'
const HOST_KEY = 'cloth.lastHost'

export type ConnectionState = RemoteState | 'loading' | 'unconfigured'

interface Connection {
  state: ConnectionState
  pairing: PairingPayload | null
  info: RemoteInfo | null
  /** Bumped after a reconnect so screens remount and reload what they show. */
  generation: number
}

export const useConnection = create<Connection>(() => ({ state: 'loading', pairing: null, info: null, generation: 0 }))

const listeners = new Set<(channel: string, payload: unknown) => void>()
let client: RemoteClient | null = null

/** Phone replacements for desktop-only calls, registered by UI hosts (folder picker, image viewer). */
export const mobileHooks: {
  pickPaths: ((opts: { directory?: boolean; multiple?: boolean; title?: string }) => Promise<string[]>) | null
  openImage: ((id: string) => void) | null
  notify: ((text: string, kind?: 'ok' | 'error' | 'info') => void) | null
} = { pickPaths: null, openImage: null, notify: null }

function start(pairing: PairingPayload, preferHost: string | null, name: string): RemoteClient {
  client?.close()
  const c = new RemoteClient(pairing, {
    name,
    platform: native ? 'android' : 'web',
    preferHost,
    onEvent: (channel, payload) => listeners.forEach((l) => l(channel, payload)),
    onState: (state, info) => {
      if (c !== client) return
      if (state === 'online' && info.host) void setPref(HOST_KEY, info.host)
      useConnection.setState((s) => ({ state, info: { ...info }, generation: state === 'online' && info.reconnected ? s.generation + 1 : s.generation }))
    }
  })
  client = c
  useConnection.setState({ state: 'connecting' })
  c.connect()
  return c
}

export async function initConnection(): Promise<void> {
  const raw = await getPref(PAIRING_KEY)
  if (!raw) return useConnection.setState({ state: 'unconfigured' })
  try {
    const pairing = JSON.parse(raw) as PairingPayload
    useConnection.setState({ pairing })
    start(pairing, await getPref(HOST_KEY), await deviceName())
  } catch {
    useConnection.setState({ state: 'unconfigured' })
  }
}

/** Pairs with the code from the desktop's QR. Resolves once connected; throws with the reason otherwise. */
export async function pairWith(text: string): Promise<void> {
  const pairing = decodePairing(text)
  const c = start(pairing, null, await deviceName())
  await new Promise<void>((resolve, reject) => {
    const unsub = useConnection.subscribe((s) => {
      if (c !== client) return
      if (s.state === 'online') {
        unsub()
        resolve()
      } else if (s.state === 'unpaired' || s.state === 'offline') {
        unsub()
        c.close()
        client = null
        useConnection.setState({ state: 'unconfigured', pairing: null })
        reject(new Error(s.state === 'unpaired' ? 'Your PC refused this code — it may have expired. Make a new one in Settings → Phone.' : (s.info?.error ?? "Couldn't reach your PC")))
      }
    })
  })
  await setPref(PAIRING_KEY, JSON.stringify(pairing))
  useConnection.setState({ pairing })
}

export async function forgetPairing(): Promise<void> {
  client?.close()
  client = null
  await setPref(PAIRING_KEY, null)
  await setPref(HOST_KEY, null)
  useConnection.setState({ state: 'unconfigured', pairing: null, info: null })
}

export function reconnectNow(): void {
  client?.nudge()
}

async function route(path: string, args: unknown[]): Promise<unknown> {
  switch (path) {
    case 'app.pickPaths':
      if (!mobileHooks.pickPaths) throw new Error('Folder picker unavailable')
      return mobileHooks.pickPaths((args[0] ?? {}) as { directory?: boolean })
    case 'app.openExternal':
      return openExternal(String(args[0]))
    case 'app.openPath':
      mobileHooks.notify?.('That opens on your PC — use Cloth there to see the folder.', 'info')
      return undefined
    case 'images.open':
      mobileHooks.openImage?.(String(args[0]))
      return undefined
    case 'images.saveAs': {
      const id = String(args[0])
      const img = (await call('remote.imageData', [id])) as { mime: string; data: string } | null
      if (!img) throw new Error('Image not found')
      await shareImage(img.data, img.mime, `cloth-${id}.${img.mime.split('/')[1] ?? 'png'}`)
      return null
    }
  }
  return call(path, args)
}

function call(path: string, args: unknown[]): Promise<unknown> {
  if (!client) return Promise.reject(new Error('Not paired with a PC'))
  return client.call(path, args)
}

export function installBridge(): void {
  window.cloth = {
    invoke: async (path, args) => {
      try {
        return { ok: true, value: await route(path, args ?? []) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    platform: 'android',
    remote: true
  }
  document.documentElement.classList.add('mobile')
  onResume(() => client?.nudge())
}
