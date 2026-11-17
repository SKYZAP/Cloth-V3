import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { serveMcp } from '../src/main/mcp/http'
import { makeServices } from './helpers'
import { connectionKey, expandVars } from '../src/main/mcp/client'

/**
 * A server that wants an OAuth sign-in, the way Datadog's, Linear's and Notion's do: 401 with a resource
 * metadata pointer, authorization-server metadata, dynamic client registration, PKCE code flow, refresh.
 */
function oauthServer() {
  let base = ''
  const issued = { codes: 0, tokens: 0, registered: 0 }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    const body = await new Promise<string>((r) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => r(b))
    })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(200, { resource: `${base}/mcp`, authorization_servers: [base] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      })
    if (url.pathname === '/register') {
      issued.registered++
      return json(201, { ...JSON.parse(body), client_id: 'cloth-client' })
    }
    if (url.pathname === '/authorize') {
      // The "browser" signs in at once and is sent back to Cloth with a code.
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', 'the-code')
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      issued.codes++
      return res.writeHead(302, { location: back.toString() }).end()
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body)
      if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'the-code' && form.get('code_verifier')) {
        issued.tokens++
        return json(200, { access_token: 'good-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh' })
      }
      return json(400, { error: 'invalid_grant' })
    }
    if (url.pathname === '/mcp') {
      if (req.headers.authorization !== 'Bearer good-token') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'invalid_token' }))
      }
      if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end()
      const mcp = new McpServer({ name: 'locked', version: '1.0.0' })
      mcp.registerTool('whoami', { description: 'Who is signed in' }, async () => ({ content: [{ type: 'text', text: 'signed in' }] }))
      await serveMcp(mcp, req, res, body ? JSON.parse(body) : undefined)
      return
    }
    res.writeHead(404).end()
  })
  return {
    issued,
    start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r((base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`)))),
    stop: () => new Promise<void>((r) => server.close(() => r()))
  }
}

describe('MCP servers that sign in with OAuth', () => {
  const remote = oauthServer()
  const opened: string[] = []
  // Stands in for the system browser: follow the sign-in page's redirect back to Cloth's listener.
  const { services } = makeServices({ openUrl: (u) => (opened.push(u), void fetch(u).catch(() => undefined)) })
  let base = ''
  beforeAll(async () => {
    base = await remote.start()
    services.settings.update({
      mcpClients: [{ id: 'mcs_locked', name: 'locked', transport: 'http', url: `${base}/mcp`, headers: {}, command: '', args: [], env: {}, enabled: true, defaultOn: true, approval: 'ask' }]
    })
  })
  afterAll(async () => {
    await services.mcpClients.stopAll()
    await remote.stop()
  })

  it('waits for a sign-in without opening the browser when a chat starts it', async () => {
    const st = await services.mcpClients.start('mcs_locked')
    expect(st.state).toBe('auth')
    expect(st.error).toMatch(/Sign in to locked/)
    expect(opened).toHaveLength(0)
  })

  it('signs in through the browser, then connects and lists its tools', async () => {
    const st = await services.mcpClients.signIn('mcs_locked')
    expect(st.error).toBeNull()
    expect(st.state).toBe('ready')
    expect(st.signedIn).toBe(true)
    expect(st.tools.map((t) => t.name)).toEqual(['whoami'])
    expect(opened).toHaveLength(1)
    const auth = new URL(opened[0])
    expect(auth.origin + auth.pathname).toBe(`${base}/authorize`)
    expect(auth.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(remote.issued).toMatchObject({ registered: 1, codes: 1, tokens: 1 })
  }, 30_000)

  it('keeps the sign-in: a later start connects without asking again', async () => {
    await services.mcpClients.stop('mcs_locked')
    const st = await services.mcpClients.start('mcs_locked')
    expect(st.state).toBe('ready')
    expect(opened).toHaveLength(1)
    expect(await services.mcpClients.call('mcs_locked', 'whoami', {})).toBe('signed in')
  })

  it('changing whether to ask first applies without restarting it', async () => {
    const events: unknown[] = []
    const before = services.mcpClients.status().find((s) => s.id === 'mcs_locked')
    expect(before?.state).toBe('ready')
    const [c] = services.settings.get().mcpClients
    services.settings.update({ mcpClients: [{ ...c, approval: 'auto', defaultOn: false }] })
    await new Promise((r) => setTimeout(r, 50))
    expect(services.mcpClients.status().find((s) => s.id === 'mcs_locked')?.state).toBe('ready')
    const st = await services.mcpClients.start('mcs_locked')
    expect(st.state).toBe('ready')
    expect(remote.issued.tokens).toBe(1)
    void events
  })

  it('signs out: the sign-in is forgotten and it asks again', async () => {
    await services.mcpClients.signOut('mcs_locked')
    const st = await services.mcpClients.start('mcs_locked')
    expect(st.signedIn).toBe(false)
    expect(st.state).toBe('auth')
  })
})

describe('MCP config details', () => {
  it('fills ${VAR} and ${VAR:-default} from the environment, leaving unknown ones as written', () => {
    expect(expandVars('Bearer ${DD_KEY}', { DD_KEY: 'abc' })).toBe('Bearer abc')
    expect(expandVars('${SITE:-datadoghq.com}/mcp', {})).toBe('datadoghq.com/mcp')
    expect(expandVars('${MISSING}', {})).toBe('${MISSING}')
  })

  it('only the connection decides whether a server restarts', () => {
    const c = { id: 'x', name: 'x', transport: 'http' as const, url: 'https://a/mcp', headers: {}, command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'ask' as const }
    expect(connectionKey({ ...c, approval: 'auto', defaultOn: true })).toBe(connectionKey(c))
    expect(connectionKey({ ...c, url: 'https://b/mcp' })).not.toBe(connectionKey(c))
    expect(connectionKey({ ...c, oauth: { clientId: 'id' } })).not.toBe(connectionKey(c))
  })
})
