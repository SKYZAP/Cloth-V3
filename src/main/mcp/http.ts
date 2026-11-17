import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * Answer one MCP request (stateless Streamable HTTP, JSON replies), sending the reply chunked.
 *
 * Some security software on Windows intercepts local HTTP traffic that looks like MCP (paths ending in /mcp,
 * the Mcp-Protocol-Version and Mcp-Session-Id headers) and rewrites replies that carry a Content-Length into
 * "Transfer-Encoding: chunked" with an unchunked body, which every client rejects ("Invalid character in chunk
 * size"). Chunked replies pass through it intact. The SDK's Node transport always sets a length, so this uses
 * the web-standard transport and writes the reply itself.
 */
export async function serveMcp(server: McpServer, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  const request = new Request(`http://127.0.0.1${req.url ?? '/'}`, { method: req.method, headers, ...(req.method === 'POST' ? { body: JSON.stringify(body) } : {}) })
  const response = await transport.handleRequest(request, { parsedBody: body })
  const out: Record<string, string> = {}
  response.headers.forEach((v, k) => {
    if (k !== 'transfer-encoding' && k !== 'content-length') out[k] = v
  })
  res.writeHead(response.status, out)
  if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
  res.end()
}
