import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { buildHubAdmin } from '../src/main/agent/admin'
import { buildTools } from '../src/main/agent/tools'
import { makeServices } from './helpers'

const t = Date.now()
const transcript = [
  { role: 'user', content: 'How do I reset the router?', timestamp: t - 2000 },
  { role: 'assistant', content: [{ type: 'text', text: 'Hold the reset button for ten seconds.' }], stopReason: 'stop', api: 'openai-completions', provider: 'x', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: t - 1000 }
] as unknown as AgentMessage[]

function hub() {
  const { services } = makeServices()
  return { services, admin: buildHubAdmin(services) }
}

describe('hub admin', () => {
  it('lists chats matching a query and reads one as text', () => {
    const { services, admin } = hub()
    const router = services.chat.fromTranscript({ title: 'Router reset', workspace: null, agentId: null, messages: transcript })
    services.chat.fromTranscript({ title: 'Grocery plan', workspace: null, agentId: null, messages: [] })
    const listed = admin.listChats('router', 10, null)
    expect(listed).toContain(router.id)
    expect(listed).not.toContain('Grocery plan')
    const read = admin.readChat(router.id, 0, 40, false)
    expect(read).toContain('# Router reset')
    expect(read).toContain('How do I reset the router?')
    expect(read).toContain('Hold the reset button for ten seconds.')
    expect(() => admin.readChat('ses_missing', 0, 10, false)).toThrow(/No chat has the id/)
  })

  it('pages through a long chat', () => {
    const { services, admin } = hub()
    const c = services.chat.fromTranscript({ title: 'Long', workspace: null, agentId: null, messages: transcript })
    expect(admin.readChat(c.id, 0, 1, false)).toContain('call session_read again with from 1')
    expect(admin.readChat(c.id, 1, 1, false)).toContain('Hold the reset button')
  })

  it('creates agents and MCP servers, refusing duplicates and bad input', () => {
    const { services, admin } = hub()
    expect(admin.createAgent({ name: 'reviewer', purpose: 'Reviews diffs', instructions: 'Find bugs.' })).toContain('Created the agent "reviewer"')
    expect(services.agents.list().find((a) => a.name === 'reviewer')).toMatchObject({ purpose: 'Reviews diffs', instructions: 'Find bugs.' })
    expect(() => admin.createAgent({ name: 'Reviewer' })).toThrow(/already exists/)

    admin.addMcpServer({ name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] })
    admin.addMcpServer({ name: 'notes', transport: 'http', url: 'https://notes.example.com/mcp', approval: 'auto' })
    const clients = services.settings.get().mcpClients
    expect(clients.find((c) => c.name === 'playwright')).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], approval: 'ask', enabled: true })
    expect(clients.find((c) => c.name === 'notes')).toMatchObject({ transport: 'http', url: 'https://notes.example.com/mcp', approval: 'auto' })
    expect(() => admin.addMcpServer({ name: 'playwright', transport: 'stdio', command: 'npx' })).toThrow(/already set up/)
    expect(() => admin.addMcpServer({ name: 'bad name', transport: 'stdio', command: 'npx' })).toThrow(/short name/)
    expect(() => admin.addMcpServer({ name: 'web', transport: 'http' })).toThrow(/address/)
  })

  it('adds a provider even when its models cannot be listed', async () => {
    const { services, admin } = hub()
    const out = await admin.addProvider({ name: 'Local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    expect(out).toContain('Added the provider "Local"')
    expect(services.providers.list().some((p) => p.name === 'Local')).toBe(true)
    await expect(admin.addProvider({ name: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })).rejects.toThrow(/already exists/)
  })

  it('offers the hub tools to chats, only the read ones to subagents, and none without a chat', () => {
    const { services, admin } = hub()
    const deps = { rag: services.rag, skills: services.skills, web: services.web, custom: services.custom, hub: admin }
    const scope = { collectionIds: [], skillsEnabled: false, workspace: null }
    const names = (s: object) => buildTools(deps, { ...scope, ...s }).map((x) => x.name)
    const hubTools = ['session_list', 'session_read', 'agent_create', 'automation_create', 'mcp_server_add', 'provider_add']
    expect(names({ sessionId: 's1' })).toEqual(expect.arrayContaining(hubTools))
    expect(names({ sessionId: 's1', depth: 1 }).filter((n) => hubTools.includes(n))).toEqual(['session_list', 'session_read'])
    expect(names({}).filter((n) => hubTools.includes(n))).toEqual([])
  })
})
