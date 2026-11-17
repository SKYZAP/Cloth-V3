import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RequestInit as UndiciRequestInit } from 'undici'
import { fetchWithWebCa, webCaBundlePath } from '../web/transport'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpOAuth } from './oauth'
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

/** The server wants a sign-in, and this start wasn't allowed to open the browser. */
class NeedsSignIn extends Error {}

/**
 * The parts of a config that decide how Cloth reaches a server. Changing anything else (Ask me first / Run
 * without asking, On in new chats) applies to the running server without restarting it.
 */
export function connectionKey(c: McpClientConfig): string {
  return JSON.stringify([c.transport ?? 'stdio', c.command, c.args, c.env, c.url ?? '', c.headers ?? {}, c.oauth ?? {}])
}

/**
 * `${VAR}` and `${VAR:-default}` filled from Cloth's environment, as Claude Code, Cursor and VS Code do in
 * their MCP configs (so imported servers keep reading API keys from the environment). An unset variable
 * with no default stays as written.
 */
export function expandVars(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, name: string, fallback?: string) => env[name] ?? fallback ?? all)
}

const expandMap = (m: Record<string, string> | undefined) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, expandVars(v)]))

function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

const isUnauthorized = (err: unknown) => err instanceof UnauthorizedError || (err instanceof Error && err.name === 'UnauthorizedError')

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
  { name: 'obsidian', transport: 'http', url: 'http://obsidian.example.internal/mcp', headers: {}, command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'auto', needsToken: true, about: 'Reads, searches and writes notes in the Obsidian vault' },
  // penpot-api-mcp on the Pi: talks to Penpot's API, so nothing has to be open in a browser.
  // Design edits run without asking, as with Penpot's own MCP before it; the penpot skill says how to use it.
  { name: 'penpot', transport: 'http', url: 'http://penpot-mcp.example.internal/mcp', headers: {}, command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'auto', needsToken: true, about: 'Reads, edits and exports designs in the self-hosted Penpot; nothing needs to be open' },
  // Plane's official MCP server on the Pi, for the self-hosted Plane (plane.example.internal, workspace "acme"). It takes a Plane
  // personal access token as the bearer token; OAuth would need Plane's paid edition.
  { name: 'plane', transport: 'http', url: 'http://plane-mcp.example.internal/http/api-key/mcp', headers: { 'X-Workspace-slug': 'acme' }, command: '', args: [], env: {}, enabled: true, defaultOn: false, approval: 'ask', needsToken: true, about: 'Reads and changes projects, work items, cycles and modules in the self-hosted Plane' }
]

/** Where a server's tool list from its last run is kept. */
const knownKey = (id: string) => `mcp.knownTools.${id}`
const brief = (t: { name: string; description: string }) => ({ name: t.name, description: t.description.split('\n')[0].slice(0, 200) })

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
    private approvals?: ApprovalService,
    private openUrl: (url: string) => void = (url) => this.ctx.log('mcp-client', 'open this address to sign in:', url)
  ) {
    // A server whose connection changed restarts; a removed or disabled one stops. Other changes (whether to
    // ask before its tools run, on in new chats) apply to the running server as they are.
    settings.onChange((next, prev) => {
      const before = new Map(prev.mcpClients.map((c) => [c.id, c]))
      for (const c of next.mcpClients) {
        const old = before.get(c.id)
        if (!old) continue
        if (connectionKey(old) !== connectionKey(c) || !c.enabled) void this.stop(c.id)
        else {
          const conn = this.conns.get(c.id)
          if (conn) conn.config = c
        }
      }
      for (const id of before.keys()) if (!next.mcpClients.some((c) => c.id === id)) void this.stop(id)
      // Servers added, changed or removed anywhere (a chat's add_mcp_server, setup's import, the phone): pages showing them reload.
      if (JSON.stringify(next.mcpClients) !== JSON.stringify(prev.mcpClients)) this.changed()
      // A new certificate applies on the next start: running servers restart with it when a chat uses them.
      if (next.webCaCertPath !== prev.webCaCertPath) for (const id of [...this.conns.keys()]) void this.stop(id)
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
      const tools = (conn?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }))
      const knownTools = conn?.state === 'ready' ? tools.map(brief) : this.ctx.kv.get<McpClientStatus['knownTools']>(knownKey(c.id), [])
      const signedIn = c.transport === 'http' && McpOAuth.signedIn(this.ctx, c.id)
      return { id: c.id, state: c.enabled ? (conn?.state ?? 'off') : 'off', error: conn?.error ?? null, signedIn, tools, knownTools }
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

  /** Sign in to a server that wants it (opens the browser), then connect. */
  async signIn(id: string): Promise<McpClientStatus> {
    await this.stop(id)
    return this.start(id, true)
  }

  /** Forget a server's sign-in and disconnect; it asks to sign in again on its next start. */
  async signOut(id: string): Promise<void> {
    McpOAuth.clear(this.ctx, id)
    await this.stop(id)
  }

  /** Start a server. `interactive`: it may open the browser to sign in (the MCP page's Sign in), not just report that it wants one. */
  async start(id: string, interactive = false): Promise<McpClientStatus> {
    const config = this.configs().find((c) => c.id === id)
    if (!config) throw new Error('Unknown MCP server')
    let conn = this.conns.get(id)
    if (conn && connectionKey(conn.config) !== connectionKey(config)) {
      await this.stop(id)
      conn = undefined
    }
    if (conn) conn.config = config
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
      if (config.transport === 'http') {
        transport = await this.connectHttp(config, interactive).then(
          (r) => ((client = r.client), r.transport),
          (err) => {
            if (err instanceof NeedsSignIn) {
              c.state = 'auth'
              c.error = err.message
            } else {
              c.state = 'error'
              c.error = errorMessage(err).slice(0, 600)
            }
            throw err
          }
        )
      } else {
        // Each server works in its own folder under Cloth's data (screenshots, logs and caches land there).
        const cwd = join(this.ctx.dataDir, 'mcp-servers', config.name.replace(/[^a-zA-Z0-9_-]+/g, '_'))
        await mkdir(cwd, { recursive: true })
        const stdio = new StdioClientTransport({
          command: expandVars(config.command),
          args: config.args.map((a) => expandVars(a)),
          cwd,
          env: { ...(process.env as Record<string, string>), ...this.certEnv(), ...expandMap(config.env) },
          stderr: 'pipe'
        })
        stdio.stderr?.on('data', (d: Buffer) => (c.stderr = (c.stderr + d.toString()).slice(-4000)))
        transport = stdio
      }
      try {
        if (config.transport !== 'http') await within(client.connect(transport), CONNECT_TIMEOUT, `${config.name} did not start within ${CONNECT_TIMEOUT / 1000}s`)
        const tools = await listAllTools(client)
        // Servers that change their tools while running say so; the chat gets the new list on its next turn.
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          if (c.client !== client) return
          c.tools = await listAllTools(client).catch(() => c.tools)
          this.ctx.kv.set(knownKey(id), c.tools.map((t) => brief({ name: t.name, description: t.description ?? '' })))
          this.changed()
        })
        c.client = client
        c.transport = transport
        c.tools = tools
        c.state = 'ready'
        this.ctx.kv.set(knownKey(id), tools.map((t) => brief({ name: t.name, description: t.description ?? '' })))
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
      // A remote server that couldn't be reached at all, or one waiting for a sign-in.
      if (c.state !== 'auth') c.state = 'error'
      c.error = c.error ?? errorMessage(err).slice(0, 600)
      c.starting = null
      if (c.state === 'error') this.ctx.log('mcp-client', `${config.name} failed to connect`, c.error)
      this.changed()
    })
    await c.starting
    return this.statusOf(id)
  }

  /**
   * Connect to a server at a web address: Streamable HTTP first (the current MCP transport), then the older
   * HTTP+SSE transport for servers that only speak that. Servers that want a sign-in get one through OAuth
   * (McpOAuth): with `interactive` the browser opens and the connection is retried once the user is back,
   * otherwise it fails with NeedsSignIn. Returns the client and transport that worked.
   */
  private async connectHttp(config: McpClientConfig, interactive: boolean): Promise<{ client: Client; transport: Transport }> {
    let url: URL
    try {
      url = new URL(expandVars(String(config.url ?? '').trim()))
    } catch {
      throw new Error(`${config.name}: “${config.url ?? ''}” isn't a web address`)
    }
    const headers = expandMap(config.headers)
    const requestInit = { headers }
    // Through the certificate set in Settings → Web search, as web search does (networks that inspect HTTPS need it).
    const ca = this.settings.get().webCaCertPath
    const viaCa = ((u: string | URL, init?: RequestInit) => fetchWithWebCa(u, init as UndiciRequestInit, ca)) as unknown as typeof fetch
    const oauth = new McpOAuth(this.ctx, config, this.openUrl, interactive)
    const slow = `${config.name} did not answer within ${CONNECT_TIMEOUT / 1000}s`
    const streamable = () => new StreamableHTTPClientTransport(url, { requestInit, fetch: viaCa, authProvider: oauth })
    const sse = () =>
      new SSEClientTransport(url, {
        requestInit,
        fetch: viaCa,
        authProvider: oauth,
        eventSourceInit: { fetch: (u, init) => viaCa(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) }
      })
    const connect = async (transport: StreamableHTTPClientTransport | SSEClientTransport) => {
      const client = new Client({ name: 'cloth', version: '1.0.0' })
      try {
        await within(client.connect(transport), CONNECT_TIMEOUT, slow)
      } catch (err) {
        await transport.close().catch(() => undefined)
        throw err
      }
      return { client, transport: transport as Transport }
    }
    const attempt = async (make: () => StreamableHTTPClientTransport | SSEClientTransport) => {
      const transport = make()
      try {
        return await connect(transport)
      } catch (err) {
        if (!isUnauthorized(err) && !oauth.needsSignIn) throw err
        if (!interactive) throw new NeedsSignIn(`Sign in to ${config.name} to use its tools.`)
        // The browser is open on the server's sign-in page; finish once it comes back with a code, then connect again.
        try {
          await transport.finishAuth(await oauth.waitForCode())
        } finally {
          oauth.close()
        }
        return connect(make())
      }
    }
    try {
      return await attempt(streamable)
    } catch (err) {
      // A sign-in that failed or was declined isn't a sign the server speaks the older transport.
      if (err instanceof NeedsSignIn || isUnauthorized(err) || oauth.needsSignIn || interactive) throw err
      try {
        return await attempt(sse)
      } catch (err2) {
        if (err2 instanceof NeedsSignIn) throw err2
        throw new Error(`${config.name}: couldn't connect to ${url.href} (${errorMessage(err)})`)
      }
    }
  }

  /**
   * The certificate set in Settings → Web search, for servers Cloth starts, as one bundle with everything the computer
   * already trusts: Node (npx and the servers it runs) adds it to its own roots, keeping any NODE_EXTRA_CA_CERTS that was
   * set before; Python tools (uvx, pip, requests) and curl-style tools take it as their whole list.
   */
  private certEnv(): Record<string, string> {
    const ca = this.settings.get().webCaCertPath.trim()
    if (!ca) return {}
    try {
      const bundle = webCaBundlePath(ca, join(this.ctx.dataDir, 'web-certificates'))
      return { NODE_EXTRA_CA_CERTS: bundle, SSL_CERT_FILE: bundle, REQUESTS_CA_BUNDLE: bundle, CURL_CA_BUNDLE: bundle }
    } catch (err) {
      this.ctx.log('mcp-client', 'the certificate set for web search could not be read', errorMessage(err))
      return {}
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
    return this.status().find((s) => s.id === id) ?? { id, state: 'off', error: null, tools: [], knownTools: [] }
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
  private async approve(saved: McpClientConfig, tool: string, params: unknown, scope: ToolScope, toolCallId: string, signal?: AbortSignal): Promise<void> {
    // The setting as it is now: it can change while the chat runs, without restarting the server.
    const server = this.configs().find((c) => c.id === saved.id) ?? saved
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

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    tools.push(...(page.tools as McpTool[]))
    cursor = page.nextCursor
  } while (cursor)
  return tools
}
