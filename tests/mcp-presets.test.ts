import { describe, expect, it } from 'vitest'
import { MCP_PRESETS } from '../src/main/mcp/client'
import { serverProblem } from '../src/shared/mcp-config'

describe('MCP presets', () => {
  it('ship no tokens and point at no private hosts', () => {
    for (const p of MCP_PRESETS) {
      expect(Object.keys(p.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization')
      expect(p.url ?? '').not.toMatch(/\.lan\b|\.local\b|192\.168\./)
    }
  })

  it('are valid servers with distinct names and a line on what each gives', () => {
    expect(new Set(MCP_PRESETS.map((p) => p.name)).size).toBe(MCP_PRESETS.length)
    for (const p of MCP_PRESETS) {
      expect(serverProblem(p, [])).toBeNull()
      expect(p.about).toBeTruthy()
    }
  })
})
