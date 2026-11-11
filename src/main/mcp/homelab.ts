import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpClientConfig, McpPreset } from '@shared/types'

/**
 * The homelab presets' tokens live in a local env file, never in the app or the repo:
 * `~/.homelab/env` (or the file HOMELAB_ENV names), one `KEY=value` per line. Which key each
 * preset reads:
 */
export const PRESET_TOKEN_KEYS: Record<string, string> = {
  homelab: 'MCP_AUTH_TOKEN',
  obsidian: 'OBSIDIAN_MCP_TOKEN',
  penpot: 'PENPOT_MCP_TOKEN',
  plane: 'PLANE_API_KEY'
}

export const homelabEnvPath = (): string => process.env.HOMELAB_ENV || join(homedir(), '.homelab', 'env')

/** `KEY=value` lines (optional `export `, quotes and `#` comments); a missing or unreadable file is empty. */
export function readEnvFile(path = homelabEnvPath()): Record<string, string> {
  if (!existsSync(path)) return {}
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

/** A preset's config with its token put where the server expects it: a query parameter or a bearer header. */
export function withToken(p: McpPreset, token: string): Omit<McpClientConfig, 'id'> {
  const { about: _about, needsToken: _needs, tokenQuery, ...config } = p
  if (tokenQuery) {
    const url = new URL(config.url ?? '')
    url.searchParams.set(tokenQuery, token)
    return { ...config, url: url.toString() }
  }
  return { ...config, headers: { ...(config.headers ?? {}), Authorization: `Bearer ${token}` } }
}

/** The presets as the MCP page offers them: those with a token on file come ready to add, token included. */
export function presetsWithTokens(presets: McpPreset[], env: Record<string, string>): McpPreset[] {
  return presets.map((p) => {
    const token = p.needsToken ? env[PRESET_TOKEN_KEYS[p.name] ?? ''] : undefined
    return token ? { ...withToken(p, token), about: p.about } : p
  })
}

/** Penpot's plugin-based MCP, replaced by penpot-api-mcp. */
const OLD_PENPOT_URL = 'http://design.example.internal/mcp/stream'

/**
 * Points a server still set up for Penpot's old plugin-based MCP at the new one, keeping its id and
 * on/off choices. With the token on file it is ready to use; without, the token field is left empty.
 * Returns null when nothing needs to change.
 */
export function migrateOldPenpot(clients: McpClientConfig[], presets: McpPreset[], env: Record<string, string>): McpClientConfig[] | null {
  const preset = presets.find((p) => p.name === 'penpot')
  if (!preset || !clients.some((c) => c.url?.startsWith(OLD_PENPOT_URL))) return null
  const token = env[PRESET_TOKEN_KEYS.penpot]
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  return clients.map((c) => (c.url?.startsWith(OLD_PENPOT_URL) ? { ...c, url: preset.url, headers } : c))
}

/**
 * The servers to add at startup: each homelab preset with a token on file that isn't set up yet and
 * hasn't been added before (so one the user removed stays removed). `seeded` is that memory.
 */
export function serversToSeed(presets: McpPreset[], env: Record<string, string>, have: string[], seeded: string[]): Omit<McpClientConfig, 'id'>[] {
  return presets
    .filter((p) => p.needsToken && env[PRESET_TOKEN_KEYS[p.name] ?? ''] && !have.includes(p.name) && !seeded.includes(p.name))
    .map((p) => withToken(p, env[PRESET_TOKEN_KEYS[p.name]]))
}
