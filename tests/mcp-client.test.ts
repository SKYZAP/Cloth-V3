import { afterEach, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type Context } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { McpClientConfig } from '../src/shared/types'
import { mcpToolName } from '../src/main/mcp/client'
import { makeServices } from './helpers'

const FIXTURE = resolve(__dirname, 'fixtures', 'echo-mcp.mjs')
const echo = (over: Partial<McpClientConfig> = {}): McpClientConfig => ({ id: 'mcs_echo', name: 'echo', command: process.execPath, args: [FIXTURE], env: {}, enabled: true, defaultOn: true, approval: 'auto', ...over })

let stop: (() => Promise<void>) | null = null
afterEach(async () => {
  await stop?.()
  stop = null
})

describe('external MCP servers', () => {
  it('names tools the way models accept', () => {
    expect(mcpToolName('playwright', 'browser_navigate')).toBe('mcp__playwright__browser_navigate')
    expect(mcpToolName('my server', 'do.thing')).toBe('mcp__my_server__do_thing')
    expect(mcpToolName('x', 'y'.repeat(100))).toHaveLength(64)
  })

  it('starts a server, lists its tools and runs them (text, images, errors)', async () => {
    const { services } = makeServices()
    stop = () => services.mcpClients.stopAll()
    services.settings.update({ mcpClients: [echo()] })
    const st = await services.mcpClients.start('mcs_echo')
    expect(st.state).toBe('ready')
    expect(st.tools.map((t) => t.name).sort()).toEqual(['echo', 'fail', 'pixel'])

    const tools = services.mcpClients.tools({ collectionIds: [], skillsEnabled: false, workspace: null, mcpServers: ['mcs_echo'] })
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    const out = await byName.mcp__echo__echo.execute('t1', { text: 'hi' })
    expect(out.content).toEqual([{ type: 'text', text: 'echo: hi' }])
    const img = await byName.mcp__echo__pixel.execute('t2', {})
    expect(img.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    await expect(byName.mcp__echo__fail.execute('t3', {})).rejects.toThrow('it broke')
    // Each call lands in the MCP page's live log, newest first.
    expect(services.mcpClients.calls().map((c) => [c.peer, c.tool, c.ok, c.direction])).toEqual([
      ['echo', 'fail', false, 'out'],
      ['echo', 'pixel', true, 'out'],
      ['echo', 'echo', true, 'out']
    ])
    // A chat that didn't turn the server on gets nothing.
    expect(services.mcpClients.tools({ collectionIds: [], skillsEnabled: false, workspace: null, mcpServers: [] })).toEqual([])
  }, 30_000)

  it('reports a server that fails to start', async () => {
    const { services } = makeServices()
    stop = () => services.mcpClients.stopAll()
    services.settings.update({ mcpClients: [echo({ id: 'mcs_bad', name: 'bad', args: [join(__dirname, 'fixtures', 'missing.mjs')] })] })
    const st = await services.mcpClients.start('mcs_bad')
    expect(st.state).toBe('error')
    expect(st.error).toBeTruthy()
  }, 30_000)

  it('gives chats the tools of their servers, asking first when the server says so', async () => {
    const { services, events } = makeServices()
    stop = () => services.mcpClients.stopAll()
    services.settings.update({ mcpClients: [echo({ approval: 'ask' })] })
    const seen: Context[] = []
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-mcp' })
    faux.setResponses([
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage([fauxToolCall('mcp__echo__echo', { text: 'from chat' })], { stopReason: 'toolUse' })
      },
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage('done')
      }
    ])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false })
      expect(chat.mcpServers).toBeNull()
      await services.chat.send(chat.id, 'use the echo tool')
      // The call waits for approval.
      let pending = services.chat.pendingApprovals(chat.id)
      for (let i = 0; i < 100 && !pending.length; i++) {
        await new Promise((r) => setTimeout(r, 50))
        pending = services.chat.pendingApprovals(chat.id)
      }
      expect(pending[0]).toMatchObject({ kind: 'tool', tool: { server: 'echo', name: 'echo' } })
      expect(pending[0].command).toContain('from chat')
      services.chat.resolveApproval(pending[0].id, 'always')
      for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 50))

      expect(await services.runtime.systemPrompt({ collectionIds: [], skillsEnabled: false, workspace: null, mcpServers: ['mcs_echo'] }, '')).toContain('## External tools')
      const toolResult = seen[1].messages.find((m) => m.role === 'toolResult')
      expect(JSON.stringify(toolResult)).toContain('echo: from chat')
      expect(events.some((e) => e.channel === 'mcpClients')).toBe(true)

      // Turned off for this chat: no tools.
      services.chat.update(chat.id, { mcpServers: [] })
      expect(JSON.parse(services.runtime.toolDefinitions({ collectionIds: [], skillsEnabled: false, workspace: null, mcpServers: [] })).some((t: { name: string }) => t.name.startsWith('mcp__'))).toBe(false)
    } finally {
      faux.unregister()
    }
  }, 30_000)
})

describe('skills written for Claude Code', () => {
  it('point ${CLAUDE_SKILL_DIR} at the skill folder and mention its scripts', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'searcher', description: 'Search design data', body: 'Run: python "${CLAUDE_SKILL_DIR}/scripts/search.py" "<query>"' })
    await services.skills.writeFile('searcher', 'scripts/search.py', 'print(1)')
    const skill = await services.skills.get('searcher')
    const text = services.skills.instructions(skill)
    const folder = services.skills.folder('searcher').replace(/\\/g, '/')
    expect(text).toContain(`python "${folder}/scripts/search.py"`)
    expect(text).toContain(`This skill's folder is ${folder}`)
    expect(services.skills.instructions({ name: 'searcher', body: 'plain', files: ['SKILL.md'] })).toBe('plain')
  })
})
