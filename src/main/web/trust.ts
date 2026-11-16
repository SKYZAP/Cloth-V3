import { X509Certificate, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { connect, getCACertificates, rootCertificates, setDefaultCACertificates, type DetailedPeerCertificate } from 'node:tls'
import type { CertificateInfo, NetworkCheck, NetworkProbe } from '@shared/types'
import { trustedCertificates, webCaBundlePath } from './transport'

/** Variables programs Cloth starts read for extra trust: Node, Python (pip, uv, requests), curl-style tools. */
const ENV_KEYS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'] as const

let startupEnv: Record<string, string | undefined> | null = null

/** What the person calls the operating system's certificate store. */
export function systemStoreName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'the macOS Keychain' : 'the system certificates'
}

const pemBlocks = (text: string) => text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
const commonName = (dn: string) => /CN=([^\n,]+)/.exec(dn)?.[1]?.trim() ?? dn.split('\n')[0]

/**
 * Trust, across Cloth, what this computer trusts (Node's roots, NODE_EXTRA_CA_CERTS, and Windows' store or the macOS
 * Keychain, where antivirus and company proxies install theirs) plus the certificate set in Settings → Network: every
 * HTTPS call the app makes (model providers, web search, MCP, updates, the skills registry) and, when a certificate is set,
 * every program it starts (the shell tool, terminals, MCP servers). Returns an error message when the file can't be used;
 * the computer's own certificates are trusted then all the same.
 */
export function applyNetworkCertificate(path: string, dataDir: string): string | null {
  startupEnv ??= Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) {
    if (startupEnv[k] === undefined) delete process.env[k]
    else process.env[k] = startupEnv[k]
  }
  const base = trustedCertificates()
  const ca = path.trim()
  try {
    if (ca) {
      const info = certificateInfo(ca)
      if ('error' in info) throw new Error(info.error)
      setDefaultCACertificates([...base, ...pemBlocks(readFileSync(resolve(ca), 'utf8'))])
      const bundle = webCaBundlePath(ca, join(dataDir, 'web-certificates'))
      for (const k of ENV_KEYS) process.env[k] = bundle
      return null
    }
    setDefaultCACertificates(base)
    return null
  } catch (err) {
    try {
      setDefaultCACertificates(base)
    } catch {
      /* keep Node's own list */
    }
    return err instanceof Error ? err.message : String(err)
  }
}

/** What a certificate file holds, for Settings → Network to show before (and after) it is used. */
export function certificateInfo(path: string): CertificateInfo {
  try {
    const blocks = pemBlocks(readFileSync(resolve(path.trim()), 'utf8'))
    if (!blocks.length) return { error: 'This file has no PEM certificate in it (a block starting -----BEGIN CERTIFICATE-----).' }
    const first = new X509Certificate(blocks[0]!)
    return { subject: commonName(first.subject), issuer: commonName(first.issuer), validTo: new Date(first.validTo).getTime(), count: blocks.length, ca: first.ca }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: /ENOENT/.test(msg) ? 'That file no longer exists.' : `This certificate can't be read: ${msg}` }
  }
}

/** Sites the check connects to: ones setup needs first (model providers, GitHub). */
export const CHECK_HOSTS = ['api.openai.com', 'api.anthropic.com', 'github.com']

const PUBLIC_ROOTS = new Set(rootCertificates.map((pem) => new X509Certificate(pem).fingerprint256))

/** The certificate at the top of what the site sent (the root, or the last one it sent when the root is left out). */
function topOf(cert: DetailedPeerCertificate): DetailedPeerCertificate {
  let c = cert
  for (let i = 0; i < 10 && c.issuerCertificate && c.issuerCertificate !== c && c.issuerCertificate.fingerprint256 !== c.fingerprint256; i++) c = c.issuerCertificate
  return c
}

/**
 * Connect to one site and look at who signed what came back. Verification is off for this one handshake only so an
 * untrusted chain can be read and named; nothing is sent over it, and whether the chain is trusted is still reported
 * (socket.authorized checks it against the same trust everything else uses).
 */
export function probeHost(host: string, timeoutMs = 8000): Promise<NetworkProbe> {
  return new Promise((done) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs })
    const finish = (p: NetworkProbe) => {
      socket.destroy()
      done(p)
    }
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate(true)
      if (!cert?.raw) return finish({ host, state: 'error', error: 'The site sent no certificate' })
      const top = topOf(cert)
      const issuer = commonName(top.issuer ? Object.entries(top.issuer).map(([k, v]) => `${k}=${v}`).join('\n') : '')
      // Signed under a public root: the site's own certificate. Anything else is something on the way re-signing it.
      const publicRoot = PUBLIC_ROOTS.has(top.fingerprint256) || publicIssuer(top)
      const trusted = socket.authorized
      if (publicRoot && trusted) return finish({ host, state: 'direct' })
      finish({ host, state: trusted ? 'inspected' : 'untrusted', issuer, ...(trusted ? {} : { error: String(socket.authorizationError ?? '') }) })
    })
    socket.once('timeout', () => finish({ host, state: 'error', error: `No answer from ${host}` }))
    socket.once('error', (err) => finish({ host, state: 'error', error: err.message }))
  })
}

/** Whether a top certificate the site sent (not always the root) was issued by one of the public roots Node ships. */
function publicIssuer(top: DetailedPeerCertificate): boolean {
  if (!top.raw) return false
  try {
    const x = new X509Certificate(top.raw)
    return rootCertificates.some((pem) => {
      const root = new X509Certificate(pem)
      return x.checkIssued(root) && x.verify(root.publicKey)
    })
  } catch {
    return false
  }
}

/**
 * Whether this computer's connections reach sites directly, are inspected by something Cloth trusts (antivirus, a company
 * proxy whose certificate is in Windows or the Keychain), or are inspected by something it doesn't, and in that last case
 * the matching certificate in the system store, if there is one, to offer instead of a file.
 */
export async function checkNetwork(hosts = CHECK_HOSTS): Promise<NetworkCheck> {
  const probes = await Promise.all(hosts.map((h) => probeHost(h)))
  const reached = probes.filter((p) => p.state !== 'error')
  const untrusted = reached.find((p) => p.state === 'untrusted')
  const inspected = reached.find((p) => p.state === 'inspected')
  const state: NetworkCheck['state'] = !reached.length ? 'offline' : untrusted ? 'untrusted' : inspected ? 'inspected' : 'direct'
  const issuer = (untrusted ?? inspected)?.issuer ?? null
  return { state, issuer, store: systemStoreName(), candidate: untrusted?.issuer ? systemCandidate(untrusted.issuer) : null, probes, checkedAt: Date.now() }
}

/** A certificate in the system store named like the one re-signing connections (the person's to choose). */
function systemCandidate(issuer: string): NetworkCheck['candidate'] {
  let list: string[] = []
  try {
    list = getCACertificates('system')
  } catch {
    return null
  }
  for (const pem of list) {
    try {
      const x = new X509Certificate(pem)
      if (commonName(x.subject) !== issuer) continue
      return { subject: issuer, validTo: new Date(x.validTo).getTime(), fingerprint: x.fingerprint256 }
    } catch {
      /* skip unreadable entries */
    }
  }
  return null
}

/** Save a certificate from the system store as a PEM file in Cloth's data folder; returns its path for the setting. */
export function saveSystemCertificate(fingerprint: string, dataDir: string): string {
  const pem = getCACertificates('system').find((p) => {
    try {
      return new X509Certificate(p).fingerprint256 === fingerprint
    } catch {
      return false
    }
  })
  if (!pem) throw new Error(`That certificate is no longer in ${systemStoreName()}`)
  const dir = join(dataDir, 'web-certificates')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `system-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 12)}.pem`)
  writeFileSync(file, pem.endsWith('\n') ? pem : `${pem}\n`)
  return file
}

const TLS_CODES = /UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_UNTRUSTED|unable to verify the first certificate|self[- ]signed certificate|unable to get local issuer certificate/i

/** Whether an error (or any error it wraps) is a certificate that isn't trusted. */
export function isCertificateError(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 6; i++) {
    const o = e as { message?: string; code?: string; cause?: unknown }
    if (TLS_CODES.test(`${o.code ?? ''} ${o.message ?? ''}`)) return true
    e = o.cause
  }
  return false
}
