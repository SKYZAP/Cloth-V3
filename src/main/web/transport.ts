import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { rootCertificates } from 'node:tls'
import { Agent, fetch as undiciFetch } from 'undici'
import type { RequestInit as UndiciRequestInit, Response } from 'undici'

const dispatchers = new Map<string, { modifiedAt: number; size: number; digest: string; agent: Agent }>()
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
  writeFileSync(bundlePath, `${rootCertificates.join('\n')}\n${certificate}`)
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
  const agent = new Agent({ connect: { ca: [...rootCertificates, certificate] } })
  dispatchers.set(resolved, { modifiedAt: stats.mtimeMs, size: stats.size, digest, agent })
  return undiciFetch(input, { ...init, dispatcher: agent })
}
