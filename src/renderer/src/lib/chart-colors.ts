import type { UsageSource } from '@shared/types'

/*
 * Colours for charts (the Dashboard). Each series colour means one thing for good: a source keeps its colour wherever it
 * shows, a model keeps the colour it got first, and a filter or a change of rank never repaints anything. The values are
 * theme tokens (styles.css), validated as a set for colour-blind viewers on the dark panel.
 */

// Written out in full: Tailwind keeps a theme variable only when its name appears in the source as is.
export const SERIES = [
  'var(--color-series-1)',
  'var(--color-series-2)',
  'var(--color-series-3)',
  'var(--color-series-4)',
  'var(--color-series-5)',
  'var(--color-series-6)',
  'var(--color-series-7)',
  'var(--color-series-8)'
]
export const OTHER = 'var(--color-series-other)'
export const INPUT = 'var(--color-series-input)'
export const OUTPUT = 'var(--color-series-output)'

/** Where tokens go: one slot each, in the order they matter most. */
export const SOURCE: Record<UsageSource, { label: string; color: string }> = {
  chat: { label: 'Chat', color: SERIES[0] },
  workflow: { label: 'Flows', color: SERIES[1] },
  skills: { label: 'Skill tests', color: SERIES[2] },
  knowledge: { label: 'Knowledge', color: SERIES[3] },
  mcp: { label: 'MCP clients', color: SERIES[4] },
  builder: { label: 'Flow builder', color: SERIES[5] },
  tools: { label: 'Tools page', color: SERIES[6] },
  other: { label: 'Other', color: OTHER }
}

/** How a skill was used. Typed in chat shares Chat's colour; MCP is the same colour everywhere. */
export const VIA: Record<string, { label: string; color: string }> = {
  slash: { label: '/ command', color: SERIES[0] },
  tool: { label: 'agent', color: SERIES[7] },
  mcp: { label: 'MCP', color: SERIES[4] },
  workflow: { label: 'flow', color: SERIES[1] }
}

/** Where a tool comes from. */
export const TOOL_KIND: Record<string, { label: string; color: string }> = {
  builtin: { label: 'built-in', color: SERIES[1] },
  mcp: { label: 'MCP', color: SERIES[4] },
  custom: { label: 'custom', color: SERIES[5] }
}

/** Calls per hour of the day: one hue from faint to strong (magnitude, not identity). */
const HEAT = ['#3a1d25', '#5a1f2c', '#7a2436', '#a82d45', '#d93a52', '#ec6d80']
export const heat = (share: number): string => HEAT[Math.min(HEAT.length - 1, Math.max(0, Math.ceil(share * HEAT.length) - 1))]!

/**
 * A slot for each model, kept once given: models already known keep theirs; a new one takes the first free slot, in the
 * order given (most used first). With every slot taken, the rest share Other. Returns the full map (changed or not).
 */
export function assignModelSlots(known: Record<string, number>, models: string[]): Record<string, number> {
  const next = { ...known }
  const used = new Set(Object.values(next))
  for (const m of models) {
    if (m in next) continue
    const free = SERIES.findIndex((_, i) => !used.has(i))
    if (free < 0) break
    next[m] = free
    used.add(free)
  }
  return next
}

export const modelColor = (slots: Record<string, number>, key: string): string => (key in slots ? SERIES[slots[key]!]! : OTHER)
