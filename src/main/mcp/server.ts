import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { McpCallLog, McpStatus } from '@shared/types'
import { errorMessage, type Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import { formatHitsForModel, type RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { WebService } from '../web/web'

const TOOLS = [
  { name: 'skill_list', description: 'List skills in the Cloth skill hub (name, description, health).' },
  { name: 'skill_use', description: 'Fetch the full instructions of a skill (SKILL.md) or one of its bundled files.' },
  { name: 'rag_search', description: 'Hybrid (BM25 + vector) or agentic search over Cloth knowledge collections.' },
  { name: 'rag_collections', description: 'List the knowledge collections available to rag_search.' },
  { name: 'web_search', description: 'Search the web through Cloth’s bundled engine (SearXNG or Obscura, set in Cloth’s settings).' }
]

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }

export class McpHost {
  private server: Server | null = null
  private error: string | null = null
  private recent: McpCallLog[] = []

  constructor(
    private ctx: Ctx,
    private settings: SettingsService,
    private deps: { rag: RagService; skills: SkillService; web: WebService }
  ) {}

  token(): string {
    let token = this.ctx.kv.get<string>('mcpToken', '')
    if (!token) {
      token = randomBytes(24).toString('base64url')
      this.ctx.kv.set('mcpToken', token)
    }
    return token
  }

  rotateToken(): McpStatus {
    this.ctx.kv.set('mcpToken', randomBytes(24).toString('base64url'))
    return this.status()
  }

  status(): McpStatus {
    const s = this.settings.get()
    return {
      running: !!this.server?.listening,
      url: `http://127.0.0.1:${s.mcpPort}/mcp`,
      port: s.mcpPort,
      token: this.token(),
      requireToken: s.mcpRequireToken,
      error: this.error,
      tools: TOOLS,
      recent: this.recent
    }
  }

  async restart(): Promise<McpStatus> {
    await this.stop()
    const s = this.settings.get()
    if (s.mcpEnabled) await this.start(s.mcpPort)
    return this.status()
  }

  async stop(): Promise<void> {
    const srv = this.server
    this.server = null
    if (srv) await new Promise<void>((r) => srv.close(() => r()))
    this.ctx.emit('mcp', this.status())
  }

  private async start(port: number): Promise<void> {
    this.error = null
    const srv = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : errorMessage(err)
        this.server = null
        resolve()
      })
      srv.listen(port, '127.0.0.1', () => {
        this.server = srv
        resolve()
      })
    })
    this.ctx.emit('mcp', this.status())
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'cloth' }))
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('Not found')
      return
    }
    // Block browser pages from driving the local server (DNS-rebinding / CSRF).
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403).end('Forbidden origin')
      return
    }
    if (this.settings.get().mcpRequireToken && req.headers.authorization !== `Bearer ${this.token()}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Missing or invalid bearer token' }))
      return
    }
    if (req.method !== 'POST') {
      // Stateless server: no SSE stream / session to resume.
      res.writeHead(405, { allow: 'POST' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }))
      return
    }
    try {
      const body = await readJson(req)
      const server = this.buildServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: errorMessage(err) }, id: null }))
    }
  }

  private buildServer(): McpServer {
    const server = new McpServer({ name: 'cloth', version: '0.1.0' }, { instructions: 'Cloth is a local developer hub. Use rag_search to ground answers in indexed docs and skill_list/skill_use to load reusable skills.' })
    const { rag, skills } = this.deps

    server.registerTool(
      'skill_list',
      { title: 'List skills', description: TOOLS[0].description, inputSchema: { query: z.string().optional().describe('Filter by substring in name/description') } },
      (args) =>
        this.logged('skill_list', args, async () => {
          const q = args.query?.toLowerCase()
          const list = (await skills.list()).filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
          const items = list.map((s) => ({ name: s.name, description: s.description, health: s.health?.verdict ?? 'untested', files: s.files }))
          return {
            content: [{ type: 'text', text: items.map((s) => `- ${s.name}: ${s.description}`).join('\n') || 'No skills installed.' }],
            structuredContent: { skills: items }
          }
        })
    )

    server.registerTool(
      'skill_use',
      {
        title: 'Use skill',
        description: TOOLS[1].description,
        inputSchema: { name: z.string().describe('Skill name from skill_list'), file: z.string().optional().describe('Relative path of a bundled file') }
      },
      (args) =>
        this.logged('skill_use', args, async () => {
          if (args.file) return { content: [{ type: 'text', text: await skills.readFile(args.name, args.file) }] }
          const s = await skills.get(args.name)
          const extra = s.files.filter((f) => f !== 'SKILL.md' && f !== 'evals.json')
          return {
            content: [
              {
                type: 'text',
                text: `# Skill: ${s.name}\n${s.description}\n\n${s.body}${extra.length ? `\n\nBundled files (fetch with skill_use + file): ${extra.join(', ')}` : ''}`
              }
            ]
          }
        })
    )

    server.registerTool(
      'rag_search',
      {
        title: 'Search knowledge',
        description: TOOLS[2].description,
        inputSchema: {
          query: z.string(),
          collections: z.array(z.string()).optional().describe('Collection names or ids (default: all)'),
          k: z.number().int().min(1).max(30).optional(),
          mode: z.enum(['hybrid', 'keyword', 'vector', 'agentic']).optional().describe('agentic = multi-query + rerank using the default model')
        }
      },
      (args) =>
        this.logged('rag_search', args, async () => {
          const res = await rag.search({ query: args.query, collectionIds: args.collections, k: args.k ?? 8, mode: args.mode ?? 'hybrid' })
          const notes = res.notes.length ? `\n\nNotes: ${res.notes.join('; ')}` : ''
          return {
            content: [{ type: 'text', text: formatHitsForModel(res.hits) + notes }],
            structuredContent: {
              mode: res.mode,
              queries: res.queries,
              hits: res.hits.map((h) => ({ title: h.title, source: h.source, heading: h.headingPath, score: h.score, text: h.text }))
            }
          }
        })
    )

    server.registerTool('rag_collections', { title: 'List collections', description: TOOLS[3].description, inputSchema: {} }, (args) =>
      this.logged('rag_collections', args, async () => {
        const cols = rag.listCollections().map((c) => ({ id: c.id, name: c.name, description: c.description, documents: c.docCount, chunks: c.chunkCount, vectors: !!c.embeddingDim }))
        return { content: [{ type: 'text', text: cols.map((c) => `- ${c.name} (${c.documents} docs): ${c.description}`).join('\n') || 'No collections.' }], structuredContent: { collections: cols } }
      })
    )
    server.registerTool(
      'web_search',
      {
        title: 'Web search',
        description: TOOLS[4].description,
        inputSchema: { query: z.string(), k: z.number().int().min(1).max(20).optional() }
      },
      (args) =>
        this.logged('web_search', args, async () => {
          const res = await this.deps.web.search(args.query, { k: args.k })
          return {
            content: [{ type: 'text', text: res.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n') || 'No results.' }],
            structuredContent: { engine: res.engine, results: res.results }
          }
        })
    )
    return server
  }

  private async logged(tool: string, args: unknown, fn: () => Promise<ToolResult>): Promise<ToolResult> {
    const started = Date.now()
    try {
      const out = await fn()
      this.record({ at: started, tool, args, ok: true, durationMs: Date.now() - started })
      return out
    } catch (err) {
      this.record({ at: started, tool, args, ok: false, durationMs: Date.now() - started, error: errorMessage(err) })
      return { content: [{ type: 'text', text: `Error: ${errorMessage(err)}` }], isError: true }
    }
  }

  private record(entry: McpCallLog): void {
    this.recent = [entry, ...this.recent].slice(0, 50)
    this.ctx.emit('mcp', this.status())
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 4_000_000) {
        reject(new Error('Request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}
