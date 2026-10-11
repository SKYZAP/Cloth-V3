import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Trash } from '@phosphor-icons/react'
import type { McpClientConfig, McpClientStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Input, Segmented, Switch, confirmAction } from '@/components/ui'

const newId = () => `mcs_${Math.random().toString(36).slice(2, 10)}`
export const STATE: Record<McpClientStatus['state'], { label: string; dot: string }> = {
  off: { label: 'Stopped', dot: 'bg-line-strong' },
  starting: { label: 'Starting…', dot: 'bg-warn animate-pulse motion-reduce:animate-none' },
  ready: { label: 'Running', dot: 'bg-ok' },
  error: { label: 'Failed', dot: 'bg-crimson' }
}

/** Split a command line into words, keeping "quoted parts" together. */
function words(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}
const quote = (w: string) => (/\s/.test(w) ? `"${w}"` : w)
/** What a server is: its command line, or its address for a server reached over HTTP. */
export const commandLine = (c: Pick<McpClientConfig, 'command' | 'args' | 'transport' | 'url'>) => (c.transport === 'http' ? (c.url ?? '') : [c.command, ...c.args].map(quote).join(' '))

const lines = (o: Record<string, string> | undefined, sep: string) => Object.entries(o ?? {}).map(([k, v]) => `${k}${sep}${v}`).join('\n')
function parseLines(text: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of text.split('\n')) {
    const i = l.indexOf(sep)
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + sep.length).trim()
  }
  return out
}

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
        <ServerForm initial={c} onSave={(next) => servers.patch(c.id, next)} />
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

/** A server's name and how Cloth reaches it: a program it starts (stdio) or a web address (HTTP). */
export function ServerForm({ initial, onSave, onCancel }: { initial?: McpClientConfig; onSave(c: Omit<McpClientConfig, 'id'>): void; onCancel?(): void }) {
  const [kind, setKind] = useState<'stdio' | 'http'>(initial?.transport ?? 'stdio')
  const [name, setName] = useState(initial?.name ?? '')
  const [line, setLine] = useState(initial && initial.transport !== 'http' ? commandLine(initial) : '')
  const [env, setEnv] = useState(lines(initial?.env, '='))
  const [url, setUrl] = useState(initial?.url ?? '')
  const [headers, setHeaders] = useState(lines(initial?.headers, ': '))
  // Follow changes made elsewhere (another window, the phone, an import).
  useEffect(() => {
    if (!initial) return
    setKind(initial.transport ?? 'stdio')
    setName(initial.name)
    setLine(initial.transport !== 'http' ? commandLine(initial) : '')
    setEnv(lines(initial.env, '='))
    setUrl(initial.url ?? '')
    setHeaders(lines(initial.headers, ': '))
  }, [initial?.name, initial?.transport, initial?.command, initial?.args.join('\u0000'), JSON.stringify(initial?.env), initial?.url, JSON.stringify(initial?.headers)])
  const parsed = words(line)
  const urlOk = /^https?:\/\/\S+$/i.test(url.trim())
  const valid = /^[a-zA-Z0-9_-]{1,32}$/.test(name) && (kind === 'http' ? urlOk : parsed.length > 0)
  const dirty =
    !initial ||
    name !== initial.name ||
    kind !== (initial.transport ?? 'stdio') ||
    (kind === 'http' ? url !== (initial.url ?? '') || headers !== lines(initial.headers, ': ') : line !== commandLine(initial) || env !== lines(initial.env, '='))
  const submit = () => {
    if (!valid) return
    const base = { name, enabled: initial?.enabled ?? true, defaultOn: initial?.defaultOn ?? false, approval: initial?.approval ?? ('ask' as const) }
    if (kind === 'http') onSave({ ...base, transport: 'http', url: url.trim(), headers: parseLines(headers, ':'), command: '', args: [], env: {} })
    else onSave({ ...base, transport: 'stdio', command: parsed[0], args: parsed.slice(1), env: parseLines(env, '=') })
  }
  const field = 'resize-none rounded-[10px] border border-line bg-panel px-3 py-1.5 font-mono text-[12px] outline-none placeholder:text-dim focus:border-crimson-line'
  return (
    <div className="grid gap-2">
      <div role="radiogroup" aria-label="How Cloth reaches it" className="grid grid-cols-2 gap-2">
        {(
          [
            ['stdio', 'A program', 'Cloth starts it on this computer (npx, uvx, docker…)'],
            ['http', 'A web address', 'A server already running, here or online (HTTP)']
          ] as const
        ).map(([k, label, sub]) => (
          <button
            key={k}
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={clsx('grid content-start gap-0.5 rounded-[10px] border px-3 py-2 text-left', kind === k ? 'border-crimson-line bg-crimson-soft' : 'border-line hover:border-line-strong')}
          >
            <span className="text-[12.5px] font-semibold">{label}</span>
            <span className="text-[11.5px] text-dim">{sub}</span>
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
        <Input value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} placeholder="name" aria-label="Server name" spellCheck={false} className="h-8 font-mono text-[12px]" />
        {kind === 'http' ? (
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" aria-label="Server address" spellCheck={false} autoComplete="off" className="h-8 font-mono text-[12px]" />
        ) : (
          <Input value={line} onChange={(e) => setLine(e.target.value)} placeholder="npx -y @playwright/mcp@latest" aria-label="Command" spellCheck={false} className="h-8 font-mono text-[12px]" />
        )}
      </div>
      {kind === 'http' ? (
        <>
          <textarea
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            rows={Math.max(1, Math.min(4, headers.split('\n').length))}
            placeholder="Headers, one per line (optional), e.g. Authorization: Bearer <token>"
            aria-label="Headers"
            spellCheck={false}
            className={field}
          />
          {url.trim() && !urlOk && <p className="text-[11.5px] text-warn">Give the full address, starting with https:// (or http:// on this computer).</p>}
          <p className="text-[11.5px] text-dim">Cloth tries Streamable HTTP first, then the older HTTP + SSE transport. Headers are saved with Cloth’s settings on this computer.</p>
        </>
      ) : (
        <textarea
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          rows={Math.max(1, Math.min(4, env.split('\n').length))}
          placeholder="Environment variables, one KEY=value per line (optional)"
          aria-label="Environment variables"
          spellCheck={false}
          className={field}
        />
      )}
      {dirty && (
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!valid} onClick={submit}>
            {initial ? 'Save' : 'Add server'}
          </Button>
        </div>
      )}
    </div>
  )
}
