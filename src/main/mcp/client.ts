import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { McpCallLog, McpClientConfig, McpClientStatus } from '@shared/types'
import { errorMessage, type Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import type { ApprovalService } from '../agent/workspace'
import type { ToolDetails, ToolScope } from '../agent/tools'

interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

interface Conn {
  config: McpClientConfig
  state: McpClientStatus['state']
  error: string | null
  tools: McpTool[]
  client: Client | null
  transport: StdioClientTransport | null
  starting: Promise<void> | null
  /** Recent stderr, for the error message when it fails to start. */
  stderr: string
}

const CONNECT_TIMEOUT = 90_000
const CALL_TIMEOUT = 5 * 60_000

/** Tool names models accept: letters, digits, _ and -, at most 64 characters. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_')
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64)
}

/** Ready-made servers for the settings page. */
export const MCP_PRESETS: Omit<McpClientConfig, 'id'>[] = [
  // File access lets it open pages built in a chat folder (file:// URLs); every call still asks first.
  { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--allow-unrestricted-file-access'], env: {}, enabled: true, defaultOn: false, approval: 'ask' },
  { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'], env: {}, enabled: true, defaultOn: false, approval: 'auto' }
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
      return { id: c.id, state: c.enabled ? (conn?.state ?? 'off') : 'off', error: conn?.error ?? null, tools: (conn?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })) }
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
      // Each server works in its own folder under Cloth's data (screenshots, logs and caches land there).
      const cwd = join(this.ctx.dataDir, 'mcp-servers', config.name.replace(/[^a-zA-Z0-9_-]+/g, '_'))
      await mkdir(cwd, { recursive: true })
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd,
        env: { ...(process.env as Record<string, string>), ...config.env },
        stderr: 'pipe'
      })
      transport.stderr?.on('data', (d: Buffer) => (c.stderr = (c.stderr + d.toString()).slice(-4000)))
      const client = new Client({ name: 'cloth', version: '1.0.0' })
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${config.name} did not start within ${CONNECT_TIMEOUT / 1000}s`)), CONNECT_TIMEOUT).unref?.())
      try {
        await Promise.race([client.connect(transport), timeout])
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
    })()
    await c.starting
    return this.statusOf(id)
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

  /** Agent tools for the chat's servers that are running. */
  tools(scope: ToolScope): AgentTool<any, ToolDetails>[] {
    if (!scope.mcpServers?.length) return []
    const out: AgentTool<any, ToolDetails>[] = []
    for (const id of scope.mcpServers) {
      const c = this.conns.get(id)
      if (c?.state !== 'ready') continue
      for (const tool of c.tools) out.push(this.agentTool(c, tool, scope))
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

  /** Servers set to "ask" need the user's go-ahead per call, unless the chat approves everything. */
  private async approve(server: McpClientConfig, tool: string, params: unknown, scope: ToolScope, toolCallId: string, signal?: AbortSignal): Promise<void> {
    if (server.approval === 'auto' || scope.autoApprove?.() === 'all') return
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
