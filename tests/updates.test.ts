import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServices } from '../src/main/services'
import { plainSecrets } from '../src/main/core/context'
import { isNewer, updateError, type Updater } from '../src/main/updates'

function fakeUpdater(result: Awaited<ReturnType<Updater['checkForUpdates']>> | Error) {
  const calls: { feed?: unknown; downloads: number; installs: number } = { downloads: 0, installs: 0 }
  let onProgress: ((p: { transferred: number; total: number }) => void) | null = null
  const updater: Updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    setFeedURL: (o) => void (calls.feed = o),
    checkForUpdates: async () => {
      if (result instanceof Error) throw result
      return result
    },
    downloadUpdate: async () => {
      calls.downloads++
      onProgress?.({ transferred: 50, total: 100 })
      return []
    },
    quitAndInstall: () => void calls.installs++,
    on: (_e, fn) => void (onProgress = fn)
  }
  return { updater, calls }
}

function setup(updater: Updater | null, status = 200) {
  const events: unknown[] = []
  const fetched: { url: string; auth: string }[] = []
  const services = createServices({
    dataDir: mkdtempSync(join(tmpdir(), 'cloth-upd-')),
    dbFile: ':memory:',
    secrets: plainSecrets,
    emit: (channel, payload) => channel === 'updates' && events.push(payload),
    updates: {
      version: '0.1.0',
      updater,
      fetch: (async (url: string, init: RequestInit) => {
        fetched.push({ url, auth: (init.headers as Record<string, string>).authorization })
        return new Response('[]', { status })
      }) as typeof fetch
    }
  })
  return { u: services.updates, kv: services.ctx.kv, events, fetched }
}

describe('updates', () => {
  it('keeps the token encrypted and only after GitHub accepts it', async () => {
    const { updater } = fakeUpdater(null)
    const { u, kv, fetched } = setup(updater)
    expect(updater.autoDownload).toBe(false)
    expect((await u.setToken('  github_pat_abc  ')).hasToken).toBe(true)
    expect(fetched[0]).toEqual({ url: 'https://api.github.com/repos/SKYZAP/Cloth-V3/releases?per_page=1', auth: 'Bearer github_pat_abc' })
    expect(kv.get('updates.token', '')).toBe(Buffer.from('github_pat_abc').toString('base64'))
    expect((await u.setToken('')).hasToken).toBe(false)

    const refused = setup(fakeUpdater(null).updater, 404)
    await expect(refused.u.setToken('nope')).rejects.toThrow(/can’t read SKYZAP\/Cloth-V3/)
    expect(refused.u.get().hasToken).toBe(false)
    await expect(setup(fakeUpdater(null).updater, 401).u.setToken('old')).rejects.toThrow(/didn’t accept/)
  })

  it('checks the private feed, downloads when asked and restarts into it', async () => {
    const { updater, calls } = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.2.0', files: [{ size: 300 }] } })
    const { u, events } = setup(updater)
    expect((await u.check()).error).toMatch(/Add a GitHub token/)
    await u.setToken('tok')
    const found = await u.check()
    expect(calls.feed).toEqual({ provider: 'github', owner: 'SKYZAP', repo: 'Cloth-V3', private: true, token: 'tok' })
    expect(found).toMatchObject({ state: 'available', version: '0.2.0', size: 300 })
    expect(calls.downloads).toBe(0)
    u.install()
    expect(calls.installs).toBe(0)
    expect((await u.download()).state).toBe('ready')
    expect(events).toContainEqual(expect.objectContaining({ state: 'downloading', progress: { transferred: 50, total: 100 } }))
    u.install()
    expect(calls.installs).toBe(1)
  })

  it('says when it is up to date or why it failed', async () => {
    const none = setup(fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }).updater)
    await none.u.setToken('tok')
    expect((await none.u.check()).state).toBe('none')

    const empty = setup(fakeUpdater(Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })).updater)
    await empty.u.setToken('tok')
    expect(await empty.u.check()).toMatchObject({ state: 'error', error: 'SKYZAP/Cloth-V3 has no published releases yet.' })
  })

  it('checks at launch only with a token, a real updater and an old last check', async () => {
    const { updater } = fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
    const { u } = setup(updater)
    await u.checkIfDue()
    expect(u.get().state).toBe('idle')
    await u.setToken('tok')
    await u.checkIfDue()
    const at = u.get().checkedAt!
    expect(u.get().state).toBe('none')
    await u.checkIfDue(at + 60_000)
    expect(u.get().checkedAt).toBe(at)

    const dev = setup(null)
    await dev.u.setToken('tok')
    await dev.u.checkIfDue()
    expect(dev.u.get()).toMatchObject({ supported: false, state: 'idle' })
  })

  it('compares versions and words errors', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true)
    expect(isNewer('v0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(updateError(Object.assign(new Error('x'), { statusCode: 401 }))).toMatch(/expired/)
    expect(updateError(new Error('getaddrinfo ENOTFOUND api.github.com'))).toMatch(/Couldn’t reach GitHub/)
  })
})
