import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApi } from '../src/main/api'
import { mapClient, masker, opener, restoreClient, sealer } from '../src/main/core/secret-fields'
import { plainSecrets } from '../src/main/core/context'
import { SECRET_MASK, maskValue } from '../src/shared/secret-fields'
import type { McpClientConfig } from '../src/shared/types'
import { makeServices } from './helpers'

const server = (over: Partial<McpClientConfig> = {}): McpClientConfig => ({
  id: 'mcs_1',
  name: 'notes',
  transport: 'http',
  url: 'http://notes.test/mcp?userToken=tok-url&view=all',
  headers: { Authorization: 'Bearer tok-header', 'X-Workspace-slug': 'acme' },
  command: '',
  args: [],
  env: { API_KEY: 'tok-env', PATH: '/usr/bin' },
  enabled: true,
  defaultOn: false,
  approval: 'ask',
  ...over
})

afterEach(() => vi.unstubAllEnvs())

describe('secret fields', () => {
  it('seals and opens only the values whose names say they are secret', () => {
    const sealed = mapClient(server(), sealer(plainSecrets))
    expect(JSON.stringify(sealed)).not.toMatch(/tok-(url|header|env)/)
    expect(sealed.headers?.['X-Workspace-slug']).toBe('acme')
    expect(sealed.env.PATH).toBe('/usr/bin')
    expect(sealed.url).toContain('view=all')
    expect(mapClient(sealed, opener(plainSecrets))).toEqual(server())
  })

  it('masks for the app, and puts the saved values back for masks sent back', () => {
    const masked = mapClient(server(), masker)
    expect(masked.headers?.Authorization).toBe(`Bearer ${SECRET_MASK}`)
    expect(masked.env.API_KEY).toBe(SECRET_MASK)
    expect(new URL(masked.url!).searchParams.get('userToken')).toBe(SECRET_MASK)
    expect(restoreClient(masked, [server()])).toEqual(server())
    // A changed value is kept; a mask with nothing behind it is cleared rather than saved.
    expect(restoreClient({ ...masked, env: { API_KEY: 'new-key' } }, [server()]).env.API_KEY).toBe('new-key')
    expect(restoreClient(masked, []).headers?.Authorization).toBe('')
  })

  it('fills a token moved from a bearer header into the address (Penpot)', () => {
    const preset = server({ url: 'http://penpot.test/mcp', headers: { Authorization: 'Bearer pp-tok' } })
    const url = new URL('http://penpot.test/mcp')
    url.searchParams.set('userToken', maskValue('pp-tok'))
    expect(new URL(restoreClient({ ...preset, headers: {}, url: url.toString() }, [preset]).url!).searchParams.get('userToken')).toBe('pp-tok')
  })
})

describe('settings and providers keep secrets to the main process', () => {
  it('stores MCP server tokens encrypted and hands the app masks', async () => {
    const { services } = makeServices()
    const api = createApi(services)
    services.settings.update({ mcpClients: [server()] })
    // At rest: sealed. Inside the main process: the real values.
    expect(JSON.stringify(services.ctx.kv.get('settings', {}))).not.toMatch(/tok-(url|header|env)/)
    expect(services.settings.get().mcpClients[0]).toEqual(server())

    const shown = await api.settings.get()
    expect(JSON.stringify(shown)).not.toMatch(/tok-(url|header|env)/)
    // The app sends the masked list back with one change: the secrets survive.
    await api.settings.update({ mcpClients: shown.mcpClients.map((c) => ({ ...c, approval: 'auto' as const })) })
    expect(services.settings.get().mcpClients[0]).toEqual(server({ approval: 'auto' }))
  })

  it('encrypts settings saved before secrets were', () => {
    const { services } = makeServices()
    services.ctx.kv.set('settings', { mcpClients: [server()] })
    services.settings.sealAtRest()
    expect(JSON.stringify(services.ctx.kv.get('settings', {}))).not.toContain('tok-header')
    expect(services.settings.get().mcpClients[0]).toEqual(server())
  })

  it('fills a preset token from the homelab env file without showing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloth-env-'))
    writeFileSync(join(dir, 'env'), 'PLANE_API_KEY=plane-secret\n')
    vi.stubEnv('HOMELAB_ENV', join(dir, 'env'))
    const { services } = makeServices()
    const api = createApi(services)
    const plane = (await api.mcp.clientPresets()).find((p) => p.name === 'plane')!
    expect(JSON.stringify(plane)).not.toContain('plane-secret')
    const { about: _a, needsToken: _n, tokenQuery: _q, ...config } = plane
    await api.settings.update({ mcpClients: [{ ...config, id: 'mcs_9' }] })
    expect(services.settings.get().mcpClients[0].headers?.Authorization).toBe('Bearer plane-secret')
  })

  it('masks provider header secrets and keeps them when sent back', async () => {
    const { services } = makeServices()
    const api = createApi(services)
    const p = await api.providers.create({ name: 'p', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', headers: { 'X-Api-Key': 'hdr-secret', 'X-Org': 'acme' } })
    expect(p.headers).toEqual({ 'X-Api-Key': SECRET_MASK, 'X-Org': 'acme' })
    expect(JSON.stringify(services.ctx.db.prepare('SELECT headers FROM providers').all())).not.toContain('hdr-secret')
    await api.providers.update(p.id, { headers: p.headers })
    expect(services.providers.get(p.id).headers['X-Api-Key']).toBe('hdr-secret')
  })
})
