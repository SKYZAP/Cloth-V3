import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Check, Copy, KeyRound, Plus, RotateCw, X } from 'lucide-react'
import type { McpCallLog, McpClientConfig, McpStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { duration, preview, timeAgo } from '@/lib/format'
import { Button, Segmented, Switch } from '@/components/ui'
import { Inspector, refocus } from '@/components/Inspector'
import { STATE, ServerDetail, ServerForm, commandLine, useExternalServers } from './mcp/ExternalServers'

type Client = 'claude-code' | 'cursor' | 'claude-desktop' | 'curl'
type Open = { kind: 'server'; id: string } | { kind: 'add' } | { kind: 'cloth' } | null

const APP_NAMES: [RegExp, string][] = [
  [/^claude-code/i, 'Claude Code'],
  [/^cursor/i, 'Cursor'],
  [/^claude-ai|^claude desktop/i, 'Claude Desktop'],
  [/^mcp-remote/i, 'Claude Desktop (mcp-remote)'],
  [/^vscode|visual studio code/i, 'VS Code'],
  [/^curl/i, 'curl']
]
/** A readable name for what an app calls itself in the MCP handshake. */
const appName = (raw: string) => APP_NAMES.find(([re]) => re.test(raw))?.[1] ?? raw

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const RECENT = 60 * 60_000

/**
 * Both directions of MCP as one picture: servers Cloth uses on the left, Cloth in the middle, apps using
 * Cloth on the right, and one live log of calls either way.
 */
export function McpPage() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [outCalls, setOutCalls] = useState<McpCallLog[]>([])
  const [open, setOpen] = useState<Open>(null)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const servers = useExternalServers()
  useEffect(() => {
    void api.mcp.status().then(setStatus)
    void api.mcp.externalCalls().then(setOutCalls, () => undefined)
  }, [])
  useEvent('mcp', setStatus)
  useEvent('mcpCalls', (c) => setOutCalls((list) => [c, ...list].slice(0, 50)))

  const calls = useMemo(() => [...(status?.recent ?? []).map((c) => ({ ...c, direction: 'in' as const })), ...outCalls].sort((a, b) => b.at - a.at).slice(0, 40), [status?.recent, outCalls])
  if (!status || !settings) return null

  const openKey = open?.kind === 'server' ? open.id : open?.kind ?? null
  const close = () => {
    const key = openKey
    setOpen(null)
    refocus(key)
  }
  const openServer = open?.kind === 'server' ? servers.configs.find((c) => c.id === open.id) : undefined
  const apps = status.apps
  const serverState = !settings.mcpEnabled ? 'Off' : status.running ? 'Running' : 'Stopped'
  const summary = [
    servers.configs.length ? `${plural(servers.configs.length, 'server')} feed${servers.configs.length === 1 ? 's' : ''} in` : 'No servers feed in yet',
    apps.length ? `${plural(apps.length, 'app')} ${apps.length === 1 ? 'uses' : 'use'} Cloth` : 'no apps use Cloth yet'
  ].join(', ')
  const addPreset = async (p: Omit<McpClientConfig, 'id'>) => {
    const id = await servers.add(p)
    setOpen({ kind: 'server', id })
  }

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-6 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <h1 className="text-[18px] font-semibold tracking-tight">MCP</h1>
              <p className="mt-0.5 text-[12.5px] text-dim">{summary}</p>
            </div>
            <Button icon={<Plus size={13} />} onClick={() => setOpen({ kind: 'add' })} data-focus-key="add">
              Add server
            </Button>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_56px_210px_56px_minmax(0,1fr)] items-center gap-y-4 max-[1000px]:grid-cols-1">
            <section aria-label="Servers Cloth uses" className="grid content-start gap-2">
              <h2 className="text-[12.5px] font-medium text-dim">Servers Cloth uses</h2>
              {servers.configs.map((c) => {
                const state = servers.stateOf(c)
                const st = servers.status.find((s) => s.id === c.id)
                return (
                  <button
                    key={c.id}
                    data-focus-key={c.id}
                    onClick={() => setOpen({ kind: 'server', id: c.id })}
                    aria-haspopup="dialog"
                    className={clsx('grid gap-1 rounded-[12px] border bg-elev px-3.5 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-elev-2', state === 'error' ? 'border-crimson-line' : 'border-line')}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATE[state].dot)} aria-hidden="true" />
                      <span className="text-[13px] font-semibold" translate="no">
                        {c.name}
                      </span>
                      <span className="text-[12px] text-dim">{c.enabled ? STATE[state].label : 'Turned off'}</span>
                      <span className="flex-1" />
                      {st?.state === 'ready' && <span className="shrink-0 rounded-full border border-line-strong px-2 py-px text-[11.5px] text-muted">{plural(st.tools.length, 'tool')}</span>}
                    </span>
                    <span className="truncate font-mono text-[11.5px] text-dim" title={commandLine(c)} translate="no">
                      {commandLine(c)}
                    </span>
                    {state === 'error' && st?.error ? (
                      <span className="truncate text-[12px] text-crimson-hi">Failed: {st.error.split('\n')[0]}</span>
                    ) : (
                      <span className="text-[12px] text-dim">{c.defaultOn ? 'On in new chats' : 'Off until a chat turns it on'}</span>
                    )}
                  </button>
                )
              })}
              {!servers.configs.length && <p className="rounded-[12px] border border-dashed border-line px-3.5 py-3 text-[12.5px] text-dim">No servers yet. Playwright lets chats open pages in a real browser and check the UI they build.</p>}
              <div className="flex flex-wrap gap-2">
                {servers.unused.map((p) => (
                  <Button key={p.name} size="sm" icon={<Plus size={12} />} onClick={() => void addPreset(p)}>
                    Add {p.name}
                  </Button>
                ))}
              </div>
            </section>

            <Arrows dir="in" />

            <div className="grid justify-items-center gap-1.5 rounded-[16px] border border-crimson-line bg-crimson-soft px-4 py-5 text-center">
              <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-crimson text-[14px] font-bold text-white">
                C
              </span>
              <span className="text-[13.5px] font-semibold">Cloth</span>
              <span className="text-[12px] text-muted">Chats, flows and subagents call the servers that feed in. Connected apps use Cloth's skills and knowledge.</span>
            </div>

            <Arrows dir="out" />

            <section aria-label="Apps using Cloth" className="grid content-start gap-2">
              <h2 className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] font-medium text-dim">
                Apps using Cloth
                <span className="font-mono text-[11.5px]" translate="no">
                  {status.url}
                </span>
              </h2>
              <button
                data-focus-key="cloth"
                onClick={() => setOpen({ kind: 'cloth' })}
                aria-haspopup="dialog"
                className={clsx('flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-[12px] border bg-elev px-3.5 py-2.5 text-left hover:border-line-strong hover:bg-elev-2', status.error ? 'border-warn/40' : 'border-line')}
              >
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', serverState === 'Running' ? 'bg-ok' : status.error ? 'bg-warn' : 'bg-line-strong')} aria-hidden="true" />
                <span className="text-[13px] font-semibold">Cloth's server</span>
                <span className="text-[12px] text-dim">{serverState}</span>
                <span className="flex-1" />
                <span className="text-[12px] text-dim">Shares {plural(status.tools.length, 'tool')}</span>
              </button>
              {apps.map((a) => {
                const recent = Date.now() - a.lastSeen < RECENT
                return (
                  <div key={a.name} className="flex items-center gap-2 rounded-[12px] border border-line bg-elev px-3.5 py-2.5">
                    <span className={clsx('h-2 w-2 shrink-0 rounded-full', recent ? 'bg-ok' : 'bg-line-strong')} aria-hidden="true" />
                    <span className="min-w-0 truncate text-[13px] font-semibold" title={a.name}>
                      {appName(a.name)}
                    </span>
                    <span className="text-[12px] text-dim">{a.calls ? (recent ? 'Active' : 'Seen before') : 'Connected'}</span>
                    <span className="flex-1" />
                    <span className="shrink-0 text-[12px] tabular-nums text-dim">{a.lastSeen ? `last call ${timeAgo(a.lastSeen)}` : ''}</span>
                  </div>
                )
              })}
              <button onClick={() => setOpen({ kind: 'cloth' })} className="rounded-[12px] border border-dashed border-line-strong px-3.5 py-2.5 text-left text-[12.5px] text-muted hover:border-crimson-line hover:text-fg">
                Connect {apps.length ? 'another' : 'an'} app: Claude Code, Cursor, Claude Desktop or curl
              </button>
            </section>
          </div>

          {status.error && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[12px] border border-warn/40 bg-warn/[0.07] px-3.5 py-2.5 text-[12.5px]">
              <span className="font-medium text-warn">{status.error}</span>
              <span className="min-w-[200px] flex-1 text-muted">{/in use/.test(status.error) ? 'Another program, often a second Cloth window, is using it, so apps can’t reach this Cloth.' : 'Apps can’t reach Cloth until the server starts.'}</span>
              {status.suggestedPort ? (
                <Button size="sm" onClick={() => void updateSettings({ mcpPort: status.suggestedPort! })}>
                  Use port {status.suggestedPort}
                </Button>
              ) : (
                <Button size="sm" icon={<RotateCw size={12} />} onClick={() => void attempt(() => api.mcp.restart()).then((s) => s && setStatus(s))}>
                  Try again
                </Button>
              )}
            </div>
          )}

          <section aria-label="Live calls" className="rounded-[12px] border border-line bg-elev">
            <h2 className="flex items-baseline gap-2 border-b border-line px-3.5 py-2.5 text-[12.5px] font-semibold">
              Live calls <span className="font-normal text-dim">both directions, newest first</span>
            </h2>
            <div role="log" aria-label="MCP calls" className="max-h-[360px] overflow-y-auto">
              {calls.map((c, i) => (
                <div key={`${c.at}-${i}`} className="grid grid-cols-[72px_minmax(0,150px)_minmax(0,1fr)_64px_70px] items-center gap-3 border-t border-line px-3.5 py-1.5 text-[12px] first:border-0 max-[700px]:grid-cols-[minmax(0,1fr)_70px]">
                  <span className="tabular-nums text-dim max-[700px]:hidden">{clock.format(c.at)}</span>
                  <span className="truncate text-muted max-[700px]:hidden">{c.direction === 'out' ? `→ ${c.peer ?? 'server'}` : `${appName(c.peer ?? 'An app')} →`}</span>
                  <span className="min-w-0 truncate font-mono text-[11.5px]" title={c.error ?? preview(c.args, 400)} translate="no">
                    {c.tool} <span className="text-dim">{c.error ?? preview(c.args, 120)}</span>
                  </span>
                  <span className="text-right tabular-nums text-dim max-[700px]:hidden">{duration(c.durationMs)}</span>
                  <span className={clsx('flex items-center justify-end gap-1.5', c.ok ? 'text-dim' : 'text-crimson-hi')}>
                    <span className={clsx('h-1.5 w-1.5 rounded-full', c.ok ? 'bg-ok' : 'bg-crimson')} aria-hidden="true" />
                    {c.ok ? 'OK' : 'Failed'}
                  </span>
                </div>
              ))}
              {!calls.length && <p className="px-3.5 py-4 text-[12.5px] text-dim">No calls yet. Calls from apps to Cloth, and from Cloth's chats to servers, show here as they happen.</p>}
            </div>
          </section>
        </div>
      </div>

      <Inspector open={!!open} label={open?.kind === 'server' ? (openServer?.name ?? 'Server') : open?.kind === 'add' ? 'Add a server' : "Cloth's server"} onClose={close} width={640}>
        <PanelHead title={open?.kind === 'server' ? (openServer?.name ?? '') : open?.kind === 'add' ? 'Add a server' : "Cloth's server"} onClose={close} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {open?.kind === 'server' && openServer && <ServerDetail config={openServer} servers={servers} onRemoved={() => setOpen(null)} />}
          {open?.kind === 'add' && (
            <div className="grid gap-5">
              {servers.unused.length > 0 && (
                <div className="grid gap-2">
                  <h3 className="text-[12px] font-medium text-muted">Ready to add</h3>
                  <div className="flex flex-wrap gap-2">
                    {servers.unused.map((p) => (
                      <Button key={p.name} size="sm" icon={<Plus size={12} />} onClick={() => void addPreset(p)}>
                        {p.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid gap-2">
                <h3 className="text-[12px] font-medium text-muted">Any MCP server that runs as a command</h3>
                <ServerForm onSave={(c) => void servers.add(c).then((id) => setOpen({ kind: 'server', id }))} onCancel={close} />
              </div>
            </div>
          )}
          {open?.kind === 'cloth' && <ClothServer status={status} setStatus={setStatus} />}
        </div>
      </Inspector>
    </div>
  )
}

function PanelHead({ title, onClose }: { title: string; onClose(): void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
      <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold" translate="no">
        {title}
      </h2>
      <button onClick={onClose} aria-label="Close" title="Close (Esc)" className="flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg">
        <X size={15} />
      </button>
    </div>
  )
}

/** Decorative arrows between the columns (the headings already say which way things go). */
function Arrows({ dir }: { dir: 'in' | 'out' }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 56 160" preserveAspectRatio="none" className="h-40 w-full max-[1000px]:hidden">
      {dir === 'in' ? (
        <>
          <path d="M0 48 C28 48 28 80 56 80 M0 112 C28 112 28 80 56 80" fill="none" stroke="var(--color-line-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d="M48 76 L56 80 L48 84" fill="none" stroke="var(--color-line-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </>
      ) : (
        <>
          <path d="M0 80 C28 80 28 48 56 48 M0 80 C28 80 28 112 56 112" fill="none" stroke="var(--color-line-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          <path d="M48 44 L56 48 L48 52 M48 108 L56 112 L48 116" fill="none" stroke="var(--color-line-strong)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  )
}

/** Cloth's own server: on/off, how apps connect, access, and what it shares. */
function ClothServer({ status, setStatus }: { status: McpStatus; setStatus(s: McpStatus): void }) {
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const [client, setClient] = useState<Client>('claude-code')
  const auth = status.requireToken ? { Authorization: `Bearer ${status.token}` } : undefined
  const snippets: Record<Client, string> = {
    'claude-code': `claude mcp add --transport http cloth ${status.url}${status.requireToken ? ` --header "Authorization: Bearer ${status.token}"` : ''}`,
    cursor: JSON.stringify({ mcpServers: { cloth: { url: status.url, ...(auth ? { headers: auth } : {}) } } }, null, 2),
    'claude-desktop': JSON.stringify({ mcpServers: { cloth: { command: 'npx', args: ['-y', 'mcp-remote', status.url, ...(auth ? ['--header', `Authorization:Bearer ${status.token}`] : [])] } } }, null, 2),
    curl: `curl -s ${status.url} \\\n  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \\\n${status.requireToken ? `  -H "Authorization: Bearer ${status.token}" \\\n` : ''}  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"rag_search","arguments":{"query":"getting started"}}}'`
  }
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-[13px]">
          <span className={clsx('h-2 w-2 rounded-full', status.running ? 'bg-ok' : 'bg-line-strong')} aria-hidden="true" />
          {!settings.mcpEnabled ? 'Off' : status.running ? 'Running' : 'Stopped'}
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-muted" translate="no">
          {status.url} <CopyIcon text={status.url} label="Copy address" />
        </span>
        <div className="flex-1" />
        <Switch checked={settings.mcpEnabled} onChange={(v) => void updateSettings({ mcpEnabled: v })} label="On" />
        <Button size="sm" icon={<RotateCw size={12} />} onClick={() => void attempt(() => api.mcp.restart()).then((s) => s && setStatus(s))}>
          Restart
        </Button>
      </div>

      <Group title="Connect an app">
        <Segmented
          value={client}
          onChange={setClient}
          items={[
            { value: 'claude-code', label: 'Claude Code' },
            { value: 'cursor', label: 'Cursor' },
            { value: 'claude-desktop', label: 'Claude Desktop' },
            { value: 'curl', label: 'curl' }
          ]}
        />
        <div className="relative">
          <pre className="selectable overflow-x-auto rounded-lg border border-line bg-panel p-3 pr-10 font-mono text-[11.5px] leading-relaxed text-muted" translate="no">
            {snippets[client]}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyIcon text={snippets[client]} label="Copy setup" />
          </div>
        </div>
        <p className="text-[12px] text-dim">
          {client === 'cursor' && 'Add to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).'}
          {client === 'claude-desktop' && 'Claude Desktop speaks stdio, so this bridges through mcp-remote. Add to claude_desktop_config.json.'}
          {client === 'claude-code' && 'Run once in a terminal; add --scope user to make it available in every project.'}
          {client === 'curl' && 'Raw JSON-RPC, handy for scripting and debugging.'}
        </p>
      </Group>

      <Group title="Access">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Switch checked={settings.mcpRequireToken} onChange={(v) => void updateSettings({ mcpRequireToken: v })} label="Require a token" />
          <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} onClick={() => void api.mcp.rotateToken().then(setStatus)}>
            New token
          </Button>
        </div>
        {status.requireToken && (
          <div className="flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" translate="no">
              {status.token}
            </span>
            <CopyIcon text={status.token} label="Copy token" />
          </div>
        )}
        <p className="text-[12px] text-dim">Only this computer can connect (127.0.0.1), and web pages other than localhost are refused. Port {status.port} is set in Settings → MCP.</p>
      </Group>

      <Group title={`What it shares (${status.tools.length} tools)`}>
        <div className="grid gap-1.5">
          {status.tools.map((t) => (
            <div key={t.name} className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 text-[12px]">
              <span className="font-mono text-fg/90" translate="no">
                {t.name}
              </span>
              <span className="text-muted">{t.description}</span>
            </div>
          ))}
        </div>
      </Group>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-[12px] font-medium text-muted">{title}</h3>
      {children}
    </div>
  )
}

function CopyIcon({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elev text-dim hover:text-fg"
      title={label}
      aria-label={done ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
    </button>
  )
}
