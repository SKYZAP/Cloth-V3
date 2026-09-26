import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Cloud, Cpu, HardDrive, Plus, RefreshCw, Star, Trash2, Zap } from 'lucide-react'
import type { ModelInfo, Provider, ProviderPreset, ProviderTestResult } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, sameRef, useApp } from '@/lib/store'
import { compact } from '@/lib/format'
import { Badge, Button, Card, Dot, Empty, Field, IconButton, Input, ListItem, ListPane, Modal, PageHeader, Switch, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'

const isLocal = (url: string) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(url)

export function ProvidersPage() {
  const providers = useApp((s) => s.providers)
  const loadProviders = useApp((s) => s.loadProviders)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!activeId || !providers.some((p) => p.id === activeId)) setActiveId(providers[0]?.id ?? null)
  }, [providers, activeId])

  const active = providers.find((p) => p.id === activeId)
  return (
    <div className="flex h-full">
      <ListPane
        header={
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold">Model providers</div>
              <div className="text-[11px] text-dim">{providers.reduce((n, p) => n + p.models.length, 0)} models</div>
            </div>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
              Add
            </Button>
          </div>
        }
      >
        {providers.map((p) => (
          <ListItem key={p.id} active={p.id === activeId} onClick={() => setActiveId(p.id)}>
            {isLocal(p.baseUrl) ? <HardDrive size={14} className="shrink-0 text-dim" /> : <Cloud size={14} className="shrink-0 text-dim" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px]">{p.name}</div>
              <div className="truncate text-[11px] text-dim">
                {p.kind} · {p.models.length} models
              </div>
            </div>
            <Dot tone={p.enabled ? 'ok' : 'dim'} />
          </ListItem>
        ))}
      </ListPane>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <Defaults />
        {active ? (
          <ProviderView key={active.id} provider={active} />
        ) : (
          <div className="h-[60%]">
            <Empty icon={<Cpu size={20} />} title="Register a model provider" action={<Button variant="primary" onClick={() => setAdding(true)}>Add provider</Button>}>
              OpenAI, Anthropic, or any OpenAI-compatible server — LM Studio, Ollama, llama.cpp, vLLM — for fully offline use.
            </Empty>
          </div>
        )}
      </div>
      <AddProvider
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={async (p) => {
          await loadProviders()
          setActiveId(p.id)
        }}
      />
    </div>
  )
}

function Defaults() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  if (!settings) return null
  return (
    <div className="grid grid-cols-2 gap-4 border-b border-line bg-panel px-5 py-3.5">
      <Field label="Default chat model" hint="Used for new chats, workflows, agentic search and skill tests.">
        <ModelPicker value={settings.defaultModel} onChange={(m) => void update({ defaultModel: m })} allowNone noneLabel="None" />
      </Field>
      <Field label="Default embedding model" hint="Pre-selected for new knowledge collections.">
        <ModelPicker kind="embedding" value={settings.embeddingModel} onChange={(m) => void update({ embeddingModel: m })} allowNone noneLabel="None (BM25 only)" />
      </Field>
    </div>
  )
}

function AddProvider({ open, onClose, onAdded }: { open: boolean; onClose(): void; onAdded(p: Provider): void }) {
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      void api.providers.presets().then(setPresets)
      setPreset(null)
      setApiKey('')
    }
  }, [open])
  const choose = (p: ProviderPreset) => {
    setPreset(p)
    setName(p.label)
    setBaseUrl(p.baseUrl)
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={preset ? `Add ${preset.label}` : 'Add provider'}
      width={600}
      footer={
        preset && (
          <>
            <Button variant="ghost" onClick={() => setPreset(null)}>
              Back
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim() || !baseUrl.trim() || (preset.needsKey && !apiKey)}
              onClick={async () => {
                setBusy(true)
                const p = await attempt(() => api.providers.create({ name, kind: preset.kind, baseUrl, apiKey: apiKey || undefined }))
                if (p) {
                  // Best effort: pull the model list straight away.
                  const refreshed = await api.providers.refreshModels(p.id).catch((err) => {
                    useApp.getState().toast(`Saved, but listing models failed: ${err instanceof Error ? err.message : err}`, 'error')
                    return p
                  })
                  onAdded(refreshed)
                  onClose()
                }
                setBusy(false)
              }}
            >
              Save & fetch models
            </Button>
          </>
        )
      }
    >
      {!preset ? (
        <div className="grid grid-cols-2 gap-2">
          {presets.map((p) => (
            <button key={p.id} onClick={() => choose(p)} className="flex items-start gap-2.5 rounded-lg border border-line p-3 text-left hover:border-crimson-line hover:bg-crimson-soft">
              {isLocal(p.baseUrl) ? <HardDrive size={15} className="mt-0.5 text-crimson-hi" /> : <Cloud size={15} className="mt-0.5 text-crimson-hi" />}
              <div>
                <div className="text-[12.5px] font-semibold">{p.label}</div>
                <div className="text-[11px] text-dim">{p.hint}</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Base URL" hint={preset.kind === 'anthropic' ? 'Without /v1' : 'Including /v1'}>
            <Input className="font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
          <Field label={preset.needsKey ? 'API key' : 'API key (optional)'} hint="Encrypted with the OS keychain (Electron safeStorage).">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={preset.needsKey ? 'sk-…' : 'not required for local servers'} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

function ProviderView({ provider }: { provider: Provider }) {
  const loadProviders = useApp((s) => s.loadProviders)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [headers, setHeaders] = useState(JSON.stringify(provider.headers, null, 2))
  const [test, setTest] = useState<ProviderTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [manual, setManual] = useState('')
  const [pings, setPings] = useState<Record<string, { ok: boolean; text: string; latencyMs: number } | 'busy'>>({})
  const [filter, setFilter] = useState('')

  const dirty = name !== provider.name || baseUrl !== provider.baseUrl || apiKey !== '' || headers !== JSON.stringify(provider.headers, null, 2)

  const save = async () => {
    let parsed: Record<string, string>
    try {
      parsed = headers.trim() ? JSON.parse(headers) : {}
    } catch {
      useApp.getState().toast('Headers must be valid JSON', 'error')
      return
    }
    await attempt(() => api.providers.update(provider.id, { name, baseUrl, apiKey: apiKey || undefined, headers: parsed }), 'Provider saved')
    setApiKey('')
    await loadProviders()
  }

  const setModels = async (models: ModelInfo[]) => {
    await attempt(() => api.providers.setModels(provider.id, models))
    await loadProviders()
  }
  const toggle = (id: string, key: 'embedding' | 'reasoning' | 'vision') => setModels(provider.models.map((m) => (m.id === id ? { ...m, [key]: !m[key] } : m)))

  const shown = provider.models.filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {provider.name}
            <Badge>{provider.kind}</Badge>
            {isLocal(provider.baseUrl) && <Badge tone="ok">local</Badge>}
          </span>
        }
        subtitle={<span className="font-mono">{provider.baseUrl}</span>}
        actions={
          <>
            <Switch
              checked={provider.enabled}
              onChange={async (enabled) => {
                await attempt(() => api.providers.update(provider.id, { enabled }))
                await loadProviders()
              }}
              label="Enabled"
            />
            <Button
              icon={<Zap size={13} />}
              loading={testing}
              onClick={async () => {
                setTesting(true)
                setTest(await api.providers.test(provider.id))
                setTesting(false)
              }}
            >
              Test
            </Button>
            <IconButton
              title="Remove provider"
              onClick={async () => {
                if (!confirmAction(`Remove ${provider.name}? Chats using it will need a new model.`)) return
                await attempt(() => api.providers.remove(provider.id))
                await loadProviders()
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          </>
        }
      />
      {test && (
        <div className={clsx('mx-5 mt-4 rounded-md border px-3 py-2 text-[12px]', test.ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-crimson-line bg-crimson-soft text-crimson-hi')}>
          {test.ok ? '✓' : '✗'} {test.message} <span className="text-dim">({test.latencyMs}ms)</span>
        </div>
      )}
      <div className="grid gap-4 p-5 xl:grid-cols-[360px_1fr]">
        <Card className="h-fit space-y-3 p-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Base URL">
            <Input className="font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
          <Field label="API key">
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.hasApiKey ? '•••••••• saved — type to replace' : 'none'} />
          </Field>
          <Field label="Extra headers (JSON)">
            <Textarea rows={3} className="font-mono text-[11.5px]" value={headers} onChange={(e) => setHeaders(e.target.value)} />
          </Field>
          <div className="flex justify-between">
            {provider.hasApiKey ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await attempt(() => api.providers.update(provider.id, { apiKey: '' }), 'Key removed')
                  await loadProviders()
                }}
              >
                Clear key
              </Button>
            ) : (
              <span />
            )}
            <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <div className="text-[12.5px] font-semibold">Models</div>
            <Input className="h-7 max-w-52" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="flex-1" />
            <Input className="h-7 max-w-52 font-mono text-[11.5px]" placeholder="add model id manually" value={manual} onChange={(e) => setManual(e.target.value)} />
            <Button
              size="sm"
              disabled={!manual.trim()}
              onClick={async () => {
                await setModels([...provider.models, { id: manual.trim(), name: manual.trim(), contextWindow: 32768, maxTokens: 8192, reasoning: false, vision: false, embedding: /embed/i.test(manual) }])
                setManual('')
              }}
            >
              Add
            </Button>
            <Button
              size="sm"
              icon={<RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />}
              onClick={async () => {
                setRefreshing(true)
                await attempt(() => api.providers.refreshModels(provider.id), 'Model list refreshed')
                await loadProviders()
                setRefreshing(false)
              }}
            >
              Fetch
            </Button>
          </div>
          {!provider.models.length ? (
            <div className="p-6 text-center text-[12px] text-dim">No models yet — click Fetch (the server must be running) or add an id manually.</div>
          ) : (
            <table className="w-full table-fixed text-[12px]">
              <thead className="text-left text-[10.5px] uppercase tracking-wider text-dim">
                <tr>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="w-20 px-2 py-2 font-medium">Context</th>
                  <th className="w-16 px-2 py-2 text-center font-medium" title="Embedding model">Embed</th>
                  <th className="w-16 px-2 py-2 text-center font-medium" title="Supports reasoning / thinking">Reason</th>
                  <th className="w-16 px-2 py-2 text-center font-medium" title="Image input">Vision</th>
                  <th className="w-44" />
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => {
                  const ref = { providerId: provider.id, modelId: m.id }
                  const isDefault = m.embedding ? sameRef(settings?.embeddingModel, ref) : sameRef(settings?.defaultModel, ref)
                  const ping = pings[m.id]
                  return (
                    <tr key={m.id} className="group border-t border-line hover:bg-elev">
                      <td className="max-w-0 px-3 py-1.5">
                        <div className="flex items-center gap-1.5">
                          {isDefault && <Star size={11} className="shrink-0 fill-crimson text-crimson" />}
                          <span className="truncate font-mono text-[11.5px]" title={m.id}>
                            {m.id}
                          </span>
                        </div>
                        {ping && ping !== 'busy' && (
                          <div className={clsx('truncate text-[10.5px]', ping.ok ? 'text-ok' : 'text-crimson-hi')} title={ping.text}>
                            {ping.ok ? `✓ “${ping.text.slice(0, 40)}” in ${ping.latencyMs}ms` : `✗ ${ping.text}`}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-[11px] text-muted">{compact(m.contextWindow)}</td>
                      {(['embedding', 'reasoning', 'vision'] as const).map((k) => (
                        <td key={k} className="px-2 py-1.5 text-center">
                          <input type="checkbox" className="accent-[#dc2645]" checked={m[k]} onChange={() => void toggle(m.id, k)} />
                        </td>
                      ))}
                      <td className="px-2 py-1.5">
                        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                          {!m.embedding && (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={ping === 'busy'}
                              onClick={async () => {
                                setPings((p) => ({ ...p, [m.id]: 'busy' }))
                                const r = await api.providers.ping(ref)
                                setPings((p) => ({ ...p, [m.id]: r }))
                              }}
                            >
                              Ping
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => void updateSettings(m.embedding ? { embeddingModel: ref } : { defaultModel: ref })}>
                            Default
                          </Button>
                          <IconButton onClick={() => void setModels(provider.models.filter((x) => x.id !== m.id))}>
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}
