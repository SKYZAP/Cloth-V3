import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { FolderOpen, Plus } from '@phosphor-icons/react'
import type { EnginesState, Hardware, Runner, RunnerStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button } from '@/components/ui'
import { Inspector, InspectorHead, refocus } from '@/components/Inspector'
import { AddModelModal, hardwareLine } from './run/AddModel'
import { BACKEND, EnginePanel, EngineStrip, FLAVOUR, engineProgress, installEngine, useEngineAutoCheck } from './run/Engine'
import { RunnerView } from './run/RunnerView'
import { ProgressBar, active, live, progressKey, stopped, useNarrow, type Progress } from './run/shared'

const FIRST_PORT = 8091

/** Local models served by llama.cpp's llama-server: one runner per model, usable in chats while it runs. */
export function RunPage() {
  const [runners, setRunners] = useState<Runner[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, RunnerStatus>>({})
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [engines, setEngines] = useState<EnginesState | null>(null)
  const [hardware, setHardware] = useState<Hardware | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [enginePanel, setEnginePanel] = useState(false)
  const [adding, setAdding] = useState(false)
  const narrow = useNarrow()
  const loadProviders = useApp((s) => s.loadProviders)

  const load = async () => {
    const [list, st, eng] = await Promise.all([api.runs.list(), api.runs.status(), api.runs.engines()])
    setRunners(list)
    setStatuses(Object.fromEntries(st.map((s) => [s.id, s])))
    setEngines(eng)
    setSelectedId((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)))
  }
  useEffect(() => {
    void attempt(load)
    void api.runs.hardware().then(setHardware, () => undefined)
  }, [])
  const onEngines = useCallback((e: EnginesState) => setEngines(e), [])
  useEngineAutoCheck(engines, onEngines)

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
        if (e.state === 'done' || e.state === 'cancelled') delete next[progressKey(e.kind, e.id)]
        else next[progressKey(e.kind, e.id)] = e
        return next
      })
      if (e.state === 'done') {
        // A finished download sets runners' paths; a new llama.cpp also sees the GPUs better.
        void api.runs.list().then(setRunners, () => undefined)
        if (e.kind === 'engine') {
          void api.runs.engines().then(setEngines, () => undefined)
          void api.runs.hardware(true).then(setHardware, () => undefined)
        }
      }
    }
  })

  const replace = (r: Runner) => setRunners((list) => list?.map((x) => (x.id === r.id ? r : x)) ?? list)
  const select = (id: string) => {
    setSelectedId(id)
    if (narrow) setInspecting(true)
  }
  const close = () => {
    setInspecting(false)
    refocus(selectedId)
  }

  const addFromDisk = async () => {
    const [path] = (await attempt(() => api.app.pickPaths({ title: 'Choose a model', filters: [{ name: 'GGUF model', extensions: ['gguf'] }] }))) ?? []
    if (!path) return
    const taken = new Set((runners ?? []).map((r) => r.port))
    let port = FIRST_PORT
    while (taken.has(port)) port++
    const name = (path.split(/[\\/]/).pop() ?? 'Model').replace(/\.gguf$/i, '').replace(/[-_]+/g, ' ')
    const serverPath = engines?.installed.find((b) => b.flavour === engines.current?.flavour && b.backend === engines.current.backend)?.path ?? null
    const r = await attempt(() => api.runs.create({ name, modelPath: path, serverPath, port, gpuLayers: 99, contextSize: 8192, flashAttention: true, useInChats: true }))
    if (!r) return
    setRunners((list) => [...(list ?? []), r])
    select(r.id)
  }

  const added = (r: Runner) => {
    setAdding(false)
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
    <RunnerView
      key={selected.id}
      runner={selected}
      status={statuses[selected.id] ?? stopped(selected.id)}
      progress={progress}
      hardware={hardware}
      engines={engines}
      onChange={replace}
      onRemoved={() => removed(selected.id)}
      onManageEngine={() => setEnginePanel(true)}
    />
  )
  const firstRun = engines && !engines.installed.length

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-5 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <h1 className="text-[18px] font-semibold tracking-tight">Run</h1>
              <p className="mt-0.5 text-[12.5px] text-dim">Models running on this PC with llama.cpp, usable in chats while they run</p>
            </div>
            <Button icon={<FolderOpen size={13} />} onClick={() => void addFromDisk()}>
              From disk
            </Button>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
              Add model
            </Button>
          </div>

          {firstRun ? (
            <FirstRun hardware={hardware} progress={progress} onEngines={onEngines} onMore={() => setEnginePanel(true)} onAdd={() => setAdding(true)} onDisk={() => void addFromDisk()} />
          ) : (
            engines && <EngineStrip engines={engines} progress={progress} onManage={() => setEnginePanel(true)} onEngines={onEngines} />
          )}

          {runners && (
            <div className={narrow ? 'grid gap-1' : 'grid grid-cols-[232px_minmax(0,1fr)] items-start gap-5'}>
              <nav aria-label="Models" className="grid content-start gap-0.5">
                {runners.map((r) => (
                  <RunnerRow key={r.id} runner={r} status={statuses[r.id] ?? stopped(r.id)} download={active(progress[progressKey('model', r.id)])} selected={!narrow && r.id === selectedId} onClick={() => select(r.id)} />
                ))}
              </nav>
              {!narrow && <div className="grid min-w-0 gap-4">{detail}</div>}
            </div>
          )}
        </div>
      </div>

      <Inspector open={narrow && inspecting && !!selected && !enginePanel} label={selected?.name ?? 'Model'} onClose={close} width={640}>
        <InspectorHead title={selected?.name ?? ''} onClose={close} />
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 py-4">{detail}</div>
      </Inspector>

      <Inspector open={enginePanel && !!engines} label="llama.cpp" onClose={() => setEnginePanel(false)} width={460}>
        {engines && <EnginePanel engines={engines} hardware={hardware} progress={progress} onEngines={onEngines} onClose={() => setEnginePanel(false)} />}
      </Inspector>

      <AddModelModal open={adding} hardware={hardware} onClose={() => setAdding(false)} onAdded={added} />
    </div>
  )
}

const DOT: Record<RunnerStatus['state'], string> = {
  running: 'bg-ok',
  starting: 'bg-warn animate-pulse motion-reduce:animate-none',
  error: 'bg-crimson',
  stopped: 'bg-line-strong'
}

function RunnerRow({ runner, status, download, selected, onClick }: { runner: Runner; status: RunnerStatus; download: Progress | null; selected: boolean; onClick(): void }) {
  const sub = download
    ? `Downloading, ${download.total ? Math.floor((download.received / download.total) * 100) : 0}%`
    : live(status)
      ? `Running on :${runner.port}`
      : status.state === 'error'
        ? 'Stopped with an error'
        : !runner.modelPath
          ? 'No model file'
          : (runner.source?.quant ?? (runner.builtin ? 'Built in' : 'From disk'))
  return (
    <button
      data-focus-key={runner.id}
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={clsx('flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line', selected ? 'bg-elev-2' : 'hover:bg-elev')}
    >
      <span className={clsx('h-[7px] w-[7px] shrink-0 rounded-full', download ? 'bg-info' : DOT[status.state])} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold" translate="no">
          {runner.name}
        </span>
        <span className="block truncate text-[11.5px] tabular-nums text-dim">{sub}</span>
      </span>
    </button>
  )
}

/** No llama.cpp yet: install one, then add a model. */
function FirstRun({
  hardware,
  progress,
  onEngines,
  onMore,
  onAdd,
  onDisk
}: {
  hardware: Hardware | null
  progress: Record<string, Progress>
  onEngines(e: EnginesState): void
  onMore(): void
  onAdd(): void
  onDisk(): void
}) {
  const backend = hardware?.recommendedBackend ?? 'vulkan'
  const downloading = engineProgress(progress, 'prism') ?? engineProgress(progress, 'official')
  return (
    <section aria-label="Get started" className="grid gap-4 rounded-[12px] border border-line bg-elev px-5 py-4">
      <div>
        <h2 className="text-[14px] font-semibold">Run models on this PC</h2>
        <p className="mt-0.5 text-[12.5px] text-dim">{hardware ? `${hardwareLine(hardware)}.` : 'Checking your hardware…'}</p>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2">
        <li className="grid content-start gap-2 rounded-[10px] border border-line bg-panel px-4 py-3">
          <div className="flex items-baseline gap-2 text-[13px] font-semibold">
            <span className="tabular-nums text-crimson-hi">1</span> Install llama.cpp
          </div>
          <p className="text-[12px] text-dim">
            {FLAVOUR.prism.name}'s build, {BACKEND[backend]} for {hardware?.gpus[0] ? `your ${hardware.gpus[0].name}` : 'this PC'}. It also runs the built-in Bonsai model.
          </p>
          {downloading ? (
            <ProgressBar p={downloading} onCancel={() => void attempt(() => api.runs.cancelDownload(downloading.id))} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => void installEngine('prism', backend, onEngines)}>
                Install llama.cpp
              </Button>
              <Button variant="ghost" onClick={onMore}>
                Other builds
              </Button>
            </div>
          )}
        </li>
        <li className="grid content-start gap-2 rounded-[10px] border border-line bg-panel px-4 py-3">
          <div className="flex items-baseline gap-2 text-[13px] font-semibold">
            <span className="tabular-nums text-crimson-hi">2</span> Add a model
          </div>
          <p className="text-[12px] text-dim">Search Hugging Face; each size is checked against your GPU and memory.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button icon={<Plus size={13} />} onClick={onAdd}>
              Add model
            </Button>
            <Button variant="ghost" onClick={onDisk}>
              Choose it from disk
            </Button>
          </div>
        </li>
      </ol>
    </section>
  )
}

