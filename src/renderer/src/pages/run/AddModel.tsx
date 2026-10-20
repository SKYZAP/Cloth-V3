import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowSquareOut, Brain, DownloadSimple, Heart, Lock, MagnifyingGlass, Monitor } from '@phosphor-icons/react'
import type { Hardware, HubFiles, HubFit, HubModel, Runner } from '@shared/types'
import { api } from '@/lib/api'
import { attempt } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { Button, Input, Modal, Segmented, Spinner } from '@/components/ui'
import { FitPill, GB, MiB, compact, fileSize, message, paramCount, tokens, useNarrow } from './shared'

type Filter = 'gpu' | 'ram' | 'all'

/**
 * Where a model would run at Q4_K_M, the usual pick, judged from its parameter count before its files are
 * listed (same rule as the main process's fitOf).
 */
function estimateFit(params: number | null, hw: Hardware | null): HubFit | null {
  if (!params || !hw) return null
  const need = params * 0.6 + 0.6 * GB + Math.min(params / 8e9, 6) * 0.5 * GB
  const vram = (hw.gpus[0]?.totalMiB ?? 0) * MiB
  if (vram && need <= vram * 0.95) return 'gpu'
  if (need <= vram + hw.ramMiB * MiB * 0.6) return 'ram'
  return 'too-big'
}

export function hardwareLine(hw: Hardware): string {
  const gpu = hw.gpus[0]
  const ram = `${Math.round(hw.ramMiB / 1024)} GB system memory`
  return gpu ? `${gpu.name}, ${Math.round(gpu.totalMiB / 1024)} GB · ${ram}` : `No GPU found · ${ram}`
}

/** Search Hugging Face for GGUF models, see which sizes suit this PC, and add one as a runner. */
export function AddModelModal({ open, hardware, onClose, onAdded }: { open: boolean; hardware: Hardware | null; onClose(): void; onAdded(r: Runner): void }) {
  const narrow = useNarrow()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HubModel[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('gpu')
  const [picked, setPicked] = useState<HubModel | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (!open) return
    const n = ++seq.current
    setSearching(true)
    const t = setTimeout(
      () =>
        void api.runs.searchModels(query).then(
          (r) => {
            if (n !== seq.current) return
            setResults(r)
            setError(null)
            setSearching(false)
          },
          (err) => {
            if (n !== seq.current) return
            setError(message(err))
            setSearching(false)
          }
        ),
      query ? 350 : 0
    )
    return () => clearTimeout(t)
  }, [query, open])

  useEffect(() => {
    if (!open) setPicked(null)
  }, [open])

  const withFit = (results ?? []).map((m) => ({ m, fit: estimateFit(m.params, hardware) }))
  const shown = withFit.filter(({ fit }) => filter === 'all' || (filter === 'gpu' ? fit === 'gpu' : fit === 'gpu' || fit === 'ram'))
  const count = (f: Filter) => withFit.filter(({ fit }) => f === 'all' || (f === 'gpu' ? fit === 'gpu' : fit === 'gpu' || fit === 'ram')).length

  const list = (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'gpu', label: `Fits on the GPU${results ? ` (${count('gpu')})` : ''}` },
            { value: 'ram', label: `Fits with RAM${results ? ` (${count('ram')})` : ''}` },
            { value: 'all', label: 'All' }
          ]}
        />
        {searching && <Spinner size={13} className="text-dim" />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-busy={searching}>
        <p className="sr-only" role="status" aria-live="polite">
          {results && !searching ? `${shown.length} models` : ''}
        </p>
        {error ? (
          <p className="px-1 py-6 text-[12.5px] text-crimson-hi">
            {error}. Check the connection and type again to retry.
          </p>
        ) : results && !shown.length ? (
          <p className="px-1 py-6 text-[12.5px] text-dim">
            {results.length ? 'Nothing here fits this filter. Try “All”, or a smaller model.' : `No GGUF models match “${query}”.`}
          </p>
        ) : (
          <ul className="grid gap-0.5" aria-label="Models">
            {shown.map(({ m, fit }) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setPicked(m)}
                  aria-current={picked?.id === m.id ? 'true' : undefined}
                  className={clsx(
                    'grid w-full gap-1 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line',
                    picked?.id === m.id ? 'bg-elev-2' : 'hover:bg-elev'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" translate="no">
                      {m.name}
                    </span>
                    {fit && <FitPill fit={fit} />}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-dim">
                    <span className="truncate" translate="no">
                      {m.author}
                    </span>
                    {paramCount(m.params) && <span className="tabular-nums">{paramCount(m.params)}</span>}
                    {m.reasoning && (
                      <span className="flex items-center gap-1">
                        <Brain size={12} aria-hidden="true" /> Reasons
                      </span>
                    )}
                    <span className="flex items-center gap-1 tabular-nums" title={`${m.downloads.toLocaleString()} downloads`}>
                      <DownloadSimple size={12} aria-hidden="true" />
                      {compact(m.downloads)}
                    </span>
                    {m.likes > 0 && (
                      <span className="flex items-center gap-1 tabular-nums">
                        <Heart size={12} aria-hidden="true" />
                        {compact(m.likes)}
                      </span>
                    )}
                    {m.gated && (
                      <span className="flex items-center gap-1">
                        <Lock size={12} aria-hidden="true" /> Licence required
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {!results && !error && (
              <li className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-dim">
                <Spinner size={13} /> Loading popular models…
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} title="Add a model" width={900}>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="relative min-w-[240px] flex-1">
            <span className="sr-only">Search Hugging Face</span>
            <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" aria-hidden="true" />
            <Input
              autoFocus={!isMobile}
              type="search"
              name="model-search"
              spellCheck={false}
              autoComplete="off"
              placeholder="Search models on Hugging Face, e.g. qwen3, gemma, llama…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-8"
            />
          </label>
          {hardware && (
            <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
              <Monitor size={14} className="shrink-0 text-dim" aria-hidden="true" />
              <span className="truncate">This PC: {hardwareLine(hardware)}</span>
            </span>
          )}
        </div>

        {narrow ? (
          <div className="flex h-[60vh] min-h-0 flex-col">{picked ? <ModelDetail key={picked.id} model={picked} hardware={hardware} onBack={() => setPicked(null)} onAdded={onAdded} /> : list}</div>
        ) : (
          <div className="grid h-[min(560px,64vh)] min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-4">
            {list}
            <div className="flex min-h-0 flex-col rounded-[12px] border border-line bg-elev">
              {picked ? (
                <ModelDetail key={picked.id} model={picked} hardware={hardware} onAdded={onAdded} />
              ) : (
                <p className="m-auto max-w-[260px] text-center text-[12.5px] text-dim">Choose a model to see its sizes and how each fits this PC.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function ModelDetail({ model, hardware, onBack, onAdded }: { model: HubModel; hardware: Hardware | null; onBack?(): void; onAdded(r: Runner): void }) {
  const [files, setFiles] = useState<HubFiles | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [quant, setQuant] = useState<string | null>(null)
  const [projector, setProjector] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = () => {
    setError(null)
    api.runs.hubFiles(model.id, model.params).then(
      (f) => {
        setFiles(f)
        setQuant((f.groups.find((g) => g.recommended) ?? f.groups.find((g) => g.fit !== 'too-big') ?? f.groups[0])?.quant ?? null)
        // The smallest vision file is as good as the larger ones for most uses.
        setProjector([...f.projectors].sort((a, b) => a.size - b.size)[0]?.path ?? null)
      },
      (err) => setError(message(err))
    )
  }
  useEffect(load, [model.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const group = files?.groups.find((g) => g.quant === quant)
  const proj = files?.projectors.find((p) => p.path === projector)
  const need = group ? group.needGB * GB + (proj?.size ?? 0) : 0

  const add = async () => {
    if (!group) return
    setAdding(true)
    const r = await attempt(() => api.runs.addHubModel({ repo: model.id, quant: group.quant, projector, name: model.name, params: model.params }))
    setAdding(false)
    if (r) onAdded(r)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        {onBack && (
          <Button size="sm" variant="ghost" icon={<ArrowLeft size={13} />} onClick={onBack} aria-label="Back to results" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold" translate="no">
            {model.name}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-dim">
            {paramCount(model.params) && <span>{paramCount(model.params)} parameters</span>}
            {model.contextLength && <span>{tokens(model.contextLength)} context</span>}
            {model.reasoning && <span>{model.reasoning === 'levels' ? 'Reasoning levels' : 'Thinking on or off'}</span>}
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={<ArrowSquareOut size={13} />} onClick={() => void api.app.openExternal(`https://huggingface.co/${model.id}`)}>
          Hugging Face
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {error ? (
          <div className="grid gap-2 py-4 text-[12.5px]">
            <p className="text-crimson-hi">{error}</p>
            <Button size="sm" className="w-fit" onClick={load}>
              Try again
            </Button>
          </div>
        ) : !files ? (
          <p className="flex items-center gap-2 py-4 text-[12.5px] text-dim">
            <Spinner size={13} /> Reading the file list…
          </p>
        ) : !files.groups.length ? (
          <p className="py-4 text-[12.5px] text-dim">This repository has no GGUF files Cloth can tell apart. Download one yourself and choose it from disk.</p>
        ) : (
          <fieldset className="grid gap-1">
            <legend className="mb-2 text-[12.5px] font-semibold">Size</legend>
            {files.groups.map((g) => (
              <label
                key={g.quant}
                className={clsx(
                  'grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[10px] border px-3 py-2 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-crimson-line',
                  quant === g.quant ? 'border-crimson-line bg-crimson-soft' : 'border-transparent hover:bg-elev-2'
                )}
              >
                <input type="radio" name="quant" value={g.quant} checked={quant === g.quant} onChange={() => setQuant(g.quant)} className="accent-[var(--color-crimson)]" />
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] font-medium" translate="no">
                      {g.quant}
                    </span>
                    {g.recommended && <span className="rounded border border-crimson-line px-1.5 py-px text-[10.5px] font-medium text-crimson-hi">Recommended</span>}
                  </span>
                  <span className="block text-[11.5px] tabular-nums text-dim">
                    {fileSize(g.size)} download{g.files.length > 1 ? ` in ${g.files.length} parts` : ''}, needs about {g.needGB} GB
                  </span>
                </span>
                <FitPill fit={g.fit} />
              </label>
            ))}
          </fieldset>
        )}

        {files && files.projectors.length > 0 && (
          <label className="mt-3 flex items-start gap-2.5 rounded-[10px] px-3 py-2 text-[12.5px] hover:bg-elev-2">
            <input type="checkbox" checked={!!projector} onChange={(e) => setProjector(e.target.checked ? ([...files.projectors].sort((a, b) => a.size - b.size)[0]?.path ?? null) : null)} className="mt-0.5 accent-[var(--color-crimson)]" />
            <span>
              Image input
              <span className="block text-[11.5px] text-dim">
                Adds the vision file ({fileSize(files.projectors.find((p) => p.path === projector)?.size ?? files.projectors[0].size)}) so chats can send it pictures.
              </span>
            </span>
          </label>
        )}
      </div>

      {group && (
        <div className="grid gap-3 border-t border-line px-4 py-3">
          {hardware && <MemoryPreview need={need} hardware={hardware} />}
          <div className="flex items-center justify-end gap-2">
            <Button variant="primary" icon={<DownloadSimple size={13} />} loading={adding} disabled={group.fit === 'too-big'} title={group.fit === 'too-big' ? 'Too big for this PC: pick a smaller size' : undefined} onClick={() => void add()}>
              Download and add
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** How much of the GPU (and system memory past it) a size would take with an 8K context. */
function MemoryPreview({ need, hardware }: { need: number; hardware: Hardware }) {
  const gpu = hardware.gpus[0]
  const cap = gpu ? gpu.totalMiB * MiB : hardware.ramMiB * MiB
  const pct = Math.min(100, (need / cap) * 100)
  const spill = gpu ? need - cap * 0.95 : 0
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-muted">With an 8K context</span>
        <span className="tabular-nums text-dim">
          {(need / GB).toFixed(1)} of {Math.round(cap / GB)} GB {gpu ? 'on the GPU' : 'memory'}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line" role="meter" aria-label="Memory needed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className={clsx('h-full rounded-full', spill > 0 ? 'bg-warn' : 'bg-ok')} style={{ width: `${pct}%` }} />
      </div>
      {spill > 0 && <p className="text-[11.5px] text-warn">About {(spill / GB).toFixed(1)} GB goes to system memory, which is several times slower.</p>}
    </div>
  )
}
