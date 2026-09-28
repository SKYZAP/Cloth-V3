import type { Settings } from '@shared/types'
import type { Ctx } from './context'

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: null,
  embeddingModel: null,
  webEngine: 'obscura',
  searxngUrl: '',
  obscuraPath: '',
  webResults: 6,
  webAllowPrivate: false,
  examplesLoaded: false,
  mcpEnabled: true,
  mcpPort: 7811,
  mcpRequireToken: false,
  chunkSize: 1600,
  chunkOverlap: 200,
  autoCompact: true,
  imageModel: null,
  remoteEnabled: false,
  remotePort: 7812,
  remoteKeepAwake: true
}

export class SettingsService {
  private listeners: ((s: Settings, prev: Settings) => void)[] = []

  constructor(private ctx: Ctx) {}

  get(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.ctx.kv.get<Partial<Settings>>('settings', {}) }
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.get()
    const next = { ...prev, ...patch }
    this.ctx.kv.set('settings', next)
    for (const l of this.listeners) l(next, prev)
    return next
  }

  onChange(fn: (s: Settings, prev: Settings) => void): void {
    this.listeners.push(fn)
  }
}
