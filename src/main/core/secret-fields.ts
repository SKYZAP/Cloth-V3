import type { McpClientConfig } from '@shared/types'
import { isMasked, isSecretName, maskValue } from '@shared/secret-fields'
import type { Secrets } from './context'

/*
 * Sealing, opening, masking and restoring the secrets inside MCP server and provider settings
 * (see shared/secret-fields.ts for which fields count).
 */

const SEALED = 'enc:v1:'

type Fn = (value: string, name: string) => string

/** The secret entries of a name → value map, changed by `fn`. */
export function mapSecrets(rec: Record<string, string>, fn: Fn): Record<string, string> {
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, typeof v === 'string' && isSecretName(k) ? fn(v, k) : v]))
}

/** The secret query parameters of an address, changed by `fn`; other addresses come back as they were. */
export function mapUrlSecrets(url: string, fn: Fn): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  let changed = false
  for (const [k, v] of [...u.searchParams]) {
    if (!isSecretName(k)) continue
    const next = fn(v, k)
    if (next !== v) {
      u.searchParams.set(k, next)
      changed = true
    }
  }
  return changed ? u.toString() : url
}

export function mapClient<T extends Pick<McpClientConfig, 'env' | 'headers' | 'url'>>(c: T, fn: Fn): T {
  return {
    ...c,
    ...(c.env ? { env: mapSecrets(c.env, fn) } : {}),
    ...(c.headers ? { headers: mapSecrets(c.headers, fn) } : {}),
    ...(c.url ? { url: mapUrlSecrets(c.url, fn) } : {})
  }
}

export const sealer = (box: Secrets): Fn => (v) => (!v || v.startsWith(SEALED) ? v : SEALED + Buffer.from(box.encrypt(v)).toString('base64'))

/** A sealed value opened; one that can't be (another PC's keychain) reads as empty, so it is asked for again. */
export const opener = (box: Secrets): Fn => (v) => {
  if (!v.startsWith(SEALED)) return v
  try {
    return box.decrypt(Buffer.from(v.slice(SEALED.length), 'base64'))
  } catch {
    return ''
  }
}

export const masker: Fn = (v) => maskValue(v)

/** Any secret value of a map, by name; an address's are found under its parameter names. */
function secretsOf(c: Pick<McpClientConfig, 'env' | 'headers' | 'url'>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (k: string, v: string) => isSecretName(k) && v && out.set(k.toLowerCase(), [...(out.get(k.toLowerCase()) ?? []), v])
  for (const [k, v] of Object.entries(c.headers ?? {})) add(k, v)
  for (const [k, v] of Object.entries(c.env ?? {})) add(k, v)
  if (c.url)
    try {
      for (const [k, v] of new URL(c.url).searchParams) add(k, v)
    } catch {
      /* not an address */
    }
  return out
}

/**
 * Masked values in a config the app sent back, replaced by the saved secrets they stand for. `known` are
 * where a secret may come from, in order: the saved server with the same id, then a preset with its token.
 * The token may have moved between a header and the address (Penpot's goes in the address), so a value
 * matches any known secret whose mask it equals: a bearer header's token fills an address parameter too.
 * A mask with nothing behind it is cleared, so a placeholder is never saved as a token.
 */
export function restoreClient<T extends Pick<McpClientConfig, 'env' | 'headers' | 'url'>>(c: T, known: Pick<McpClientConfig, 'env' | 'headers' | 'url'>[]): T {
  const pools = known.map(secretsOf)
  const fill: (value: string, name: string) => string = (v, name) => {
    if (!isMasked(v)) return v
    for (const pool of pools) {
      const same = pool.get(name.toLowerCase()) ?? []
      const all = [...pool.values()].flat()
      for (const s of [...same, ...all]) {
        if (maskValue(s) === v) return s
        // A bearer token moved into an address parameter (or back).
        const bare = s.replace(/^(bearer|basic|token)\s+/i, '')
        if (maskValue(bare) === v) return bare
        if (maskValue(`Bearer ${s}`) === v) return `Bearer ${s}`
      }
    }
    return ''
  }
  return mapClient(c, fill)
}

/** A provider's headers: masked for the app, restored when the app sends the masks back. */
export function restoreHeaders(next: Record<string, string>, saved: Record<string, string>): Record<string, string> {
  return mapSecrets(next, (v, k) => (isMasked(v) ? (saved[k] && maskValue(saved[k]) === v ? saved[k] : '') : v))
}
