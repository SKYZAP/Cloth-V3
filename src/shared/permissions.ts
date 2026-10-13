import type { AutoApprove, FileAccess, Permissions } from './types'

/** What a permission mode lets the agent do, as the tool switches the runtime is built from. */
export interface PermissionCaps {
  fileAccess: FileAccess
  shell: boolean
  autoApprove: AutoApprove
}

/**
 * The one place a chat's permission mode turns into tool switches; nothing else decides them.
 * - auto: read, write and commands; nothing asks, risky actions included (see `asksBeforeRisky`).
 * - manual: read, write and commands; only risky actions ask (see main/agent/risk.ts).
 * - plan: read-only, no commands, until the user approves a plan.
 */
export function permissionCaps(p: Permissions): PermissionCaps {
  switch (p) {
    case 'plan':
      return { fileAccess: 'read', shell: false, autoApprove: 'none' }
    default:
      return { fileAccess: 'write', shell: true, autoApprove: 'all' }
  }
}

/**
 * Whether risky actions (risk.ts) still need a person's OK: everywhere except a chat in Auto. An
 * unattended run (no chat, or no mode) always checks, and refuses them since nobody can say yes.
 */
export function asksBeforeRisky(p: Permissions | undefined, attended: boolean): boolean {
  return !(attended && p === 'auto')
}

export const PERMISSION_MODES: Permissions[] = ['auto', 'manual', 'plan']

export function isPermissions(v: unknown): v is Permissions {
  return v === 'auto' || v === 'manual' || v === 'plan'
}

/** The switches chats (and project defaults) had before permission modes. */
export interface LegacyCaps {
  fileAccess?: FileAccess
  shell?: boolean
  autoApprove?: AutoApprove
}

/**
 * The mode a chat set up with the old switches gets: container chats → auto (their changes are
 * reviewed with Apply/Discard); a read-only folder without commands → plan; otherwise → manual,
 * which still asks before risky actions (never the looser Auto). A chat without a folder has no
 * files to protect, so read-only keeps its approvals (manual) rather than becoming a plan.
 */
export function legacyPermissions(l: LegacyCaps, where: { workspace?: string | null; container?: unknown } = {}): Permissions {
  if (where.container) return 'auto'
  const fileAccess = l.fileAccess ?? 'read'
  if (where.workspace && fileAccess === 'read' && !l.shell) return 'plan'
  return 'manual'
}

/** True when the patch sets one of the old switches. */
export function hasLegacyCaps(p: LegacyCaps): boolean {
  return p.fileAccess !== undefined || p.shell !== undefined || p.autoApprove !== undefined
}
