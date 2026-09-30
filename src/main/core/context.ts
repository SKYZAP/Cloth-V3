import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import { Kv } from './db'

/** Encrypts secrets at rest. Electron's safeStorage in the app, a passthrough in tests. */
export interface Secrets {
  encrypt(plain: string): Uint8Array
  decrypt(data: Uint8Array): string
}

export type EventChannel = 'chat' | 'workflow' | 'ingest' | 'mcp' | 'skills' | 'tools' | 'web' | 'remote'

export interface Ctx {
  db: Db
  kv: Kv
  dataDir: string
  skillsDir: string
  /** Folder holding bundled sidecars (obscura/, searxng/) — resources in a packaged build. */
  sidecarsDir: string
  /** Bundled example knowledge documents. */
  examplesDir: string
  secrets: Secrets
  emit(channel: EventChannel, payload: unknown): void
  log(scope: string, ...args: unknown[]): void
}

export const plainSecrets: Secrets = {
  encrypt: (plain) => new TextEncoder().encode(plain),
  decrypt: (data) => new TextDecoder().decode(data)
}

export const newId = (prefix = ''): string => prefix + randomUUID().replace(/-/g, '').slice(0, 16)

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err)
}
