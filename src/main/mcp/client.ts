import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { McpCallLog, McpClientConfig, McpClientStatus, McpPreset } from '@shared/types'
import { errorMessage, type Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import type { ApprovalService } from '../agent/workspace'
import { inPlanMode, type ToolDetails, type ToolScope } from '../agent/tools'

interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  /** MCP tool hints; readOnlyHint = it doesn't change anything. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

/** Whether a server's tool may run in Plan mode (read-only): the tool says it only reads, or the server is trusted to run without asking. */
export function mcpReadOnly(server: Pick<McpClientConfig, 'approval'>, tool: Pick<McpTool, 'annotations'>): boolean {
  return tool.annotations?.readOnlyHint === true || server.approval === 'auto'
}

interface Conn {
  config: McpClientConfig
  state: McpClientStatus['state']
  error: string | null
  tools: McpTool[]
  client: Client | null
  transport: Transport | null
  starting: Promise<void> | null
  /** Recent stderr, for the error message when it fails to start. */
  stderr: string
}

const CONNECT_TIMEOUT = 90_000
const CALL_TIMEOUT = 5 * 60_000

/** Tool names models accept: letters, digits, _ and -, at most 64 characters. */
import { mcpToolName } from '@shared/types'
export { mcpToolName }

/** Ready-made servers for the MCP page. */
export const MCP_PRESETS: McpPreset[] = [
  // File access lets it open pages built in a chat folder (file:// URLs); every call still asks first.
  { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--allow-unrestricted-file-access'], env: {}, enabled: true, defaultOn: false, approval: 'ask', about: 'Opens pages in a real browser to check the UI chats build' },
  { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'], env: {}, enabled: true, defaultOn: false, approval: 'auto', about: 'Up-to-date library and framework docs' },
  // The homelab on the Raspberry Pi, reached over the LAN; each needs its bearer token pasted in.
  // Deploying and stopping apps changes the Pi, so those calls ask first; reading and writing notes runs.
  { name: 'homelab', transport: 'http', url: 'http://mcp.example.internal/mcp', headers: {}, command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'ask', needsToken: true, about: 'Deploys and controls apps on the Pi through Dokploy' },
  { name: 'obsidian', transport: 'http', url: 'http://obsidian.example.internal/mcp', headers: {}, command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'auto', needsToken: true, about: 'Reads, searches and writes notes in the Obsidian vault' }
]

/**
 * Cloth as an MCP client: starts the external servers set up in Settings (stdio), lists their tools
 * and hands them to chats that turn them on. Calls go through the chat's approvals.
 */
export class McpClientService {
  private conns = new Map<string, Conn>()
  /** Servers the user said "always allow" for, per chat (until restart). */
  private trusted = new Map<string, Set<string>>()
  /** Recent tool calls to external servers, newest first (for the MCP page's live log). */
  private recent: McpCallLog[] = []

  constructor(
    private ctx: Ctx,
    private settings: SettingsService,
    private approvals?: ApprovalService
  ) {
    // A server whose command changed restarts; a removed or disabled one stops.
    settings.onChange((next, prev) => {
      const before = new Map(prev.mcpClients.map((c) => [c.id, JSON.stringify(c)]))
      for (const c of next.mcpClients) if (before.get(c.id) !== undefined && before.get(c.id) !== JSON.stringify(c)) void this.stop(c.id)
      for (const id of before.keys()) if (!next.mcpClients.some((c) => c.id === id)) void this.stop(id)
    })
  }

  calls(): McpCallLog[] {
    return this.recent
  }

  private record(entry: McpCallLog): void {
    this.recent = [entry, ...this.recent].slice(0, 50)
    this.ctx.emit('mcpCalls', entry)
  }

  configs(): McpClientConfig[] {
    return this.settings.get().mcpClients
  }

  status(): McpClientStatus[] {
    return this.configs().map((c) => {
      const conn = this.conns.get(c.id)
      return { id: c.id, state: c.enabled ? (conn?.state ?? 'off') : 'off', error: conn?.error ?? null, tools: (conn?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema })) }
    })
  }

  /** The servers a chat uses: its own choice, or the ones on by default. */
  chatServers(chosen: string[] | null): string[] {
    const enabled = this.configs().filter((c) => c.enabled)
    return (chosen ?? enabled.filter((c) => c.defaultOn).map((c) => c.id)).filter((id) => enabled.some((c) => c.id === id))
  }

  /** Start the given servers if they aren't running (errors are kept in their status, not thrown). */
  async ensure(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.start(id).catch(() => undefined)))
  }

  async start(id: string): Promise<McpClientStatus> {
    const config = this.configs().find((c) => c.id === id)
    if (!config) throw new Error('Unknown MCP server')
    let conn = this.conns.get(id)
    if (conn && JSON.stringify(conn.config) !== JSON.stringify(config)) {
      await this.stop(id)
      conn = undefined
    }
    if (conn?.state === 'ready') return this.statusOf(id)
    if (conn?.starting) {
      await conn.starting
      return this.statusOf(id)
    }
    const c: Conn = conn ?? { config, state: 'off', error: null, tools: [], client: null, transport: null, starting: null, stderr: '' }
    this.conns.set(id, c)
    c.state = 'starting'
    c.error = null
    c.stderr = ''
    this.changed()
    c.starting = (async () => {
      let transport: Transport
      let client = new Client({ name: 'cloth', version: '1.0.0' })
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${config.name} did not ${config.transport === 'http' ? 'answer' : 'start'} within ${CONNECT_TIMEOUT / 1000}s`)), CONNECT_TIMEOUT).unref?.())
      if (config.transport === 'http') {
        transport = await this.connectHttp(config, client, timeout).then(
          (r) => ((client = r.client), r.transport),
          (err) => {
            c.state = 'error'
            c.error = errorMessage(err).slice(0, 600)
            throw err
          }
        )
      } else {
        // Each server works in its own folder under Cloth's data (screenshots, logs and caches land there).
        const cwd = join(this.ctx.dataDir, 'mcp-servers', config.name.replace(/[^a-zA-Z0-9_-]+/g, '_'))
        await mkdir(cwd, { recursive: true })
        const stdio = new StdioClientTransport({
          command: config.command,
          args: config.args,
          cwd,
          env: { ...(process.env as Record<string, string>), ...config.env },
          stderr: 'pipe'
        })
        stdio.stderr?.on('data', (d: Buffer) => (c.stderr = (c.stderr + d.toString()).slice(-4000)))
        transport = stdio
      }
      try {
        if (config.transport !== 'http') await Promise.race([client.connect(transport), timeout])
        const tools: McpTool[] = []
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined)
          tools.push(...(page.tools as McpTool[]))
          cursor = page.nextCursor
        } while (cursor)
        c.client = client
        c.transport = transport
        c.tools = tools
        c.state = 'ready'
        transport.onclose = () => {
          if (c.transport !== transport) return
          c.state = 'off'
          c.client = null
          c.transport = null
          this.changed()
        }
      } catch (err) {
        await transport.close().catch(() => undefined)
        const tail = c.stderr.trim().split('\n').slice(-3).join(' ')
        c.state = 'error'
        c.error = `${errorMessage(err)}${tail ? ` — ${tail}` : ''}`.slice(0, 600)
        this.ctx.log('mcp-client', `${config.name} failed to start`, c.error)
      } finally {
        c.starting = null
        this.changed()
      }
    })().catch((err) => {
      // A remote server that couldn't be reached at all.
      c.state = 'error'
      c.error = c.error ?? errorMessage(err).slice(0, 600)
      c.starting = null
      this.ctx.log('mcp-client', `${config.name} failed to connect`, c.error)
      this.changed()
    })
    await c.starting
    return this.statusOf(id)
  }

  /**
   * Connect to a server at a web address: Streamable HTTP first (the current MCP transport), then the older
   * HTTP+SSE transport for servers that only speak that. Returns the client and transport that worked.
   */
  private async connectHttp(config: McpClientConfig, first: Client, timeout: Promise<never>): Promise<{ client: Client; transport: Transport }> {
    let url: URL
    try {
      url = new URL(String(config.url ?? '').trim())
    } catch {
      throw new Error(`${config.name}: “${config.url ?? ''}” isn't a web address`)
    }
    const requestInit = { headers: config.headers ?? {} }
    const streamable = new StreamableHTTPClientTransport(url, { requestInit })
    try {
      await Promise.race([first.connect(streamable), timeout])
      return { client: first, transport: streamable }
    } catch (err) {
      await streamable.close().catch(() => undefined)
      const sse = new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...requestInit.headers } }) } })
      const client = new Client({ name: 'cloth', version: '1.0.0' })
      try {
        await Promise.race([client.connect(sse), timeout])
        return { client, transport: sse }
      } catch {
        await sse.close().catch(() => undefined)
        throw new Error(`${config.name}: couldn't connect to ${url.href} (${errorMessage(err)})`)
      }
    }
  }

  async stop(id: string): Promise<void> {
    const c = this.conns.get(id)
    if (!c) return
    this.conns.delete(id)
    const t = c.transport
    c.transport = null
    c.client = null
    await t?.close().catch(() => undefined)
    this.changed()
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.conns.keys()].map((id) => this.stop(id)))
  }

  private statusOf(id: string): McpClientStatus {
    return this.status().find((s) => s.id === id) ?? { id, state: 'off', error: null, tools: [] }
  }

  private changed(): void {
    this.ctx.emit('mcpClients', { type: 'changed' })
  }

  /** Call one tool on a server, outside any chat (the Tools page's Try it, an automation's check). Returns its text. */
  async call(id: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    await this.ensure([id])
    const c = this.conns.get(id)
    if (c?.state !== 'ready') throw new Error(`The ${c?.config.name ?? 'MCP'} server isn't running${c?.error ? `: ${c.error}` : ''}`)
    const t = c.tools.find((x) => x.name === tool)
    if (!t) throw new Error(`The ${c.config.name} server has no tool called ${tool}`)
    const result = await this.agentTool(c, t, { collectionIds: [], skillsEnabled: false, workspace: null, autoApprove: () => 'all' }).execute(`try_${Date.now()}`, args, signal)
    return result.content.map((x) => (x.type === 'text' ? x.text : '[image]')).join('\n')
  }

  /** Agent tools for the chat's servers that are running. */
  tools(scope: ToolScope): AgentTool<any, ToolDetails>[] {
    if (!scope.mcpServers?.length) return []
    const out: AgentTool<any, ToolDetails>[] = []
    for (const id of scope.mcpServers) {
      const c = this.conns.get(id)
      if (c?.state !== 'ready') continue
      // Plan mode is read-only: only tools that say they only read (or trusted servers' tools).
      for (const tool of c.tools) if (!inPlanMode(scope) || mcpReadOnly(c.config, tool)) out.push(this.agentTool(c, tool, scope))
    }
    return out
  }

  private agentTool(c: Conn, tool: McpTool, scope: ToolScope): AgentTool<any, ToolDetails> {
    const server = c.config
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
    return {
      name: mcpToolName(server.name, tool.name),
      label: `${server.name}: ${tool.name}`,
      description: `${tool.description ?? tool.name} (external tool from the "${server.name}" MCP server)`.slice(0, 1024),
      parameters: Type.Unsafe(schema),
      execute: async (toolCallId, params, signal) => {
        const started = Date.now()
        if (inPlanMode(scope) && !mcpReadOnly(server, tool)) throw new Error('This chat is in Plan mode, which is read-only: put this step in your plan (present_plan) instead.')
        await this.approve(server, tool.name, params, scope, toolCallId, signal)
        const client = this.conns.get(server.id)?.client
        if (!client) throw new Error(`The ${server.name} server is not running — it may have exited. Try again, or check it in Settings → MCP.`)
        const call = client.callTool({ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> }, undefined, { signal, timeout: CALL_TIMEOUT })
        const log = (ok: boolean, error?: string) => this.record({ at: started, tool: tool.name, args: params, ok, durationMs: Date.now() - started, direction: 'out', peer: server.name, ...(error ? { error } : {}) })
        const result = (await call.then(
          (r) => r,
          (err) => {
            log(false, err instanceof Error ? err.message : String(err))
            throw err
          }
        )) as {
          content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string } }[]
          isError?: boolean
          structuredContent?: unknown
        }
        const content: (TextContent | ImageContent)[] = []
        for (const item of result.content ?? []) {
          if (item.type === 'text' && item.text) content.push({ type: 'text', text: item.text })
          else if (item.type === 'image' && item.data && item.mimeType) content.push({ type: 'image', data: item.data, mimeType: item.mimeType })
          else if (item.type === 'resource' && item.resource) content.push({ type: 'text', text: item.resource.text ?? `[resource ${item.resource.uri ?? ''}]` })
          else if (item.type === 'resource_link') content.push({ type: 'text', text: `[resource ${(item as { uri?: string }).uri ?? ''}]` })
        }
        if (!content.length && result.structuredContent !== undefined) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) })
        if (result.isError) {
          const message = content.map((x) => (x.type === 'text' ? x.text : '')).join('\n') || `${tool.name} failed`
          log(false, message.slice(0, 300))
          throw new Error(message)
        }
        log(true)
        if (!content.length) content.push({ type: 'text', text: '(no output)' })
        return { content, details: { durationMs: Date.now() - started } as ToolDetails }
      }
    }
  }

  /**
   * Servers set to "ask" need the user's go-ahead per call in every permission mode (until "Always
   * allow here"); runs outside chats that approve everything up front don't ask.
   */
  private async approve(server: McpClientConfig, tool: string, params: unknown, scope: ToolScope, toolCallId: string, signal?: AbortSignal): Promise<void> {
    if (server.approval === 'auto' || (!scope.permissions && scope.autoApprove?.() === 'all')) return
    const session = scope.sessionId
    if (!session) return
    if (this.trusted.get(session)?.has(server.id)) return
    if (!this.approvals) throw new Error('This tool needs approval, and there is no one to ask in this context')
    const args = JSON.stringify(params ?? {}, null, 2)
    const decision = await this.approvals.request({ sessionId: session, toolCallId, kind: 'tool', tool: { server: server.name, name: tool }, command: args.length > 4000 ? `${args.slice(0, 4000)}…` : args }, signal)
    if (decision === 'deny') throw new Error(`The user declined this ${server.name} tool call. Do not retry it; ask the user how to proceed.`)
    if (decision === 'always') {
      const set = this.trusted.get(session) ?? new Set<string>()
      set.add(server.id)
      this.trusted.set(session, set)
    }
  }
}
