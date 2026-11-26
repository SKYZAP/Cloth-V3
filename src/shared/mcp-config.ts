import type { McpClientConfig } from './types'

/** A server as the standard JSON config describes it (Claude Desktop, Cursor, VS Code, Claude Code). */
export type McpServerEntry = Pick<McpClientConfig, 'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'oauth'>

const NAME = /^[a-zA-Z0-9_-]{1,32}$/

/** One server as standard JSON, keyed by its name: `{ "playwright": { "type": "stdio", … } }`. */
export function mcpServerJson(c: McpServerEntry): string {
  const body: Record<string, unknown> =
    c.transport === 'http'
      ? { type: 'http', url: c.url ?? '', ...(c.headers && Object.keys(c.headers).length ? { headers: c.headers } : {}), ...(c.oauth && Object.keys(c.oauth).length ? { oauth: c.oauth } : {}) }
      : { type: 'stdio', command: c.command, args: c.args, ...(Object.keys(c.env ?? {}).length ? { env: c.env } : {}) }
  return JSON.stringify({ [c.name]: body }, null, 2)
}

/**
 * Servers from pasted JSON in any of the usual shapes: `{ "name": {…} }`, `{ "mcpServers": {…} }`,
 * VS Code's `{ "servers": {…} }`, or the `"mcpServers": {…}` fragment copied out of a bigger file.
 * Returns the servers, or a plain error saying what's wrong.
 */
export function parseMcpServers(text: string): { servers: McpServerEntry[]; error: null } | { servers: []; error: string } {
  const fail = (error: string) => ({ servers: [] as [], error })
  let src = text.trim()
  if (!src) return fail('Paste or write a server’s JSON config.')
  // A fragment like `"mcpServers": { … }` (copied from inside a file) becomes an object.
  if (src.startsWith('"')) src = `{${src.replace(/,\s*$/, '')}}`
  let data: unknown
  try {
    data = JSON.parse(src)
  } catch (err) {
    return fail(`That isn’t valid JSON: ${err instanceof Error ? err.message.replace(/^JSON\.parse: /, '') : String(err)}`)
  }
  if (!isObject(data)) return fail('Write the server as an object, like { "playwright": { "command": "npx", … } }.')
  const root = isObject(data.mcpServers) ? data.mcpServers : isObject(data.servers) ? data.servers : data
  // A single server written without its name around it.
  if (typeof root.command === 'string' || typeof root.url === 'string') return fail('Put the server under a name, like { "my-server": { … } }. The name is how its tools are labelled.')
  const out: McpServerEntry[] = []
  for (const [name, raw] of Object.entries(root)) {
    if (!NAME.test(name)) return fail(`“${name}” can’t be a server name: use up to 32 letters, digits, - or _.`)
    if (!isObject(raw)) return fail(`“${name}” should be an object with a command or a url.`)
    const type = String(raw.type ?? (typeof raw.url === 'string' ? 'http' : 'stdio')).toLowerCase()
    if (['http', 'streamable-http', 'streamablehttp', 'sse'].includes(type)) {
      const url = typeof raw.url === 'string' ? raw.url.trim() : ''
      if (!/^https?:\/\/\S+$/i.test(url)) return fail(`“${name}” needs a "url" starting with https:// (or http:// on this computer).`)
      const headers = strings(raw.headers)
      if (headers === null) return fail(`“${name}”: "headers" should map names to text, like { "Authorization": "Bearer …" }.`)
      const oauth = oauthOf(raw.oauth)
      if (oauth === null) return fail(`“${name}”: "oauth" should be like { "clientId": "…", "callbackPort": 8080 }.`)
      out.push({ name, transport: 'http', url, headers, command: '', args: [], env: {}, ...(oauth ? { oauth } : {}) })
    } else if (type === 'stdio') {
      if (typeof raw.command !== 'string' || !raw.command.trim()) return fail(`“${name}” needs a "command", like "npx".`)
      const args = raw.args === undefined ? [] : Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string' || typeof a === 'number') ? raw.args.map(String) : null
      if (args === null) return fail(`“${name}”: "args" should be a list of text, like ["-y", "@playwright/mcp@latest"].`)
      const env = strings(raw.env)
      if (env === null) return fail(`“${name}”: "env" should map names to text, like { "API_KEY": "…" }.`)
      out.push({ name, transport: 'stdio', command: raw.command.trim(), args, env })
    } else return fail(`“${name}” has "type": "${raw.type}". Use "stdio" for a program or "http" for a web address.`)
  }
  if (!out.length) return fail('No servers found. Write one like { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }.')
  return { servers: out, error: null }
}

/** A server's "oauth" block (Claude Code writes clientId and callbackPort); undefined when absent, null when malformed. */
export function oauthOf(v: unknown): McpClientConfig['oauth'] | null | undefined {
  if (v === undefined || v === null) return undefined
  if (!isObject(v)) return null
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined)
  const port = typeof v.callbackPort === 'number' ? v.callbackPort : typeof v.callbackPort === 'string' && /^\d+$/.test(v.callbackPort) ? Number(v.callbackPort) : undefined
  if (port !== undefined && (port < 1 || port > 65535)) return null
  const out = { clientId: str(v.clientId ?? v.client_id), clientSecret: str(v.clientSecret ?? v.client_secret), callbackPort: port, scope: str(v.scope ?? (Array.isArray(v.scopes) ? v.scopes.join(' ') : undefined)) }
  const kept = Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined))
  return Object.keys(kept).length ? (kept as McpClientConfig['oauth']) : undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** A { name: text } map (numbers and booleans count as text); null when it isn't one. */
function strings(v: unknown): Record<string, string> | null {
  if (v === undefined) return {}
  if (!isObject(v)) return null
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') return null
    out[k] = String(x)
  }
  return out
}

/** What's wrong with a server filled in field by field (null when it can be saved). */
export function serverProblem(e: McpServerEntry, taken: string[]): string | null {
  if (!e.name.trim()) return 'Give it a name.'
  if (!NAME.test(e.name)) return 'Names use up to 32 letters, digits, - or _.'
  if (taken.includes(e.name)) return `There’s already a server called “${e.name}”. Pick another name.`
  if (e.transport === 'http') {
    if (!/^https?:\/\/\S+$/i.test((e.url ?? '').trim())) return 'Enter its address, starting with http:// or https://.'
    if (Object.keys(e.headers ?? {}).some((k) => !k.trim())) return 'Each header needs a name.'
  } else {
    if (!e.command.trim()) return 'Enter the program to run, like npx.'
    if (/\s/.test(e.command.trim())) return 'Put only the program in Program; each argument goes in its own box.'
    if (Object.keys(e.env ?? {}).some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) return 'Variable names use letters, digits and _, and don’t start with a digit.'
  }
  return null
}

/**
 * A pasted command line as a program and its arguments: `npx -y "@scope/pkg" --flag` →
 * npx, [-y, @scope/pkg, --flag]. Quotes group words; nothing else is interpreted.
 */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const words: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) words.push(m[1] ?? m[2] ?? m[3])
  return { command: words[0] ?? '', args: words.slice(1) }
}

/** A suggested server name from what it runs or where it is: @playwright/mcp → playwright, mcp.example.com → mcp. */
export function suggestName(e: Pick<McpServerEntry, 'transport' | 'command' | 'args' | 'url'>): string {
  let base = ''
  if (e.transport === 'http') {
    try {
      const host = new URL(e.url ?? '').hostname
      base = host.split('.').filter((p) => !['www', 'mcp', 'api', 'localhost'].includes(p))[0] ?? host.split('.')[0] ?? ''
    } catch {
      base = ''
    }
  } else {
    const pkg = e.args.find((a) => !a.startsWith('-')) ?? e.command
    base = pkg.replace(/@[^/]*$/, '').replace(/^@[^/]+\//, (s) => (/(^@)(modelcontextprotocol|mcp)\//.test(s) ? '' : s.slice(1, -1) + '-')).replace(/[-_]?mcp(-server)?$|^mcp[-_]?(server[-_])?|^server[-_]/g, '')
    base = base.split(/[\/]/).pop() ?? base
  }
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
}
