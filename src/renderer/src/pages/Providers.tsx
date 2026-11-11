import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Cloud, Cpu, HardDrive, Plus, RefreshCw, Star, Trash2, Zap } from 'lucide-react'
import type { GeneratedImage, ImageSize, ModelInfo, ModelRef, Provider, ProviderPreset, ProviderTestResult } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, sameRef, useApp } from '@/lib/store'
import { compact } from '@/lib/format'
import { Badge, Button, Card, Dot, Empty, Field, IconButton, Input, ListItem, ListPane, Modal, PageHeader, Switch, Textarea, confirmAction } from '@/components/ui'
import { SplitDetail, SplitRoot } from '@/components/SplitView'
import { ModelPicker } from '@/components/ModelPicker'
import { GeneratedImageCard } from '@/components/GeneratedImageCard'

const isLocal = (url: string) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(url)

export function ProvidersPage() {
  // Runners on the Run page show up as providers while they run; they're managed there, not here.
  const all = useApp((s) => s.providers)
  const providers = useMemo(() => all.filter((p) => !p.runnerId), [all])
  const loadProviders = useApp((s) => s.loadProviders)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!activeId || !providers.some((p) => p.id === activeId)) setActiveId(providers[0]?.id ?? null)
  }, [providers, activeId])

  const active = providers.find((p) => p.id === activeId)
  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        header={
          <div className="flex items-center justify-between">
            <div>
              <div className="text-ui font-semibold">Model providers</div>
              <div className="text-caption text-dim">{providers.reduce((n, p) => n + p.models.length, 0)} models</div>
            </div>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
              Add
            </Button>
          </div>
        }
      >
        {providers.map((p) => (
          <ListItem key={p.id} active={p.id === activeId} onClick={() => (setActiveId(p.id), setOpen(true))}>
            {isLocal(p.baseUrl) ? <HardDrive size={14} className="shrink-0 text-dim" /> : <Cloud size={14} className="shrink-0 text-dim" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-ui">{p.name}</div>
              <div className="truncate text-caption text-dim">
                {p.kind} · {p.models.length} models
              </div>
            </div>
            <Dot tone={p.enabled ? 'ok' : 'dim'} />
          </ListItem>
        ))}
        {!providers.length && <div className="p-4 text-center text-caption text-dim">No providers yet — tap Add to connect OpenAI, Anthropic or a local server.</div>}
      </ListPane>
      <SplitDetail>
        <div className="h-full overflow-y-auto">
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
      </SplitDetail>
      <AddProvider
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={async (p) => {
          await loadProviders()
          setActiveId(p.id)
          setOpen(true)
        }}
      />
    </SplitRoot>
  )
}

function Defaults() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  if (!settings) return null
  return (
    <div className="grid grid-cols-2 gap-4 border-b border-line bg-panel px-5 py-3.5">
      <Field label="Default chat model">
        <ModelPicker value={settings.defaultModel} onChange={(m) => void update({ defaultModel: m })} allowNone noneLabel="None" />
      </Field>
      <Field label="Default embedding model">
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
                <div className="text-ui font-semibold">{p.label}</div>
                <div className="text-caption text-dim">{p.hint}</div>
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
          <Field label={preset.needsKey ? 'API key' : 'API key (optional)'} hint="Encrypted with the OS keychain.">
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
  const toggle = (id: string, key: 'embedding' | 'reasoning' | 'vision' | 'image') => setModels(provider.models.map((m) => (m.id === id ? { ...m, [key]: !m[key] } : m)))
  const [playground, setPlayground] = useState<string | null>(null)

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
                if (!(await confirmAction(`Chats using ${provider.name} will need a new model.`, { title: `Remove ${provider.name}?`, confirmLabel: 'Remove', danger: true }))) return
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
        <div className={clsx('mx-5 mt-4 rounded-md border px-3 py-2 text-caption', test.ok ? 'border-ok/30 bg-ok/10 text-ok' : 'border-crimson-line bg-crimson-soft text-crimson-hi')}>
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
            <Textarea rows={3} className="font-mono text-caption" value={headers} onChange={(e) => setHeaders(e.target.value)} />
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
            <div className="text-ui font-semibold">Models</div>
            <Input className="h-7 max-w-52" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="flex-1" />
            <Input className="h-7 max-w-52 font-mono text-caption" placeholder="add model id manually" value={manual} onChange={(e) => setManual(e.target.value)} />
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
            <div className="p-6 text-center text-caption text-dim">No models yet — click Fetch (the server must be running) or add an id manually.</div>
          ) : (
            <table className="w-full table-fixed text-caption">
              <thead className="text-left text-caption font-medium text-dim">
                <tr>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="w-20 px-2 py-2 font-medium">Context</th>
                  <th className="w-16 px-2 py-2 text-center font-medium" title="Embedding model">Embed</th>
                  <th className="w-16 px-2 py-2 text-center font-medium" title="Supports reasoning / thinking">Reason</th>
                  <th className="w-16 px-2 py-2 text-center font-medium" title="Image input">Vision</th>
                  <th className="w-16 px-2 py-2 text-center font-medium" title="Generates images (Images API / OpenRouter image output)">Image</th>
                  <th className="w-28 px-2 py-2 font-medium" title="USD per 1M tokens (input / output) — used for cost on the Dashboard. Leave empty to use the built-in price list.">$ / 1M in·out</th>
                  <th className="w-44" />
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => {
                  const ref = { providerId: provider.id, modelId: m.id }
                  const isDefault = m.image ? sameRef(settings?.imageModel, ref) : m.embedding ? sameRef(settings?.embeddingModel, ref) : sameRef(settings?.defaultModel, ref)
                  const ping = pings[m.id]
                  return (
                    <tr key={m.id} className="group border-t border-line hover:bg-elev">
                      <td className="max-w-0 px-3 py-1.5">
                        <div className="flex items-center gap-1.5">
                          {isDefault && <Star size={11} className="shrink-0 fill-crimson text-crimson" />}
                          <span className="truncate font-mono text-caption" title={m.id}>
                            {m.id}
                          </span>
                        </div>
                        {ping && ping !== 'busy' && (
                          <div className={clsx('truncate text-micro', ping.ok ? 'text-ok' : 'text-crimson-hi')} title={ping.text}>
                            {ping.ok ? `✓ “${ping.text.slice(0, 40)}” in ${ping.latencyMs}ms` : `✗ ${ping.text}`}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 font-mono text-caption text-muted">{compact(m.contextWindow)}</td>
                      {(['embedding', 'reasoning', 'vision', 'image'] as const).map((k) => (
                        <td key={k} className="px-2 py-1.5 text-center">
                          <input type="checkbox" className="accent-[#dc2645]" checked={!!m[k]} onChange={() => void toggle(m.id, k)} />
                        </td>
                      ))}
                      <td className="px-2 py-1.5">
                        <PriceCell
                          value={m.pricing ?? null}
                          onChange={(pricing) => void setModels(provider.models.map((x) => (x.id === m.id ? { ...x, pricing } : x)))}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 mobile:opacity-100">
                          {m.image && (
                            <Button size="sm" variant="ghost" onClick={() => setPlayground(m.id)}>
                              Generate
                            </Button>
                          )}
                          {!m.embedding && !m.image && (
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
                          <Button size="sm" variant="ghost" onClick={() => void updateSettings(m.image ? { imageModel: ref } : m.embedding ? { embeddingModel: ref } : { defaultModel: ref })}>
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
      <ImagePlayground model={playground ? { providerId: provider.id, modelId: playground } : null} onClose={() => setPlayground(null)} />
    </div>
  )
}


/** Inline editor for a model's price (USD per 1M tokens). Empty = use the built-in price list. */
function PriceCell({ value, onChange }: { value: { input: number; output: number } | null; onChange(v: { input: number; output: number } | null): void }) {
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const open = () => {
    setInput(value ? String(value.input) : '')
    setOutput(value ? String(value.output) : '')
    setEditing(true)
  }
  const commit = () => {
    setEditing(false)
    const i = parseFloat(input)
    const o = parseFloat(output)
    const next = Number.isFinite(i) || Number.isFinite(o) ? { input: Number.isFinite(i) ? i : 0, output: Number.isFinite(o) ? o : 0 } : null
    if (JSON.stringify(next) !== JSON.stringify(value)) onChange(next)
  }
  if (!editing) {
    return (
      <button onClick={open} className="font-mono text-caption text-muted hover:text-crimson-hi" title="Set price (USD per 1M tokens)">
        {value ? `${value.input} · ${value.output}` : <span className="text-dim">auto</span>}
      </button>
    )
  }
  const field = (v: string, set: (s: string) => void, label: string, autoFocus?: boolean) => (
    <input
      autoFocus={autoFocus}
      aria-label={label}
      placeholder={label}
      inputMode="decimal"
      value={v}
      onChange={(e) => set(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditing(false)
      }}
      className="h-6 w-full min-w-0 rounded border border-line-strong bg-bg px-1 font-mono text-caption outline-none focus:border-crimson"
    />
  )
  return (
    <div
      className="flex items-center gap-1"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit()
      }}
    >
      {field(input, setInput, 'in', true)}
      {field(output, setOutput, 'out')}
    </div>
  )
}


const SIZES: { value: ImageSize; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: '1024x1024', label: 'Square' },
  { value: '1536x1024', label: 'Landscape' },
  { value: '1024x1536', label: 'Portrait' }
]

/** Try an image model: prompt in, image out, shown with the same card chat uses. */
function ImagePlayground({ model, onClose }: { model: ModelRef | null; onClose(): void }) {
  const [prompt, setPrompt] = useState('A lighthouse on a rocky coast at dusk, warm light in the window, long exposure sea, cinematic')
  const [size, setSize] = useState<ImageSize>('1024x1024')
  const [image, setImage] = useState<GeneratedImage | null>(null)
  useEffect(() => setImage(null), [model?.modelId])
  const busy = image?.status === 'generating'
  const run = async () => {
    if (!model || !prompt.trim()) return
    const started: GeneratedImage = { status: 'generating', prompt, size, model: model.modelId, startedAt: Date.now() }
    setImage(started)
    try {
      setImage({ ...(await api.images.generate({ prompt, size, model })), startedAt: started.startedAt })
    } catch (err) {
      setImage({ ...started, status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }
  return (
    <Modal open={!!model} onClose={onClose} title={<span className="font-mono text-ui">{model?.modelId}</span>} width={560}>
      <div className="space-y-3">
        <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the image" onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void run()} />
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
            {SIZES.map((s) => (
              <button key={s.value} onClick={() => setSize(s.value)} className={clsx('h-6 rounded px-2.5 text-caption font-medium transition-colors', size === s.value ? 'bg-elev-2 text-fg' : 'text-dim hover:text-muted')}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <Button variant="primary" loading={busy} disabled={!prompt.trim()} onClick={() => void run()}>
            Generate
          </Button>
        </div>
        {image && <GeneratedImageCard image={image} onRetry={() => void run()} className="mx-auto max-w-[400px] pt-1" />}
        {!image && <div className="rounded-[10px] border border-dashed border-line-strong p-6 text-center text-caption text-dim">Ctrl+Enter to generate.</div>}
      </div>
    </Modal>
  )
}
