import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { ArrowSquareOut, ArrowUp, CheckCircle, Cpu, GearSix } from '@phosphor-icons/react'
import type { EngineBackend, EngineBuild, EngineFlavour, EnginesState, Hardware } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Segmented, Spinner, Switch } from '@/components/ui'
import { InspectorHead } from '@/components/Inspector'
import { ProgressBar, active, fileSize, message, progressKey, type Progress } from './shared'

export const FLAVOUR: Record<EngineFlavour, { name: string; about: string }> = {
  prism: { name: 'PrismML', about: 'Also runs 1-bit models like Bonsai' },
  official: { name: 'Official', about: 'Newest model support' }
}

export const BACKEND: Record<EngineBackend, string> = {
  vulkan: 'Vulkan',
  rocm: 'ROCm',
  cuda: 'CUDA',
  cpu: 'CPU',
  metal: 'Metal'
}
const BACKEND_ABOUT: Record<EngineBackend, string> = {
  vulkan: 'Any recent GPU',
  rocm: 'AMD Radeon',
  cuda: 'NVIDIA',
  cpu: 'No GPU',
  metal: 'Apple silicon and Mac GPUs'
}

/** The builds this computer can run: Metal on a Mac, the Windows builds elsewhere. */
export const PLATFORM_BACKENDS: EngineBackend[] = window.cloth.platform === 'darwin' ? ['metal'] : ['vulkan', 'rocm', 'cuda', 'cpu']

const buildNumber = (tag: string) => Number(/b(\d+)/.exec(tag)?.[1] ?? 0)
/** A tag as shown: "your own build" for one found on disk rather than installed by Cloth. */
export const tagLabel = (tag: string) => (tag === 'local' ? 'your own build' : tag)
/** "prism-b10787-73bfe6c" → "b10787", for buttons. */
const shortTag = (tag: string) => tag.replace(/^prism-/, '').replace(/-[0-9a-f]{7}$/, '')
const DAY = 24 * 60 * 60 * 1000

/** The installed build of a kind, newest first. */
function installedOf(engines: EnginesState, flavour: EngineFlavour, backend: EngineBackend): EngineBuild | null {
  return engines.installed.filter((b) => b.flavour === flavour && b.backend === backend).sort((a, b) => buildNumber(b.tag) - buildNumber(a.tag))[0] ?? null
}

/** The build in use and a newer release of it, if there is one. */
export function engineStatus(engines: EnginesState | null) {
  const cur = engines?.current ?? null
  const build = engines && cur ? installedOf(engines, cur.flavour, cur.backend) : null
  const latest = cur ? engines?.latest?.[cur.flavour] : undefined
  // A build found in ~/llama-prism has no version to compare: the panel still offers installing one.
  const update = build && build.tag !== 'local' && latest && latest.sizes[build.backend] !== undefined && buildNumber(latest.tag) > buildNumber(build.tag) ? latest : null
  return { cur, build, update }
}

export const engineProgress = (progress: Record<string, Progress>, flavour: EngineFlavour) => active(progress[progressKey('engine', `engine-${flavour}`)])

/** Install or update a build, keeping the page's engine state current. */
export async function installEngine(flavour: EngineFlavour, backend: EngineBackend, onEngines: (e: EnginesState) => void) {
  try {
    onEngines(await api.runs.installEngine(flavour, backend))
    useApp.getState().toast(`${FLAVOUR[flavour].name} llama.cpp is ready`, 'ok')
  } catch (err) {
    if (!/cancel|abort/i.test(message(err))) useApp.getState().toast(message(err), 'error')
  }
}

/** The thin bar above the runners: which llama.cpp is in use, and an update when one is out. */
export function EngineStrip({ engines, progress, onManage, onEngines }: { engines: EnginesState; progress: Record<string, Progress>; onManage(): void; onEngines(e: EnginesState): void }) {
  const { cur, build, update } = engineStatus(engines)
  const downloading = cur ? engineProgress(progress, cur.flavour) : null
  return (
    <div className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-line bg-elev px-3.5 py-2">
      <Cpu size={16} className="shrink-0 text-dim" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-[12.5px]">
        {build && cur ? (
          <>
            <span className="font-semibold">llama.cpp</span>
            <span className="text-muted">
              {' '}
              {FLAVOUR[cur.flavour].name}
              {build.tag === 'local' ? ', your own build' : <> <span translate="no" title={build.tag}>{shortTag(build.tag)}</span></>}, {BACKEND[build.backend]}
            </span>
          </>
        ) : (
          <span className="text-muted">No llama.cpp chosen yet</span>
        )}
      </div>
      {downloading ? (
        <span className="flex items-center gap-1.5 text-[12px] tabular-nums text-dim">
          <Spinner size={12} />
          {downloading.state === 'extracting' ? 'Unpacking…' : `Updating, ${downloading.total ? Math.floor((downloading.received / downloading.total) * 100) : 0}%`}
        </span>
      ) : update && cur ? (
        <Button size="sm" variant="primary" icon={<ArrowUp size={13} />} onClick={() => void installEngine(cur.flavour, cur.backend, onEngines)}>
          Update to {shortTag(update.tag)}
        </Button>
      ) : (
        build && (
          <span className="flex items-center gap-1 text-[12px] text-dim">
            <CheckCircle size={13} className="text-ok" aria-hidden="true" />
            {engines.checkedAt ? 'Up to date' : 'Installed'}
          </span>
        )
      )}
      <Button size="sm" variant="ghost" icon={<GearSix size={13} />} onClick={onManage}>
        Manage
      </Button>
    </div>
  )
}

/** Look for new builds when the page opens, at most once a day, if allowed. */
export function useEngineAutoCheck(engines: EnginesState | null, onEngines: (e: EnginesState) => void) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!engines || done) return
    setDone(true)
    if (engines.autoCheck && (!engines.checkedAt || Date.now() - engines.checkedAt > DAY)) void api.runs.checkEngines().then(onEngines, () => undefined)
  }, [engines, done, onEngines])
}

/** Side panel: pick which llama.cpp and which build, install or update it, and switch between installed ones. */
export function EnginePanel({
  engines,
  hardware,
  progress,
  onEngines,
  onClose
}: {
  engines: EnginesState
  hardware: Hardware | null
  progress: Record<string, Progress>
  onEngines(e: EnginesState): void
  onClose(): void
}) {
  const [flavour, setFlavour] = useState<EngineFlavour>(engines.current?.flavour ?? 'prism')
  const [backend, setBackend] = useState<EngineBackend>(engines.current?.backend ?? hardware?.recommendedBackend ?? PLATFORM_BACKENDS[0])
  const [checking, setChecking] = useState(false)

  const check = async (loud: boolean) => {
    setChecking(true)
    const e = loud ? await attempt(() => api.runs.checkEngines()) : await api.runs.checkEngines().catch(() => undefined)
    if (e) onEngines(e)
    setChecking(false)
  }
  useEffect(() => {
    if (!engines.latest) void check(false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const latest = engines.latest?.[flavour]
  const offered = PLATFORM_BACKENDS.filter((b) => !latest || latest.sizes[b] !== undefined)
  // A release without this build (PrismML has no CUDA one): fall back to the first it has.
  useEffect(() => {
    if (latest && latest.sizes[backend] === undefined && offered.length) {
      const rec = hardware?.recommendedBackend ?? PLATFORM_BACKENDS[0]
      setBackend(offered.includes(rec) ? rec : offered[0])
    }
  }, [flavour, latest]) // eslint-disable-line react-hooks/exhaustive-deps

  const installed = installedOf(engines, flavour, backend)
  const inUse = engines.current?.flavour === flavour && engines.current.backend === backend
  const newer = latest && (!installed || buildNumber(latest.tag) > buildNumber(installed.tag))
  const downloading = engineProgress(progress, flavour)
  const size = latest?.sizes[backend]
  const gpu = hardware?.gpus[0]

  return (
    <>
      <InspectorHead title="llama.cpp" onClose={onClose} />
      <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-5 py-4">
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-[12.5px] font-semibold">Which llama.cpp</legend>
          {(['prism', 'official'] as const).map((f) => (
            <label
              key={f}
              className={clsx(
                'flex cursor-default items-start gap-3 rounded-[10px] border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-crimson-line',
                flavour === f ? 'border-crimson-line bg-elev-2' : 'border-line bg-elev hover:bg-elev-2'
              )}
            >
              <input type="radio" name="flavour" value={f} checked={flavour === f} onChange={() => setFlavour(f)} className="mt-0.5 accent-[var(--color-crimson)]" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[13px] font-semibold">
                  {FLAVOUR[f].name}
                  {engines.current?.flavour === f && <span className="text-[11px] font-medium text-ok">In use</span>}
                </span>
                <span className="mt-0.5 block text-[12px] text-dim">{FLAVOUR[f].about}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-2">
          <div className="text-[12.5px] font-semibold">Build for your hardware</div>
          <div className="overflow-x-auto">
            <Segmented
              value={backend}
              onChange={setBackend}
              items={offered.map((b) => ({ value: b, label: BACKEND[b], title: BACKEND_ABOUT[b] }))}
            />
          </div>
          <p className="text-[12px] text-dim">
            {hardware && (backend === hardware.recommendedBackend ? (gpu ? `Recommended for your ${gpu.name}.` : 'Recommended, since no GPU was found.') : `${BACKEND[hardware.recommendedBackend]} suits ${gpu ? `your ${gpu.name}` : 'this computer'} best.`)}
          </p>
        </div>

        <div className="grid gap-3 rounded-[12px] border border-line bg-elev px-3.5 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
            <span className="font-semibold">
              {FLAVOUR[flavour].name}, {BACKEND[backend]}
            </span>
            <span className="text-dim">
              {!installed ? (
                'not installed'
              ) : installed.tag === 'local' ? (
                'your own build is installed'
              ) : (
                <>
                  installed <span translate="no">{installed.tag}</span>
                </>
              )}
            </span>
          </div>
          {downloading ? (
            <ProgressBar p={downloading} onCancel={() => void attempt(() => api.runs.cancelDownload(`engine-${flavour}`))} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {newer && latest ? (
                <Button variant="primary" icon={installed && installed.tag !== 'local' ? <ArrowUp size={13} /> : undefined} onClick={() => void installEngine(flavour, backend, onEngines)}>
                  {installed && installed.tag !== 'local' ? 'Update to' : 'Install'} <span translate="no">{shortTag(latest.tag)}</span>
                </Button>
              ) : installed && !inUse ? (
                <Button variant="primary" onClick={() => void attempt(() => api.runs.useEngine(flavour, backend)).then((e) => e && onEngines(e))}>
                  Use this build
                </Button>
              ) : installed ? (
                <span className="flex items-center gap-1.5 text-[12px] text-ok">
                  <CheckCircle size={14} aria-hidden="true" /> In use and up to date
                </span>
              ) : (
                !latest && (
                  <Button variant="primary" loading={checking} onClick={() => void check(true)}>
                    Look for builds
                  </Button>
                )
              )}
              {newer && size !== undefined && <span className="text-[12px] tabular-nums text-dim">{fileSize(size)} download</span>}
              {installed && !inUse && newer && (
                <Button variant="ghost" onClick={() => void attempt(() => api.runs.useEngine(flavour, backend)).then((e) => e && onEngines(e))}>
                  Use installed
                </Button>
              )}
            </div>
          )}
          {latest && (
            <button type="button" onClick={() => void api.app.openExternal(latest.url)} className="flex w-fit items-center gap-1 rounded text-[12px] text-muted underline decoration-line-strong underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line">
              Release notes for <span translate="no">{latest.tag}</span>
              <ArrowSquareOut size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        {engines.installed.length > 0 && (
          <div className="grid gap-2">
            <div className="text-[12.5px] font-semibold">Installed builds</div>
            <ul className="grid divide-y divide-line rounded-[12px] border border-line bg-elev">
              {engines.installed.map((b) => {
                const current = engines.current?.flavour === b.flavour && engines.current.backend === b.backend && installedOf(engines, b.flavour, b.backend)?.path === b.path
                return (
                  <li key={b.path} className="flex items-center gap-2 px-3.5 py-2 text-[12.5px]" title={b.path}>
                    <span className="min-w-0 flex-1 truncate">
                      {FLAVOUR[b.flavour].name} <span className="text-muted" translate="no">{tagLabel(b.tag)}</span>
                      <span className="text-dim">, {BACKEND[b.backend]}</span>
                    </span>
                    {current ? (
                      <span className="text-[11.5px] font-medium text-ok">In use</span>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.runs.useEngine(b.flavour, b.backend)).then((e) => e && onEngines(e))}>
                        Use
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          <Switch checked={engines.autoCheck} onChange={(v) => void attempt(() => api.runs.setEngineAutoCheck(v)).then((e) => e && onEngines(e))} label="Check for updates once a day" />
          <Button size="sm" variant="ghost" loading={checking} onClick={() => void check(true)}>
            Check now
          </Button>
        </div>
        {engines.checkedAt && <p className="-mt-3 text-[11.5px] text-dim">Last checked {new Date(engines.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>}
      </div>
    </>
  )
}
