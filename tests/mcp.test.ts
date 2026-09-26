import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeServices } from './helpers'

const PORT = 17000 + Math.floor(Math.random() * 1000)
const { services } = makeServices()

async function connect(token?: string) {
  const client = new Client({ name: 'cloth-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  })
  await client.connect(transport)
  return client
}

describe('MCP server', () => {
  beforeAll(async () => {
    services.settings.update({ mcpPort: PORT, mcpEnabled: true })
    await services.mcp.restart()
    const col = services.rag.createCollection({ name: 'docs', embedding: null })
    await services.rag.ingestText(col.id, 'Cron', '# Cron\n\nCron expressions schedule workflows. Five fields: minute hour day month weekday.')
    await services.skills.create({ name: 'cron-helper', description: 'Explain cron expressions', body: 'Use croner syntax.' })
  })
  afterAll(() => services.mcp.stop())

  it('lists the expected tools', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['rag_collections', 'rag_search', 'skill_list', 'skill_use'])
    await client.close()
  })

  it('serves skills and search results', async () => {
    const client = await connect()
    const list = await client.callTool({ name: 'skill_list', arguments: {} })
    expect(JSON.stringify(list.content)).toContain('cron-helper')
    const use = await client.callTool({ name: 'skill_use', arguments: { name: 'cron-helper' } })
    expect(JSON.stringify(use.content)).toContain('Use croner syntax.')
    const search = await client.callTool({ name: 'rag_search', arguments: { query: 'cron fields', collections: ['docs'] } })
    expect(JSON.stringify(search.structuredContent)).toContain('Cron')
    const bad = await client.callTool({ name: 'skill_use', arguments: { name: 'nope' } })
    expect(bad.isError).toBe(true)
    expect(services.mcp.status().recent.length).toBeGreaterThanOrEqual(4)
    await client.close()
  })

  it('enforces the bearer token when required', async () => {
    services.settings.update({ mcpRequireToken: true })
    await expect(connect()).rejects.toThrow()
    const client = await connect(services.mcp.token())
    expect((await client.listTools()).tools.length).toBe(4)
    await client.close()
    services.settings.update({ mcpRequireToken: false })
  })
})
