import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getCACertificates, rootCertificates } from 'node:tls'
import { Agent, fetch as undiciFetch } from 'undici'
import type { RequestInit as UndiciRequestInit, Response } from 'undici'

const dispatchers = new Map<string, { modifiedAt: number; size: number; digest: string; agent: Agent }>()

/**
 * What the computer already trusts, for a list the chosen certificate is added to: Node's roots, certificates from
 * NODE_EXTRA_CA_CERTS (antivirus and corporate proxies set it) and the operating system's store (where they install
 * theirs). Replacing the list with Node's roots alone broke HTTPS on computers whose traffic such software inspects.
 * Node's own list is read once, at startup: Settings → Network changes it later (trust.ts), and a certificate set then
 * and replaced since must not linger in it.
 */
export function trustedCertificates(): string[] {
  const out = new Set<string>(STARTUP_DEFAULT)
  try {
    for (const c of getCACertificates('system')) out.add(c)
  } catch {
    /* not available on this Node, or the store can't be read */
  }
  return [...out]
}
const STARTUP_DEFAULT: string[] = (() => {
  try {
    return [...new Set([...rootCertificates, ...getCACertificates('default')])]
  } catch {
    return [...rootCertificates]
  }
})()
const bundlePaths = new Map<string, { modifiedAt: number; size: number; digest: string; path: string }>()

export function webCaBundlePath(caCertPath: string, dataDir: string): string {
  const path = resolve(caCertPath.trim())
  const stats = statSync(path)
  const certificate = readFileSync(path)
  const digest = createHash('sha256').update(certificate).digest('hex')
  const existing = bundlePaths.get(path)
  if (existing && existing.modifiedAt === stats.mtimeMs && existing.size === stats.size && existing.digest === digest) return existing.path
  const bundlePath = join(dataDir, `web-ca-${createHash('sha256').update(path).digest('hex').slice(0, 16)}.pem`)
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(bundlePath, `${trustedCertificates().join('\n')}\n${certificate}`)
  bundlePaths.set(path, { modifiedAt: stats.mtimeMs, size: stats.size, digest, path: bundlePath })
  return bundlePath
}

export function fetchWithWebCa(input: string | URL, init: UndiciRequestInit = {}, caCertPath?: string): Promise<Response> {
  const path = caCertPath?.trim()
  if (!path) return undiciFetch(input, init)
  const resolved = resolve(path)
  const stats = statSync(resolved)
  const certificate = readFileSync(resolved)
  const digest = createHash('sha256').update(certificate).digest('hex')
  const existing = dispatchers.get(resolved)
  if (existing && existing.modifiedAt === stats.mtimeMs && existing.size === stats.size && existing.digest === digest) {
    return undiciFetch(input, { ...init, dispatcher: existing.agent })
  }
  const agent = new Agent({ connect: { ca: [...trustedCertificates(), certificate] } })
  dispatchers.set(resolved, { modifiedAt: stats.mtimeMs, size: stats.size, digest, agent })
  return undiciFetch(input, { ...init, dispatcher: agent })
}
