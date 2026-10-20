import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CaretRight, ChatCircleDots, Play, Stop, Trash, Warning } from '@phosphor-icons/react'
import type { EnginesState, Hardware, ModelMeta, ReasoningKind, Runner, RunnerPatch, RunnerReasoning, RunnerSampling, RunnerStatus } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Segmented, Spinner, Switch, confirmAction } from '@/components/ui'
import { FLAVOUR, engineStatus, tagLabel } from './Engine'
import { CommitInput, Devices, GB, LogCard, MiB, PathRow, ProgressBar, Row, Section, active, fileSize, live, message, progressKey, tokens, type Progress } from './shared'

/** Working buffers llama.cpp keeps besides the weights and the context cache (rough, for the meter). */
const BUFFERS = 0.45 * GB
const STOPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144]

type Save = (patch: RunnerPatch) => Promise<boolean>

export function RunnerView({
  runner,
  status,
  progress,
  hardware,
  engines,
  onChange,
  onRemoved,
  onManageEngine
}: {
  runner: Runner
  status: RunnerStatus
  progress: Record<string, Progress>
  hardware: Hardware | null
  engines: EnginesState | null
  onChange(r: Runner): void
  onRemoved(): void
  onManageEngine(): void
}) {
  const [meta, setMeta] = useState<ModelMeta | null>(null)
  const [context, setContext] = useState(runner.contextSize)
  useEffect(() => setContext(runner.contextSize), [runner.contextSize])
  useEffect(() => {
    setMeta(null)
    if (runner.modelPath) void api.runs.modelMeta(runner.id).then(setMeta, () => undefined)
  }, [runner.id, runner.modelPath, runner.mmprojPath])

  const locked = live(status)
  const save: Save = async (patch) => {
    const r = await attempt(() => api.runs.update(runner.id, patch))
    if (r) onChange(r)
    return !!r
  }
  const ready = !!runner.serverPath && !!runner.modelPath

  return (
    <>
      <Header runner={runner} status={status} meta={meta} ready={ready} />
      <Setup runner={runner} progress={progress} engines={engines} locked={locked} save={save} onChange={onChange} onRemoved={onRemoved} onManageEngine={onManageEngine} />
      {runner.modelPath && (
        <Section title="Context window" aside={locked && <span className="text-[12px] text-dim">Stop it to change</span>}>
          <div className="grid gap-4 px-3.5 py-3">
            <MemoryMeter meta={meta} hardware={hardware} runner={runner} context={context} />
            <ContextWindow meta={meta} hardware={hardware} runner={runner} value={context} locked={locked} onDraft={setContext} onCommit={(n) => save({ contextSize: n })} />
          </div>
        </Section>
      )}
      {meta?.reasoning && <Reasoning kind={meta.reasoning} value={runner.reasoning} locked={locked} onChange={(reasoning) => void save({ reasoning })} />}
      <Section title="Hardware" aside={locked && <span className="text-[12px] text-dim">Stop it to change</span>}>
        <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 px-3.5 py-3 mobile:grid-cols-1">
          <Row label="GPU">
            <Devices runner={runner} locked={locked} onSelect={(device) => void save({ device })} />
          </Row>
          <Row label="GPU layers">
            <div className="flex items-center gap-2">
              <CommitInput aria-label="GPU layers" type="number" inputMode="numeric" min={0} className="w-[90px]" value={String(runner.gpuLayers)} disabled={locked} onCommit={(v) => (v.trim() === '' ? Promise.resolve(false) : save({ gpuLayers: Number(v) }))} />
              <span className="text-[12px] text-dim">{runner.gpuLayers >= 99 ? 'All on the GPU' : runner.gpuLayers === 0 ? 'All on the CPU' : 'The rest run on the CPU'}</span>
            </div>
          </Row>
          <Row label="Flash attention">
            <Switch checked={runner.flashAttention} disabled={locked} onChange={(v) => void save({ flashAttention: v })} label="Faster, and a smaller context cache" />
          </Row>
        </div>
      </Section>
      <Advanced runner={runner} locked={locked} save={save} onRemoved={onRemoved} />
      <LogCard id={runner.id} />
    </>
  )
}

function Header({ runner, status, meta, ready }: { runner: Runner; status: RunnerStatus; meta: ModelMeta | null; ready: boolean }) {
  const setPage = useApp((s) => s.setPage)
  const loadProviders = useApp((s) => s.loadProviders)
  const [busy, setBusy] = useState(false)
  const running = status.state === 'running'

  const toggle = async () => {
    setBusy(true)
    await attempt(() => (live(status) ? api.runs.stop(runner.id) : api.runs.start(runner.id)))
    setBusy(false)
  }
  const openChat = async () => {
    const s = await attempt(() => api.chat.create({ model: { providerId: `run-${runner.id}`, modelId: runner.alias } }))
    if (!s) return
    await loadProviders().catch(() => undefined)
    try {
      localStorage.setItem('cloth.chat', s.id)
    } catch {
      /* storage unavailable */
    }
    setPage('chat')
  }

  const about = [runner.source?.quant, meta?.architecture, meta && meta.fileBytes ? fileSize(meta.fileBytes + meta.projectorBytes) : null].filter(Boolean).join(', ')
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-[200px] flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2 className="text-[17px] font-semibold tracking-tight" translate="no">
            {runner.name}
          </h2>
          {status.state === 'running' && <span className="text-[12.5px] text-ok">Running</span>}
          {status.state === 'starting' && (
            <span className="flex items-center gap-1.5 text-[12.5px] text-warn">
              <Spinner size={12} className="text-warn" />
              Starting
            </span>
          )}
          {status.state === 'error' && <span className="text-[12.5px] text-crimson-hi">Stopped with an error</span>}
          {status.state === 'stopped' && <span className="text-[12.5px] text-dim">Stopped</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-[12px] text-dim">
          {about && <span translate="no">{about}</span>}
          {running && status.url && (
            <span className="selectable font-mono text-[11.5px]" translate="no">
              {status.url}
            </span>
          )}
          {running && status.lastTokensPerSecond !== undefined && <span className="tabular-nums">{status.lastTokensPerSecond.toFixed(1)} tokens/s last reply</span>}
        </div>
      </div>
      {running && runner.useInChats && (
        <Button icon={<ChatCircleDots size={13} />} onClick={() => void openChat()}>
          Open chat
        </Button>
      )}
      {live(status) ? (
        <Button icon={<Stop size={13} />} loading={busy} onClick={() => void toggle()}>
          Stop
        </Button>
      ) : (
        <Button variant="primary" icon={<Play size={13} />} loading={busy} disabled={!ready} title={ready ? undefined : 'Needs llama.cpp and a model first'} onClick={() => void toggle()}>
          Start
        </Button>
      )}
      {status.state === 'error' && status.error && <p className="selectable basis-full whitespace-pre-wrap break-words text-[12px] text-crimson-hi">{status.error}</p>}
    </div>
  )
}

/** What a runner still needs before it can start: a llama.cpp build and a model file (or its download). */
function Setup({
  runner,
  progress,
  engines,
  locked,
  save,
  onChange,
  onRemoved,
  onManageEngine
}: {
  runner: Runner
  progress: Record<string, Progress>
  engines: EnginesState | null
  locked: boolean
  save: Save
  onChange(r: Runner): void
  onRemoved(): void
  onManageEngine(): void
}) {
  const download = progress[progressKey('model', runner.id)]
  const downloading = active(download)
  const [busy, setBusy] = useState(false)
  if (runner.serverPath && runner.modelPath && !downloading) return null

  const { build } = engineStatus(engines)
  const needsPrism = !!runner.builtin
  const usable = build && (!needsPrism || build.flavour === 'prism') ? build : (engines?.installed.find((b) => b.flavour === 'prism' && needsPrism) ?? null)

  const downloadBonsai = async () => {
    setBusy(true)
    try {
      onChange(await api.runs.downloadModel(runner.id))
    } catch (err) {
      if (!/cancel|abort/i.test(message(err))) useApp.getState().toast(message(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!(await confirmAction('Files that finished downloading stay on disk, so adding it again picks up where it left off.', { title: `Delete ${runner.name}?`, confirmLabel: 'Delete', danger: true }))) return
    if (await attempt(() => api.runs.remove(runner.id).then(() => true))) onRemoved()
  }

  return (
    <Section>
      <div className="grid gap-3 px-3.5 py-3">
        {!runner.serverPath && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Warning size={15} className="shrink-0 text-warn" aria-hidden="true" />
            <span className="min-w-0 flex-1 text-[12.5px]">{needsPrism ? "Bonsai needs PrismML's llama.cpp." : 'Choose which llama.cpp runs this model.'}</span>
            {usable ? (
              <Button size="sm" variant="primary" disabled={locked} onClick={() => void save({ serverPath: usable.path })}>
                Use {FLAVOUR[usable.flavour].name} <span translate="no">{tagLabel(usable.tag)}</span>
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={onManageEngine}>
                Install llama.cpp
              </Button>
            )}
          </div>
        )}
        {downloading ? (
          <ProgressBar p={downloading} label={`Downloading ${runner.source ? `${runner.source.quant} from ${runner.source.repo}` : 'the model'}`} onCancel={() => void attempt(() => api.runs.cancelDownload(runner.id))} />
        ) : (
          !runner.modelPath && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Warning size={15} className="shrink-0 text-warn" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-[12.5px]">
                {download?.state === 'error' ? `The download failed: ${download.error ?? 'unknown error'}.` : runner.source ? "The model's download didn't finish." : 'No model file yet.'}
                {runner.source && !runner.builtin && <span className="text-dim"> Delete this and add the model again to resume; finished files are kept.</span>}
              </span>
              {runner.builtin ? (
                <Button size="sm" variant="primary" loading={busy} disabled={locked} onClick={() => void downloadBonsai()}>
                  Download Bonsai
                </Button>
              ) : runner.source ? (
                <Button size="sm" variant="ghost" className="!text-crimson-hi hover:!bg-crimson-soft" icon={<Trash size={13} />} onClick={() => void remove()}>
                  Delete
                </Button>
              ) : null}
            </div>
          )
        )}
      </div>
    </Section>
  )
}

/** Memory a runner would use: what each part takes, against the GPU (or system memory without one). */
function usage(meta: ModelMeta | null, hardware: Hardware | null, runner: Runner, context: number) {
  const gpu = runner.gpuLayers > 0 ? hardware?.gpus[0] : undefined
  const cap = gpu ? gpu.totalMiB * MiB : (hardware?.ramMiB ?? 0) * MiB
  const weights = meta?.fileBytes ?? 0
  const vision = meta?.projectorBytes ?? 0
  const cache = meta?.kvBytesPerToken ? meta.kvBytesPerToken * context : 0
  const total = weights + vision + cache + BUFFERS
  // The longest context that still fits in 95% of it.
  const room = cap * 0.95 - weights - vision - BUFFERS
  const maxFit = meta?.kvBytesPerToken && room > 0 ? Math.floor(room / meta.kvBytesPerToken) : null
  return { gpu, cap, weights, vision, cache, total, maxFit }
}

function MemoryMeter({ meta, hardware, runner, context }: { meta: ModelMeta | null; hardware: Hardware | null; runner: Runner; context: number }) {
  if (!meta || !hardware) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-dim">
        <Spinner size={12} /> Reading the model…
      </p>
    )
  }
  const u = usage(meta, hardware, runner, context)
  const scale = Math.max(u.cap, u.total)
  const parts = [
    { label: 'Model', bytes: u.weights, color: 'bg-crimson' },
    { label: 'Vision', bytes: u.vision, color: 'bg-info' },
    { label: 'Context cache', bytes: u.cache, color: 'bg-warn' },
    { label: 'Buffers', bytes: BUFFERS, color: 'bg-line-strong' }
  ].filter((p) => p.bytes > 0)
  const over = u.total > u.cap * 0.95
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12px]">
        <span className="font-medium">
          {(u.total / GB).toFixed(1)} GB <span className="font-normal text-dim">of {(u.cap / GB).toFixed(0)} GB {u.gpu ? `on the ${u.gpu.name}` : 'system memory'}</span>
        </span>
        {over && <span className="text-warn">{u.gpu ? 'Over the GPU: the rest spills into slower system memory' : 'More than this PC has'}</span>}
      </div>
      <div className="relative flex h-2.5 overflow-hidden rounded-full bg-line" role="meter" aria-label="Memory use" aria-valuemin={0} aria-valuemax={Math.round(u.cap / MiB)} aria-valuenow={Math.round(u.total / MiB)} aria-valuetext={`${(u.total / GB).toFixed(1)} of ${(u.cap / GB).toFixed(0)} GB`}>
        {parts.map((p) => (
          <div key={p.label} className={clsx('h-full transition-[width] duration-200 motion-reduce:transition-none', p.color)} style={{ width: `${(p.bytes / scale) * 100}%` }} />
        ))}
        {u.total > u.cap && <div className="absolute inset-y-0 w-px bg-fg" style={{ left: `${(u.cap / scale) * 100}%` }} aria-hidden="true" />}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-dim">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5 tabular-nums">
            <span className={clsx('h-2 w-2 rounded-sm', p.color)} aria-hidden="true" />
            {p.label} {fileSize(p.bytes)}
          </li>
        ))}
        {!meta.kvBytesPerToken && <li>Context cache size unknown for this model</li>}
      </ul>
    </div>
  )
}

function ContextWindow({
  meta,
  hardware,
  runner,
  value,
  locked,
  onDraft,
  onCommit
}: {
  meta: ModelMeta | null
  hardware: Hardware | null
  runner: Runner
  value: number
  locked: boolean
  onDraft(n: number): void
  onCommit(n: number): Promise<boolean>
}) {
  const trained = meta?.trainedContext ?? null
  const stops = STOPS.filter((s) => !trained || s <= trained)
  if (trained && !stops.includes(trained) && trained > (stops.at(-1) ?? 0)) stops.push(trained)
  const index = stops.reduce((best, s, i) => (Math.abs(s - value) < Math.abs(stops[best] - value) ? i : best), 0)
  const { maxFit, gpu } = usage(meta, hardware, runner, value)
  const commit = () => value !== runner.contextSize && void onCommit(value).then((ok) => !ok && onDraft(runner.contextSize))

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <label htmlFor={`ctx-${runner.id}`} className="text-[12.5px] font-medium">
          Context window
        </label>
        <span className="min-w-0 flex-1 text-[12px] text-dim">How much of a chat the model can see at once</span>
        <CommitInput
          aria-label="Context window in tokens"
          type="number"
          inputMode="numeric"
          min={512}
          max={trained ?? undefined}
          step={1024}
          className="w-[96px] tabular-nums"
          value={String(runner.contextSize)}
          disabled={locked}
          onCommit={(v) => {
            const n = Number(v)
            if (!Number.isFinite(n) || n < 512) return Promise.resolve(false)
            onDraft(n)
            return onCommit(n)
          }}
        />
      </div>
      <input
        id={`ctx-${runner.id}`}
        type="range"
        min={0}
        max={stops.length - 1}
        step={1}
        value={index}
        disabled={locked}
        aria-valuetext={`${tokens(stops[index])} tokens`}
        onChange={(e) => onDraft(stops[Number(e.target.value)])}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-full accent-[var(--color-crimson)] disabled:opacity-50"
      />
      <div className="flex justify-between text-[11px] tabular-nums text-dim" aria-hidden="true">
        {stops.map((s) => (
          <span key={s} className={clsx(s === stops[index] && 'font-medium text-fg')}>
            {tokens(s)}
          </span>
        ))}
      </div>
      <p className="text-[12px] text-dim">
        {trained && <>Trained for {tokens(trained)}. </>}
        {maxFit !== null &&
          gpu &&
          (trained && maxFit >= trained
            ? 'Fits on the GPU even at full length.'
            : maxFit >= value
              ? `Fits on the GPU up to about ${tokens(maxFit)}.`
              : `Above about ${tokens(maxFit)} part of it spills into system memory.`)}
        {trained && value > trained && <span className="text-warn"> Longer than it was trained for: answers may fall apart.</span>}
      </p>
    </div>
  )
}

const LEVELS: { value: RunnerReasoning; label: string; title?: string }[] = [
  { value: 'default', label: 'Default', title: "The model's own setting" },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]
const TOGGLE: { value: RunnerReasoning; label: string; title?: string }[] = [
  { value: 'default', label: 'Default', title: "The model's own setting" },
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' }
]

function Reasoning({ kind, value, locked, onChange }: { kind: NonNullable<ReasoningKind>; value: RunnerReasoning; locked: boolean; onChange(v: RunnerReasoning): void }) {
  const items = kind === 'levels' ? LEVELS : TOGGLE
  const current = items.some((i) => i.value === value) ? value : 'default'
  return (
    <Section title="Reasoning" aside={locked && <span className="text-[12px] text-dim">Stop it to change</span>}>
      <fieldset disabled={locked} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-3 disabled:opacity-60">
        <legend className="sr-only">Reasoning</legend>
        <Segmented value={current} onChange={onChange} items={items} />
        <span className="min-w-0 flex-1 text-[12px] text-dim">
          {kind === 'levels' ? 'How long it thinks before answering. Higher is slower and more careful.' : 'Whether it thinks before answering. Off is faster.'}
        </span>
      </fieldset>
    </Section>
  )
}

function Advanced({ runner, locked, save, onRemoved }: { runner: Runner; locked: boolean; save: Save; onRemoved(): void }) {
  const choose = async (field: 'serverPath' | 'modelPath' | 'mmprojPath', title: string, filters?: { name: string; extensions: string[] }[]) => {
    const [path] = (await attempt(() => api.app.pickPaths({ title, filters }))) ?? []
    if (path) await save({ [field]: path })
  }
  const sample = (field: keyof RunnerSampling) => (v: string) => {
    const next: RunnerSampling = { ...runner.sampling }
    if (v.trim() === '') delete next[field]
    else if (Number.isFinite(Number(v))) next[field] = Number(v)
    else return Promise.resolve(false)
    return save({ sampling: next })
  }
  const remove = async () => {
    if (!(await confirmAction('Its settings and log go too. Model files on disk stay.', { title: `Delete ${runner.name}?`, confirmLabel: 'Delete', danger: true }))) return
    if (await attempt(() => api.runs.remove(runner.id).then(() => true))) onRemoved()
  }
  const serverFilters = window.cloth.platform === 'win32' ? [{ name: 'llama-server', extensions: ['exe'] }] : undefined
  const gguf = [{ name: 'GGUF model', extensions: ['gguf'] }]
  const builtin = !!runner.builtin

  return (
    <details className="group rounded-[12px] border border-line bg-elev">
      <summary className="flex min-h-[38px] cursor-default list-none items-center gap-2 rounded-[12px] px-3.5 py-2 text-[12.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line [&::-webkit-details-marker]:hidden">
        <CaretRight size={12} className="text-dim transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
        <span className="flex-1">Advanced</span>
        <span className="text-[12px] font-normal text-dim">Files, port, sampling, flags</span>
      </summary>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 border-t border-line px-3.5 py-3 mobile:grid-cols-1">
        <Row label="Name">
          {builtin ? (
            <span className="text-[12.5px]" translate="no">
              {runner.name}
            </span>
          ) : (
            <CommitInput aria-label="Name" value={runner.name} disabled={locked} onCommit={(v) => (v.trim() ? save({ name: v }) : Promise.resolve(false))} />
          )}
        </Row>
        <Row label="llama-server">
          <PathRow value={runner.serverPath} locked={locked} onChoose={() => void choose('serverPath', 'Choose llama-server', serverFilters)} />
        </Row>
        <Row label="Model">
          <PathRow value={runner.modelPath} locked={locked} onChoose={() => void choose('modelPath', 'Choose a model', gguf)} />
        </Row>
        <Row label="Vision file">
          <PathRow value={runner.mmprojPath} locked={locked} onChoose={() => void choose('mmprojPath', 'Choose a vision file (mmproj)', gguf)} onClear={() => void save({ mmprojPath: null })} />
        </Row>
        <Row label="Port">
          <CommitInput aria-label="Port" type="number" inputMode="numeric" className="w-[96px]" value={String(runner.port)} disabled={locked} onCommit={(v) => (v.trim() === '' ? Promise.resolve(false) : save({ port: Number(v) }))} />
        </Row>
        <Row label="Alias">
          <CommitInput aria-label="Alias, the model name in chats" placeholder="Model name in chats" spellCheck={false} className="font-mono" value={runner.alias} disabled={locked} onCommit={(v) => save({ alias: v })} />
        </Row>
        <Row label="Sampling">
          <div className="flex flex-wrap gap-x-3 gap-y-2">
            {(
              [
                ['temp', 'temp'],
                ['topP', 'top-p'],
                ['topK', 'top-k'],
                ['minP', 'min-p']
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="flex items-center gap-1.5 text-[11.5px] text-dim">
                {label}
                <CommitInput type="number" step="any" className="w-[72px]" placeholder="default" value={runner.sampling[field] === undefined ? '' : String(runner.sampling[field])} disabled={locked} onCommit={sample(field)} />
              </label>
            ))}
          </div>
        </Row>
        <Row label="Extra flags">
          <CommitInput aria-label="Extra flags" spellCheck={false} className="font-mono" value={runner.extraArgs} disabled={locked} onCommit={(v) => save({ extraArgs: v })} />
        </Row>
        <Row label="In chats">
          <Switch checked={runner.useInChats} disabled={locked} onChange={(v) => void save({ useInChats: v })} label="Show as a model while running" />
        </Row>
      </div>
      {!builtin && (
        <div className="border-t border-line px-3.5 py-2.5">
          <Button size="sm" variant="ghost" className="!text-crimson-hi hover:!bg-crimson-soft" icon={<Trash size={13} />} disabled={locked} onClick={() => void remove()}>
            Delete model
          </Button>
        </div>
      )}
    </details>
  )
}
