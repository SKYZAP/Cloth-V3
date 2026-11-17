import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, ChevronRight, Copy, Globe, KeyRound, Plus, RotateCw, SquareTerminal, X } from 'lucide-react'
import type { McpCallLog, McpClientConfig, McpPreset, McpStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { duration, preview, timeAgo } from '@/lib/format'
import { Button, Segmented, Switch, PageTitle } from '@/components/ui'
import { Inspector, refocus } from '@/components/Inspector'
import { STATE, ServerDetail, ServerForm, aboutOf, commandLine, useExternalServers, type ExternalServers } from './mcp/ExternalServers'
import { GuidedServerForm } from './mcp/GuidedServerForm'

type Client = 'claude-code' | 'cursor' | 'claude-desktop' | 'curl'
type Open = { kind: 'server'; id: string } | { kind: 'add'; preset?: McpPreset } | null
type Filter = 'all' | 'out' | 'in'

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
 * MCP in two parts: the servers that give Cloth's chats extra tools (the main list), and Cloth's own
 * server that lets other apps use Cloth (beside it), with one activity log of calls either way below.
 */
export function McpPage() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [outCalls, setOutCalls] = useState<McpCallLog[]>([])
  const [open, setOpen] = useState<Open>(null)
  const [addMode, setAddMode] = useState<'fields' | 'json'>('fields')
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const servers = useExternalServers()
  useEffect(() => {
    void api.mcp.status().then(setStatus)
    void api.mcp.externalCalls().then(setOutCalls, () => undefined)
  }, [])
  useEvent('mcp', setStatus)
  useEvent('mcpCalls', (c) => setOutCalls((list) => [c, ...list].slice(0, 50)))

  const calls = useMemo(() => [...(status?.recent ?? []).map((c) => ({ ...c, direction: 'in' as const })), ...outCalls].sort((a, b) => b.at - a.at).slice(0, 60), [status?.recent, outCalls])
  if (!status || !settings) return null

  const openKey = open?.kind === 'server' ? open.id : (open?.kind ?? null)
  const close = () => {
    const key = openKey
    setOpen(null)
    refocus(key)
  }
  const openServer = open?.kind === 'server' ? servers.configs.find((c) => c.id === open.id) : undefined
  // A preset that needs a token opens the form filled in, to paste it; the rest are added straight away.
  const addPreset = async ({ about: _about, needsToken, tokenQuery, ...config }: McpPreset) => {
    if (needsToken) return setOpen({ kind: 'add', preset: { ...config, about: _about, needsToken, tokenQuery } })
    const id = await servers.add(config)
    setOpen({ kind: 'server', id })
  }
  const preset = open?.kind === 'add' ? open.preset : undefined
  const panelTitle = open?.kind === 'server' ? (openServer?.name ?? 'Server') : preset ? `Add ${preset.name}` : 'Add a server'

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[calc(100%-48px)] max-w-[2200px] gap-6 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <PageTitle>MCP</PageTitle>
            </div>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setOpen({ kind: 'add' })} data-focus-key="add">
              Add server
            </Button>
          </div>

          <div className="grid items-start gap-6 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(400px,0.52fr)]">
            <Servers servers={servers} onOpen={(id) => setOpen({ kind: 'server', id })} onAdd={() => setOpen({ kind: 'add' })} onPreset={(p) => void addPreset(p)} />
            <div className="min-[1180px]:sticky min-[1180px]:top-4">
              <Share status={status} setStatus={setStatus} />
            </div>
          </div>

          <Activity calls={calls} />
        </div>
      </div>

      <Inspector open={!!open} label={panelTitle} onClose={close} width={640}>
        <PanelHead title={panelTitle} sub={open?.kind === 'server' && openServer ? aboutOf(openServer, servers.presets) : undefined} onClose={close} />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {open?.kind === 'server' && openServer && <ServerDetail config={openServer} servers={servers} onRemoved={() => setOpen(null)} />}
          {open?.kind === 'add' && preset && (
            <div className="grid gap-4">
              {preset.about && <p className="text-ui text-muted">{preset.about}.</p>}
              <GuidedServerForm
                key={preset.name}
                prefill={preset}
                focusToken
                tokenHint={preset.tokenQuery ? `Added to the address as ?${preset.tokenQuery}=…` : undefined}
                taken={servers.configs.map((c) => c.name)}
                onSave={async (form) => {
                  // A server that takes its token in the address (Penpot): move it out of the header.
                  let c = form
                  const auth = form.headers?.Authorization
                  if (preset.tokenQuery && auth) {
                    const { Authorization: _a, ...headers } = form.headers ?? {}
                    const url = new URL(form.url ?? '')
                    url.searchParams.set(preset.tokenQuery, auth.replace(/^Bearer\s+/i, ''))
                    c = { ...form, headers, url: url.toString() }
                  }
                  const id = await servers.add({ ...c, enabled: preset.enabled, defaultOn: preset.defaultOn, approval: preset.approval })
                  setOpen({ kind: 'server', id })
                }}
                onCancel={() => setOpen({ kind: 'add' })}
              />
            </div>
          )}
          {open?.kind === 'add' && !preset && (
            <div className="grid gap-6">
              {servers.unused.length > 0 && (
                <div className="grid gap-2.5">
                  <h3 className="text-ui font-semibold">Ready to add</h3>
                  <div className="grid gap-2">
                    {servers.unused.map((p) => (
                      <PresetCard key={p.name} preset={p} onAdd={() => void addPreset(p)} />
                    ))}
                  </div>
                </div>
              )}
              <div className="grid gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-ui font-semibold">{servers.unused.length ? 'Any other server' : 'Any MCP server'}</h3>
                  <span className="flex-1" />
                  <Segmented
                    value={addMode}
                    onChange={setAddMode}
                    items={[
                      { value: 'fields', label: 'Fill in' },
                      { value: 'json', label: 'Paste a config', title: 'A config from Claude Desktop, Cursor or VS Code; several servers at once' }
                    ]}
                  />
                </div>
                {addMode === 'fields' ? (
                  <GuidedServerForm
                    taken={servers.configs.map((c) => c.name)}
                    onSave={async (c) => {
                      const id = await servers.add({ ...c, enabled: true, defaultOn: false, approval: 'ask' })
                      setOpen({ kind: 'server', id })
                    }}
                    onCancel={close}
                  />
                ) : (
                  <ServerForm
                    taken={servers.configs.map((c) => c.name)}
                    onSave={async (list) => {
                      let id = ''
                      for (const c of list) id = await servers.add({ ...c, enabled: true, defaultOn: false, approval: 'ask' })
                      setOpen({ kind: 'server', id })
                    }}
                    onCancel={close}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </Inspector>

      {status.error && <PortProblem status={status} setStatus={setStatus} onUsePort={(p) => void updateSettings({ mcpPort: p })} />}
    </div>
  )
}

function PanelHead({ title, sub, onClose }: { title: string; sub?: string; onClose(): void }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-section font-semibold" translate="no">
          {title}
        </h2>
        {sub && <p className="truncate text-caption text-dim">{sub}</p>}
      </div>
      <button onClick={onClose} aria-label="Close" title="Close (Esc)" className="flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line">
        <X size={15} />
      </button>
    </div>
  )
}

/** What a server is doing, in words, and what happens next. */
function stateLine(c: McpClientConfig, servers: ExternalServers): { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' } {
  const st = servers.status.find((s) => s.id === c.id)
  if (!c.enabled) return { text: 'Turned off', tone: 'dim' }
  switch (servers.stateOf(c)) {
    case 'ready':
      return { text: 'Running', tone: 'ok' }
    case 'starting':
      return { text: 'Starting…', tone: 'warn' }
    case 'auth':
      return { text: 'Needs you to sign in', tone: 'warn' }
    case 'error':
      return { text: `${c.transport === 'http' ? 'Couldn’t connect' : 'Couldn’t start'}: ${(st?.error ?? 'unknown error').split('\n')[0]}`, tone: 'bad' }
    default:
      return { text: 'Starts when a chat uses it', tone: 'dim' }
  }
}

const TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-danger-hi', dim: 'text-dim' }

function Servers({ servers, onOpen, onAdd, onPreset }: { servers: ExternalServers; onOpen(id: string): void; onAdd(): void; onPreset(p: McpPreset): void }) {
  return (
    <section aria-label="Tools for Cloth’s chats" className="grid min-w-0 content-start gap-3">
      <div className="grid gap-2">
        {servers.configs.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-elev">
            {servers.configs.map((c) => (
              <ServerRow key={c.id} config={c} servers={servers} onOpen={() => onOpen(c.id)} />
            ))}
          </ul>
        )}
        <button
          onClick={onAdd}
          className="flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-line-strong px-4 py-3.5 text-ui font-semibold text-muted transition-colors hover:border-muted/50 hover:bg-elev hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line"
        >
          <Plus size={14} aria-hidden="true" /> {servers.configs.length ? 'Any other server' : 'Add an MCP server'}
        </button>
      </div>

      {servers.unused.length > 0 && (
        <div className="grid gap-2 pt-2">
          <h3 className="text-ui font-semibold">Ready to add</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
            {servers.unused.map((p) => (
              <PresetCard key={p.name} preset={p} onAdd={() => onPreset(p)} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function ServerRow({ config: c, servers, onOpen }: { config: McpClientConfig; servers: ExternalServers; onOpen(): void }) {
  const st = servers.status.find((s) => s.id === c.id)
  const state = servers.stateOf(c)
  const line = stateLine(c, servers)
  const tools = st?.state === 'ready' ? st.tools : (st?.knownTools ?? [])
  const shown = tools.slice(0, 5)
  const Icon = c.transport === 'http' ? Globe : SquareTerminal
  return (
    <li className={clsx('grid grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3.5 transition-colors', !c.enabled && 'opacity-60')}>
      <span className="relative mt-0.5 flex h-9 w-9 items-center justify-center rounded-[10px] border border-line bg-panel text-muted" aria-hidden="true">
        <Icon size={16} />
        <span className={clsx('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-elev', c.enabled ? STATE[state].dot : 'bg-line-strong')} />
      </span>
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <button data-focus-key={c.id} onClick={onOpen} aria-haspopup="dialog" className="truncate rounded text-left text-body font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line" translate="no">
            {c.name}
          </button>
          <span className="min-w-0 truncate text-ui text-muted">{aboutOf(c, servers.presets)}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
          <span className={clsx('min-w-0 truncate', TONE[line.tone])} title={line.tone === 'bad' ? (st?.error ?? undefined) : undefined}>
            {line.text}
          </span>
          {tools.length > 0 && <span className="text-dim">· {plural(tools.length, 'tool')}</span>}
        </div>
        {shown.length > 0 && (
          <ul className="mt-0.5 flex min-w-0 flex-wrap gap-1" aria-label={`Some of ${c.name}’s tools`}>
            {shown.map((t) => (
              <li key={t.name} title={t.description} className="max-w-[220px] truncate rounded-md border border-line bg-panel px-1.5 py-px font-mono text-caption text-muted" translate="no">
                {t.name}
              </li>
            ))}
            {tools.length > shown.length && <li className="px-1 py-px text-caption text-dim">+{tools.length - shown.length} more</li>}
          </ul>
        )}
        {!tools.length && state !== 'error' && <span className="truncate font-mono text-caption text-dim" translate="no">{commandLine(c)}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-3 self-center">
        {state === 'error' && c.enabled && (
          <Button size="sm" icon={<RotateCw size={12} />} onClick={() => servers.restart(c.id)}>
            Try again
          </Button>
        )}
        {state === 'auth' && c.enabled && (
          <Button size="sm" variant="primary" onClick={() => servers.signIn(c.id)}>
            Sign in
          </Button>
        )}
        <span className="max-[820px]:hidden">
          <Switch checked={c.defaultOn && c.enabled} disabled={!c.enabled} onChange={(defaultOn) => servers.patch(c.id, { defaultOn })} label="In new chats" />
        </span>
        <button onClick={onOpen} aria-label={`${c.name} settings`} title="Settings and tools" className="flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line">
          <ChevronRight size={16} />
        </button>
      </div>
    </li>
  )
}

function PresetCard({ preset: p, onAdd }: { preset: McpPreset; onAdd(): void }) {
  const Icon = p.transport === 'http' ? Globe : SquareTerminal
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[12px] border border-line bg-elev px-3.5 py-3">
      <div className="grid min-w-0 gap-0.5">
        <span className="flex items-center gap-1.5 text-ui font-semibold" translate="no">
          <Icon size={13} className="text-dim" aria-hidden="true" />
          {p.name}
        </span>
        {p.about && <span className="line-clamp-2 text-caption text-muted">{p.about}</span>}
        {p.needsToken && <span className="text-caption text-dim">Needs an access token</span>}
      </div>
      <Button size="sm" icon={<Plus size={12} />} onClick={onAdd} aria-label={`Add ${p.name}`}>
        Add
      </Button>
    </div>
  )
}

/** Cloth's own server: whether it's on, how to connect an app, which apps have, and access. */
function Share({ status, setStatus }: { status: McpStatus; setStatus(s: McpStatus): void }) {
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
  const where: Record<Client, string> = {
    'claude-code': 'Run once in a terminal. Add --scope user to make it available in every project.',
    cursor: 'Add to ~/.cursor/mcp.json, or .cursor/mcp.json in a project.',
    'claude-desktop': 'Add to claude_desktop_config.json. Claude Desktop reaches Cloth through mcp-remote.',
    curl: 'Raw JSON-RPC, for scripts and debugging.'
  }
  const on = settings.mcpEnabled
  const headline = !on ? 'Other apps can’t use Cloth' : status.running ? 'Other apps can use Cloth' : status.error ? 'Cloth’s server isn’t running' : 'Starting Cloth’s server…'
  const apps = status.apps
  return (
    <section aria-labelledby="mcp-share" className="grid gap-4 rounded-[14px] border border-line bg-elev p-4">
      <div className="grid gap-1">
        <div className="flex items-center gap-3">
          <h2 id="mcp-share" className="min-w-0 flex-1 text-body font-semibold">
            Use Cloth from other apps
          </h2>
          <Switch checked={on} onChange={(v) => void updateSettings({ mcpEnabled: v })} label={on ? 'On' : 'Off'} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-[10px] border border-line bg-panel px-3 py-2">
        <span className={clsx('h-2 w-2 shrink-0 rounded-full', on && status.running ? 'bg-ok' : status.error ? 'bg-warn' : 'bg-line-strong')} aria-hidden="true" />
        <span role="status" className="text-ui font-medium">
          {headline}
        </span>
        <span className="flex-1" />
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-caption text-muted" translate="no">
          <span className="truncate">{status.url}</span>
          <CopyIcon text={status.url} label="Copy address" />
        </span>
        {on && (
          <button onClick={() => void attempt(() => api.mcp.restart()).then((s) => s && setStatus(s))} aria-label="Restart Cloth’s server" title="Restart" className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elev text-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line">
            <RotateCw size={12} />
          </button>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-ui font-semibold">Connect an app</h3>
        <div className="overflow-x-auto">
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
        </div>
        <div className="relative">
          <pre className="selectable max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-line bg-panel p-3 pr-10 font-mono text-caption leading-relaxed text-muted" translate="no">
            {snippets[client]}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyIcon text={snippets[client]} label="Copy setup" />
          </div>
        </div>
        <p className="text-caption text-dim">{where[client]}</p>
      </div>

      <div className="grid gap-2">
        <h3 className="text-ui font-semibold">Connected apps</h3>
        {apps.length ? (
          <ul className="grid gap-1">
            {apps.map((a) => {
              const recent = Date.now() - a.lastSeen < RECENT
              return (
                <li key={a.name} className="flex items-center gap-2 text-ui">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', recent ? 'bg-ok' : 'bg-line-strong')} aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium" title={a.name}>
                    {appName(a.name)}
                  </span>
                  <span className="flex-1" />
                  <span className="shrink-0 tabular-nums text-dim">{a.lastSeen ? `last call ${timeAgo(a.lastSeen)}` : 'connected'}</span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-caption text-dim">None yet.</p>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-ui font-semibold">Access</h3>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Switch checked={settings.mcpRequireToken} onChange={(v) => void updateSettings({ mcpRequireToken: v })} label="Require a token" />
          {status.requireToken && (
            <Button size="sm" variant="ghost" icon={<KeyRound size={12} />} onClick={() => void api.mcp.rotateToken().then(setStatus)}>
              New token
            </Button>
          )}
        </div>
        {status.requireToken && (
          <div className="flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1.5">
            <span className="selectable min-w-0 flex-1 truncate font-mono text-caption text-muted" translate="no">
              {status.token}
            </span>
            <CopyIcon text={status.token} label="Copy token" />
          </div>
        )}
        <p className="text-caption text-dim">Only this computer can connect. Port {status.port} (Settings → MCP).</p>
      </div>

      <details className="group">
        <summary className="flex cursor-default list-none items-center gap-1.5 rounded text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line [&::-webkit-details-marker]:hidden">
          <ChevronDown size={13} className="-rotate-90 text-dim transition-transform group-open:rotate-0 motion-reduce:transition-none" aria-hidden="true" />
          What other apps get
          <span className="font-normal text-dim">{plural(status.tools.length, 'tool')}</span>
        </summary>
        <ul className="mt-2 grid gap-1.5">
          {status.tools.map((t) => (
            <li key={t.name} className="grid grid-cols-[124px_minmax(0,1fr)] gap-3 text-caption">
              <span className="font-mono text-fg/90" translate="no">
                {t.name}
              </span>
              <span className="text-muted">{t.description}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}

/** Cloth's server couldn't start (often the port is taken): what happened and the fix, pinned to the bottom. */
function PortProblem({ status, setStatus, onUsePort }: { status: McpStatus; setStatus(s: McpStatus): void; onUsePort(p: number): void }) {
  return (
    <div role="alert" className="absolute inset-x-6 bottom-4 z-10 mx-auto flex max-w-[900px] flex-wrap items-center gap-3 rounded-[12px] border border-warn/40 bg-elev-2 px-4 py-2.5 text-ui shadow-lg shadow-black/40">
      <span className="font-medium text-warn">{status.error}</span>
      <span className="min-w-[200px] flex-1 text-muted">{/in use/.test(status.error ?? '') ? 'Another program, often a second Cloth window, is using it, so other apps can’t reach this Cloth.' : 'Other apps can’t reach Cloth until it starts.'}</span>
      {status.suggestedPort ? (
        <Button size="sm" onClick={() => onUsePort(status.suggestedPort!)}>
          Use port {status.suggestedPort}
        </Button>
      ) : (
        <Button size="sm" icon={<RotateCw size={12} />} onClick={() => void attempt(() => api.mcp.restart()).then((s) => s && setStatus(s))}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** Every tool call either way, newest first: chats calling servers, and apps calling Cloth. */
function Activity({ calls }: { calls: McpCallLog[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const shown = calls.filter((c) => filter === 'all' || c.direction === filter)
  return (
    <section aria-labelledby="mcp-activity" className="rounded-[12px] border border-line bg-elev">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <h2 id="mcp-activity" className="text-ui font-semibold">
          Activity
        </h2>
        <span className="flex-1" />
        <Segmented
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All' },
            { value: 'out', label: 'Cloth’s chats' },
            { value: 'in', label: 'Other apps' }
          ]}
        />
      </div>
      <div role="log" aria-label="MCP tool calls" className="max-h-[420px] overflow-y-auto overscroll-contain">
        {shown.length > 0 && (
          <div className="grid grid-cols-[80px_minmax(0,200px)_minmax(0,1fr)_64px_84px] gap-3 border-b border-line px-4 py-1.5 text-caption text-dim max-[760px]:hidden" aria-hidden="true">
            <span>Time</span>
            <span>Who called</span>
            <span>Tool and input</span>
            <span className="text-right">Took</span>
            <span className="text-right">Result</span>
          </div>
        )}
        {shown.map((c, i) => (
          <div key={`${c.at}-${i}`} className="grid grid-cols-[80px_minmax(0,200px)_minmax(0,1fr)_64px_84px] items-center gap-3 border-t border-line px-4 py-1.5 text-caption first:border-0 max-[760px]:grid-cols-[minmax(0,1fr)_84px]">
            <span className="tabular-nums text-dim max-[760px]:hidden">{clock.format(c.at)}</span>
            <span className="truncate text-muted max-[760px]:hidden">{c.direction === 'out' ? `A chat → ${c.peer ?? 'server'}` : `${appName(c.peer ?? 'An app')} → Cloth`}</span>
            <span className="min-w-0 truncate font-mono text-caption" title={c.error ?? preview(c.args, 400)} translate="no">
              {c.tool} <span className="text-dim">{c.error ?? preview(c.args, 140)}</span>
            </span>
            <span className="text-right tabular-nums text-dim max-[760px]:hidden">{duration(c.durationMs)}</span>
            <span className={clsx('flex items-center justify-end gap-1.5', c.ok ? 'text-dim' : 'text-danger-hi')}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', c.ok ? 'bg-ok' : 'bg-crimson')} aria-hidden="true" />
              {c.ok ? 'Done' : 'Failed'}
            </span>
          </div>
        ))}
        {!shown.length && (
          <p className="px-4 py-5 text-ui text-dim">
            {filter === 'in' ? 'No app has called Cloth yet.' : filter === 'out' ? 'No chat has used a server’s tools yet.' : 'Nothing yet. When a chat uses a server’s tools, or another app calls Cloth, the calls show here.'}
          </p>
        )}
      </div>
    </section>
  )
}

function CopyIcon({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-line bg-elev text-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line"
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

