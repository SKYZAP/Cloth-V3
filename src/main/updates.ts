import type { Ctx } from './core/context'
import { errorMessage } from './core/context'
import type { UpdateStatus } from '@shared/types'

export const UPDATE_REPO = { owner: 'SKYZAP', repo: 'Cloth-V3' } as const
const REPO = `${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`
const CHECKED_KV = 'updates.checkedAt'
/** A launch checks again once the last check is this old. */
const RECHECK_MS = 20 * 60 * 60 * 1000

/** The part of electron-updater's autoUpdater Cloth uses (tests pass a stand-in). */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(options: { provider: 'github'; owner: string; repo: string }): void
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string; files?: { size?: number }[] } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', listener: (p: { transferred: number; total: number }) => void): unknown
}

export interface UpdateDeps {
  version: string
  /** Null when this build can't update itself (dev, or a Mac build without a signature). */
  updater: Updater | null
  fetch: typeof fetch
}

/**
 * Checks Cloth's public GitHub releases for a newer version, downloads it in the background (only the changed blocks
 * where it can), and installs it silently: no setup wizard, the same install folder, Cloth reopens by itself. An update
 * that isn't installed by hand goes in silently the next time Cloth quits.
 */
export class UpdateService {
  private status: UpdateStatus

  constructor(
    private ctx: Ctx,
    private deps: UpdateDeps
  ) {
    this.status = { state: 'idle', current: deps.version, supported: !!deps.updater, checkedAt: ctx.kv.get<number | undefined>(CHECKED_KV, undefined) }
    if (deps.updater) {
      deps.updater.autoDownload = false
      deps.updater.autoInstallOnAppQuit = true
      deps.updater.on('download-progress', (p) => this.set({ progress: { transferred: p.transferred, total: p.total } }))
    }
  }

  get(): UpdateStatus {
    return this.status
  }

  async check(): Promise<UpdateStatus> {
    const { updater } = this.deps
    if (!updater) return this.status
    // Busy, or already downloaded and waiting for a restart: nothing to check.
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'ready') return this.status
    this.set({ state: 'checking', error: undefined })
    try {
      updater.setFeedURL({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo })
      const res = await updater.checkForUpdates()
      const checkedAt = Date.now()
      this.ctx.kv.set(CHECKED_KV, checkedAt)
      const info = res?.updateInfo
      const newer = !!info && (res.isUpdateAvailable ?? isNewer(info.version, this.deps.version))
      if (!newer) return this.set({ state: 'none', checkedAt, version: undefined, size: undefined })
      const size = info.files?.reduce((n, f) => n + (f.size ?? 0), 0) || undefined
      const found = this.set({ state: 'available', checkedAt, version: info.version, size })
      // Fetch it straight away, so it's ready by the time anyone looks.
      void this.download()
      return found
    } catch (err) {
      return this.set({ state: 'error', error: updateError(err) })
    }
  }

  async download(): Promise<UpdateStatus> {
    const { updater } = this.deps
    if (!updater || this.status.state !== 'available') return this.status
    this.set({ state: 'downloading', progress: { transferred: 0, total: this.status.size ?? 0 } })
    try {
      await updater.downloadUpdate()
      return this.set({ state: 'ready', progress: undefined })
    } catch (err) {
      return this.set({ state: 'available', progress: undefined, error: updateError(err) })
    }
  }

  install(): void {
    // Silent (no setup wizard, the same install folder) and Cloth starts again once it's in.
    if (this.status.state === 'ready') this.deps.updater?.quitAndInstall(true, true)
  }

  /** At launch: check quietly when the last check is old. */
  async checkIfDue(now = Date.now()): Promise<void> {
    if (!this.deps.updater) return
    if (this.status.checkedAt && now - this.status.checkedAt < RECHECK_MS) return
    await this.check()
  }

  private set(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch }
    this.ctx.emit('updates', this.status)
    return this.status
  }
}

/** a.b.c newer than the running version; pre-release tags compare as their numbers only. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [a, b] = [parts(candidate), parts(current)]
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** electron-updater's errors in words that say what to do. */
export function updateError(err: unknown): string {
  const e = err as { code?: string; statusCode?: number }
  const msg = errorMessage(err)
  if (e?.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || /no published versions/i.test(msg)) return `${REPO} has no published releases yet.`
  if (e?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /latest\.yml/i.test(msg)) return 'The newest release has no latest.yml. Publish it with npm run release.'
  if (e?.statusCode === 403 || /\b403\b/.test(msg)) return 'GitHub is limiting requests from this network. Try again in an hour.'
  if (e?.statusCode === 404 || /\b404\b/.test(msg)) return `Couldn’t find ${REPO}’s releases.`
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(msg)) return 'Couldn’t reach GitHub. Check the connection and try again.'
  return msg.split('\n')[0]
}
