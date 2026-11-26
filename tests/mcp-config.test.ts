import { describe, expect, it } from 'vitest'
import { mcpServerJson, parseMcpServers, serverProblem, splitCommandLine, suggestName } from '../src/shared/mcp-config'

describe('MCP server JSON', () => {
  it('reads the usual shapes, including a pasted "mcpServers" fragment', () => {
    const fragment = `"mcpServers": {
    "playwright": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp@latest"] },
    "cloth-rag": { "type": "http", "url": "http://localhost:3030/mcp" }
  }`
    const r = parseMcpServers(fragment)
    expect(r.error).toBeNull()
    expect(r.servers).toEqual([
      { name: 'playwright', transport: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
      { name: 'cloth-rag', transport: 'http', url: 'http://localhost:3030/mcp', headers: {}, command: '', args: [], env: {} }
    ])
    expect(parseMcpServers(`{ "mcpServers": ${fragment.slice(fragment.indexOf('{'))} }`).servers).toHaveLength(2)
    expect(parseMcpServers('{ "servers": { "gh": { "type": "sse", "url": "https://x.dev/sse", "headers": { "Authorization": "Bearer t" } } } }').servers[0]).toMatchObject({ transport: 'http', headers: { Authorization: 'Bearer t' } })
    // No type: a url means HTTP, a command means a program.
    expect(parseMcpServers('{ "a": { "url": "https://a.dev/mcp" }, "b": { "command": "uvx", "args": ["x", 1], "env": { "N": 2 } } }').servers).toMatchObject([
      { transport: 'http' },
      { transport: 'stdio', args: ['x', '1'], env: { N: '2' } }
    ])
  })

  it('says plainly what is wrong', () => {
    expect(parseMcpServers('').error).toMatch(/Paste or write/)
    expect(parseMcpServers('{ "a": ').error).toMatch(/isn’t valid JSON/)
    expect(parseMcpServers('{ "command": "npx" }').error).toMatch(/under a name/)
    expect(parseMcpServers('{ "bad name": { "command": "npx" } }').error).toMatch(/can’t be a server name/)
    expect(parseMcpServers('{ "a": { "type": "stdio" } }').error).toMatch(/needs a "command"/)
    expect(parseMcpServers('{ "a": { "type": "http", "url": "ftp://x" } }').error).toMatch(/needs a "url"/)
    expect(parseMcpServers('{ "a": { "command": "npx", "args": "-y" } }').error).toMatch(/"args" should be a list/)
    expect(parseMcpServers('{ "a": { "type": "websocket", "url": "ws://x" } }').error).toMatch(/Use "stdio"/)
    expect(parseMcpServers('{}').error).toMatch(/No servers found/)
  })

  it('writes a server back as JSON that reads the same', () => {
    const stdio = { name: 'playwright', transport: 'stdio' as const, command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { DEBUG: '1' } }
    const json = mcpServerJson(stdio)
    expect(JSON.parse(json)).toEqual({ playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { DEBUG: '1' } } })
    expect(parseMcpServers(json).servers[0]).toEqual(stdio)
    const http = { name: 'remote', transport: 'http' as const, url: 'https://r.dev/mcp', headers: {}, command: '', args: [], env: {} }
    expect(JSON.parse(mcpServerJson(http))).toEqual({ remote: { type: 'http', url: 'https://r.dev/mcp' } })
  })

  it('splits a pasted command line into the program and its arguments', () => {
    expect(splitCommandLine('npx -y @playwright/mcp@latest')).toEqual({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] })
    expect(splitCommandLine('node "C:/My Tools/server.js" --port 4401')).toEqual({ command: 'node', args: ['C:/My Tools/server.js', '--port', '4401'] })
    expect(splitCommandLine('  ')).toEqual({ command: '', args: [] })
  })

  it('suggests a name from the package or the address', () => {
    expect(suggestName({ transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).toBe('playwright')
    expect(suggestName({ transport: 'stdio', command: 'npx', args: ['@modelcontextprotocol/server-filesystem', 'C:/x'] })).toBe('filesystem')
    expect(suggestName({ transport: 'http', command: '', args: [], url: 'http://notes.example.com/mcp' })).toBe('notes')
    expect(suggestName({ transport: 'http', command: '', args: [], url: 'http://localhost:4401/mcp' })).toBe('localhost')
  })

  it('checks a server filled in field by field', () => {
    const http = { name: 'penpot', transport: 'http' as const, url: 'http://localhost:4401/mcp', headers: {}, command: '', args: [], env: {} }
    expect(serverProblem(http, [])).toBeNull()
    expect(serverProblem({ ...http, url: 'localhost:4401' }, [])).toMatch(/http:\/\//)
    expect(serverProblem(http, ['penpot'])).toMatch(/already/)
    expect(serverProblem({ ...http, name: 'bad name' }, [])).toMatch(/letters/)
    const stdio = { name: 'pw', transport: 'stdio' as const, command: 'npx', args: ['-y'], env: { API_KEY: 'x' } }
    expect(serverProblem(stdio, [])).toBeNull()
    expect(serverProblem({ ...stdio, command: 'npx -y pkg' }, [])).toMatch(/own box/)
    expect(serverProblem({ ...stdio, env: { '1BAD': 'x' } }, [])).toMatch(/Variable names/)
  })
})
