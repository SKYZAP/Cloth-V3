import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServices } from '../src/main/services'
import { plainSecrets } from '../src/main/core/context'
import { channelFileFor, isNewer, missingChannelFile, updateError, type Updater } from '../src/main/updates'

function fakeUpdater(result: Awaited<ReturnType<Updater['checkForUpdates']>> | Error) {
  const calls: { feed?: unknown; downloads: number; installs: number; installArgs?: unknown[] } = { downloads: 0, installs: 0 }
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
    quitAndInstall: (...args) => void (calls.installs++, (calls.installArgs = args)),
    on: (_e, fn) => void (onProgress = fn)
  }
  return { updater, calls }
}

function setup(updater: Updater | null, releases: unknown = []) {
  const events: unknown[] = []
  const services = createServices({
    dataDir: mkdtempSync(join(tmpdir(), 'cloth-upd-')),
    dbFile: ':memory:',
    secrets: plainSecrets,
    emit: (channel, payload) => channel === 'updates' && events.push(payload),
    updates: { version: '0.1.0', updater, channelFile: 'latest.yml', fetch: (async () => new Response(JSON.stringify(releases))) as unknown as typeof fetch }
  })
  return { u: services.updates, events }
}

describe('updates', () => {
  it('checks the public releases, downloads a newer one by itself and installs it silently', async () => {
    const { updater, calls } = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.2.0', files: [{ size: 300 }] } })
    const { u, events } = setup(updater)
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    const found = await u.check()
    expect(calls.feed).toEqual({ provider: 'github', owner: 'SKYZAP', repo: 'Cloth-V3' })
    expect(found).toMatchObject({ state: 'available', version: '0.2.0', size: 300 })
    // The download starts on its own.
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.downloads).toBe(1)
    expect(u.get().state).toBe('ready')
    expect(events).toContainEqual(expect.objectContaining({ state: 'downloading', progress: { transferred: 50, total: 100 } }))
    // Installing: silent (no setup wizard), and Cloth starts again afterwards.
    u.install()
    expect(calls.installs).toBe(1)
    expect(calls.installArgs).toEqual([true, true])
  })

  it('checks the newest release that has latest.yml when the latest one has none yet', async () => {
    const feeds: unknown[] = []
    const updater: Updater = {
      ...fakeUpdater(null).updater,
      setFeedURL: (o) => void feeds.push(o),
      checkForUpdates: async () => {
        if ((feeds.at(-1) as { provider: string }).provider === 'github') throw Object.assign(new Error('Cannot find latest.yml in the latest release artifacts'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
        return { isUpdateAvailable: true, updateInfo: { version: '0.2.0' } }
      }
    }
    const releases = [
      { tag_name: 'v0.3.0', draft: false, prerelease: false, assets: [{ name: 'Cloth-0.3.0-android.apk' }] },
      { tag_name: 'v0.2.5', draft: false, prerelease: true, assets: [{ name: 'latest.yml' }] },
      { tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [{ name: 'latest.yml' }, { name: 'Cloth-Setup-0.2.0.exe' }] }
    ]
    const { u } = setup(updater, releases)
    expect(await u.check()).toMatchObject({ state: 'available', version: '0.2.0' })
    expect(feeds.at(-1)).toEqual({ provider: 'generic', url: 'https://github.com/SKYZAP/Cloth-V3/releases/download/v0.2.0' })

    // No release has one: the original error stands.
    const none = setup({ ...updater, setFeedURL: (o) => void feeds.push(o) }, releases.slice(0, 1))
    expect(await none.u.check()).toMatchObject({ state: 'error' })
    expect(missingChannelFile(new Error('other'))).toBe(false)
    expect(channelFileFor('darwin')).toBe('latest-mac.yml')
  })

  it('installs nothing before the download is done', async () => {
    const { updater, calls } = fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
    const { u } = setup(updater)
    await u.check()
    u.install()
    expect(calls.installs).toBe(0)
    expect(calls.downloads).toBe(0)
  })

  it('says when it is up to date or why it failed', async () => {
    const none = setup(fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } }).updater)
    expect((await none.u.check()).state).toBe('none')

    const empty = setup(fakeUpdater(Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })).updater)
    expect(await empty.u.check()).toMatchObject({ state: 'error', error: 'SKYZAP/Cloth-V3 has no published releases yet.' })
  })

  it('checks at launch only with a real updater and an old last check', async () => {
    const { updater } = fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
    const { u } = setup(updater)
    await u.checkIfDue()
    const at = u.get().checkedAt!
    expect(u.get().state).toBe('none')
    await u.checkIfDue(at + 60_000)
    expect(u.get().checkedAt).toBe(at)

    const dev = setup(null)
    await dev.u.checkIfDue()
    expect(dev.u.get()).toMatchObject({ supported: false, state: 'idle' })
  })

  it('compares versions and words errors', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true)
    expect(isNewer('v0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(updateError(Object.assign(new Error('x'), { statusCode: 403 }))).toMatch(/limiting/)
    expect(updateError(new Error('getaddrinfo ENOTFOUND api.github.com'))).toMatch(/Couldn’t reach GitHub/)
  })
})
