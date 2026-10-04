import type { Settings, SubagentSettings } from '@shared/types'
import type { Ctx } from './context'

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: null,
  embeddingModel: null,
  webEngine: 'obscura',
  searxngUrl: '',
  webCaCertPath: '',
  obscuraPath: '',
  webResults: 6,
  webAllowPrivate: false,
  examplesLoaded: false,
  mcpEnabled: true,
  mcpPort: 7811,
  mcpRequireToken: false,
  mcpClients: [],
  chunkSize: 1600,
  chunkOverlap: 200,
  autoCompact: true,
  aiTitles: true,
  titleModel: null,
  starredModels: [],
  imageModel: null,
  remoteEnabled: false,
  remotePort: 7812,
  remoteKeepAwake: true,
  subagents: {
    enabledByDefault: true,
    model: null,
    thinking: 'inherit',
    maxTurns: 30,
    maxParallel: 4,
    allowWorkers: true,
    instructions: ''
  }
}

export const DEFAULT_SUBAGENTS: SubagentSettings = DEFAULT_SETTINGS.subagents

export class SettingsService {
  private listeners: ((s: Settings, prev: Settings) => void)[] = []

  constructor(private ctx: Ctx) {}

  get(): Settings {
    const stored = this.ctx.kv.get<Partial<Settings>>('settings', {})
    // Nested groups merge field by field so settings added later get their defaults.
    return { ...DEFAULT_SETTINGS, ...stored, subagents: { ...DEFAULT_SETTINGS.subagents, ...stored.subagents } }
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
