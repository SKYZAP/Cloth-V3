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

/**
 * The effort a model actually gets when it takes only `efforts` (Bonsai 2: low, medium, xhigh): the saved one
 * if allowed, else the nearest allowed above it, else the highest. The same rounding the request uses.
 */
export function effortFor(t: unknown, efforts?: readonly Effort[] | null): Effort {
  const e = normalizeEffort(t)
  if (!efforts?.length || efforts.includes(e)) return e
  const order = EFFORT_OPTIONS.map((o) => o.value)
  return order.slice(order.indexOf(e)).find((x) => efforts.includes(x)) ?? order.filter((x) => efforts.includes(x)).at(-1)!
}

/** The effort choices for a model: all four, or just the ones it takes. */
export function effortOptions(efforts?: readonly Effort[] | null): { value: Effort; label: string }[] {
  return efforts?.length ? EFFORT_OPTIONS.filter((o) => efforts.includes(o.value)) : EFFORT_OPTIONS
}

/** "Low" | "Medium" | "High" | "Max" for any saved level (old off/minimal read as Low). */
export function effortLabel(t: ThinkingLevel | null | undefined): string {
  const v = normalizeEffort(t)
  return EFFORT_OPTIONS.find((e) => e.value === v)!.label
}
