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
      // Settings saved before access levels had only "Allow workers": off means delegated jobs stay Readers.
      subagents: withEffort({ ...DEFAULT_SETTINGS.subagents, ...stored.subagents, ...(stored.subagents && !stored.subagents.maxAccess ? { maxAccess: stored.subagents.allowWorkers === false ? 'reader' : 'operator' } : {}) }),
      ...(stored.agentTiers ? { agentTiers: stored.agentTiers.map(withInstructions) } : {})
    }
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.get()
    const next = { ...prev, ...patch }
    if (patch.agentTiers) next.agentTiers = cleanTiers(patch.agentTiers)
    if (patch.subagents) {
      // "Allow workers" and the access level say the same thing: whichever this change moved decides the other.
      const sub = { ...next.subagents }
      if (sub.maxAccess !== prev.subagents.maxAccess) sub.allowWorkers = sub.maxAccess !== 'reader'
      else if (sub.allowWorkers !== prev.subagents.allowWorkers) sub.maxAccess = sub.allowWorkers ? 'operator' : 'reader'
      next.subagents = sub
    }
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
  const name = RENAMED_TIERS[t.id]?.[0] === t.name ? RENAMED_TIERS[t.id][1] : t.name
  return { ...t, name, thinking: normalizeEffortOrNull(t.thinking), instructions: typeof raw === 'string' ? raw.trim() : (DEFAULT_TIER_INSTRUCTIONS[t.id] ?? '') }
}

/** The default tiers are named after their reasoning level now; a default still under its old name takes the new one. */
const RENAMED_TIERS: Record<string, [string, string]> = { light: ['Light', 'Low'], careful: ['Careful', 'High'], heavy: ['Heavy', 'Max'] }

/** Subagent effort saved before the four levels ('off', 'minimal') reads as Light; 'inherit' stays. */
function withEffort(s: SubagentSettings): SubagentSettings {
  return { ...s, thinking: s.thinking === 'inherit' ? 'inherit' : normalizeEffort(s.thinking) }
}
