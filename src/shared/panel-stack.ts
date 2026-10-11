// The chat side panel's stacked tabs: which tabs are shown top to bottom, how the height is shared, and
// which section the tab bar acts on.

export type PanelTab = 'setup' | 'terminal' | 'files' | 'git'
export const PANEL_TABS: readonly PanelTab[] = ['setup', 'files', 'terminal', 'git']
/** Sections the panel can stack at most. */
export const MAX_STACK = 3
/** The smallest height a section's content can be dragged to, in pixels. */
export const MIN_SECTION = 120

export interface PanelStack {
  /** 1–3 distinct tabs, top to bottom. */
  stack: PanelTab[]
  /** Each section's share of the height; they sum to 1. */
  sizes: number[]
  /** The section the tab bar acts on (the last one used). */
  focus: number
}

const isTab = (t: unknown): t is PanelTab => typeof t === 'string' && (PANEL_TABS as readonly string[]).includes(t)
const even = (n: number) => Array.from({ length: n }, () => 1 / n)

/** Shares that sum to 1 (equal shares when the given ones don't fit the sections). */
function normalize(sizes: unknown, n: number): number[] {
  if (!Array.isArray(sizes) || sizes.length !== n || !sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)) return even(n)
  const sum = (sizes as number[]).reduce((a, b) => a + b, 0)
  return (sizes as number[]).map((s) => s / sum)
}

/** The saved panel layout, from today's `{stack, sizes, focus}` or an older `{tab}`; anything unreadable falls back to Setup. */
export function migrate(raw: unknown): PanelStack {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { stack?: unknown; sizes?: unknown; focus?: unknown; tab?: unknown }
  let stack: PanelTab[] = []
  if (Array.isArray(r.stack)) for (const t of r.stack) if (isTab(t) && !stack.includes(t) && stack.length < MAX_STACK) stack.push(t)
  if (!stack.length) stack = [isTab(r.tab) ? r.tab : 'setup']
  const sizes = Array.isArray(r.stack) && r.stack.length === stack.length ? normalize(r.sizes, stack.length) : even(stack.length)
  const focus = typeof r.focus === 'number' && Number.isInteger(r.focus) && r.focus >= 0 && r.focus < stack.length ? r.focus : 0
  return { stack, sizes, focus }
}

/** Focus a section (an index outside the stack leaves it as it is). */
export function focusSection(s: PanelStack, index: number): PanelStack {
  return index >= 0 && index < s.stack.length && index !== s.focus ? { ...s, focus: index } : s
}

/** Picking a tab in the bar: focus its section when it's shown, otherwise show it in the focused section. */
export function focusOrReplace(s: PanelStack, tab: PanelTab): PanelStack {
  const at = s.stack.indexOf(tab)
  if (at >= 0) return focusSection(s, at)
  const focus = Math.min(Math.max(0, s.focus), s.stack.length - 1)
  return { ...s, focus, stack: s.stack.map((t, i) => (i === focus ? tab : t)) }
}

/** Whether another tab can be stacked below. */
export const canStack = (s: PanelStack) => s.stack.length < MAX_STACK

/**
 * Stack a tab as a new section at the bottom, taking an even share of the height from the others.
 * A tab already shown only gets focus; with three sections shown nothing changes.
 */
export function stackBelow(s: PanelStack, tab: PanelTab): PanelStack {
  const at = s.stack.indexOf(tab)
  if (at >= 0) return focusSection(s, at)
  if (!canStack(s)) return s
  const n = s.stack.length
  return { stack: [...s.stack, tab], sizes: [...s.sizes.map((x) => (x * n) / (n + 1)), 1 / (n + 1)], focus: n }
}

/** Remove a section; its height goes to the section above it (below, for the top one). The last section stays. */
export function unstack(s: PanelStack, index: number): PanelStack {
  if (s.stack.length <= 1 || index < 0 || index >= s.stack.length) return s
  const heir = index > 0 ? index - 1 : 1
  const sizes = s.sizes.map((x, i) => (i === heir ? x + s.sizes[index] : x)).filter((_, i) => i !== index)
  const stack = s.stack.filter((_, i) => i !== index)
  const focus = s.focus === index ? (index > 0 ? index - 1 : 0) : s.focus > index ? s.focus - 1 : s.focus
  return { stack, sizes: normalize(sizes, stack.length), focus }
}

/**
 * Shares after dragging the handle below section `index` by `delta` pixels, where `total` is the
 * height the sections' contents share. Only the two sections beside the handle change, and neither
 * gets smaller than `min` pixels (when they can't both fit, the drag changes nothing).
 */
export function resize(sizes: readonly number[], index: number, delta: number, total: number, min = MIN_SECTION): number[] {
  if (index < 0 || index + 1 >= sizes.length || !(total > 0)) return [...sizes]
  const a = sizes[index] * total
  const b = sizes[index + 1] * total
  if (a + b < 2 * min) return [...sizes]
  const nextA = Math.min(Math.max(a + delta, min), a + b - min)
  const out = [...sizes]
  out[index] = nextA / total
  out[index + 1] = (a + b - nextA) / total
  return out
}

/** The tabs the panel shows: phones show only the top one. */
export const shownTabs = (s: PanelStack, mobile: boolean): PanelTab[] => (mobile ? s.stack.slice(0, 1) : s.stack)

/** Show a tab from outside the panel (e.g. a shortcut). Phones keep a single tab. */
export function showTab(s: PanelStack, tab: PanelTab, mobile: boolean): PanelStack {
  return mobile ? { stack: [tab], sizes: [1], focus: 0 } : focusOrReplace(s, tab)
}
