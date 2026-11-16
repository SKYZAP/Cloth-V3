import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, rootCertificates } from 'node:tls'
import { describe, expect, it } from 'vitest'
import type { McpClientConfig } from '../src/shared/types'
import { trustedCertificates, webCaBundlePath } from '../src/main/web/transport'
import { makeServices } from './helpers'

const tmp = () => mkdtempSync(join(tmpdir(), 'cloth-mcp-trust-'))
// Any PEM block stands in for a private CA here: these checks only look at what is passed along.
const FAKE_CA = `-----BEGIN CERTIFICATE-----\nMIIBfakeprivateca\n-----END CERTIFICATE-----\n`

describe('MCP servers list', () => {
  it('tells pages when servers are added anywhere, not only from the MCP page', () => {
    const { services, events } = makeServices()
    const server: McpClientConfig = { id: 'mcp_x', name: 'x', transport: 'stdio', command: 'npx', args: [], env: {}, enabled: true, defaultOn: false, approval: 'ask' }
    const changed = () => events.filter((e) => e.channel === 'mcpClients').length
    services.settings.update({ mcpClients: [server] })
    expect(changed()).toBe(1)
    services.settings.update({ webEngine: services.settings.get().webEngine })
    expect(changed()).toBe(1)
  })
})

describe('certificate trust', () => {
  it('keeps what the computer trusts when a certificate is added', () => {
    const all = trustedCertificates()
    expect(all).toEqual(expect.arrayContaining([...rootCertificates]))
    expect(all).toEqual(expect.arrayContaining(getCACertificates('system')))
    expect(all).toEqual(expect.arrayContaining(getCACertificates('default')))
    const dir = tmp()
    const ca = join(dir, 'corp.pem')
    writeFileSync(ca, FAKE_CA)
    const bundle = readFileSync(webCaBundlePath(ca, dir), 'utf8')
    expect(bundle).toContain('MIIBfakeprivateca')
    expect(bundle).toContain(rootCertificates[0])
  })

  it('hands the certificate to servers Cloth starts', async () => {
    const { services } = makeServices()
    const dir = tmp()
    const ca = join(dir, 'corp.pem')
    writeFileSync(ca, FAKE_CA)
    // A "server" that only writes down the trust settings it was started with, then exits.
    const out = join(dir, 'env.json')
    const script = join(dir, 'server.cjs')
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ node: process.env.NODE_EXTRA_CA_CERTS, ssl: process.env.SSL_CERT_FILE, own: process.env.OWN }))`)
    services.settings.update({
      webCaCertPath: ca,
      mcpClients: [{ id: 'mcp_env', name: 'env', transport: 'stdio', command: process.execPath, args: [script], env: { OWN: '1', ELECTRON_RUN_AS_NODE: '1' }, enabled: true, defaultOn: false, approval: 'ask' }]
    })
    const status = await services.mcpClients.start('mcp_env')
    expect(status.state).toBe('error')
    expect(existsSync(out)).toBe(true)
    const seen = JSON.parse(readFileSync(out, 'utf8')) as { node: string; ssl: string; own: string }
    expect(seen.own).toBe('1')
    expect(seen.node).toBe(seen.ssl)
    expect(readFileSync(seen.node, 'utf8')).toContain('MIIBfakeprivateca')
  }, 30_000)

  it('starts servers as before when no certificate is set', async () => {
    const { services } = makeServices()
    const dir = tmp()
    const out = join(dir, 'env.json')
    const script = join(dir, 'server.cjs')
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ ssl: process.env.SSL_CERT_FILE ?? null }))`)
    services.settings.update({ mcpClients: [{ id: 'mcp_plain', name: 'plain', transport: 'stdio', command: process.execPath, args: [script], env: { SSL_CERT_FILE: 'mine.pem' }, enabled: true, defaultOn: false, approval: 'ask' }] })
    await services.mcpClients.start('mcp_plain')
    expect(JSON.parse(readFileSync(out, 'utf8')).ssl).toBe('mine.pem')
  }, 30_000)
})
