import type { FileAccess, SubagentSettings } from './types'

/**
 * What an agent may do, in one setting: a Reader reads and searches, a Writer also edits files, an
 * Operator also runs commands. Stored as the older fileAccess + shell pair, which these map onto.
 * The chat's mode can only lower it (Plan makes every agent a Reader until the plan is approved).
 */
export type AgentAccess = 'reader' | 'writer' | 'operator'

export const ACCESS_LEVELS: { value: AgentAccess; label: string; sub: string }[] = [
  { value: 'reader', label: 'Reader', sub: 'Reads and searches; never changes anything' },
  { value: 'writer', label: 'Writer', sub: 'Also edits files' },
  { value: 'operator', label: 'Operator', sub: 'Also edits files and runs commands' }
]

const RANK: Record<AgentAccess, number> = { reader: 0, writer: 1, operator: 2 }

export function accessOf(a: { fileAccess: FileAccess; shell: boolean }): AgentAccess {
  return a.fileAccess !== 'write' ? 'reader' : a.shell ? 'operator' : 'writer'
}

export function accessCaps(level: AgentAccess): { fileAccess: FileAccess; shell: boolean } {
  return { fileAccess: level === 'reader' ? 'read' : 'write', shell: level === 'operator' }
}

/** The lower of two levels. */
export function capAccess(level: AgentAccess, max: AgentAccess): AgentAccess {
  return RANK[level] <= RANK[max] ? level : max
}

export function accessLabel(level: AgentAccess): string {
  return ACCESS_LEVELS.find((l) => l.value === level)!.label
}

/** The most a delegated job may do (Settings → Subagents); settings saved before levels map from "Allow workers". */
export function maxDelegatedAccess(cfg: Pick<SubagentSettings, 'allowWorkers' | 'maxAccess'>): AgentAccess {
  return cfg.maxAccess ?? (cfg.allowWorkers ? 'operator' : 'reader')
}
