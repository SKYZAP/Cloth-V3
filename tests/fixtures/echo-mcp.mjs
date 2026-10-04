// A tiny stdio MCP server for tests: `echo` returns its text, `pixel` returns an image, `fail` errors.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo', version: '1.0.0' })
server.tool('echo', 'Repeat the text back', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }))
server.tool('pixel', 'A 1×1 image', {}, async () => ({
  content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }]
}))
server.tool('fail', 'Always fails', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'it broke' }] }))
await server.connect(new StdioServerTransport())
