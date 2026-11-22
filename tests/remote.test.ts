import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApi } from '../src/main/api'
import { RemoteClient, type RemoteState } from '../src/shared/remote-client'
import { SecureChannel, decodePairing, encodePairing, randomBytes, remoteAllowed, sessionKey, type PairingPayload } from '../src/shared/remote'
import { nodeSessionCipher } from '../src/main/remote/cipher'
import { makeServices } from './helpers'

const { services } = makeServices()
const port = 17000 + Math.floor(Math.random() * 2000)
const clients: RemoteClient[] = []

function client(pairing: PairingPayload, onEvent: (c: string, p: unknown) => void = () => {}) {
  const states: RemoteState[] = []
  const c = new RemoteClient({ ...pairing, h: ['127.0.0.1'] }, { name: 'Pixel Test', platform: 'android', onEvent, onState: (s) => states.push(s) })
  clients.push(c)
  return { c, states }
}

/** A chat the size of a long agent run: many tool steps with big outputs (~24 MB of JSON). */
function bigChat() {
  const out = 'x'.repeat(8_000) + ' é✓🙂 '
  return {
    id: 'chat_big',
    title: 'Fix YouTube Playback Abort Error',
    messages: Array.from({ length: 3_000 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'tool', content: `step ${i} ${out}` }))
  }
}

const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  services.settings.update({ remotePort: port })
  const api = createApi(services)
  services.remote.attach({
    dispatch: async (path, args) => {
      if (path === 'test.bigChat') return bigChat()
      if (path === 'test.circular') {
        const o: Record<string, unknown> = {}
        o.self = o
        return o
      }
      const [ns, m] = path.split('.')
      return (api as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>)[ns][m](...args)
    }
  })
})

afterAll(async () => {
  clients.forEach((c) => c.close())
  await services.remote.stop()
})

describe('remote protocol', () => {
  it('round-trips pairing links and rejects junk', () => {
    const p: PairingPayload = { v: 1, id: 'dev_x', k: 'abc', port: 1, h: ['10.0.0.2'], n: 'pc' }
    expect(decodePairing(encodePairing(p))).toEqual(p)
    expect(decodePairing(encodePairing(p).split('d=')[1])).toEqual(p)
    expect(() => decodePairing('hello')).toThrow(/pairing code/)
  })

  it('encrypts frames and refuses replays, reordering and the wrong key', async () => {
    const k = randomBytes(32)
    const ch = randomBytes(16)
    const nonce = randomBytes(16)
    const a = new SecureChannel(await sessionKey(k, ch, nonce), 1, 2)
    const b = new SecureChannel(await sessionKey(k, ch, nonce), 2, 1)
    const f1 = await a.seal({ n: 1 })
    const f2 = await a.seal({ n: 2 })
    await expect(b.open(f2)).rejects.toThrow(/Out-of-order/)
    expect(await b.open(f1)).toEqual({ n: 1 })
    await expect(b.open(f1)).rejects.toThrow(/Out-of-order/)
    expect(await b.open(f2)).toEqual({ n: 2 })
    const evil = new SecureChannel(await sessionKey(randomBytes(32), ch, nonce), 1, 2)
    const c = new SecureChannel(await sessionKey(k, ch, nonce), 2, 1)
    await expect(c.open(await evil.seal({ n: 1 }))).rejects.toThrow()
  })

  it("desktop's node:crypto cipher and the phone's Web Crypto agree, on large frames too", async () => {
    const k = randomBytes(32)
    const ch = randomBytes(16)
    const nonce = randomBytes(16)
    const desktop = new SecureChannel(nodeSessionCipher(k, ch, nonce), 2, 1)
    const phone = new SecureChannel(await sessionKey(k, ch, nonce), 1, 2)
    const big = bigChat()
    expect(await phone.open(await desktop.seal(big))).toEqual(big)
    expect(await desktop.open(await phone.seal({ t: 'call', id: 1 }))).toEqual({ t: 'call', id: 1 })
    // Many frames in flight at once still arrive in order.
    const sealed = await Promise.all(Array.from({ length: 50 }, (_, i) => desktop.seal({ i, pad: 'y'.repeat(100_000) })))
    for (let i = 0; i < 50; i++) expect(((await phone.open(sealed[i])) as { i: number }).i).toBe(i)
    // Wrong key and tampering are refused.
    const evil = new SecureChannel(nodeSessionCipher(randomBytes(32), ch, nonce), 1, 2)
    await expect(new SecureChannel(nodeSessionCipher(k, ch, nonce), 2, 1).open(await evil.seal({ n: 1 }))).rejects.toThrow()
    const f = await phone.seal({ n: 2 })
    f[f.length - 1] ^= 1
    await expect(desktop.open(f)).rejects.toThrow()
  })

  it("doesn't spend a frame number on a value it can't serialise", async () => {
    const k = randomBytes(32)
    const ch = randomBytes(16)
    const a = new SecureChannel(nodeSessionCipher(k, ch, ch), 2, 1)
    const b = new SecureChannel(await sessionKey(k, ch, ch), 1, 2)
    const o: Record<string, unknown> = {}
    o.self = o
    expect(() => a.seal(o)).toThrow()
    expect(await b.open(await a.seal({ ok: 1 }))).toEqual({ ok: 1 })
  })

  it('keeps desktop-only and pairing calls off the phone', () => {
    expect(remoteAllowed('chat.send')).toBe(true)
    expect(remoteAllowed('remote.listDir')).toBe(true)
    expect(remoteAllowed('app.pickPaths')).toBe(false)
    expect(remoteAllowed('remote.pair')).toBe(false)
    expect(remoteAllowed('remote.revoke')).toBe(false)
  })
})

describe('remote host', () => {
  let pairing: PairingPayload

  it('pairs a phone, which then calls the API and receives events', async () => {
    const link = await services.remote.pair()
    expect(services.settings.get().remoteEnabled).toBe(true)
    expect(services.remote.status().running).toBe(true)
    pairing = decodePairing(link.link)
    expect(pairing.port).toBe(port)
    expect(services.remote.status().devices).toMatchObject([{ id: pairing.id, pending: true }])

    const events: { c: string; p: unknown }[] = []
    const { c, states } = client(pairing, (ch, p) => events.push({ c: ch, p }))
    c.connect()
    await until(() => c.state === 'online')
    expect(states).toContain('connecting')
    expect(services.remote.status().devices).toMatchObject([{ id: pairing.id, pending: false, connected: true, name: 'Pixel Test', platform: 'android' }])

    const settings = (await c.call('settings.get', [])) as { remotePort: number }
    expect(settings.remotePort).toBe(port)
    const chat = (await c.call('chat.create', [{ title: 'From phone' }])) as { id: string; title: string }
    expect(chat.title).toBe('From phone')
    await expect(c.call('app.pickPaths', [{}])).rejects.toThrow(/only available on the desktop/)
    await expect(c.call('remote.pair', [])).rejects.toThrow(/only available on the desktop/)
    const roots = (await c.call('remote.roots', [])) as { path: string }[]
    const listing = (await c.call('remote.listDir', [roots[0].path])) as { entries: unknown[] }
    expect(Array.isArray(listing.entries)).toBe(true)

    // Streaming message updates collapse to the latest; other events keep their order.
    for (let i = 0; i < 20; i++) services.remote.broadcast('chat', { type: 'message', sessionId: 's', message: { id: 'm1', n: i } })
    services.remote.broadcast('chat', { type: 'end', sessionId: 's' })
    await until(() => events.some((e) => (e.p as { type: string }).type === 'end'))
    const seen = events.map((e) => e.p as { type: string; message?: { n: number } })
    expect(seen.filter((e) => e.type === 'message').length).toBeLessThan(5)
    expect(seen.at(-2)).toMatchObject({ type: 'message', message: { n: 19 } })
  })

  it('sends a large chat to the phone, and answers a reply it cannot send without dropping the link', async () => {
    const { c } = client(pairing)
    c.connect()
    await until(() => c.state === 'online')
    const chat = (await c.call('test.bigChat', [])) as ReturnType<typeof bigChat>
    expect(chat.messages).toHaveLength(3_000)
    expect(chat).toEqual(bigChat())
    await expect(c.call('test.circular', [])).rejects.toThrow(/could not be sent to the phone/)
    expect(((await c.call('settings.get', [])) as { remotePort: number }).remotePort).toBe(port)
    expect(c.state).toBe('online')
    c.close()
  }, 30_000)

  it('rejects a phone with the wrong key or an unknown id', async () => {
    const bad = client({ ...pairing, k: 'A'.repeat(43) })
    bad.c.connect()
    await until(() => bad.c.state === 'unpaired')
    const stranger = client({ ...pairing, id: 'dev_nobody' })
    stranger.c.connect()
    await until(() => stranger.c.state === 'unpaired')
    expect(stranger.c.info.error).toMatch(/not paired/)
  })

  it('reconnects after a drop and disconnects revoked phones', async () => {
    const { c } = client(pairing)
    const states: RemoteState[] = []
    c.connect()
    await until(() => c.state === 'online')
    await services.remote.restart()
    ;(c as unknown as { opts: { onState(s: RemoteState): void } }).opts.onState = (s) => states.push(s)
    await until(() => c.state === 'online' && c.info.reconnected, 8000)
    services.remote.revoke(pairing.id)
    await until(() => c.state === 'unpaired')
    expect(services.remote.status().devices).toEqual([])
  })
})
