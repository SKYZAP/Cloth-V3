import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_PRESETS } from '../src/main/mcp/client'
import { migrateOldPenpot, presetsWithTokens, readEnvFile, serversToSeed, withToken } from '../src/main/mcp/homelab'

const env = { MCP_AUTH_TOKEN: 'tok-homelab', OBSIDIAN_MCP_TOKEN: 'tok-vault', PENPOT_MCP_TOKEN: 'tok-penpot' }
const preset = (name: string) => MCP_PRESETS.find((p) => p.name === name)!

describe('homelab MCP tokens', () => {
  it('reads KEY=value lines, with export, quotes and comments; a missing file is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloth-env-'))
    const file = join(dir, 'env')
    writeFileSync(file, ['# homelab', 'export MCP_AUTH_TOKEN=abc', 'OBSIDIAN_MCP_TOKEN="d e f"', "PENPOT_MCP_TOKEN='x.y_z' ", 'NOTE=1 # trailing', 'not a line'].join('\n'))
    expect(readEnvFile(file)).toEqual({ MCP_AUTH_TOKEN: 'abc', OBSIDIAN_MCP_TOKEN: 'd e f', PENPOT_MCP_TOKEN: 'x.y_z', NOTE: '1' })
    expect(readEnvFile(join(dir, 'nope'))).toEqual({})
  })

  it('puts each token where its server wants it', () => {
    expect(withToken(preset('homelab'), 't1')).toMatchObject({ url: 'http://mcp.example.internal/mcp', headers: { Authorization: 'Bearer t1' } })
    expect(withToken(preset('penpot'), 'a.b-c')).toMatchObject({ url: 'http://penpot-mcp.example.internal/mcp', headers: { Authorization: 'Bearer a.b-c' } })
    // Plane keeps its workspace header next to the token.
    expect(withToken(preset('plane'), 'pat')).toMatchObject({ url: 'http://plane-mcp.example.internal/http/api-key/mcp', headers: { 'X-Workspace-slug': 'acme', Authorization: 'Bearer pat' } })
    // A preset that takes its token in the address gets it there instead.
    const inQuery = withToken({ ...preset('penpot'), url: 'http://x.test/mcp', tokenQuery: 'userToken' }, 'a.b-c')
    expect(inQuery.url).toBe('http://x.test/mcp?userToken=a.b-c')
    expect(inQuery.headers).toEqual({})
    expect(inQuery).not.toHaveProperty('tokenQuery')
  })

  it('offers presets ready to add when their token is on file, and asks otherwise', () => {
    const offered = presetsWithTokens(MCP_PRESETS, { OBSIDIAN_MCP_TOKEN: 'tok-vault' })
    expect(offered.find((p) => p.name === 'obsidian')).toMatchObject({ headers: { Authorization: 'Bearer tok-vault' } })
    expect(offered.find((p) => p.name === 'obsidian')?.needsToken).toBeUndefined()
    expect(offered.find((p) => p.name === 'homelab')?.needsToken).toBe(true)
    expect(offered.find((p) => p.name === 'playwright')).toEqual(preset('playwright'))
  })

  it('sets up each homelab server once: not again when already there or removed later', () => {
    expect(serversToSeed(MCP_PRESETS, env, [], []).map((c) => c.name)).toEqual(['homelab', 'obsidian', 'penpot'])
    expect(serversToSeed(MCP_PRESETS, env, ['homelab'], ['obsidian']).map((c) => c.name)).toEqual(['penpot'])
    expect(serversToSeed(MCP_PRESETS, {}, [], [])).toEqual([])
    // Servers that don't need a token are never added on their own.
    expect(serversToSeed(MCP_PRESETS, env, [], []).some((c) => c.name === 'playwright')).toBe(false)
  })
  it("moves a server still set up for Penpot's old MCP to the new one, keeping its id and choices", () => {
    const old = { id: 'mcs_1', name: 'penpot', transport: 'http' as const, url: 'http://design.example.internal/mcp/stream?userToken=old', headers: {}, command: '', args: [], env: {}, enabled: false, defaultOn: true, approval: 'ask' as const }
    const other = { ...old, id: 'mcs_2', name: 'obsidian', url: 'http://obsidian.example.internal/mcp' }
    const moved = migrateOldPenpot([old, other], MCP_PRESETS, env)!
    expect(moved[0]).toEqual({ ...old, url: 'http://penpot-mcp.example.internal/mcp', headers: { Authorization: 'Bearer tok-penpot' } })
    expect(moved[1]).toBe(other)
    expect(migrateOldPenpot([old], MCP_PRESETS, {})![0].headers).toEqual({})
    expect(migrateOldPenpot(moved, MCP_PRESETS, env)).toBeNull()
  })
})
