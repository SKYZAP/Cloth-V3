import type { UsageService } from '../core/usage'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { serveMcp } from './http'
import { z } from 'zod'
import type { McpApp, McpCallLog, McpStatus } from '@shared/types'
import { createServer as createNetServer } from 'node:net'
import { errorMessage, type Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import { formatHitsForModel, type RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { WebService } from '../web/web'
import type { CustomToolService } from '../tools/custom'
import { createSkill, createTool, indexKnowledge, RAG_INDEX_DESCRIPTION, SKILL_CREATE_DESCRIPTION, TOOL_CREATE_DESCRIPTION } from '../agent/hub'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

/** What Cloth's server shares with apps (the Tools page's "apps" column follows this). */
export const TOOLS = [
  { name: 'skill_list', description: 'List skills in the Cloth skill hub (name, description, health).' },
  { name: 'skill_use', description: 'Fetch the full instructions of a skill (SKILL.md) or one of its bundled files.' },
  { name: 'rag_search', description: 'Hybrid (BM25 + vector) or agentic search over Cloth knowledge collections.' },
  { name: 'rag_collections', description: 'List the knowledge collections available to rag_search.' },
  { name: 'web_search', description: 'Search the web through Cloth’s bundled engine (SearXNG or Obscura, set in Cloth’s settings).' },
  { name: 'rag_index', description: 'Index text, web pages or local files into a knowledge collection (created if needed).' },
  { name: 'tool_create', description: 'Create a custom tool that shows up on Cloth’s Tools page (code-running kinds start disabled until reviewed).' },
  { name: 'skill_create', description: 'Create a skill (SKILL.md plus optional files) in the Cloth skill hub.' }
]

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }

export class McpHost {
  private server: Server | null = null
  private error: string | null = null
  private suggestedPort: number | null = null
  private recent: McpCallLog[] = []

  constructor(
    private ctx: Ctx,
    private settings: SettingsService,
    private deps: { rag: RagService; skills: SkillService; web: WebService; custom: CustomToolService; usage?: UsageService }
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
      recent: this.recent,
      suggestedPort: this.error ? this.suggestedPort : null,
      apps: this.apps().map(({ name, lastSeen, calls }) => ({ name, lastSeen, calls }))
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

  /** Apps seen in MCP handshakes, by user agent (the stateless server has no sessions to remember them by). */
  private apps(): (McpApp & { ua: string })[] {
    return this.ctx.kv.get<(McpApp & { ua: string })[]>('mcpApps', [])
  }

  private saveApps(list: (McpApp & { ua: string })[]): void {
    this.ctx.kv.set('mcpApps', list.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 12))
  }

  /** The app behind a request: its handshake name if it introduced itself, else a name from its user agent. */
  private appFor(ua: string, hello?: string): string {
    const list = this.apps()
    if (hello) {
      const name = hello.slice(0, 60)
      const known = list.find((a) => a.ua === ua)
      if (known) known.name = name
      else list.push({ name, ua, lastSeen: Date.now(), calls: 0 })
      this.saveApps(list)
      return name
    }
    return list.find((a) => a.ua === ua)?.name ?? (ua.split(/[\s/]/)[0] || 'An app')
  }

  private countCall(ua: string, name: string): void {
    const list = this.apps()
    const a = list.find((x) => x.ua === ua) ?? list[list.push({ name, ua, lastSeen: 0, calls: 0 }) - 1]
    a.lastSeen = Date.now()
    a.calls++
    this.saveApps(list)
  }

  private async start(port: number): Promise<void> {
    this.error = null
    this.suggestedPort = null
    const srv = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => {
      srv.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : errorMessage(err)
        this.server = null
        if (err.code === 'EADDRINUSE') void freePort(port + 1).then((p) => ((this.suggestedPort = p), this.ctx.emit('mcp', this.status())))
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
      const ua = String(req.headers['user-agent'] ?? '')
      const msg = (Array.isArray(body) ? body[0] : body) as { method?: string; params?: { clientInfo?: { name?: unknown } } } | undefined
      const hello = msg?.method === 'initialize' && typeof msg.params?.clientInfo?.name === 'string' ? msg.params.clientInfo.name : undefined
      const app = this.appFor(ua, hello)
      const server = this.buildServer(app, ua)
      await serveMcp(server, req, res, body)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: errorMessage(err) }, id: null }))
    }
  }

  private buildServer(app: string, ua: string): McpServer {
    const logged = (tool: string, args: unknown, fn: () => Promise<ToolResult>) => this.logged(tool, args, fn, app, ua)
    const server = new McpServer({ name: 'cloth', version: '0.1.0' }, {
        instructions:
          'Cloth is a local developer hub. Use rag_search to ground answers in indexed docs and skill_list/skill_use to load reusable skills. When the user asks, save knowledge with rag_index, make skills with skill_create and add tools to Cloth with tool_create.'
      })
    const { rag, skills } = this.deps

    server.registerTool(
      'skill_list',
      { title: 'List skills', description: TOOLS[0].description, inputSchema: { query: z.string().optional().describe('Filter by substring in name/description') } },
      (args) =>
        logged('skill_list', args, async () => {
          const q = args.query?.toLowerCase()
          const list = (await skills.list()).filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
          const items = list.map((s) => ({ name: s.name, description: s.description, health: null, files: s.files }))
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
        logged('skill_use', args, async () => {
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
        logged('rag_search', args, async () => {
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
      logged('rag_collections', args, async () => {
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
        logged('web_search', args, async () => {
          const res = await this.deps.web.search(args.query, { k: args.k })
          return {
            content: [{ type: 'text', text: res.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n') || 'No results.' }],
            structuredContent: { engine: res.engine, results: res.results }
          }
        })
    )
    server.registerTool(
      'rag_index',
      {
        title: 'Index knowledge',
        description: RAG_INDEX_DESCRIPTION + ' Paths are absolute paths on this computer.',
        inputSchema: {
          collection: z.string().describe('Collection name (or id)'),
          create: z.boolean().optional().describe('Create the collection if missing (default true)'),
          description: z.string().optional().describe('Description for a new collection'),
          title: z.string().optional().describe('Title for text'),
          text: z.string().optional().describe('Markdown or plain text to index'),
          urls: z.array(z.string()).optional().describe('Web pages to fetch and index'),
          crawl: z.boolean().optional().describe('Follow same-site links from each URL'),
          maxPages: z.number().int().min(1).max(1000).optional().describe('Page limit when crawling (default 25)'),
          paths: z.array(z.string()).optional().describe('Absolute paths of files or folders')
        }
      },
      (args) =>
        logged('rag_index', args, async () => {
          const text = await indexKnowledge(this.deps.rag, args, {
            resolvePath: async (p) => {
              if (!isAbsolute(p)) throw new Error(`Use an absolute path: ${p}`)
              await stat(p).catch(() => {
                throw new Error(`Not found: ${p}`)
              })
              return resolve(p)
            }
          })
          return { content: [{ type: 'text', text }] }
        })
    )

    server.registerTool(
      'tool_create',
      {
        title: 'Create tool',
        description: TOOL_CREATE_DESCRIPTION,
        inputSchema: {
          name: z.string().describe('snake_case tool name'),
          description: z.string().describe('What the tool does and when to call it'),
          kind: z.enum(['http', 'javascript', 'command', 'prompt']),
          params: z
            .array(z.object({ name: z.string(), type: z.enum(['string', 'number', 'boolean', 'json']).optional(), description: z.string().optional(), required: z.boolean().optional() }))
            .optional()
            .describe('Arguments, referenced in templates as {{name}}'),
          config: z.record(z.string(), z.unknown()).describe('Kind-specific settings (see description)'),
          replace: z.boolean().optional().describe('Update a tool created earlier through MCP or chat')
        }
      },
      (args) =>
        logged('tool_create', args, async () => {
          const { tool, text } = createTool(this.deps.custom, args, 'mcp')
          return { content: [{ type: 'text', text }], structuredContent: { id: tool.id, name: tool.name, kind: tool.kind, enabled: tool.enabled } }
        })
    )

    server.registerTool(
      'skill_create',
      {
        title: 'Create skill',
        description: SKILL_CREATE_DESCRIPTION,
        inputSchema: {
          name: z.string().describe('kebab-case name'),
          description: z.string().describe('What the skill does and when to use it'),
          instructions: z.string().describe('The SKILL.md body in Markdown'),
          files: z.array(z.object({ path: z.string(), content: z.string() })).optional().describe('Supporting files by relative path')
        }
      },
      (args) => logged('skill_create', args, async () => ({ content: [{ type: 'text', text: await createSkill(this.deps.skills, args) }] }))
    )
    return server
  }

  private async logged(tool: string, args: unknown, fn: () => Promise<ToolResult>, app: string, ua: string): Promise<ToolResult> {
    this.countCall(ua, app)
    const usage = this.deps.usage
    const call = async (): Promise<ToolResult> => {
      const started = Date.now()
      try {
        const out = await fn()
        this.record({ at: started, tool, args, ok: true, durationMs: Date.now() - started, direction: 'in', peer: app })
        usage?.tool(tool, 'mcp', Date.now() - started, true)
        const a = args as { name?: unknown; file?: unknown }
        if (tool === 'skill_use' && typeof a?.name === 'string' && !a.file) usage?.skill(a.name, 'mcp')
        return out
      } catch (err) {
        this.record({ at: started, tool, args, ok: false, durationMs: Date.now() - started, error: errorMessage(err), direction: 'in', peer: app })
        usage?.tool(tool, 'mcp', Date.now() - started, false)
        return { content: [{ type: 'text', text: `Error: ${errorMessage(err)}` }], isError: true }
      }
    }
    return usage ? usage.run({ source: 'mcp' }, call) : call()
  }

  private record(entry: McpCallLog): void {
    this.recent = [entry, ...this.recent].slice(0, 50)
    this.ctx.emit('mcp', this.status())
  }
}

/** The first port from `from` that nothing is listening on (null if none of the next 20 is free). */
function freePort(from: number): Promise<number | null> {
  const tryPort = (p: number) =>
    new Promise<boolean>((resolve) => {
      const s = createNetServer()
      s.once('error', () => resolve(false))
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)))
    })
  return (async () => {
    for (let p = from; p < from + 20 && p <= 65535; p++) if (await tryPort(p)) return p
    return null
  })()
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
