import type { ThinkingLevel } from './types'

/**
 * The reasoning efforts a person picks from, in order. 'off' stays internal (models that don't reason);
 * 'off' and 'minimal' saved by older versions read as 'low' (Light).
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

export const EFFORT_OPTIONS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Max' }
]

const EFFORTS = new Set<string>(EFFORT_OPTIONS.map((e) => e.value))

/** A saved effort as one of the four: 'off', 'minimal' and anything unknown become 'low'. */
export function normalizeEffort(t: unknown): Effort {
  if (t === 'max') return 'xhigh'
  return typeof t === 'string' && EFFORTS.has(t) ? (t as Effort) : 'low'
}

/** Like normalizeEffort, but null/undefined ("use the chat's effort") stays null. */
export function normalizeEffortOrNull(t: unknown): Effort | null {
  return t === null || t === undefined ? null : normalizeEffort(t)
}

/** "Low" | "Medium" | "High" | "Max" for any saved level (old off/minimal read as Low). */
export function effortLabel(t: ThinkingLevel | null | undefined): string {
  const v = normalizeEffort(t)
  return EFFORT_OPTIONS.find((e) => e.value === v)!.label
}
