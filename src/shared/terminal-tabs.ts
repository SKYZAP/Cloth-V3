import type { TerminalEvent, TerminalInfo } from './types'

// The chat side panel's terminal tabs: which terminals a chat lists, and when showing the tab starts one.

/** The chat's tabs with a terminal it opened: other chats' terminals are left out, and each terminal is listed once. */
export function withTerminal(list: TerminalInfo[] | null, sessionId: string, t: TerminalInfo): TerminalInfo[] | null {
  if (t.sessionId !== sessionId || list?.some((x) => x.id === t.id)) return list
  return [...(list ?? []), t]
}

/**
 * The chat's tabs after a terminal event (the same list when it doesn't change them). Before the list
 * has loaded (null) events are dropped: the load on its way already includes what they report.
 */
export function terminalsAfter(list: TerminalInfo[] | null, sessionId: string, e: TerminalEvent): TerminalInfo[] | null {
  if (!list) return list
  if (e.type === 'opened') return withTerminal(list, sessionId, e.terminal)
  if (e.type === 'closed') return e.sessionId === sessionId && list.some((t) => t.id === e.id) ? list.filter((t) => t.id !== e.id) : list
  if (e.type === 'exit') return list.some((t) => t.id === e.id) ? list.map((t) => (t.id === e.id ? { ...t, running: false, exitCode: e.code } : t)) : list
  return list
}

/**
 * Whether showing the Terminal tab starts a shell. It is decided once, the first time the tab is shown
 * with the chat's terminals loaded: a shell starts only when the chat has none. Closing the last
 * terminal afterwards leaves the tab empty rather than starting another.
 */
export function autoStart(decided: boolean, visible: boolean, list: readonly TerminalInfo[] | null): { decided: boolean; start: boolean } {
  if (decided || !visible || !list) return { decided, start: false }
  return { decided: true, start: !list.length }
}
