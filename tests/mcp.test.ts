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
    expect(tools.map((t) => t.name).sort()).toEqual(['rag_collections', 'rag_index', 'rag_search', 'skill_create', 'skill_list', 'skill_use', 'tool_create', 'web_search'])
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
    // Calls are put down to the app that introduced itself in the handshake.
    expect(services.mcp.status().recent[0]).toMatchObject({ direction: 'in', peer: 'cloth-test' })
    expect(services.mcp.status().apps.find((a) => a.name === 'cloth-test')?.calls).toBeGreaterThanOrEqual(4)
    await client.close()
  })

  it('offers the next free port when its own is taken', async () => {
    const { services: other } = makeServices()
    other.settings.update({ mcpPort: PORT, mcpEnabled: true })
    await other.mcp.restart()
    for (let i = 0; i < 50 && other.mcp.status().suggestedPort === null; i++) await new Promise((r) => setTimeout(r, 20))
    const st = other.mcp.status()
    expect(st.error).toMatch(/already in use/)
    expect(st.suggestedPort).toBeGreaterThan(PORT)
    await other.mcp.stop()
  })

  it('indexes knowledge, creates tools and skills', async () => {
    const client = await connect()
    const idx = await client.callTool({ name: 'rag_index', arguments: { collection: 'Team notes', title: 'Deploys', text: 'Deploys go out on Tuesdays via the blue-green pipeline.' } })
    expect(idx.isError).toBeFalsy()
    expect(JSON.stringify(idx.content)).toContain('Created the collection')
    const col = services.rag.findCollection('team notes')!
    expect(services.rag.listDocuments(col.id).map((d) => d.title)).toEqual(['Deploys'])
    const hits = await services.rag.search({ query: 'blue-green deploys', collectionIds: [col.id], k: 3, mode: 'keyword' })
    expect(hits.hits[0]?.text).toContain('Tuesdays')
    const missing = await client.callTool({ name: 'rag_index', arguments: { collection: 'nope', create: false, text: 'x' } })
    expect(missing.isError).toBe(true)
    const relative = await client.callTool({ name: 'rag_index', arguments: { collection: 'Team notes', paths: ['docs'] } })
    expect(JSON.stringify(relative.content)).toContain('absolute path')

    const http = await client.callTool({
      name: 'tool_create',
      arguments: { name: 'weather_lookup', description: 'Current weather for a city', kind: 'http', params: [{ name: 'city' }], config: { url: 'https://wttr.in/{{city}}?format=3', headers: { accept: 'text/plain' } } }
    })
    expect(http.isError).toBeFalsy()
    const weather = services.custom.findByName('weather_lookup')!
    expect(weather).toMatchObject({ enabled: true, createdBy: 'mcp', kind: 'http' })
    expect(weather.params[0]).toMatchObject({ name: 'city', type: 'string', required: true })
    expect(JSON.parse(weather.config.headers)).toEqual({ accept: 'text/plain' })
    // Code-running kinds wait for the user's review.
    await client.callTool({ name: 'tool_create', arguments: { name: 'list_home', description: 'List files', kind: 'command', config: { command: 'ls', args: ['-la', '{{dir}}'] } } })
    expect(services.custom.findByName('list_home')).toMatchObject({ enabled: false, createdBy: 'mcp' })
    expect(services.custom.findByName('list_home')!.config.args).toBe('-la\n{{dir}}')
    const dup = await client.callTool({ name: 'tool_create', arguments: { name: 'weather_lookup', description: 'x', kind: 'prompt', config: { prompt: 'hi' } } })
    expect(dup.isError).toBe(true)
    const replaced = await client.callTool({ name: 'tool_create', arguments: { name: 'weather_lookup', description: 'Weather', kind: 'prompt', config: { prompt: 'Weather in {{city}}?' }, replace: true } })
    expect(replaced.isError).toBeFalsy()
    expect(services.custom.findByName('weather_lookup')!.kind).toBe('prompt')

    const skill = await client.callTool({
      name: 'skill_create',
      arguments: { name: 'Release Notes', description: 'Write release notes. Use when tagging a release.', instructions: '# Release notes\n\n1. Read the git log.', files: [{ path: 'templates/notes.md', content: '## Changes' }] }
    })
    expect(skill.isError).toBeFalsy()
    const created = await services.skills.get('release-notes')
    expect(created.body).toContain('Read the git log')
    expect(created.files).toContain('templates/notes.md')
    const escape = await client.callTool({ name: 'skill_create', arguments: { name: 'bad-files', description: 'x', instructions: 'y', files: [{ path: '../evil.md', content: 'z' }] } })
    expect(escape.isError).toBe(true)
    await expect(services.skills.list().then((l) => l.some((s) => s.name === 'bad-files'))).resolves.toBe(false)
    await client.close()
  })

  it('enforces the bearer token when required', async () => {
    services.settings.update({ mcpRequireToken: true })
    await expect(connect()).rejects.toThrow()
    const client = await connect(services.mcp.token())
    expect((await client.listTools()).tools.length).toBe(8)
    await client.close()
    services.settings.update({ mcpRequireToken: false })
  })
})
