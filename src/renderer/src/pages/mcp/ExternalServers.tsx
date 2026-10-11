import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Trash } from '@phosphor-icons/react'
import type { McpClientConfig, McpClientStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Segmented, Switch, confirmAction } from '@/components/ui'
import { Editor } from '@/components/Editor'
import { mcpServerJson, parseMcpServers, type McpServerEntry } from '@shared/mcp-config'

const newId = () => `mcs_${Math.random().toString(36).slice(2, 10)}`
export const STATE: Record<McpClientStatus['state'], { label: string; dot: string }> = {
  off: { label: 'Stopped', dot: 'bg-line-strong' },
  starting: { label: 'Starting…', dot: 'bg-warn animate-pulse motion-reduce:animate-none' },
  ready: { label: 'Running', dot: 'bg-ok' },
  error: { label: 'Failed', dot: 'bg-crimson' }
}

const quote = (w: string) => (/\s/.test(w) ? `"${w}"` : w)
/** What a server is: its command line, or its address for a server reached over HTTP. */
export const commandLine = (c: Pick<McpClientConfig, 'command' | 'args' | 'transport' | 'url'>) => (c.transport === 'http' ? (c.url ?? '') : [c.command, ...c.args].map(quote).join(' '))


/** External MCP servers Cloth connects to (configs live in settings), with their live status. */
export function useExternalServers() {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const [status, setStatus] = useState<McpClientStatus[]>([])
  const [presets, setPresets] = useState<Omit<McpClientConfig, 'id'>[]>([])
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
  const stateOf = (c: McpClientConfig): McpClientStatus['state'] => (c.enabled ? (status.find((s) => s.id === c.id)?.state ?? 'off') : 'off')
  const unused = presets.filter((p) => !configs.some((c) => c.name === p.name))
  return { configs, status, unused, patch, add, remove, restart, stateOf }
}

export type ExternalServers = ReturnType<typeof useExternalServers>

/** One server's settings, state, tools and actions (shown in the MCP page's side panel). */
export function ServerDetail({ config: c, servers, onRemoved }: { config: McpClientConfig; servers: ExternalServers; onRemoved(): void }) {
  const st = servers.status.find((s) => s.id === c.id)
  const state = servers.stateOf(c)
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-[13px]">
          <span className={clsx('h-2 w-2 rounded-full', STATE[state].dot)} aria-hidden="true" />
          {c.enabled ? STATE[state].label : 'Turned off'}
        </span>
        <div className="flex-1" />
        <Switch checked={c.enabled} onChange={(enabled) => servers.patch(c.id, { enabled })} label="Connect" />
        <Button size="sm" disabled={!c.enabled || state === 'starting'} onClick={() => servers.restart(c.id)}>
          {state === 'ready' ? 'Restart' : 'Start'}
        </Button>
      </div>
      {st?.state === 'error' && st.error && (
        <div role="alert" className="rounded-[10px] border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">
          <div className="font-medium">It stopped with this error:</div>
          <div className="mt-1 font-mono text-[11.5px]">{st.error}</div>
          <div className="mt-1.5 text-muted">{c.transport === 'http' ? 'Check the address and headers below, then Start it again.' : 'Check the command and environment below, then Start it again.'}</div>
        </div>
      )}
      <div className="grid gap-2">
        <h3 className="text-[12px] font-medium text-muted">In chats</h3>
        <label className="flex items-center gap-2 text-[12.5px]">
          <Switch checked={c.defaultOn} onChange={(defaultOn) => servers.patch(c.id, { defaultOn })} />
          On in new chats
        </label>
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          Tool calls
          <Segmented
            value={c.approval}
            onChange={(approval) => servers.patch(c.id, { approval })}
            items={[
              { value: 'ask', label: 'Ask first' },
              { value: 'auto', label: 'Run' }
            ]}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <h3 className="text-[12px] font-medium text-muted">Connection</h3>
        <ServerForm initial={c} taken={servers.configs.filter((x) => x.id !== c.id).map((x) => x.name)} onSave={([next]) => servers.patch(c.id, next)} />
      </div>
      <div className="grid gap-2">
        <h3 className="text-[12px] font-medium text-muted">Tools{st?.state === 'ready' ? ` (${st.tools.length})` : ''}</h3>
        {st?.state === 'ready' ? (
          <div className="grid gap-1">
            {st.tools.map((t) => (
              <div key={t.name} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-3 text-[12px]">
                <span className="truncate font-mono text-fg/90" translate="no" title={t.name}>
                  {t.name}
                </span>
                <span className="text-dim">{t.description.split('\n')[0].slice(0, 140)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-dim">Its tools are listed once it's running.</p>
        )}
      </div>
      <div className="border-t border-line pt-4">
        <Button size="sm" variant="ghost" icon={<Trash size={12} />} onClick={() => void servers.remove(c).then((gone) => gone && onRemoved())}>
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
      <div aria-live="polite" className="min-h-4 text-[11.5px]">
        {error ? (
          <span className="text-crimson-hi">{error}</span>
        ) : valid && !initial ? (
          <span className="text-dim">Adds {kinds.join(', ')}.</span>
        ) : (
          <span className="text-dim">
            A program: <code className="font-mono">{'"type": "stdio"'}</code> with <code className="font-mono">command</code>, <code className="font-mono">args</code> and <code className="font-mono">env</code>. A web address: <code className="font-mono">{'"type": "http"'}</code> with <code className="font-mono">url</code> and <code className="font-mono">headers</code>. Paste a whole <code className="font-mono">mcpServers</code> block to add several.
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
