import { describe, expect, it } from 'vitest'
import { MCP_PRESETS } from '../src/main/mcp/client'
import { serverProblem } from '../src/shared/mcp-config'

describe('MCP presets', () => {
  it('include the homelab servers, reached over HTTP and set up with a token', () => {
    const byName = Object.fromEntries(MCP_PRESETS.map((p) => [p.name, p]))
    expect(byName.homelab).toMatchObject({ transport: 'http', url: 'http://mcp.example.internal/mcp', needsToken: true, approval: 'ask' })
    expect(byName.obsidian).toMatchObject({ transport: 'http', url: 'http://obsidian.example.internal/mcp', needsToken: true, approval: 'auto' })
    // The token is pasted in, never shipped.
    for (const p of MCP_PRESETS) expect(p.headers ?? {}).toEqual({})
  })

  it('are valid servers with distinct names and a line on what each gives', () => {
    expect(new Set(MCP_PRESETS.map((p) => p.name)).size).toBe(MCP_PRESETS.length)
    for (const p of MCP_PRESETS) {
      expect(serverProblem(p, [])).toBeNull()
      expect(p.about).toBeTruthy()
    }
  })
})
