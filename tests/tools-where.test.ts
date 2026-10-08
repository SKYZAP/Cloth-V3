import { describe, expect, it } from 'vitest'
import { describeBuiltins } from '../src/main/agent/tools'
import { TOOLS as SHARED } from '../src/main/mcp/server'
import { makeServices } from './helpers'

describe('where tools work', () => {
  it('marks every built-in, and "apps" matches what Cloth’s MCP server shares', () => {
    const shared = new Set(SHARED.map((t) => t.name))
    for (const t of describeBuiltins()) {
      expect(t.where, t.name).toBeDefined()
      expect(t.where.chats, t.name).toBe(true)
      expect(t.where.apps, t.name).toBe(shared.has(t.name))
    }
    const by = Object.fromEntries(describeBuiltins().map((t) => [t.name, t.where]))
    // Only the chat plans with you, asks you, or starts subagents.
    for (const n of ['todo_write', 'ask_user', 'task']) expect(by[n]).toMatchObject({ subagents: false, flows: false })
    // Flow steps have no shell or code intelligence.
    expect(by.lsp.flows).toBe(false)
  })

  it('counts calls per tool with a daily series', () => {
    const { services } = makeServices()
    services.providers.usage.tool('read', 'builtin', 12, true)
    services.providers.usage.tool('read', 'builtin', 8, false)
    services.providers.usage.tool('grep', 'builtin', 5, true)
    const u = services.dashboard.toolUsage()
    expect(u.read).toMatchObject({ calls: 2, errors: 1 })
    expect(u.read.daily).toHaveLength(14)
    expect(u.read.daily[13]).toBe(2)
    expect(u.grep.calls).toBe(1)
  })
})
