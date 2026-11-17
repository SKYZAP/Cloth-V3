import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Trash } from '@phosphor-icons/react'
import type { McpClientConfig, McpClientStatus, McpPreset } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Segmented, Switch, confirmAction } from '@/components/ui'
import { Editor } from '@/components/Editor'
import { mcpServerJson, parseMcpServers, type McpServerEntry } from '@shared/mcp-config'
import { GuidedServerForm } from './GuidedServerForm'

const newId = () => `mcs_${Math.random().toString(36).slice(2, 10)}`
export const STATE: Record<McpClientStatus['state'], { label: string; dot: string }> = {
  off: { label: 'Stopped', dot: 'bg-line-strong' },
  starting: { label: 'Starting…', dot: 'bg-warn animate-pulse motion-reduce:animate-none' },
  ready: { label: 'Running', dot: 'bg-ok' },
  error: { label: 'Failed', dot: 'bg-danger' },
  auth: { label: 'Needs sign-in', dot: 'bg-warn' }
}

const quote = (w: string) => (/\s/.test(w) ? `"${w}"` : w)
/** What a server is: its command line, or its address for a server reached over HTTP. */
const SECRET = /token|key|secret|password|auth/i
/** An address with token-like query values hidden (Penpot's key travels in the address). */
function maskUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) if (SECRET.test(k)) u.searchParams.set(k, '•••')
    return u.toString().replace(/%E2%80%A2/g, '•')
  } catch {
    return url
  }
}
/** How a server is started, for display: secrets in addresses and after --token-like flags are hidden. */
export const commandLine = (c: Pick<McpClientConfig, 'command' | 'args' | 'transport' | 'url'>) => {
  if (c.transport === 'http') return maskUrl(c.url ?? '')
  const args = c.args.map((a, i) => {
    const flag = /^(--?[\w-]+)=(.*)$/.exec(a)
    if (flag && SECRET.test(flag[1])) return `${flag[1]}=•••`
    if (i > 0 && /^--?[\w-]+$/.test(c.args[i - 1]) && SECRET.test(c.args[i - 1])) return '•••'
    return /^https?:\/\//.test(a) ? maskUrl(a) : a
  })
  return [c.command, ...args].map(quote).join(' ')
}

/** One line on what a server is: its preset's description, else where it lives or what it runs. */
export function aboutOf(c: Pick<McpClientConfig, 'name' | 'transport' | 'url' | 'command' | 'args'>, presets: McpPreset[]): string {
  const known = presets.find((p) => p.name === c.name)?.about
  if (known) return known
  if (c.transport === 'http') {
    try {
      return `A server at ${new URL(c.url ?? '').host}`
    } catch {
      return 'A server at a web address'
    }
  }
  const pkg = c.args.find((a) => !a.startsWith('-'))
  return pkg ? `Runs ${pkg} on this computer` : `Runs ${c.command} on this computer`
}

/** External MCP servers Cloth connects to (configs live in settings), with their live status. */
export function useExternalServers() {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const [status, setStatus] = useState<McpClientStatus[]>([])
  const [presets, setPresets] = useState<McpPreset[]>([])
  const load = () => void api.mcp.clients().then(setStatus)
  useEffect(() => {
    load()
    void api.mcp.clientPresets().then(setPresets)
  }, [])
  useEvent('mcpClients', () => {
    load()
    // The server list may have changed somewhere else (another window, the phone): pick it up.
    void api.settings.get().then((fresh) => useApp.setState({ settings: fresh }))
  })
  const configs = settings?.mcpClients ?? []

  const save = async (next: McpClientConfig[]) => {
    await updateSettings({ mcpClients: next })
    load()
  }
  const patch = (id: string, p: Partial<McpClientConfig>) => void save(configs.map((c) => (c.id === id ? { ...c, ...p } : c)))
  /** Adds a server and starts it right away, so problems show up here rather than in a chat. Returns its id. */
  const add = async (c: Omit<McpClientConfig, 'id'>) => {
    const id = newId()
    await save([...configs, { ...c, id }])
    void attempt(() => api.mcp.startClient(id)).then(load)
    return id
  }
  const remove = async (c: McpClientConfig) => {
    if (!(await confirmAction(`Chats stop getting the “${c.name}” tools.`, { title: `Remove ${c.name}?`, confirmLabel: 'Remove', danger: true }))) return false
    await save(configs.filter((x) => x.id !== c.id))
    return true
  }
  const restart = (id: string) => void attempt(() => api.mcp.stopClient(id).then(() => api.mcp.startClient(id))).then(load)
  /** Opens the server's sign-in in the browser; it connects once the user is back. */
  const signIn = (id: string) => void attempt(() => api.mcp.signInClient(id)).then(load)
  const signOut = (id: string) => void attempt(() => api.mcp.signOutClient(id)).then(load)
  const stateOf = (c: McpClientConfig): McpClientStatus['state'] => (c.enabled ? (status.find((s) => s.id === c.id)?.state ?? 'off') : 'off')
  const unused = presets.filter((p) => !configs.some((c) => c.name === p.name))
  return { configs, status, presets, unused, patch, add, remove, restart, signIn, signOut, stateOf }
}

export type ExternalServers = ReturnType<typeof useExternalServers>

/** One server's state, chat defaults, tools and connection (the MCP page's side panel). */
export function ServerDetail({ config: c, servers, onRemoved }: { config: McpClientConfig; servers: ExternalServers; onRemoved(): void }) {
  const st = servers.status.find((s) => s.id === c.id)
  const state = servers.stateOf(c)
  const [asJson, setAsJson] = useState(false)
  const [filter, setFilter] = useState('')
  const live = st?.state === 'ready'
  const tools = live ? st.tools : (st?.knownTools ?? [])
  const q = filter.trim().toLowerCase()
  const shown = q ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) : tools
  const label = !c.enabled
    ? 'Turned off. Chats can’t use it.'
    : state === 'ready'
      ? 'Running'
      : state === 'starting'
        ? 'Starting…'
        : state === 'auth'
          ? `Sign in to ${c.name} to use its tools`
          : state === 'error'
            ? c.transport === 'http'
              ? 'Couldn’t connect'
              : 'Couldn’t start'
            : 'Not running. It starts when a chat uses it.'
  return (
    <div className="grid min-w-0 gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex min-w-0 flex-1 items-center gap-2 text-ui">
            <span className={clsx('h-2 w-2 shrink-0 rounded-full', c.enabled ? STATE[state].dot : 'bg-line-strong')} aria-hidden="true" />
            <span role="status">{label}</span>
          </span>
          {state === 'auth' ? (
            <Button size="sm" variant="primary" disabled={!c.enabled} onClick={() => servers.signIn(c.id)}>
              Sign in
            </Button>
          ) : (
            <Button size="sm" disabled={!c.enabled || state === 'starting'} onClick={() => servers.restart(c.id)}>
              {state === 'ready' ? 'Restart' : state === 'error' ? 'Try again' : 'Start now'}
            </Button>
          )}
        </div>
        {state === 'auth' && <p className="text-caption text-muted">Sign in opens {c.name}’s sign-in page in your browser. Cloth keeps the sign-in, so you only do this once.</p>}
        {state === 'starting' && c.transport === 'http' && !st?.signedIn && <p className="text-caption text-muted">If your browser opened a sign-in page, finish signing in there.</p>}
        {st?.state === 'error' && st.error && (
          <div role="alert" className="rounded-[10px] border border-danger-line bg-danger-soft px-3 py-2 text-caption">
            <div className="selectable font-mono text-caption text-danger-hi">{st.error}</div>
            <div className="mt-1.5 text-muted">{c.transport === 'http' ? 'Check the address and token under Connection, then try again.' : 'Check the program and its arguments under Connection, then try again.'}</div>
          </div>
        )}
        {c.transport === 'http' && st?.signedIn && (
          <div className="flex flex-wrap items-center gap-3 text-caption text-muted">
            <span className="flex-1">Signed in through {c.name}’s own sign-in page.</span>
            <Button size="sm" variant="ghost" onClick={() => servers.signOut(c.id)}>
              Sign out
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-3">
        <h3 className="text-ui font-semibold">In chats</h3>
        <Switch checked={c.enabled} onChange={(enabled) => servers.patch(c.id, { enabled })} label="Let chats use it" />
        <div className="grid gap-1">
          <Switch checked={c.defaultOn} disabled={!c.enabled} onChange={(defaultOn) => servers.patch(c.id, { defaultOn })} label="On in new chats" />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ui">
          <span>Before a tool runs</span>
          <Segmented
            value={c.approval}
            onChange={(approval) => servers.patch(c.id, { approval })}
            items={[
              { value: 'ask', label: 'Ask me first' },
              { value: 'auto', label: 'Run without asking' }
            ]}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-ui font-semibold">
            Tools <span className="font-normal text-dim">{tools.length || ''}</span>
          </h3>
          <span className="flex-1" />
          {tools.length > 8 && (
            <input
              type="search"
              aria-label={`Filter ${c.name}’s tools`}
              placeholder="Filter tools…"
              spellCheck={false}
              autoComplete="off"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-7 w-[180px] rounded-md border border-line bg-panel px-2 text-caption text-fg placeholder:text-dim focus:border-crimson-line focus:outline-none"
            />
          )}
        </div>
        {tools.length ? (
          <>
            {!live && <p className="text-caption text-dim">From its last run.</p>}
            <ul className="grid divide-y divide-line rounded-[10px] border border-line bg-panel">
              {shown.map((t) => (
                <li key={t.name} className="grid gap-0.5 px-3 py-2 text-caption">
                  <span className="truncate font-mono text-fg/90" translate="no" title={t.name}>
                    {t.name}
                  </span>
                  {t.description && <span className="line-clamp-2 text-dim">{t.description.split('\n')[0]}</span>}
                </li>
              ))}
              {!shown.length && <li className="px-3 py-2 text-caption text-dim">No tool matches “{filter.trim()}”.</li>}
            </ul>
          </>
        ) : (
          <p className="text-caption text-dim">Start it to see its tools.</p>
        )}
      </div>

      <details className="group grid gap-2">
        <summary className="flex cursor-default list-none items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line [&::-webkit-details-marker]:hidden">
          <span className="text-ui font-semibold">Connection</span>
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-dim" translate="no">
            {commandLine(c)}
          </span>
          <span className="text-caption text-muted group-open:hidden">Edit</span>
        </summary>
        <div className="mt-3 grid gap-3">
          <Segmented
            value={asJson ? 'json' : 'fields'}
            onChange={(v) => setAsJson(v === 'json')}
            items={[
              { value: 'fields', label: 'Fields' },
              { value: 'json', label: 'JSON' }
            ]}
          />
          {asJson ? (
            <ServerForm initial={c} taken={servers.configs.filter((x) => x.id !== c.id).map((x) => x.name)} onSave={([next]) => servers.patch(c.id, { oauth: undefined, ...next })} />
          ) : (
            <GuidedServerForm initial={c} taken={servers.configs.filter((x) => x.id !== c.id).map((x) => x.name)} onSave={(next) => servers.patch(c.id, next)} />
          )}
        </div>
      </details>

      <div className="border-t border-line pt-4">
        <Button size="sm" variant="ghost" className="!text-danger-hi hover:!bg-danger-soft" icon={<Trash size={12} />} onClick={() => void servers.remove(c).then((gone) => gone && onRemoved())}>
          Remove {c.name}
        </Button>
      </div>
    </div>
  )
}

const EXAMPLE = `{
  "playwright": {
    "type": "stdio",
    "command": "npx",
    "args": ["@playwright/mcp@latest"]
  }
}`

/**
 * A server as standard JSON, the way Claude Desktop, Cursor and VS Code write it: a program
 * (`"type": "stdio"`, command, args, env) or a web address (`"type": "http"`, url, headers).
 * Adding takes one server or several pasted at once, including a whole "mcpServers" block.
 */
export function ServerForm({ initial, taken, onSave, onCancel }: { initial?: McpClientConfig; taken: string[]; onSave(servers: McpServerEntry[]): void; onCancel?(): void }) {
  const saved = initial ? mcpServerJson(initial) : ''
  const [text, setText] = useState(saved)
  // Follow changes made elsewhere (another window, the phone, an import).
  useEffect(() => setText(saved), [saved])
  const parsed = parseMcpServers(text)
  const clash = parsed.servers.find((x) => taken.includes(x.name))
  const error = !text.trim() ? null : (parsed.error ?? (clash ? `There’s already a server called “${clash.name}”. Pick another name.` : initial && parsed.servers.length > 1 ? 'Edit one server here. Add the others with Add server.' : null))
  const valid = !!text.trim() && !error
  const dirty = text !== saved
  const tidy = () => {
    try {
      const src = text.trim().startsWith('"') ? `{${text.trim().replace(/,\s*$/, '')}}` : text
      setText(JSON.stringify(JSON.parse(src), null, 2))
    } catch {
      /* not JSON yet: leave it as written */
    }
  }
  const kinds = parsed.servers.map((x) => `${x.name} (${x.transport === 'http' ? 'web address' : 'program'})`)
  return (
    <div className="grid gap-2">
      <div className="h-[220px] overflow-hidden rounded-[10px] border border-line bg-bg focus-within:border-crimson-line" onBlur={tidy}>
        <Editor value={text} onChange={setText} lang="json" placeholder={EXAMPLE} />
      </div>
      <div aria-live="polite" className="min-h-4 text-caption">
        {error ? (
          <span className="text-danger-hi">{error}</span>
        ) : valid && !initial ? (
          <span className="text-dim">Adds {kinds.join(', ')}.</span>
        ) : (
          <span className="text-dim">
            A program: <code className="font-mono">{'"type": "stdio"'}</code> with <code className="font-mono">command</code>, <code className="font-mono">args</code> and <code className="font-mono">env</code>. A web address: <code className="font-mono">{'"type": "http"'}</code> (or <code className="font-mono">"sse"</code>) with <code className="font-mono">url</code> and <code className="font-mono">headers</code>; servers that sign in through the browser need nothing else, and <code className="font-mono">oauth</code> takes a <code className="font-mono">clientId</code> and <code className="font-mono">callbackPort</code> when one needs them. <code className="font-mono">{'${VAR}'}</code> reads an environment variable. Paste a whole <code className="font-mono">mcpServers</code> block to add several.
          </span>
        )}
      </div>
      {dirty && (
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {initial && (
            <Button size="sm" variant="ghost" onClick={() => setText(saved)}>
              Undo changes
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!valid} onClick={() => onSave(parsed.servers)}>
            {initial ? 'Save' : parsed.servers.length > 1 ? `Add ${parsed.servers.length} servers` : 'Add server'}
          </Button>
        </div>
      )}
    </div>
  )
}
