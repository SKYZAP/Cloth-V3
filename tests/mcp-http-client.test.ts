import { afterAll, describe, expect, it } from 'vitest'
import { makeServices } from './helpers'

const PORT = 18000 + Math.floor(Math.random() * 1000)

describe('MCP servers over HTTP', () => {
  // Cloth's own MCP server speaks Streamable HTTP, so it stands in for a remote server.
  const { services } = makeServices()
  afterAll(async () => {
    await services.mcpClients.stopAll()
    await services.mcp.stop()
  })

  it('connects to a server by its address, lists its tools and calls one', async () => {
    services.settings.update({ mcpPort: PORT, mcpEnabled: true })
    await services.mcp.restart()
    await services.skills.create({ name: 'remote-skill', description: 'Found over HTTP', body: 'x' })
    services.settings.update({
      mcpClients: [{ id: 'mcs_remote', name: 'remote', transport: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { 'x-test': '1' }, command: '', args: [], env: {}, enabled: true, defaultOn: true, approval: 'auto' }]
    })
    const status = await services.mcpClients.start('mcs_remote')
    expect(status.error).toBeNull()
    expect(status.state).toBe('ready')
    expect(status.tools.map((t) => t.name)).toContain('skill_list')
    expect(await services.mcpClients.call('mcs_remote', 'skill_list', {})).toContain('remote-skill')
  })

  it('explains an address that is wrong or unreachable', async () => {
    services.settings.update({
      mcpClients: [
        { id: 'mcs_bad', name: 'bad', transport: 'http', url: 'not a url', command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'ask' },
        { id: 'mcs_down', name: 'down', transport: 'http', url: 'http://127.0.0.1:1/mcp', command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'ask' }
      ]
    })
    const bad = await services.mcpClients.start('mcs_bad')
    expect(bad.state).toBe('error')
    expect(bad.error).toMatch(/isn't a web address/)
    const down = await services.mcpClients.start('mcs_down')
    expect(down.state).toBe('error')
    expect(down.error).toMatch(/couldn't connect to http:\/\/127\.0\.0\.1:1\/mcp/)
  }, 30_000)
})
