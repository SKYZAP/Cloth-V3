import type { AgentMessage } from '@earendil-works/pi-agent-core'

export const SCREENSHOTS_KEPT = 3
export const SCREENSHOT_REMOVED = '(earlier screenshot removed)'

/**
 * The history with only the latest `keep` computer-tool screenshots: older ones become a short
 * note. Returns the same array when nothing changes; never mutates the messages it is given.
 */
export function pruneScreenshots(messages: AgentMessage[], keep = SCREENSHOTS_KEPT): AgentMessage[] {
  let seen = 0
  let out: AgentMessage[] | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'toolResult' || m.toolName !== 'computer' || !m.content.some((c) => c.type === 'image')) continue
    let changed = false
    const content = [...m.content].reverse().map((c) => {
      if (c.type !== 'image') return c
      if (++seen <= keep) return c
      changed = true
      return { type: 'text' as const, text: SCREENSHOT_REMOVED }
    }).reverse()
    if (!changed) continue
    out ??= messages.slice()
    out[i] = { ...m, content }
  }
  return out ?? messages
}
