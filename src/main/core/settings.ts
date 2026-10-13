import { DEFAULT_TIER_INSTRUCTIONS, type AgentTier, type Settings, type SubagentSettings } from '@shared/types'
import { newId, type Ctx } from './context'

export { DEFAULT_TIER_INSTRUCTIONS }

/** The tiers a chat agent picks from when it delegates; model null = the chat's own model. */
export const DEFAULT_AGENT_TIERS: AgentTier[] = [
  { id: 'light', name: 'Light', model: null, thinking: 'low', purpose: 'Mechanical edits, renames, running builds or tests, small isolated fixes.', instructions: DEFAULT_TIER_INSTRUCTIONS.light },
  { id: 'medium', name: 'Medium', model: null, thinking: 'medium', purpose: 'Standard features and bug fixes with a known cause, a few files.', instructions: DEFAULT_TIER_INSTRUCTIONS.medium },
  { id: 'careful', name: 'Careful', model: null, thinking: 'high', purpose: 'Delicate changes where the approach is clear: multi-file refactors, edge cases, keeping invariants.', instructions: DEFAULT_TIER_INSTRUCTIONS.careful },
  { id: 'heavy', name: 'Heavy', model: null, thinking: 'high', purpose: 'Unclear causes, unfamiliar or messy code, where a wrong first approach is expensive.', instructions: DEFAULT_TIER_INSTRUCTIONS.heavy }
]

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: null,
  defaultDesignId: null,
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
  },
  agentTiers: DEFAULT_AGENT_TIERS,
  defaultPermissions: 'auto'
}

export const DEFAULT_SUBAGENTS: SubagentSettings = DEFAULT_SETTINGS.subagents

export class SettingsService {
  private listeners: ((s: Settings, prev: Settings) => void)[] = []

  constructor(private ctx: Ctx) {}

  get(): Settings {
    const stored = this.ctx.kv.get<Partial<Settings>>('settings', {})
    // Nested groups merge field by field so settings added later get their defaults.
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      subagents: { ...DEFAULT_SETTINGS.subagents, ...stored.subagents },
      ...(stored.agentTiers ? { agentTiers: stored.agentTiers.map(withInstructions) } : {})
    }
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.get()
    const next = { ...prev, ...patch }
    if (patch.agentTiers) next.agentTiers = cleanTiers(patch.agentTiers)
    this.ctx.kv.set('settings', next)
    for (const l of this.listeners) l(next, prev)
    return next
  }

  onChange(fn: (s: Settings, prev: Settings) => void): void {
    this.listeners.push(fn)
  }
}

/** Tiers as saved: every one has a unique id (new ones get tier_<random>) and a name. */
function cleanTiers(tiers: AgentTier[]): AgentTier[] {
  const seen = new Set<string>()
  return tiers.map((t) => {
    let id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : ''
    if (!id || seen.has(id)) id = newId('tier_')
    seen.add(id)
    return withInstructions({ id, name: t.name?.trim() || 'Tier', model: t.model ?? null, thinking: t.thinking ?? null, purpose: t.purpose?.trim() ?? '', instructions: t.instructions })
  })
}

/** Tiers saved before they had instructions get their default's (an explicit '' stays empty). */
function withInstructions(t: AgentTier): AgentTier {
  const raw: unknown = t.instructions
  return { ...t, instructions: typeof raw === 'string' ? raw.trim() : (DEFAULT_TIER_INSTRUCTIONS[t.id] ?? '') }
}
