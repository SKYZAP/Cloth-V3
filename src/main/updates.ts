import type { Ctx } from './core/context'
import { errorMessage } from './core/context'
import type { UpdateStatus } from '@shared/types'

export const UPDATE_REPO = { owner: 'SKYZAP', repo: 'Cloth-V3' } as const
const REPO = `${UPDATE_REPO.owner}/${UPDATE_REPO.repo}`
const TOKEN_KV = 'updates.token'
const CHECKED_KV = 'updates.checkedAt'
/** A launch checks again once the last check is this old. */
const RECHECK_MS = 20 * 60 * 60 * 1000

/** The part of electron-updater's autoUpdater Cloth uses (tests pass a stand-in). */
export interface Updater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(options: { provider: 'github'; owner: string; repo: string; private: boolean; token: string }): void
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
 * Checks the private GitHub releases for a newer Cloth and installs it. The token is the user's own, pasted in
 * Settings and kept encrypted; nothing secret ships in the app. Downloads only start when asked.
 */
export class UpdateService {
  private status: UpdateStatus

  constructor(
    private ctx: Ctx,
    private deps: UpdateDeps
  ) {
    this.status = { state: 'idle', current: deps.version, supported: !!deps.updater, hasToken: !!this.token(), checkedAt: ctx.kv.get<number | undefined>(CHECKED_KV, undefined) }
    if (deps.updater) {
      deps.updater.autoDownload = false
      deps.updater.autoInstallOnAppQuit = true
      deps.updater.on('download-progress', (p) => this.set({ progress: { transferred: p.transferred, total: p.total } }))
    }
  }

  get(): UpdateStatus {
    return this.status
  }

  async setToken(token: string): Promise<UpdateStatus> {
    const t = token.trim()
    if (t) await this.verify(t)
    this.ctx.kv.set(TOKEN_KV, t ? Buffer.from(this.ctx.secrets.encrypt(t)).toString('base64') : null)
    return this.set({ hasToken: !!t, state: 'idle', error: undefined, version: undefined, size: undefined, progress: undefined })
  }

  async check(): Promise<UpdateStatus> {
    const { updater } = this.deps
    if (!updater) return this.status
    const token = this.token()
    if (!token) return this.set({ state: 'error', error: `Add a GitHub token that can read ${REPO} first.` })
    if (this.status.state === 'checking' || this.status.state === 'downloading') return this.status
    this.set({ state: 'checking', error: undefined })
    try {
      updater.setFeedURL({ provider: 'github', owner: UPDATE_REPO.owner, repo: UPDATE_REPO.repo, private: true, token })
      const res = await updater.checkForUpdates()
      const checkedAt = Date.now()
      this.ctx.kv.set(CHECKED_KV, checkedAt)
      const info = res?.updateInfo
      const newer = !!info && (res.isUpdateAvailable ?? isNewer(info.version, this.deps.version))
      if (!newer) return this.set({ state: 'none', checkedAt, version: undefined, size: undefined })
      const size = info.files?.reduce((n, f) => n + (f.size ?? 0), 0) || undefined
      return this.set({ state: 'available', checkedAt, version: info.version, size })
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
    if (this.status.state === 'ready') this.deps.updater?.quitAndInstall(false, true)
  }

  /** At launch: check quietly when a token is saved and the last check is old. */
  async checkIfDue(now = Date.now()): Promise<void> {
    if (!this.deps.updater || !this.status.hasToken) return
    if (this.status.checkedAt && now - this.status.checkedAt < RECHECK_MS) return
    await this.check()
  }

  private token(): string | null {
    const stored = this.ctx.kv.get<string | null>(TOKEN_KV, null)
    if (!stored) return null
    try {
      return this.ctx.secrets.decrypt(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  /** Reads one release with the token, so a wrong or too-narrow token fails here and not on the first check. */
  private async verify(token: string): Promise<void> {
    let res: Response
    try {
      res = await this.deps.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'Cloth' },
        signal: AbortSignal.timeout(15_000)
      })
    } catch (err) {
      throw new Error(`Couldn’t reach GitHub: ${errorMessage(err)}`)
    }
    if (res.ok) return
    if (res.status === 401) throw new Error('GitHub didn’t accept this token. Check it was copied whole and hasn’t expired.')
    if (res.status === 403 || res.status === 404) throw new Error(`This token can’t read ${REPO}. Give it read access to Contents on that repository.`)
    throw new Error(`GitHub answered ${res.status} when checking the token.`)
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
  if (e?.statusCode === 401 || /\b401\b/.test(msg)) return 'GitHub didn’t accept the saved token. It may have expired; paste a new one.'
  if (e?.statusCode === 404 || e?.statusCode === 403 || /\b40[34]\b/.test(msg)) return `The saved token can’t read ${REPO}’s releases.`
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(msg)) return 'Couldn’t reach GitHub. Check the connection and try again.'
  return msg.split('\n')[0]
}
