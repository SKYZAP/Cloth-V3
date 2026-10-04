import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CaretDown, CaretRight, Plugs, Plus, Trash } from '@phosphor-icons/react'
import type { McpClientConfig, McpClientStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Badge, Button, Card, Input, Segmented, Switch, confirmAction } from '@/components/ui'

const newId = () => `mcs_${Math.random().toString(36).slice(2, 10)}`
const STATE: Record<McpClientStatus['state'], { label: string; dot: string }> = {
  off: { label: 'Not running', dot: 'bg-line-strong' },
  starting: { label: 'Starting…', dot: 'bg-warn animate-pulse' },
  ready: { label: 'Running', dot: 'bg-ok' },
  error: { label: 'Failed', dot: 'bg-crimson' }
}

/** Split a command line into words, keeping "quoted parts" together. */
function words(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}
const quote = (w: string) => (/\s/.test(w) ? `"${w}"` : w)

/** External MCP servers Cloth connects to: their tools become available in chats. */
export function ExternalServers() {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const [status, setStatus] = useState<McpClientStatus[]>([])
  const [presets, setPresets] = useState<Omit<McpClientConfig, 'id'>[]>([])
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
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
  if (!settings) return null
  const configs = settings.mcpClients ?? []

  const save = async (next: McpClientConfig[]) => {
    await updateSettings({ mcpClients: next })
    load()
  }
  const patch = (id: string, p: Partial<McpClientConfig>) => void save(configs.map((c) => (c.id === id ? { ...c, ...p } : c)))
  const add = async (c: Omit<McpClientConfig, 'id'>) => {
    const id = newId()
    await save([...configs, { ...c, id }])
    setAdding(false)
    setOpen(id)
    // Start it right away so problems show up here rather than in a chat.
    void attempt(() => api.mcp.startClient(id)).then(load)
  }
  const remove = async (c: McpClientConfig) => {
    if (!(await confirmAction(`Chats stop getting the “${c.name}” tools.`, { title: 'Remove server?', confirmLabel: 'Remove', danger: true }))) return
    await save(configs.filter((x) => x.id !== c.id))
  }
  const unused = presets.filter((p) => !configs.some((c) => c.name === p.name))

  return (
    <Card className="xl:col-span-2">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Plugs size={18} className="text-muted" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">External servers</div>
          <div className="text-[12px] text-dim">Tools from other MCP servers, for Cloth's chats — turn them on per chat in its context sheet.</div>
        </div>
        {unused.map((p) => (
          <Button key={p.name} size="sm" icon={<Plus size={12} />} onClick={() => void add(p)}>
            {p.name}
          </Button>
        ))}
        <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
          Custom
        </Button>
      </div>
      {adding && <ServerForm onSave={(c) => void add(c)} onCancel={() => setAdding(false)} />}
      {!configs.length && !adding && <div className="px-4 py-5 text-[12.5px] text-dim">No external servers yet. Add Playwright to let chats open pages in a real browser and check the UI they build.</div>}
      {configs.map((c) => {
        const st = status.find((s) => s.id === c.id)
        const state = c.enabled ? (st?.state ?? 'off') : 'off'
        const expanded = open === c.id
        return (
          <div key={c.id} className="border-b border-line last:border-b-0">
            <div className="flex items-center gap-3 px-4 py-2.5">
              <button onClick={() => setOpen(expanded ? null : c.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={expanded}>
                {expanded ? <CaretDown size={12} className="text-dim" /> : <CaretRight size={12} className="text-dim" />}
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', STATE[state].dot)} title={STATE[state].label} />
                <span className="text-[13px] font-medium">{c.name}</span>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-dim">{[c.command, ...c.args].map(quote).join(' ')}</span>
              </button>
              {st?.state === 'ready' && <Badge tone="dim">{st.tools.length} tools</Badge>}
              {c.defaultOn && <Badge tone="dim">on in new chats</Badge>}
              <Switch checked={c.enabled} onChange={(enabled) => patch(c.id, { enabled })} />
            </div>
            {st?.state === 'error' && st.error && <div className="mx-4 mb-2.5 rounded-[10px] border border-crimson-line bg-crimson-soft px-3 py-2 font-mono text-[11.5px] text-crimson-hi">{st.error}</div>}
            {expanded && (
              <div className="space-y-3 px-4 pb-4 pl-[42px]">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <label className="flex items-center gap-2 text-[12px] text-muted">
                    <Switch checked={c.defaultOn} onChange={(defaultOn) => patch(c.id, { defaultOn })} />
                    On in chats by default
                  </label>
                  <div className="flex items-center gap-2 text-[12px] text-muted">
                    Tool calls
                    <Segmented
                      value={c.approval}
                      onChange={(approval) => patch(c.id, { approval })}
                      items={[
                        { value: 'ask', label: 'Ask first' },
                        { value: 'auto', label: 'Run' }
                      ]}
                    />
                  </div>
                  <div className="flex-1" />
                  <Button size="sm" disabled={!c.enabled || state === 'starting'} onClick={() => void attempt(() => api.mcp.stopClient(c.id).then(() => api.mcp.startClient(c.id))).then(load)}>
                    {state === 'ready' ? 'Restart' : 'Start'}
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash size={12} />} onClick={() => void remove(c)}>
                    Remove
                  </Button>
                </div>
                <ServerForm initial={c} onSave={(next) => patch(c.id, next)} />
                {st?.state === 'ready' && (
                  <div>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-dim">Tools</div>
                    <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                      {st.tools.map((t) => (
                        <div key={t.name} className="min-w-0 text-[12px]" title={t.description}>
                          <span className="font-mono text-fg/90">{t.name}</span> <span className="text-dim">{t.description.split('\n')[0].slice(0, 80)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </Card>
  )
}

/** Name, command line and environment of a server. */
function ServerForm({ initial, onSave, onCancel }: { initial?: McpClientConfig; onSave(c: Omit<McpClientConfig, 'id'>): void; onCancel?(): void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [line, setLine] = useState(initial ? [initial.command, ...initial.args].map(quote).join(' ') : '')
  const [env, setEnv] = useState(initial ? Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n') : '')
  // Follow changes made elsewhere (another window, the phone, an import).
  useEffect(() => {
    if (!initial) return
    setName(initial.name)
    setLine([initial.command, ...initial.args].map(quote).join(' '))
    setEnv(Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n'))
  }, [initial?.name, initial?.command, initial?.args.join('\u0000'), JSON.stringify(initial?.env)])
  const parsed = words(line)
  const valid = /^[a-zA-Z0-9_-]{1,32}$/.test(name) && parsed.length > 0
  const dirty = !initial || name !== initial.name || line !== [initial.command, ...initial.args].map(quote).join(' ') || env !== Object.entries(initial.env).map(([k, v]) => `${k}=${v}`).join('\n')
  const submit = () => {
    if (!valid) return
    const vars: Record<string, string> = {}
    for (const l of env.split('\n')) {
      const i = l.indexOf('=')
      if (i > 0) vars[l.slice(0, i).trim()] = l.slice(i + 1).trim()
    }
    onSave({ name, command: parsed[0], args: parsed.slice(1), env: vars, enabled: initial?.enabled ?? true, defaultOn: initial?.defaultOn ?? false, approval: initial?.approval ?? 'ask' })
  }
  return (
    <div className={clsx('grid gap-2', !initial && 'border-b border-line p-4')}>
      <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
        <Input value={name} onChange={(e) => setName(e.target.value.replace(/\s+/g, '-'))} placeholder="name" aria-label="Server name" className="h-8 font-mono text-[12px]" />
        <Input value={line} onChange={(e) => setLine(e.target.value)} placeholder="npx -y @playwright/mcp@latest" aria-label="Command" className="h-8 font-mono text-[12px]" />
      </div>
      <textarea
        value={env}
        onChange={(e) => setEnv(e.target.value)}
        rows={Math.max(1, Math.min(4, env.split('\n').length))}
        placeholder="Environment variables, one KEY=value per line (optional)"
        aria-label="Environment"
        className="resize-none rounded-[10px] border border-line bg-panel px-3 py-1.5 font-mono text-[12px] outline-none placeholder:text-dim focus:border-crimson-line"
      />
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
