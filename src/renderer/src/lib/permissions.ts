import type { ChatSession, Permissions, UiMessage } from '@shared/types'

/** The three permission modes in Shift+Tab order, with the copy the composer's menu shows. */
export const PERMISSION_MODES: { id: Permissions; name: string; sub: string; note: { lead: string; rest: string } }[] = [
  {
    id: 'auto',
    name: 'Auto',
    sub: 'Edits files and runs commands on its own; still asks before anything risky.',
    note: {
      lead: 'Still asks before:',
      rest: 'deleting or writing outside the folder, git push, installing packages, downloading from the network. In a Linux container it doesn’t ask; you review the changes instead.'
    }
  },
  {
    id: 'manual',
    name: 'Manual',
    sub: 'Reads freely; asks before every change and every command.',
    note: { lead: 'Asks before:', rest: 'every file change (as a diff) and every command. Reading and searching never ask.' }
  },
  {
    id: 'plan',
    name: 'Plan',
    sub: 'Reads and drafts a plan. Nothing changes until you approve it.',
    note: { lead: 'Read-only until you approve.', rest: 'Approving switches the chat to Auto or Manual and it carries on.' }
  }
]

export const permissionMode = (id: Permissions) => PERMISSION_MODES.find((m) => m.id === id) ?? PERMISSION_MODES[0]

/** The mode Shift+Tab switches to: auto → manual → plan → auto. */
export function nextPermission(current: Permissions): Permissions {
  const i = PERMISSION_MODES.findIndex((m) => m.id === current)
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length].id
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
