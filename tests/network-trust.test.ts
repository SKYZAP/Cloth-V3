import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, rootCertificates } from 'node:tls'
import { afterAll, describe, expect, it } from 'vitest'
import { applyNetworkCertificate, certificateInfo, isCertificateError, systemStoreName } from '../src/main/web/trust'
import { certificateHint } from '../src/main/providers/providers'

const tmp = () => mkdtempSync(join(tmpdir(), 'cloth-trust-'))
const KEYS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

afterAll(() => applyNetworkCertificate('', tmp()))

describe('the system certificate store', () => {
  it('is named the way each platform calls it', () => {
    expect(systemStoreName('win32')).toBe('Windows')
    expect(systemStoreName('darwin')).toBe('the macOS Keychain')
    expect(systemStoreName('linux')).toBe('the system certificates')
  })

  it('is trusted by the whole app even with no certificate set', () => {
    const dir = tmp()
    expect(applyNetworkCertificate('', dir)).toBeNull()
    const trusted = new Set(getCACertificates('default'))
    for (const c of getCACertificates('system').slice(0, 20)) expect(trusted.has(c)).toBe(true)
    // Programs Cloth starts keep what they had: nothing is set for them without a certificate.
    for (const k of KEYS) expect(process.env[k]).toBe(saved[k])
  })
})

describe('a certificate set in Settings → Network', () => {
  const dir = tmp()
  const file = join(dir, 'corp.pem')
  // A real CA certificate stands in for a company's: one of Node's own roots.
  writeFileSync(file, rootCertificates[0]!)

  it('is described before it is used', () => {
    const info = certificateInfo(file)
    expect('error' in info).toBe(false)
    if ('error' in info) return
    expect(info.ca).toBe(true)
    expect(info.count).toBe(1)
    expect(info.validTo).toBeGreaterThan(0)
    expect(certificateInfo(join(dir, 'missing.pem'))).toEqual({ error: 'That file no longer exists.' })
    const junk = join(dir, 'junk.pem')
    writeFileSync(junk, 'not a certificate')
    expect(certificateInfo(junk)).toMatchObject({ error: expect.stringMatching(/no PEM certificate/) })
  })

  it('goes to programs Cloth starts as one bundle with everything else trusted, and comes off again', () => {
    expect(applyNetworkCertificate(file, dir)).toBeNull()
    const bundle = process.env.NODE_EXTRA_CA_CERTS!
    for (const k of KEYS) expect(process.env[k]).toBe(bundle)
    const text = readFileSync(bundle, 'utf8')
    expect(text).toContain(rootCertificates[0]!.trim())
    expect(text).toContain(rootCertificates[1]!.trim())
    expect(applyNetworkCertificate('', dir)).toBeNull()
    for (const k of KEYS) expect(process.env[k]).toBe(saved[k])
  })

  it('that cannot be read changes nothing for programs and says why', () => {
    const junk = join(dir, 'junk2.pem')
    writeFileSync(junk, 'nope')
    expect(applyNetworkCertificate(junk, dir)).toMatch(/no PEM certificate/)
    for (const k of KEYS) expect(process.env[k]).toBe(saved[k])
  })
})

describe('certificate errors', () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }) })

  it('are recognised through the errors that wrap them', () => {
    expect(isCertificateError(refused)).toBe(true)
    expect(isCertificateError(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }))).toBe(false)
  })

  it('tell the person where to fix them when a provider fails to connect', () => {
    const hinted = certificateHint(refused, 'https://api.openai.com/v1') as Error
    expect(hinted.message).toMatch(/api\.openai\.com/)
    expect(hinted.message).toMatch(/Settings → Network/)
    const other = new Error('401 Unauthorized')
    expect(certificateHint(other, 'https://api.openai.com/v1')).toBe(other)
  })
})
