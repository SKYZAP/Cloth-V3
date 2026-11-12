import { DEFAULT_TIER_INSTRUCTIONS, type AgentTier, type Settings, type SubagentSettings } from '@shared/types'
import { DEFAULT_AGENT_TIERS, DEFAULT_SETTINGS } from '@shared/settings-defaults'
import { newId, type Ctx } from './context'
import { normalizeEffort, normalizeEffortOrNull } from '@shared/effort'

export { DEFAULT_TIER_INSTRUCTIONS }

export { DEFAULT_AGENT_TIERS, DEFAULT_SETTINGS }

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
      subagents: withEffort({ ...DEFAULT_SETTINGS.subagents, ...stored.subagents }),
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

/** Tiers saved before they had instructions get their default's (an explicit '' stays empty). Old efforts ('off', 'minimal') read as Light. */
function withInstructions(t: AgentTier): AgentTier {
  const raw: unknown = t.instructions
  return { ...t, thinking: normalizeEffortOrNull(t.thinking), instructions: typeof raw === 'string' ? raw.trim() : (DEFAULT_TIER_INSTRUCTIONS[t.id] ?? '') }
}

/** Subagent effort saved before the four levels ('off', 'minimal') reads as Light; 'inherit' stays. */
function withEffort(s: SubagentSettings): SubagentSettings {
  return { ...s, thinking: s.thinking === 'inherit' ? 'inherit' : normalizeEffort(s.thinking) }
}
