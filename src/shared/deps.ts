/** Programs Cloth ships with or uses from this PC, as Settings → Dependencies shows them. */

export type DependencyId = 'obscura' | 'searxng' | 'openspec' | 'git' | 'gh' | 'docker' | 'node' | 'python' | 'bash' | 'pwsh'

/** ok: there and usable. warn: there but not usable yet (Docker not running, gh signed out). missing: not found. */
export type DependencyStatus = 'ok' | 'warn' | 'missing'

export interface Dependency {
  id: DependencyId
  name: string
  /** Shipped inside Cloth, or found on this PC. */
  source: 'bundled' | 'system'
  status: DependencyStatus
  version: string | null
  /** What in Cloth uses it. */
  usedFor: string
  /** Why it's a warning, or what happens without it. */
  detail?: string
  /** Nothing breaks without it (Cloth uses something else). */
  optional?: boolean
  /** Where to get it, for a program on this PC. */
  url?: string
}

export interface DependencyReport {
  items: Dependency[]
  checkedAt: number
}
