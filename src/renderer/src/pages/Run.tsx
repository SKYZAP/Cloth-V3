import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ChatCircleDots, Check, Copy, Play, Plus, Stop, Trash } from '@phosphor-icons/react'
import type { ModelDownloadInfo, RunDevice, RunEvent, Runner, RunnerPatch, RunnerSampling, RunnerStatus, RuntimeBackend, RuntimeOptions } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { Button, IconButton, Input, Segmented, Select, Spinner, Switch, confirmAction } from '@/components/ui'
import { Inspector, InspectorHead, refocus } from '@/components/Inspector'

type Progress = Extract<RunEvent, { type: 'progress' }>
type Kind = Progress['kind']

const FIRST_PORT = 8091
const BACKENDS: { value: RuntimeBackend; label: string }[] = [
  { value: 'hip-radeon', label: 'HIP for AMD Radeon' },
  { value: 'vulkan', label: 'Vulkan' },
  { value: 'cuda-12.4', label: 'CUDA 12.4' },
  { value: 'cpu', label: 'CPU' }
]

const narrowQuery = window.matchMedia('(max-width: 760px)')
const subscribeNarrow = (cb: () => void) => {
  narrowQuery.addEventListener('change', cb)
  return () => narrowQuery.removeEventListener('change', cb)
}
/** Too narrow for the list beside the detail: the detail opens in an inspector instead. */
function useNarrow(): boolean {
  const narrow = useSyncExternalStore(subscribeNarrow, () => narrowQuery.matches)
  return isMobile || narrow
}

const stopped = (id: string): RunnerStatus => ({ id, state: 'stopped' })
const live = (s: RunnerStatus) => s.state === 'running' || s.state === 'starting'
const key = (kind: Kind, id: string) => `${kind}:${id}`

function fileSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
}

/** "github.com/PrismML-Eng" from a release page address. */
function origin(url: string): string {
  try {
    const u = new URL(url)
    const first = u.pathname.split('/').filter(Boolean)[0]
    return first ? `${u.host}/${first}` : u.host
  } catch {
    return url
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Local models served by llama.cpp's llama-server: one runner per model, usable in chats while it runs. */
export function RunPage() {
  const [runners, setRunners] = useState<Runner[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, RunnerStatus>>({})
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const narrow = useNarrow()
  const loadProviders = useApp((s) => s.loadProviders)

  const load = async () => {
    const [list, st] = await Promise.all([api.runs.list(), api.runs.status()])
    setRunners(list)
    setStatuses(Object.fromEntries(st.map((s) => [s.id, s])))
    setSelectedId((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)))
  }
  useEffect(() => {
    void attempt(load)
  }, [])

  useEvent('runs', (e) => {
    if (e.type === 'status') {
      setStatuses((prev) => {
        const was = prev[e.status.id]?.state
        // The chat model picker reads the provider list: refresh it when a runner comes or goes.
        if ((was === 'running') !== (e.status.state === 'running')) void loadProviders().catch(() => undefined)
        return { ...prev, [e.status.id]: e.status }
      })
    } else if (e.type === 'progress') {
      setProgress((prev) => {
        const next = { ...prev }
        if (e.state === 'done' || e.state === 'cancelled') delete next[key(e.kind, e.id)]
        else next[key(e.kind, e.id)] = e
        return next
      })
      // A download that finished sets the runner's paths.
      if (e.state === 'done') void api.runs.list().then(setRunners, () => undefined)
    }
  })

  const replace = (r: Runner) => setRunners((list) => list?.map((x) => (x.id === r.id ? r : x)) ?? list)
  const clearProgress = (kind: Kind, id: string) =>
    setProgress((prev) => {
      const next = { ...prev }
      delete next[key(kind, id)]
      return next
    })

  const select = (id: string) => {
    setSelectedId(id)
    if (narrow) setInspecting(true)
  }
  const close = () => {
    setInspecting(false)
    refocus(selectedId)
  }

  const addRunner = async () => {
    const taken = new Set((runners ?? []).map((r) => r.port))
    let port = FIRST_PORT
    while (taken.has(port)) port++
    const r = await attempt(() => api.runs.create({ name: 'New runner', port, gpuLayers: 99, contextSize: 8192, flashAttention: true, useInChats: true }))
    if (!r) return
    setRunners((list) => [...(list ?? []), r])
    select(r.id)
  }

  const removed = (id: string) => {
    const next = runners?.filter((r) => r.id !== id) ?? null
    setRunners(next)
    setSelectedId(next?.[0]?.id ?? null)
    setInspecting(false)
  }

  const selected = runners?.find((r) => r.id === selectedId) ?? null
  const detail = selected && (
    <RunnerDetail
      key={selected.id}
      runner={selected}
      status={statuses[selected.id] ?? stopped(selected.id)}
      progress={progress}
      onChange={replace}
      onClearProgress={clearProgress}
      onRemoved={() => removed(selected.id)}
    />
  )

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-6 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <h1 className="text-[18px] font-semibold tracking-tight">Run</h1>
              <p className="mt-0.5 text-[12.5px] text-dim">Local models on llama.cpp, usable in chats while running</p>
            </div>
            <Button icon={<Plus size={13} />} onClick={() => void addRunner()}>
              New runner
            </Button>
          </div>

          {runners && (
            <div className={narrow ? 'grid gap-1' : 'grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4'}>
              <nav aria-label="Runners" className="grid content-start gap-0.5">
                {runners.map((r) => (
                  <RunnerRow key={r.id} runner={r} status={statuses[r.id] ?? stopped(r.id)} selected={!narrow && r.id === selectedId} onClick={() => select(r.id)} />
                ))}
              </nav>
              {!narrow && <div className="grid min-w-0 gap-4">{detail}</div>}
            </div>
          )}
        </div>
      </div>

      <Inspector open={narrow && inspecting && !!selected} label={selected?.name ?? 'Runner'} onClose={close} width={640}>
        <InspectorHead title={selected?.name ?? ''} onClose={close} />
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-4">{detail}</div>
      </Inspector>
    </div>
  )
}

const DOT: Record<RunnerStatus['state'], string> = {
  running: 'bg-ok',
  starting: 'bg-warn animate-pulse',
  error: 'bg-crimson',
  stopped: 'bg-line-strong'
}

function RunnerRow({ runner, status, selected, onClick }: { runner: Runner; status: RunnerStatus; selected: boolean; onClick(): void }) {
  return (
    <button
      data-focus-key={runner.id}
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={clsx('flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line', selected ? 'bg-elev-2' : 'hover:bg-elev')}
    >
      <span className={clsx('h-[7px] w-[7px] shrink-0 rounded-full', DOT[status.state])} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold" translate="no">
          {runner.name}
        </span>
        <span className="block truncate text-[11.5px] text-dim">
          {runner.builtin ? 'built in' : 'custom'} · {live(status) ? `:${runner.port}` : 'stopped'}
        </span>
      </span>
    </button>
  )
}

function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-[12px] border border-line bg-elev', className)}>
      {title && (
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
          <h2 className="min-w-0 flex-1 text-[12.5px] font-semibold">{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

function RunnerDetail({
  runner,
  status,
  progress,
  onChange,
  onClearProgress,
  onRemoved
}: {
  runner: Runner
  status: RunnerStatus
  progress: Record<string, Progress>
  onChange(r: Runner): void
  onClearProgress(kind: Kind, id: string): void
  onRemoved(): void
}) {
  return (
    <>
      <StatusCard runner={runner} status={status} />
      <SettingsCard runner={runner} locked={live(status)} progress={progress} onChange={onChange} onClearProgress={onClearProgress} onRemoved={onRemoved} />
      <LogCard id={runner.id} />
    </>
  )
}

function StatusCard({ runner, status }: { runner: Runner; status: RunnerStatus }) {
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

  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-[200px] flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="text-[14px] font-semibold" translate="no">
              {runner.name}
            </span>
            {status.state === 'running' && <span className="text-[12.5px] text-ok">running</span>}
            {status.state === 'starting' && (
              <span className="flex items-center gap-1.5 text-[12.5px] text-warn">
                <Spinner size={12} className="text-warn" />
                starting
              </span>
            )}
            {status.state === 'error' && <span className="text-[12.5px] text-crimson-hi">error</span>}
            {status.state === 'stopped' && <span className="text-[12.5px] text-dim">stopped</span>}
          </div>
          {running && (
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 text-[12px] text-dim">
              {status.url && (
                <span className="selectable font-mono text-[11.5px]" translate="no">
                  {status.url}
                </span>
              )}
              {status.lastTokensPerSecond !== undefined && <span className="tabular-nums">{status.lastTokensPerSecond.toFixed(1)} tok/s last reply</span>}
            </div>
          )}
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
          <Button variant="primary" icon={<Play size={13} />} loading={busy} onClick={() => void toggle()}>
            Start
          </Button>
        )}
      </div>
      {status.state === 'error' && status.error && <p className="selectable mt-2 whitespace-pre-wrap break-words text-[12px] text-crimson-hi">{status.error}</p>}
    </Card>
  )
}

function Row({ label, children, top }: { label: ReactNode; children: ReactNode; top?: boolean }) {
  return (
    <>
      <span className={clsx('text-[12px] text-muted', top && 'self-start pt-1.5')}>{label}</span>
      <div className="min-w-0">{children}</div>
    </>
  )
}

/** A text box that saves when it loses focus (or on Enter); a refused value goes back to the saved one. */
function CommitInput({ value, onCommit, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onCommit(v: string): Promise<boolean> }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === value) return
        void onCommit(draft).then((ok) => !ok && setDraft(value))
      }}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={clsx('disabled:opacity-60', rest.className)}
    />
  )
}

function PathRow({ value, locked, onChoose, onClear, extra }: { value: string | null; locked: boolean; onChoose(): void; onClear?(): void; extra?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className={clsx('min-w-0 flex-1 truncate font-mono text-[11.5px]', value ? 'text-muted' : 'text-dim')} title={value ?? undefined} translate="no">
        {value ?? 'Not set'}
      </span>
      {extra}
      <Button size="sm" disabled={locked} onClick={onChoose}>
        Choose…
      </Button>
      {onClear && value && (
        <Button size="sm" variant="ghost" disabled={locked} onClick={onClear}>
          Clear
        </Button>
      )}
    </div>
  )
}

function SettingsCard({
  runner,
  locked,
  progress,
  onChange,
  onClearProgress,
  onRemoved
}: {
  runner: Runner
  locked: boolean
  progress: Record<string, Progress>
  onChange(r: Runner): void
  onClearProgress(kind: Kind, id: string): void
  onRemoved(): void
}) {
  const save = async (patch: RunnerPatch): Promise<boolean> => {
    const r = await attempt(() => api.runs.update(runner.id, patch))
    if (r) onChange(r)
    return !!r
  }
  const choose = async (field: 'serverPath' | 'modelPath' | 'mmprojPath', title: string, filters?: { name: string; extensions: string[] }[]) => {
    const [path] = (await attempt(() => api.app.pickPaths({ title, filters }))) ?? []
    if (path) await save({ [field]: path })
  }
  const int = (field: 'gpuLayers' | 'contextSize' | 'port') => (v: string) => (v.trim() === '' ? Promise.resolve(false) : save({ [field]: Number(v) }))
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
    <Card title="Settings" actions={locked && <span className="text-[12px] text-dim">Stop it to change settings.</span>}>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 px-3.5 py-3">
        <Row label="Name">
          {builtin ? (
            <span className="text-[12.5px]" translate="no">
              {runner.name}
            </span>
          ) : (
            <CommitInput aria-label="Name" value={runner.name} disabled={locked} onCommit={(v) => (v.trim() ? save({ name: v }) : Promise.resolve(false))} />
          )}
        </Row>

        <Row label="llama.cpp" top={builtin && !runner.serverPath}>
          <div className="grid gap-2">
            <PathRow
              value={runner.serverPath}
              locked={locked}
              onChoose={() => void choose('serverPath', 'Choose llama-server', serverFilters)}
              extra={builtin && runner.serverPath && <span className="shrink-0 text-[12px] text-ok">Installed</span>}
            />
            {builtin && !runner.serverPath && <RuntimeDownload runner={runner} progress={progress[key('runtime', runner.id)]} locked={locked} onChange={onChange} onClearProgress={onClearProgress} />}
          </div>
        </Row>

        <Row label="Model" top={builtin && !runner.modelPath}>
          <div className="grid gap-2">
            <PathRow value={runner.modelPath} locked={locked} onChoose={() => void choose('modelPath', 'Choose a model', gguf)} />
            {builtin && !runner.modelPath && <ModelDownload runner={runner} progress={progress[key('model', runner.id)]} locked={locked} onChange={onChange} onClearProgress={onClearProgress} />}
          </div>
        </Row>

        <Row label="Vision file">
          <PathRow value={runner.mmprojPath} locked={locked} onChoose={() => void choose('mmprojPath', 'Choose a vision file (mmproj)', gguf)} onClear={() => void save({ mmprojPath: null })} />
        </Row>

        <Row label="GPU">
          <Devices runner={runner} locked={locked} onSelect={(device) => void save({ device })} />
        </Row>

        <Row label="GPU layers">
          <CommitInput aria-label="GPU layers" type="number" className="w-[100px]" value={String(runner.gpuLayers)} disabled={locked} onCommit={int('gpuLayers')} />
        </Row>

        <Row label="Flash attention">
          <Switch checked={runner.flashAttention} disabled={locked} onChange={(v) => void save({ flashAttention: v })} />
        </Row>

        <Row label="Context size">
          <CommitInput aria-label="Context size" type="number" className="w-[100px]" value={String(runner.contextSize)} disabled={locked} onCommit={int('contextSize')} />
        </Row>

        <Row label="Port">
          <CommitInput aria-label="Port" type="number" className="w-[100px]" value={String(runner.port)} disabled={locked} onCommit={int('port')} />
        </Row>

        <Row label="Alias">
          <CommitInput aria-label="Alias, the model name in chats" placeholder="Model name in chats" className="font-mono" value={runner.alias} disabled={locked} onCommit={(v) => save({ alias: v })} />
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
          <CommitInput aria-label="Extra flags" className="font-mono" value={runner.extraArgs} disabled={locked} onCommit={(v) => save({ extraArgs: v })} />
        </Row>

        <Row label="In chats">
          <Switch checked={runner.useInChats} disabled={locked} onChange={(v) => void save({ useInChats: v })} label="Show as a model while running" />
        </Row>
      </div>
      {!builtin && (
        <div className="border-t border-line px-3.5 py-2.5">
          <Button size="sm" variant="ghost" className="!text-crimson-hi hover:!bg-crimson-soft" icon={<Trash size={13} />} disabled={locked} onClick={() => void remove()}>
            Delete runner
          </Button>
        </div>
      )}
    </Card>
  )
}

function Devices({ runner, locked, onSelect }: { runner: Runner; locked: boolean; onSelect(device: string | null): void }) {
  const [devices, setDevices] = useState<RunDevice[] | null>(null)
  const [loading, setLoading] = useState(false)
  const load = async (loud: boolean) => {
    setLoading(true)
    const list = loud ? await attempt(() => api.runs.devices(runner.id)) : await api.runs.devices(runner.id).catch(() => undefined)
    if (list) setDevices(list)
    setLoading(false)
    // With several GPUs llama.cpp splits the model across all of them, integrated graphics included, which
    // is much slower: until one is chosen, take the one with the most memory.
    if (list && list.length > 1 && runner.device === null && !locked) onSelect([...list].sort((a, b) => b.totalMiB - a.totalMiB)[0].id)
  }
  useEffect(() => {
    if (runner.serverPath) void load(false)
  }, [runner.id, runner.serverPath]) // eslint-disable-line react-hooks/exhaustive-deps

  const known = devices?.some((d) => d.id === runner.device)
  return (
    <div className="flex items-center gap-2">
      <Select aria-label="GPU" value={runner.device ?? ''} disabled={locked} className="disabled:opacity-60" onChange={(e) => onSelect(e.target.value || null)}>
        <option value="">Default (llama.cpp decides)</option>
        {runner.device && !known && <option value={runner.device}>{runner.device}</option>}
        {devices?.map((d) => (
          <option key={d.id} value={d.id}>
            {d.id} · {d.description} ({Math.round(d.totalMiB / 1024)} GB)
          </option>
        ))}
      </Select>
      <IconButton aria-label="Refresh devices" title="Refresh devices" disabled={!runner.serverPath || loading} onClick={() => void load(true)}>
        {loading ? <Spinner size={13} /> : <ArrowClockwise size={14} />}
      </IconButton>
    </div>
  )
}

function ProgressBar({ p, onCancel }: { p: Progress; onCancel(): void }) {
  const pct = p.total > 0 ? Math.min(100, (p.received / p.total) * 100) : 0
  const text =
    p.state === 'extracting'
      ? `Unpacking${p.file ? ` ${p.file}` : ''}…`
      : `${p.file ? `${p.file} · ` : ''}${fileSize(p.received)}${p.total > 0 ? ` of ${fileSize(p.total)}` : ''}`
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <div className={clsx('h-full rounded-full bg-crimson transition-[width]', p.state === 'extracting' && 'animate-pulse')} style={{ width: `${p.state === 'extracting' ? 100 : pct}%` }} />
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <span className="truncate text-[11.5px] tabular-nums text-dim" translate="no">
        {text}
      </span>
    </div>
  )
}

/** Download flow shared by llama.cpp and the model: start, follow progress events, cancel. */
function useDownload(kind: Kind, runner: Runner, progress: Progress | undefined, onChange: (r: Runner) => void, onClearProgress: (kind: Kind, id: string) => void) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<Runner>) => {
    onClearProgress(kind, runner.id)
    setBusy(true)
    try {
      onChange(await fn())
    } catch (err) {
      if (!/cancel/i.test(message(err))) useApp.getState().toast(message(err), 'error')
    } finally {
      setBusy(false)
      onClearProgress(kind, runner.id)
    }
  }
  const active = progress && (progress.state === 'downloading' || progress.state === 'extracting') ? progress : null
  const cancel = () => void attempt(() => api.runs.cancelDownload(runner.id))
  return { busy: busy || !!active, active, run, cancel, failed: progress?.state === 'error' ? (progress.error ?? 'The download failed') : null }
}

function RuntimeDownload({ runner, progress, locked, onChange, onClearProgress }: { runner: Runner; progress?: Progress; locked: boolean; onChange(r: Runner): void; onClearProgress(kind: Kind, id: string): void }) {
  const [options, setOptions] = useState<RuntimeOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [backend, setBackend] = useState<RuntimeBackend>('hip-radeon')
  const dl = useDownload('runtime', runner, progress, onChange, onClearProgress)

  const load = () => {
    setError(null)
    api.runs.runtimeOptions().then(
      (o) => {
        setOptions(o)
        if (o.assets.length && !o.assets.some((a) => a.backend === 'hip-radeon')) setBackend(o.assets[0].backend)
      },
      (err) => setError(message(err))
    )
  }
  useEffect(load, [])

  const items = options ? BACKENDS.filter((b) => options.assets.some((a) => a.backend === b.value)) : BACKENDS
  const asset = options?.assets.find((a) => a.backend === backend)
  return (
    <div className="grid gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
      <p className="text-[12px] text-muted">PrismML's llama.cpp isn't on this PC.</p>
      <div className="overflow-x-auto">
        <Segmented value={backend} onChange={setBackend} items={items} />
      </div>
      {dl.active ? (
        <ProgressBar p={dl.active} onCancel={dl.cancel} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Button size="sm" variant="primary" disabled={locked || !asset} loading={dl.busy} onClick={() => void dl.run(() => api.runs.downloadRuntime(runner.id, backend))}>
            Download
          </Button>
          {asset && options && (
            <span className="min-w-0 break-all text-[11.5px] text-dim" translate="no">
              {asset.name}, {fileSize(asset.size)} from {origin(options.source)}
            </span>
          )}
          {!options && !error && (
            <span className="flex items-center gap-1.5 text-[11.5px] text-dim">
              <Spinner size={12} /> Checking the latest build…
            </span>
          )}
          {error && (
            <span className="flex items-center gap-2 text-[11.5px] text-crimson-hi">
              {error}
              <Button size="sm" variant="ghost" onClick={load}>
                Try again
              </Button>
            </span>
          )}
        </div>
      )}
      {dl.failed && <p className="text-[11.5px] text-crimson-hi">{dl.failed}</p>}
    </div>
  )
}

function ModelDownload({ runner, progress, locked, onChange, onClearProgress }: { runner: Runner; progress?: Progress; locked: boolean; onChange(r: Runner): void; onClearProgress(kind: Kind, id: string): void }) {
  const [info, setInfo] = useState<ModelDownloadInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dl = useDownload('model', runner, progress, onChange, onClearProgress)

  const load = () => {
    setError(null)
    api.runs.modelDownloadInfo().then(setInfo, (err) => setError(message(err)))
  }
  useEffect(load, [])

  const main = info?.files.find((f) => !f.optional)
  const vision = info?.files.find((f) => f.optional)
  return (
    <div className="grid gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
      {dl.active ? (
        <ProgressBar p={dl.active} onCancel={dl.cancel} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Button size="sm" variant="primary" disabled={locked || !main} loading={dl.busy} onClick={() => void dl.run(() => api.runs.downloadModel(runner.id))}>
            Download
          </Button>
          {main && info && (
            <span className="min-w-0 break-all text-[11.5px] text-dim" translate="no">
              {main.name}, {fileSize(main.size)} from {origin(info.source)}
              {vision ? `, plus a ${fileSize(vision.size)} vision file` : ''}
            </span>
          )}
          {!info && !error && (
            <span className="flex items-center gap-1.5 text-[11.5px] text-dim">
              <Spinner size={12} /> Checking Hugging Face…
            </span>
          )}
          {error && (
            <span className="flex items-center gap-2 text-[11.5px] text-crimson-hi">
              {error}
              <Button size="sm" variant="ghost" onClick={load}>
                Try again
              </Button>
            </span>
          )}
        </div>
      )}
      {dl.failed && <p className="text-[11.5px] text-crimson-hi">{dl.failed}</p>}
    </div>
  )
}

const MAX_LINES = 2000

function LogCard({ id }: { id: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    let current = true
    setLines([])
    stick.current = true
    api.runs.logs(id).then(
      (l) => current && setLines(l.slice(-MAX_LINES)),
      () => undefined
    )
    return () => {
      current = false
    }
  }, [id])
  useEvent('runs', (e) => {
    if (e.type === 'log' && e.id === id) setLines((l) => l.concat(e.lines).slice(-MAX_LINES))
  })
  useLayoutEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines])

  const copy = () => {
    void navigator.clipboard.writeText(lines.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <Card
      title="Log"
      actions={
        <Button size="sm" variant="ghost" icon={copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />} disabled={!lines.length} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      }
    >
      <div
        ref={box}
        role="log"
        aria-label="llama-server output"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="selectable max-h-[320px] overflow-y-auto px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted"
        translate="no"
      >
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line || ' '}
          </div>
        ))}
        {!lines.length && <p className="font-sans text-[12px] text-dim">Nothing yet. llama-server's output shows here when it runs.</p>}
      </div>
    </Card>
  )
}
