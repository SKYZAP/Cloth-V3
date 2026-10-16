import type { ChatSession, Permissions, UiMessage } from '@shared/types'

/** What the agent may do without asking, in the Access menu's order. */
export type Access = 'auto' | 'manual'

export const ACCESS_LEVELS: { id: Access; name: string; sub: string; note: { lead: string; rest: string } }[] = [
  {
    id: 'auto',
    name: 'Auto',
    sub: 'Edits, runs commands and takes risky actions without asking.',
    note: { lead: 'Never asks,', rest: 'not even before risky actions. MCP servers you set to ask still ask, and you can undo file changes.' }
  },
  {
    id: 'manual',
    name: 'Manual',
    sub: 'Works on its own, but asks before risky actions: outside the folder, deleting, pushing, installing, downloading or admin rights.',
    note: {
      lead: 'Asks before:',
      rest: 'deleting or writing outside the folder, git push, installing packages, downloading from the network, admin rights. In a Linux container it doesn’t ask; you review the changes instead.'
    }
  }
]

export const accessLevel = (id: Access) => ACCESS_LEVELS.find((m) => m.id === id) ?? ACCESS_LEVELS[1]

/** How the chat works: separate from what it may do without asking (its access). */
export type ChatMode = 'chat' | 'plan' | 'spec'

export const CHAT_MODES: { id: ChatMode; name: string; sub: string }[] = [
  { id: 'chat', name: 'Chat', sub: 'Talks and works straight away.' },
  { id: 'plan', name: 'Plan', sub: 'Reads and drafts a plan first. Nothing changes until you approve it.' },
  { id: 'spec', name: 'Spec → ship', sub: 'Questions, spec, tickets, build and review, with your OK between stages. Starts when you send what you want built.' }
]

export const chatModeInfo = (id: ChatMode) => CHAT_MODES.find((m) => m.id === id) ?? CHAT_MODES[0]

/** The chat's mode: Spec → ship while its workflow runs, Plan while planning, else Chat. */
export function chatMode(session: Pick<ChatSession, 'permissions' | 'workflow'>): ChatMode {
  if (session.workflow && session.workflow.stage !== 'done') return 'spec'
  return session.permissions === 'plan' ? 'plan' : 'chat'
}

/** The access that applies outside Plan mode (and after a plan is approved). */
export function accessOf(session: Pick<ChatSession, 'permissions' | 'access'>): Access {
  if (session.permissions === 'auto' || session.permissions === 'manual') return session.permissions
  return session.access ?? 'manual'
}

/** Shift+Tab: Chat ⇄ Plan, as the permissions patch to apply. Spec → ship is only left from the menu (null). */
export function nextModePatch(session: Pick<ChatSession, 'permissions' | 'access' | 'workflow'>): { permissions: Permissions } | null {
  const mode = chatMode(session)
  if (mode === 'spec') return null
  return { permissions: mode === 'plan' ? accessOf(session) : 'plan' }
}

/**
 * Whether a key press should cycle the permission mode: plain Shift+Tab, and only while the message
 * box has focus or nothing does (other fields keep Shift+Tab for moving focus back).
 */
export function cyclesPermission(e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }, focus: 'composer' | 'none' | 'other'): boolean {
  return e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && focus !== 'other'
}

/**
 * The state of a plan presented in `messages[index]`: open (waiting for approval: the latest message
 * and no run going), approved (the next message approved it) or closed (the chat moved on).
 */
export function planStatus(messages: Pick<UiMessage, 'role' | 'planApproval'>[], index: number, running: boolean): 'open' | 'approved' | 'closed' {
  const next = messages[index + 1]
  if (next) return next.role === 'user' && next.planApproval ? 'approved' : 'closed'
  return running ? 'closed' : 'open'
}

/** How many knowledge collections the chat searches (none when knowledge is off; empty ids = all). */
export function knowledgeCount(session: Pick<ChatSession, 'knowledgeEnabled' | 'collectionIds'>, collectionIds: string[]): number {
  if (!session.knowledgeEnabled) return 0
  return session.collectionIds.length ? session.collectionIds.filter((id) => collectionIds.includes(id)).length : collectionIds.length
}
