import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Cloud, Cpu, HardDrive, Plus, RefreshCw, Star, Trash2, Zap } from 'lucide-react'
import { CaretDown, MagnifyingGlass, WarningCircle } from '@phosphor-icons/react'
import type { GeneratedImage, ImageSize, ModelInfo, ModelRef, Provider, ProviderPreset, ProviderTestResult } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, sameRef, useApp } from '@/lib/store'
import { compact } from '@/lib/format'
import { Button, Empty, Field, IconButton, Input, Modal, Switch, Textarea, confirmAction, PageTitle } from '@/components/ui'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { useSideBySide } from '@/lib/platform'
import { GeneratedImageCard } from '@/components/GeneratedImageCard'

const isLocal = (url: string) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(url)

export function ProvidersPage() {
  // Runners on the Run page show up as providers while they run; they're managed there, not here.
  const all = useApp((s) => s.providers)
  const providers = useMemo(() => all.filter((p) => !p.runnerId), [all])
  const loadProviders = useApp((s) => s.loadProviders)
  const side = useSideBySide()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  // Latest connection test per provider, shown in the list and the header.
  const [tests, setTests] = useState<Record<string, ProviderTestResult>>({})

  useEffect(() => {
    if (!activeId || !providers.some((p) => p.id === activeId)) setActiveId(providers[0]?.id ?? null)
  }, [providers, activeId])

  const active = providers.find((p) => p.id === activeId)
  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <aside className={clsx('flex h-full shrink-0 flex-col', side ? 'w-[264px] border-r border-line/60' : 'w-full')}>
        <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-6 mobile:pt-4">
          <PageTitle className="pl-1">Models</PageTitle>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
            Add provider
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2" role="list" aria-label="Providers">
          {providers.map((p) => {
            const t = tests[p.id]
            const on = side && p.id === activeId
            return (
              <button
                key={p.id}
                role="listitem"
                aria-current={on ? 'true' : undefined}
                onClick={() => (setActiveId(p.id), setOpen(true))}
                className={clsx(
                  'my-0.5 grid w-full grid-cols-[28px_1fr_auto] items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors mobile:min-h-[56px]',
                  on ? 'bg-elev-2' : 'hover:bg-elev'
                )}
              >
                <ProviderMark provider={p} />
                <span className="min-w-0">
                  <span className="block truncate text-ui font-semibold">{p.name}</span>
                  <span className="block truncate text-caption text-dim">{!p.enabled ? 'Off' : `${p.models.length} ${isLocal(p.baseUrl) ? 'local ' : ''}${p.models.length === 1 ? 'model' : 'models'}`}</span>
                </span>
                <Health enabled={p.enabled} test={t} />
              </button>
            )
          })}
          {!providers.length && <p className="p-3 text-caption text-dim">No providers yet. Add one to connect OpenAI, Anthropic or a server on this computer.</p>}
        </div>
        <Jobs providers={providers} />
      </aside>
      <SplitDetail>
        <div className="h-full overflow-y-auto">
          {active ? (
            <ProviderView key={active.id} provider={active} test={tests[active.id]} onTest={(r) => setTests((t) => ({ ...t, [active.id]: r }))} />
          ) : (
            <div className="h-[60%]">
              <Empty icon={<Cpu size={20} />} title="Connect a model provider" action={<Button variant="primary" onClick={() => setAdding(true)}>Add provider</Button>}>
                OpenAI, Anthropic, or any OpenAI-compatible server on this computer, like LM Studio, Ollama, llama.cpp or vLLM.
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

/** A provider's initial on a tile, tinted by kind: the list's way to tell providers apart at a glance. */
function ProviderMark({ provider, size = 28 }: { provider: Provider; size?: number }) {
  const tone = isLocal(provider.baseUrl)
    ? 'border-[#3d3260] bg-[#2b2340] text-[#d9cbff]'
    : provider.kind === 'anthropic'
      ? 'border-[#5a2e17] bg-[#3a1d0f] text-[#ffd2b8]'
      : 'border-[#1c6b46] bg-[#0f3a26] text-[#c8f2da]'
  return (
    <span
      aria-hidden="true"
      className={clsx('grid shrink-0 place-items-center rounded-[7px] border font-bold', provider.enabled ? tone : 'border-line bg-elev-2 text-dim')}
      style={{ width: size, height: size, fontSize: size > 32 ? 16 : 12, borderRadius: size > 32 ? 10 : 7 }}
    >
      {provider.name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}

function Health({ enabled, test }: { enabled: boolean; test?: ProviderTestResult }) {
  const tone = !enabled ? 'bg-line-strong' : test && !test.ok ? 'bg-danger' : 'bg-ok'
  const label = !enabled ? 'off' : test ? (test.ok ? `${test.latencyMs}ms` : 'failed') : ''
  return (
    <span className="flex items-center gap-1.5 font-mono text-micro text-dim" title={test?.message}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', tone)} />
      {label}
    </span>
  )
}

/** Which model does each job, so it's visible where models are managed. Changed in Settings › Models. */
function Jobs({ providers }: { providers: Provider[] }) {
  const settings = useApp((s) => s.settings)
  if (!settings) return null
  const jobs: [string, ModelRef | null, string][] = [
    ['Chat', settings.defaultModel, 'Not set'],
    ['Embeddings', settings.embeddingModel, 'Words only'],
    ['Images', settings.imageModel, 'First available'],
    ['Chat titles', settings.aiTitles ? (settings.titleModel ?? settings.defaultModel) : null, settings.aiTitles ? 'Same as chat' : 'Off']
  ]
  const exists = (r: ModelRef | null) => !!r && providers.some((p) => p.id === r.providerId && p.models.some((m) => m.id === r.modelId))
  return (
    <div className="border-t border-line/60 px-5 pb-4 pt-3 mobile:hidden">
      {jobs.map(([job, ref, none]) => (
        <div key={job} className="flex justify-between gap-3 py-1 text-caption">
          <span className="text-dim">{job}</span>
          {ref ? (
            <span className={clsx('truncate font-mono', exists(ref) ? 'text-fg' : 'text-warn')} title={exists(ref) ? ref.modelId : `${ref.modelId} is no longer offered`}>
              {ref.modelId}
            </span>
          ) : (
            <span className={clsx('truncate', job === 'Chat' ? 'text-warn' : 'text-dim')}>{none}</span>
          )}
        </div>
      ))}
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
            <button key={p.id} onClick={() => choose(p)} className="flex items-start gap-2.5 rounded-lg border border-line p-3 text-left hover:border-line-strong hover:bg-elev">
              {isLocal(p.baseUrl) ? <HardDrive size={15} className="mt-0.5 text-muted" /> : <Cloud size={15} className="mt-0.5 text-muted" />}
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

const CAPS: { key: 'reasoning' | 'vision' | 'embedding' | 'image'; label: string; title: string }[] = [
  { key: 'reasoning', label: 'Reasoning', title: 'Thinks before answering' },
  { key: 'vision', label: 'Vision', title: 'Reads images you attach' },
  { key: 'embedding', label: 'Embed', title: 'Turns text into vectors for knowledge search' },
  { key: 'image', label: 'Images', title: 'Generates images' }
]

function ProviderView({ provider, test, onTest }: { provider: Provider; test?: ProviderTestResult; onTest(r: ProviderTestResult): void }) {
  const loadProviders = useApp((s) => s.loadProviders)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [headers, setHeaders] = useState(JSON.stringify(provider.headers, null, 2))
  const [connOpen, setConnOpen] = useState(!provider.models.length)
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [manual, setManual] = useState('')
  const [pings, setPings] = useState<Record<string, { ok: boolean; text: string; latencyMs: number } | 'busy'>>({})
  const [filter, setFilter] = useState('')
  const [playground, setPlayground] = useState<string | null>(null)

  const savedHeaders = JSON.stringify(provider.headers, null, 2)
  const dirty = name !== provider.name || baseUrl !== provider.baseUrl || apiKey !== '' || headers !== savedHeaders
  const discard = () => {
    setName(provider.name)
    setBaseUrl(provider.baseUrl)
    setApiKey('')
    setHeaders(savedHeaders)
  }
  const save = async () => {
    let parsed: Record<string, string>
    try {
      parsed = headers.trim() ? JSON.parse(headers) : {}
    } catch {
      useApp.getState().toast('Extra headers must be valid JSON, like {"X-Org": "abc"}', 'error')
      return
    }
    await attempt(() => api.providers.update(provider.id, { name, baseUrl, apiKey: apiKey || undefined, headers: parsed }), 'Connection saved')
    setApiKey('')
    await loadProviders()
  }
  const runTest = async () => {
    setTesting(true)
    onTest(await api.providers.test(provider.id))
    setTesting(false)
  }
  const remove = async () => {
    if (!(await confirmAction(`Chats using ${provider.name} will need a new model.`, { title: `Remove ${provider.name}?`, confirmLabel: 'Remove', danger: true }))) return
    await attempt(() => api.providers.remove(provider.id))
    await loadProviders()
  }
  const setModels = async (models: ModelInfo[]) => {
    await attempt(() => api.providers.setModels(provider.id, models))
    await loadProviders()
  }
  const toggle = (id: string, key: (typeof CAPS)[number]['key']) => setModels(provider.models.map((m) => (m.id === id ? { ...m, [key]: !m[key] } : m)))
  const addManual = async () => {
    const id = manual.trim()
    if (!id || provider.models.some((m) => m.id === id)) return setManual('')
    await setModels([...provider.models, { id, name: id, contextWindow: 32768, maxTokens: 8192, reasoning: false, vision: false, embedding: /embed/i.test(id) }])
    setManual('')
  }

  const shown = provider.models.filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()))
  const maxCtx = Math.max(1, ...provider.models.map((m) => m.contextWindow))
  const role = (m: ModelInfo) => {
    const ref = { providerId: provider.id, modelId: m.id }
    const roles = [
      sameRef(settings?.defaultModel, ref) && 'Default for chat',
      sameRef(settings?.embeddingModel, ref) && 'Default for embeddings',
      sameRef(settings?.imageModel, ref) && 'Default for images',
      settings?.aiTitles && sameRef(settings?.titleModel, ref) && 'Names chats'
    ].filter(Boolean) as string[]
    return roles.join(', ')
  }
  const makeDefault = (m: ModelInfo) => {
    const ref = { providerId: provider.id, modelId: m.id }
    void updateSettings(m.image ? { imageModel: ref } : m.embedding ? { embeddingModel: ref } : { defaultModel: ref })
  }
  const defaultLabel = (m: ModelInfo) => (m.image ? 'Use for images' : m.embedding ? 'Use for embeddings' : 'Use for chat')

  return (
    <div className="px-8 pb-16 pt-6 mobile:px-4 mobile:pt-3">
      <div className="flex items-center gap-3.5 mobile:flex-wrap">
        <SplitBack />
        <ProviderMark provider={provider} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-title font-semibold tracking-tight">{provider.name}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-ui text-dim" aria-live="polite">
            {!provider.enabled ? (
              <span>Off. Its models don’t appear in model pickers.</span>
            ) : test ? (
              test.ok ? (
                <span className="flex items-center gap-1.5 font-medium text-ok">
                  <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                  Answered in {test.latencyMs}ms
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-danger-hi">
                  <WarningCircle size={14} />
                  {test.message}
                </span>
              )
            ) : (
              <span>{isLocal(provider.baseUrl) ? 'Runs on this computer' : 'Cloud provider'}</span>
            )}
            <span>{KIND_LABEL[provider.kind] ?? provider.kind}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Button variant="ghost" icon={<Zap size={14} />} loading={testing} disabled={!provider.enabled} onClick={() => void runTest()}>
            Test connection
          </Button>
          <Switch
            checked={provider.enabled}
            label="On"
            onChange={async (enabled) => {
              await attempt(() => api.providers.update(provider.id, { enabled }))
              await loadProviders()
            }}
          />
        </div>
      </div>

      <section className="mt-5 rounded-[10px] border border-line/70" aria-label="Connection">
        <button
          type="button"
          aria-expanded={connOpen}
          onClick={() => setConnOpen((o) => !o)}
          className="flex w-full flex-wrap items-center gap-x-5 gap-y-1 rounded-[10px] px-4 py-3 text-left text-ui text-muted hover:bg-elev/50"
        >
          <span className="min-w-0 truncate">
            <span className="mr-1.5 text-dim">Address</span>
            <span className="font-mono text-caption">{provider.baseUrl}</span>
          </span>
          <span>
            <span className="mr-1.5 text-dim">Key</span>
            {provider.hasApiKey ? 'Saved' : 'None'}
          </span>
          {Object.keys(provider.headers).length > 0 && (
            <span>
              <span className="mr-1.5 text-dim">Headers</span>
              {Object.keys(provider.headers).length}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5 font-medium text-fg">
            {connOpen ? 'Hide connection' : 'Edit connection'}
            <CaretDown size={13} className={clsx('transition-transform', connOpen && 'rotate-180')} />
          </span>
        </button>
        {connOpen && (
          <form
            className="grid grid-cols-2 gap-x-4 gap-y-3.5 border-t border-line/70 p-4 mobile:grid-cols-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (dirty) void save()
            }}
          >
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Address" hint={provider.kind === 'anthropic' ? 'Without /v1' : 'Including /v1'}>
              <Input className="font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            <Field label="API key" hint="Encrypted with the OS keychain.">
              <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.hasApiKey ? 'Saved. Type to replace it.' : 'None'} />
            </Field>
            <Field label="Extra headers" hint="JSON, sent with every request.">
              <Textarea rows={2} className="font-mono text-caption" value={headers} onChange={(e) => setHeaders(e.target.value)} />
            </Field>
            <div className="col-span-full flex flex-wrap items-center gap-2">
              <Button type="button" variant="ghost" className="text-danger-hi hover:text-danger-hi" icon={<Trash2 size={14} />} onClick={() => void remove()}>
                Remove provider
              </Button>
              {provider.hasApiKey && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={async () => {
                    await attempt(() => api.providers.update(provider.id, { apiKey: '' }), 'Key removed')
                    await loadProviders()
                  }}
                >
                  Remove key
                </Button>
              )}
              <span className="flex-1" />
              {dirty && (
                <Button type="button" onClick={discard}>
                  Discard
                </Button>
              )}
              <Button type="submit" variant="primary" disabled={!dirty}>
                Save connection
              </Button>
            </div>
          </form>
        )}
      </section>

      <div className="mb-2.5 mt-7 flex flex-wrap items-center gap-2.5">
        <h3 className="mr-1 text-section font-semibold">Models</h3>
        <span className="text-ui text-dim">{filter ? `${shown.length} of ${provider.models.length}` : provider.models.length}</span>
        <div className="relative ml-auto w-56 mobile:w-full">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-[9px] text-dim" />
          <Input className="pl-8" placeholder="Filter models" aria-label="Filter models" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <Button
          icon={<RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />}
          disabled={refreshing || !provider.enabled}
          onClick={async () => {
            setRefreshing(true)
            await attempt(() => api.providers.refreshModels(provider.id), 'Model list updated')
            await loadProviders()
            setRefreshing(false)
          }}
        >
          Fetch list
        </Button>
      </div>

      {!provider.models.length ? (
        <div className="rounded-[10px] border border-dashed border-line px-6 py-8 text-center text-ui text-dim">
          No models yet. Fetch the list (the server must be running) or add a model by its id below.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-ui">
            <thead>
              <tr className="border-b border-line text-left text-caption text-dim">
                <th className="w-[38%] py-2 pl-1 pr-3 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Context</th>
                <th className="px-3 py-2 font-medium">Can</th>
                <th className="whitespace-nowrap px-3 py-2 font-medium" title="USD per 1M tokens, used for cost on the Dashboard. Empty uses the built-in price list.">
                  Price per 1M in / out
                </th>
                <th className="w-px" />
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const ref = { providerId: provider.id, modelId: m.id }
                const ping = pings[m.id]
                const r = role(m)
                const isChatDefault = sameRef(settings?.defaultModel, ref)
                return (
                  <tr key={m.id} className="group border-b border-line/50 hover:bg-white/[0.015]">
                    <td className="py-2.5 pl-1 pr-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => makeDefault(m)}
                          className={clsx('shrink-0 rounded p-0.5', isChatDefault || r ? 'text-warn' : 'text-line-strong hover:text-muted')}
                          aria-label={r || defaultLabel(m)}
                          title={r || defaultLabel(m)}
                        >
                          <Star size={15} className={clsx(r && 'fill-warn')} />
                        </button>
                        <div className="min-w-0 max-w-[420px]">
                          <div className="truncate font-mono text-ui font-medium" title={m.id}>
                            {m.id}
                          </div>
                          {ping && ping !== 'busy' ? (
                            <div className={clsx('truncate text-caption', ping.ok ? 'text-ok' : 'text-danger-hi')} title={ping.text}>
                              {ping.ok ? `Answered “${ping.text.slice(0, 40)}” in ${ping.latencyMs}ms` : ping.text}
                            </div>
                          ) : (
                            r && <div className="truncate text-caption text-dim">{r}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5" title={`${m.contextWindow.toLocaleString()} tokens`}>
                        <span className="w-10 text-right font-mono text-caption font-medium">{compact(m.contextWindow)}</span>
                        <span className="h-1 w-[72px] overflow-hidden rounded-full bg-elev-2">
                          <span className="block h-full rounded-full bg-muted" style={{ width: `${Math.max(3, (m.contextWindow / maxCtx) * 100)}%` }} />
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1">
                        {CAPS.map((c) => (
                          <button
                            key={c.key}
                            type="button"
                            aria-pressed={!!m[c.key]}
                            title={c.title}
                            onClick={() => void toggle(m.id, c.key)}
                            className={clsx(
                              'h-[26px] rounded-full border px-2.5 text-caption font-medium transition-colors',
                              m[c.key] ? 'border-line-strong bg-elev-2 text-fg' : 'border-dashed border-line text-dim hover:border-line-strong hover:text-muted'
                            )}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <PriceCell value={m.pricing ?? null} onChange={(pricing) => void setModels(provider.models.map((x) => (x.id === m.id ? { ...x, pricing } : x)))} />
                    </td>
                    <td className="py-2.5 pl-2 pr-1">
                      <div className="flex justify-end gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 mobile:opacity-100">
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
                              const res = await api.providers.ping(ref)
                              setPings((p) => ({ ...p, [m.id]: res }))
                            }}
                          >
                            Ping
                          </Button>
                        )}
                        <IconButton aria-label={`Remove ${m.id}`} title="Remove model" onClick={() => void setModels(provider.models.filter((x) => x.id !== m.id))}>
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="relative mt-3 w-80 mobile:w-full"
        onSubmit={(e) => {
          e.preventDefault()
          void addManual()
        }}
      >
        <Plus size={14} className="pointer-events-none absolute left-2.5 top-[9px] text-dim" />
        <Input className="pl-8 font-mono text-caption" placeholder="Add a model by its id" aria-label="Add a model by its id" value={manual} onChange={(e) => setManual(e.target.value)} />
      </form>
      <ImagePlayground model={playground ? { providerId: provider.id, modelId: playground } : null} onClose={() => setPlayground(null)} />
    </div>
  )
}

const KIND_LABEL: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', 'openai-compatible': 'OpenAI-compatible' }


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
      <button onClick={open} className="font-mono text-caption text-muted hover:text-fg" title="Set price (USD per 1M tokens)">
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
