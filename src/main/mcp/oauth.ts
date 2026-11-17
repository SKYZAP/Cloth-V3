import { createServer, type Server } from 'node:http'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpClientConfig } from '@shared/types'
import type { Ctx } from '../core/context'

/** What Cloth keeps for one server's sign-in, encrypted at rest. */
interface Stored {
  /** The loopback port the browser comes back to; registered with the server, so it stays the same. */
  port?: number
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  verifier?: string
}

const key = (id: string) => `mcp.oauth.${id}`
const SIGN_IN_TIMEOUT = 5 * 60_000

const PAGE = (ok: boolean, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>Cloth</title><body style="font:15px system-ui;background:#111114;color:#e8e8ec;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1 style="font-size:18px;color:${ok ? '#e8e8ec' : '#ff8a8a'}">${text}</h1><p style="color:#9a9aa4">You can close this tab and go back to Cloth.</p></div>`

/**
 * OAuth for MCP servers reached over HTTP (the MCP authorization spec: discovery, dynamic client registration,
 * PKCE, refresh). Cloth signs in through the system browser and a one-off listener on 127.0.0.1, the way
 * Claude Code and other desktop clients do. Without `interactive`, a server that wants a sign-in just
 * records that it does, so a chat starting servers in the background never pops a browser.
 */
export class McpOAuth implements OAuthClientProvider {
  /** Set by redirectToAuthorization when sign-in is needed but not allowed right now. */
  needsSignIn = false
  private listener: { server: Server; code: Promise<string> } | null = null

  constructor(
    private ctx: Ctx,
    private config: McpClientConfig,
    private openBrowser: (url: string) => void,
    private interactive: boolean
  ) {}

  static clear(ctx: Ctx, id: string): void {
    ctx.kv.set(key(id), null)
  }

  static signedIn(ctx: Ctx, id: string): boolean {
    return !!read(ctx, id).tokens
  }

  private get stored(): Stored {
    return read(this.ctx, this.config.id)
  }

  private save(patch: Partial<Stored>): void {
    const next = { ...this.stored, ...patch }
    this.ctx.kv.set(key(this.config.id), Buffer.from(this.ctx.secrets.encrypt(JSON.stringify(next))).toString('base64'))
  }

  private get port(): number {
    let port = this.config.oauth?.callbackPort ?? this.stored.port
    if (!port) {
      port = 33000 + Math.floor(Math.random() * 20000)
      this.save({ port })
    }
    return port
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Cloth',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.config.oauth?.clientSecret ? 'client_secret_post' : 'none',
      ...(this.config.oauth?.scope ? { scope: this.config.oauth.scope } : {})
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // A client registered by hand (servers without dynamic registration, like GitHub's) wins over a registered one.
    const o = this.config.oauth
    if (o?.clientId) return { client_id: o.clientId, ...(o.clientSecret ? { client_secret: o.clientSecret } : {}) }
    return this.stored.client
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.save({ client })
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.save({ tokens })
  }

  saveCodeVerifier(verifier: string): void {
    this.save({ verifier })
  }

  codeVerifier(): string {
    const v = this.stored.verifier
    if (!v) throw new Error('The sign-in was not started from Cloth. Sign in again.')
    return v
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') this.save({ client: undefined, tokens: undefined, verifier: undefined })
    else if (scope === 'client') this.save({ client: undefined })
    else if (scope === 'tokens') this.save({ tokens: undefined })
    else if (scope === 'verifier') this.save({ verifier: undefined })
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) {
      this.needsSignIn = true
      return
    }
    await this.listen()
    this.openBrowser(url.toString())
  }

  /** The code the browser brings back after the user signs in (rejects after five minutes or on an error). */
  waitForCode(): Promise<string> {
    if (!this.listener) return Promise.reject(new Error('Sign-in did not start'))
    return this.listener.code
  }

  close(): void {
    this.listener?.server.close()
    this.listener = null
  }

  private async listen(): Promise<void> {
    if (this.listener) return
    let resolve!: (code: string) => void
    let reject!: (err: Error) => void
    const code = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)))
    code.catch(() => undefined)
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', this.redirectUrl)
      if (u.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const err = u.searchParams.get('error')
      const got = u.searchParams.get('code')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (got) {
        res.end(PAGE(true, `Signed in to ${escapeHtml(this.config.name)}`))
        resolve(got)
      } else {
        const why = u.searchParams.get('error_description') ?? err ?? 'no code came back'
        res.end(PAGE(false, `Couldn’t sign in to ${escapeHtml(this.config.name)}`))
        reject(new Error(`Sign-in failed: ${why}`))
      }
      setTimeout(() => this.close(), 500).unref?.()
    })
    await new Promise<void>((res, rej) => {
      server.once('error', (e: NodeJS.ErrnoException) =>
        rej(e.code === 'EADDRINUSE' ? new Error(`Port ${this.port} is in use, so the sign-in can't come back to Cloth. Close what's using it, or set another callback port.`) : e)
      )
      server.listen(this.port, '127.0.0.1', () => res())
    })
    const timer = setTimeout(() => {
      reject(new Error('The sign-in took longer than five minutes. Try again.'))
      this.close()
    }, SIGN_IN_TIMEOUT)
    timer.unref?.()
    server.on('close', () => clearTimeout(timer))
    this.listener = { server, code }
  }
}

function read(ctx: Ctx, id: string): Stored {
  const raw = ctx.kv.get<string | null>(key(id), null)
  if (!raw) return {}
  try {
    return JSON.parse(ctx.secrets.decrypt(Buffer.from(raw, 'base64'))) as Stored
  } catch {
    return {}
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
