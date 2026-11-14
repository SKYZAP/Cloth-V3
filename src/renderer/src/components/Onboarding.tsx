import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowSquareOut, CaretDown, Check, CheckCircle, Circle, FolderSimple, Info, Warning, X, XCircle } from '@phosphor-icons/react'
import type { Dependency, DependencyReport } from '@shared/deps'
import type { Provider, ProviderPreset } from '@shared/types'
import {
  LANGUAGES,
  ONBOARDING_STEPS,
  type BestPracticeCadence,
  type FolderScan,
  type ImportSelection,
  type ImportSource,
  type LanguageId,
  type LanguageServerInfo,
  type OnboardingState,
  type OnboardingStep
} from '@shared/onboarding'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button, Input, Select, Spinner, Switch, confirmAction } from './ui'
import { Logo } from './Logo'
import { armSpecShip } from '@/pages/Chat'

/*
 * First-run setup: a modal over the app that walks through a model, the main folder, languages, a tools
 * check, importing from other coding tools and the ways to work. Only the model step blocks chatting.
 * Progress is saved per step (settings.onboarding); skipped steps show on the Dashboard until done.
 */

const LABEL: Record<OnboardingStep, string> = { welcome: 'Welcome', model: 'Model', folder: 'Folder', langs: 'Languages', deps: 'Tools check', import: 'Import', modes: 'Ways to work' }
const NUMBERED = ONBOARDING_STEPS.slice(1)

/** Providers the model step offers first; the rest of the presets are under "More". */
const FEATURED = ['anthropic', 'openai', 'openrouter', 'ollama', 'lmstudio']

type Mode = 'chat' | 'ospec' | 'ship' | 'boards'

export function Onboarding() {
  const { open, step: askedStep } = useApp((s) => s.onboarding)
  const settings = useApp((s) => s.settings)
  if (!open || !settings) return null
  return <OnboardingDialog initial={askedStep ?? settings.onboarding?.step ?? 'welcome'} saved={settings.onboarding} />
}

function OnboardingDialog({ initial, saved }: { initial: OnboardingStep; saved: OnboardingState | null }) {
  const close = useApp((s) => s.closeOnboarding)
  const updateSettings = useApp((s) => s.updateSettings)
  const settings = useApp((s) => s.settings)!
  const [step, setStep] = useState<OnboardingStep>(initial)
  const [done, setDone] = useState<Set<OnboardingStep>>(() => new Set(saved?.completedAt ? NUMBERED : NUMBERED.filter((s) => !saved?.skipped.includes(s) && ONBOARDING_STEPS.indexOf(s) < ONBOARDING_STEPS.indexOf(saved?.step ?? 'welcome'))))
  const [skipped, setSkipped] = useState<Set<OnboardingStep>>(() => new Set(saved?.skipped ?? []))

  // Shared between steps: the scan picks languages, the languages decide which tools are required.
  const [scan, setScan] = useState<FolderScan | null>(null)
  const [langs, setLangs] = useState<Set<LanguageId>>(() => new Set(settings.languages))
  const [frameworks, setFrameworks] = useState<Set<string>>(new Set())
  const [deps, setDeps] = useState<DependencyReport | null>(null)
  // The tools check runs as soon as setup opens, so it's usually ready by its step.
  useEffect(() => {
    void api.deps.list().then(setDeps).catch(() => undefined)
  }, [])

  const save = (patch: Partial<OnboardingState>) => {
    const base: OnboardingState = settings.onboarding ?? { completedAt: null, skipped: [], step: 'welcome' }
    return updateSettings({ onboarding: { ...base, ...patch } })
  }
  const go = (next: OnboardingStep, mark?: 'done' | 'skipped') => {
    const nextDone = new Set(done)
    const nextSkipped = new Set(skipped)
    if (mark === 'done') {
      nextDone.add(step)
      nextSkipped.delete(step)
    } else if (mark === 'skipped') {
      nextSkipped.add(step)
      nextDone.delete(step)
    }
    setDone(nextDone)
    setSkipped(nextSkipped)
    setStep(next)
    void save({ step: next, skipped: [...nextSkipped] })
  }
  const nextOf = (s: OnboardingStep) => ONBOARDING_STEPS[Math.min(ONBOARDING_STEPS.indexOf(s) + 1, ONBOARDING_STEPS.length - 1)]
  const prevOf = (s: OnboardingStep) => ONBOARDING_STEPS[Math.max(ONBOARDING_STEPS.indexOf(s) - 1, 0)]
  const advance = (mark: 'done' | 'skipped' = 'done') => go(nextOf(step), mark)
  const back = () => setStep(prevOf(step))

  /** Leave now; whatever isn't done yet shows on the Dashboard. */
  const later = async (resumeAt: OnboardingStep = step) => {
    const left = NUMBERED.filter((s) => !done.has(s))
    await save({ step: resumeAt, skipped: [...new Set([...skipped, ...left])], cardDismissed: false })
    close()
  }
  const asking = useRef(false)
  const askClose = async () => {
    if (settings.onboarding?.completedAt) return close()
    if (asking.current) return
    asking.current = true
    const leave = await confirmAction('Anything you haven’t set up yet shows on the Dashboard, and you can run setup again from Settings.', { title: 'Finish setup later?', confirmLabel: 'Finish later', cancelLabel: 'Keep going' })
    asking.current = false
    if (leave) await later()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !asking.current) void askClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const common = { advance, back, skip: () => advance('skipped') }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-[2px]">
      <div role="dialog" aria-modal="true" aria-labelledby="onboarding-title" className="grid h-[min(620px,calc(100vh-48px))] w-[min(900px,100%)] grid-cols-[208px_1fr] overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60">
        <aside className="flex flex-col gap-0.5 border-r border-line bg-card px-3 py-5">
          <div className="flex items-center gap-2 px-2 pb-4 text-ui font-semibold">
            <Logo size={18} />
            Set up Cloth
          </div>
          {ONBOARDING_STEPS.map((s, i) => {
            const isOn = s === step
            const isDone = done.has(s) && !isOn
            const isSkipped = skipped.has(s) && !isOn
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStep(s)}
                aria-current={isOn ? 'step' : undefined}
                className={clsx('flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-ui', isOn ? 'bg-elev text-fg' : 'text-dim hover:bg-elev hover:text-muted')}
              >
                <span
                  className={clsx(
                    'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[10px]',
                    isOn ? 'border-crimson-hi text-crimson-text' : isDone ? 'border-ok bg-ok text-[#0b1a11]' : isSkipped ? 'border-dashed border-line-strong' : 'border-line-strong'
                  )}
                >
                  {isDone ? <Check size={10} weight="bold" /> : isSkipped ? '–' : i === 0 ? '' : i}
                </span>
                {LABEL[s]}
              </button>
            )
          })}
          <p className="mt-auto px-2 text-caption leading-snug text-dim">Skipped steps show on the Dashboard. You can run setup again from Settings.</p>
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-col">
          <button type="button" onClick={() => void askClose()} aria-label="Close setup" className="absolute top-3 right-3 z-10 rounded-md p-1.5 text-dim hover:bg-elev hover:text-fg">
            <X size={15} />
          </button>
          {step === 'welcome' && <Welcome onStart={() => go('model')} onLater={() => void later('welcome')} />}
          {step === 'model' && <ModelStep {...common} onLocal={() => void later('folder').then(() => useApp.getState().setPage('run'))} />}
          {step === 'folder' && (
            <FolderStep
              {...common}
              scan={scan}
              onScan={(sc) => {
                setScan(sc)
                if (sc?.languages.length) setLangs(new Set(sc.languages.map((l) => l.id)))
                if (sc?.frameworks.length) setFrameworks(new Set(sc.frameworks))
              }}
            />
          )}
          {step === 'langs' && <LanguagesStep {...common} scan={scan} langs={langs} setLangs={setLangs} frameworks={frameworks} setFrameworks={setFrameworks} />}
          {step === 'deps' && <DepsStep {...common} report={deps} setReport={setDeps} langs={langs} />}
          {step === 'import' && <ImportStep {...common} />}
          {step === 'modes' && (
            <ModesStep
              back={back}
              done={done}
              skipped={skipped}
              onFinish={async (mode) => {
                const left = NUMBERED.filter((s) => s !== 'modes' && !done.has(s))
                await save({ completedAt: Date.now(), step: 'modes', skipped: left, cardDismissed: false })
                close()
                await startIn(mode)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** Opens the first chat in the mode picked (Boards opens the Boards page). */
async function startIn(mode: Mode): Promise<void> {
  const app = useApp.getState()
  if (mode === 'boards') return app.setPage('boards')
  try {
    const chat = await api.chat.create({})
    if (mode === 'ospec') await api.chat.update(chat.id, { openspec: { step: 'setup', change: null, waitAfterPropose: false, tasks: null, pr: null, startedAt: Date.now() }, permissions: 'auto' })
    if (mode === 'ship') armSpecShip(chat.id)
    app.openChatById(chat.id)
  } catch (err) {
    app.toast(`Couldn’t start the chat: ${err instanceof Error ? err.message : String(err)}`, 'error')
    app.setPage('chat')
  }
}

// ─── Layout pieces ────────────────────────────────────────────────────────────

function Pane({ n, title, lede, children, footer }: { n?: number; title: string; lede?: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-8 pt-7 pb-5">
        <div className="flex flex-col gap-1.5 pr-8">
          {n != null && <span className="font-mono text-caption text-dim">Step {n} of {NUMBERED.length}</span>}
          <h2 id="onboarding-title" className="text-title font-semibold tracking-tight">
            {title}
          </h2>
          {lede && <p className="max-w-[60ch] text-body text-muted">{lede}</p>}
        </div>
        {children}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-5 py-3.5">{footer}</div>
    </>
  )
}

const Spacer = () => <span className="flex-1" />

function Note({ tone = 'neutral', icon, children }: { tone?: 'neutral' | 'info' | 'warn'; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={clsx('flex gap-2.5 rounded-lg border px-3 py-2.5 text-ui text-muted', tone === 'info' ? 'border-info/35 bg-info/[0.07]' : tone === 'warn' ? 'border-warn/35 bg-warn/[0.06]' : 'border-line bg-card')}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx('inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-ui', on ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line bg-card text-muted hover:border-line-strong hover:text-fg')}
    >
      {children}
    </button>
  )
}

function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info'; children: ReactNode }) {
  const cls = { neutral: 'border-line text-dim', ok: 'border-ok/40 text-ok', warn: 'border-warn/40 text-warn', danger: 'border-danger-line text-danger', info: 'border-info/40 text-info' }[tone]
  return <span className={clsx('inline-flex items-center rounded-full border px-2 text-micro font-medium whitespace-nowrap', cls)}>{children}</span>
}

// ─── Steps ────────────────────────────────────────────────────────────────────

interface StepProps {
  advance(mark?: 'done' | 'skipped'): void
  back(): void
  skip(): void
}

function Welcome({ onStart, onLater }: { onStart(): void; onLater(): void }) {
  return (
    <Pane
      title="Let’s get you to your first chat"
      lede="Cloth runs agents, specs and boards against code on this PC. A few choices now make every chat better: which model to use, where your code lives and what it’s written in."
      footer={
        <>
          <Button variant="ghost" onClick={onLater}>
            Set up later
          </Button>
          <Spacer />
          <Button variant="primary" onClick={onStart}>
            Get started
          </Button>
        </>
      }
    >
      <ol className="grid grid-cols-2 gap-x-6 gap-y-2 text-ui text-muted">
        {NUMBERED.map((s, i) => (
          <li key={s} className="flex items-baseline gap-2">
            <span className="font-mono text-micro text-dim">{i + 1}</span>
            {LABEL[s]}
            {s === 'model' && <Pill tone="info">needed to chat</Pill>}
          </li>
        ))}
      </ol>
      <Note>About two minutes. Everything except the model can be skipped and finished later.</Note>
    </Pane>
  )
}

function ModelStep({ advance, back, onLocal }: StepProps & { onLocal(): void }) {
  const providers = useApp((s) => s.providers)
  const loadProviders = useApp((s) => s.loadProviders)
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [presetId, setPresetId] = useState('anthropic')
  const [more, setMore] = useState(false)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The provider this step made (so a second try updates it instead of adding another).
  const [made, setMade] = useState<Provider | null>(null)
  const chatModels = (p: Provider) => p.models.filter((m) => !m.embedding)
  const usable = providers.filter((p) => p.enabled && chatModels(p).length)
  const [model, setModel] = useState(() => (settings.defaultModel ? `${settings.defaultModel.providerId}::${settings.defaultModel.modelId}` : ''))
  const [adding, setAdding] = useState(usable.length === 0)

  useEffect(() => {
    void api.providers.presets().then(setPresets)
  }, [])
  const preset = presets.find((p) => p.id === presetId)
  useEffect(() => {
    if (preset) setBaseUrl(preset.baseUrl)
  }, [preset])
  // Pick a model once one is there.
  useEffect(() => {
    if (model || !usable.length) return
    const p = made && chatModels(made).length ? made : usable[0]
    setModel(`${p.id}::${chatModels(p)[0].id}`)
  }, [usable, made, model])

  const connect = async () => {
    if (!preset) return
    setBusy(true)
    setError(null)
    try {
      const input = { name: preset.label, kind: preset.kind, baseUrl: baseUrl.trim() || preset.baseUrl, apiKey: key.trim() || undefined }
      const p = made ? await api.providers.update(made.id, input) : await api.providers.create(input)
      setMade(p)
      const refreshed = await api.providers.refreshModels(p.id)
      setMade(refreshed)
      if (!chatModels(refreshed).length) throw new Error('Connected, but the server listed no chat models')
      setModel(`${refreshed.id}::${chatModels(refreshed)[0].id}`)
      setAdding(false)
      await loadProviders()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      await loadProviders()
    } finally {
      setBusy(false)
    }
  }
  const finish = async () => {
    const [providerId, modelId] = model.split('::')
    if (providerId && modelId) await updateSettings({ defaultModel: { providerId, modelId } })
    advance()
  }
  const shown = more ? presets : presets.filter((p) => FEATURED.includes(p.id))

  return (
    <Pane
      n={1}
      title="Connect a model"
      lede="Cloth needs one model to chat with. You can add more providers later on the Models page."
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Button variant="ghost" onClick={onLocal}>
            Use a local model
          </Button>
          <Spacer />
          <Button variant="primary" disabled={!model || adding} onClick={() => void finish()}>
            Continue
          </Button>
        </>
      }
    >
      {!adding && usable.length > 0 ? (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-muted">Default model</span>
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {usable.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {chatModels(p).map((m) => (
                    <option key={m.id} value={`${p.id}::${m.id}`}>
                      {m.name || m.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </label>
          <span className="flex items-center gap-1.5 text-caption text-ok">
            <CheckCircle size={14} weight="fill" />
            {usable.length === 1 ? `${usable[0].name} is connected.` : `${usable.length} providers connected.`}
          </span>
          <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}>
            Add another provider
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={p.id === presetId}
                onClick={() => {
                  setPresetId(p.id)
                  setError(null)
                }}
                className={clsx('flex min-w-0 flex-col gap-0.5 rounded-lg border p-3 text-left', p.id === presetId ? 'border-crimson-line bg-crimson-soft' : 'border-line bg-card hover:border-line-strong')}
              >
                <span className="truncate text-ui font-semibold">{p.label}</span>
                <span className="truncate text-caption text-dim">{p.hint}</span>
              </button>
            ))}
            {!more && (
              <button type="button" onClick={() => setMore(true)} className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-line p-3 text-ui text-dim hover:border-line-strong hover:text-fg">
                More <CaretDown size={12} />
              </button>
            )}
          </div>
          {preset && preset.kind === 'openai-compatible' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-muted">Server address</span>
              <Input className="font-mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
          )}
          {preset && (
            <label className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-muted">API key{preset.needsKey ? '' : ' (optional)'}</span>
              <div className="flex gap-2">
                <Input className="font-mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void connect()} />
                <Button loading={busy} disabled={preset.needsKey && !key.trim()} onClick={() => void connect()}>
                  Connect
                </Button>
              </div>
              <span className="text-caption text-dim">Saved encrypted on this PC and never shown in the app again.</span>
            </label>
          )}
          {error && (
            <Note tone="warn" icon={<Warning size={15} className="text-warn" />}>
              {error}
            </Note>
          )}
          {usable.length > 0 && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setAdding(false)}>
              Use a provider that’s already connected
            </Button>
          )}
        </>
      )}
      <Note tone="info" icon={<Info size={15} className="text-info" />}>
        <b className="font-semibold text-fg">No API key?</b> You can run an open model on this PC from the <b className="font-semibold text-fg">Run</b> page: Cloth downloads it, starts it and adds it as a provider. Choose “Use a local model” to go there now and finish the rest of setup later.
      </Note>
    </Pane>
  )
}

function FolderStep({ advance, back, skip, scan, onScan }: StepProps & { scan: FolderScan | null; onScan(s: FolderScan | null): void }) {
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const [folder, setFolder] = useState<string | null>(scan?.path ?? settings.defaultWorkspace)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addProjects, setAddProjects] = useState(true)

  const runScan = async (path: string) => {
    setScanning(true)
    setError(null)
    try {
      onScan(await api.onboarding.scanFolder(path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      onScan(null)
    } finally {
      setScanning(false)
    }
  }
  useEffect(() => {
    if (folder && !scan) void runScan(folder)
    // Scan a folder saved earlier once, when the step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = async () => {
    const [path] = await api.app.pickPaths({ directory: true, title: 'Choose your main working folder' })
    if (!path) return
    setFolder(path)
    void runScan(path)
  }
  const finish = async () => {
    if (!folder) return
    await updateSettings({ defaultWorkspace: folder })
    if (addProjects && scan?.subprojects.length) {
      const existing = await api.projects.list()
      const sep = folder.includes('\\') ? '\\' : '/'
      for (const name of scan.subprojects) {
        const path = `${folder.replace(/[\\/]+$/, '')}${sep}${name}`
        if (!existing.some((p) => p.folder?.toLowerCase() === path.toLowerCase())) await api.projects.create({ name, folder: path }).catch(() => undefined)
      }
    }
    advance()
  }
  const top = scan?.languages.slice(0, 3).map((l) => LANGUAGES.find((x) => x.id === l.id)?.name).join(', ')

  return (
    <Pane
      n={2}
      title="Choose your main working folder"
      lede="New chats open here unless you pick another folder. Cloth reads it to suggest your languages, and changes nothing in it during setup."
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Spacer />
          <Button variant="ghost" onClick={skip}>
            Skip
          </Button>
          <Button variant="primary" disabled={!folder || scanning} onClick={() => void finish()}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-line-strong bg-card p-3">
        <FolderSimple size={18} className="shrink-0 text-muted" />
        <span className={clsx('min-w-0 flex-1 font-mono text-ui break-all', !folder && 'text-dim')}>{folder ?? 'No folder chosen'}</span>
        <Button size="sm" onClick={() => void pick()}>
          {folder ? 'Change' : 'Choose folder…'}
        </Button>
      </div>
      {scanning && (
        <span className="flex items-center gap-2 text-caption text-dim">
          <Spinner size={12} /> Looking through the folder…
        </span>
      )}
      {error && <Note tone="warn" icon={<Warning size={15} className="text-warn" />}>{error}</Note>}
      {scan && !scanning && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Fact k="Repository" v={scan.git ? `Git${scan.git.branch ? ` · ${scan.git.branch}` : ''}` : 'Not a Git repository'} />
            <Fact k="Instructions" v={scan.instructions ? `${scan.instructions} found` : 'None yet'} />
            <Fact k="Mostly" v={top || 'No code found'} />
          </div>
          {scan.subprojects.length > 1 && (
            <div className="flex items-start gap-3 rounded-lg border border-line bg-card p-3">
              <Switch checked={addProjects} onChange={setAddProjects} ariaLabel="Add the projects inside" />
              <div className="min-w-0">
                <div className="text-ui font-semibold">Add the {scan.subprojects.length} projects inside to Cloth</div>
                <div className="text-caption text-dim">{scan.subprojects.join(', ')}. Each gets its own chats, board and permissions.</div>
              </div>
            </div>
          )}
        </>
      )}
      <Note>Skip this if you work across many folders. Chats ask for a folder when they need one.</Note>
    </Pane>
  )
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-line bg-card px-3 py-2.5">
      <span className="text-micro tracking-wide text-dim uppercase">{k}</span>
      <span className="text-ui font-medium break-words">{v}</span>
    </div>
  )
}

function LanguagesStep({
  advance,
  back,
  skip,
  scan,
  langs,
  setLangs,
  frameworks,
  setFrameworks
}: StepProps & { scan: FolderScan | null; langs: Set<LanguageId>; setLangs(s: Set<LanguageId>): void; frameworks: Set<string>; setFrameworks(s: Set<string>): void }) {
  const settings = useApp((s) => s.settings)!
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)
  const [servers, setServers] = useState<LanguageServerInfo[]>([])
  const [library, setLibrary] = useState(true)
  const [cadence, setCadence] = useState<BestPracticeCadence>('monthly')
  const [busy, setBusy] = useState(false)
  const picked = LANGUAGES.filter((l) => langs.has(l.id))
  const offered = [...new Set(picked.flatMap((l) => l.frameworks))]

  useEffect(() => {
    void api.onboarding.languageServers([...langs]).then(setServers).catch(() => setServers([]))
  }, [langs])
  const toggle = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    apply(next)
  }
  const share = (id: LanguageId) => scan?.languages.find((l) => l.id === id)?.share
  const names = [...picked.map((l) => l.name), ...offered.filter((f) => frameworks.has(f))]
  const runs = Math.max(1, names.length)

  const finish = async () => {
    setBusy(true)
    await updateSettings({ languages: [...langs] })
    if (library && langs.size) {
      if (!settings.defaultModel) toast('The best-practice library needs a model: connect one, then run setup again from Settings.', 'error')
      else {
        try {
          const made = await api.onboarding.bestPractices({ languages: [...langs], frameworks: offered.filter((f) => frameworks.has(f)), cadence })
          await updateSettings({ onboarding: { ...(useApp.getState().settings?.onboarding ?? { completedAt: null, skipped: [], step: 'langs' }), bestPractices: made } })
          toast('Building your best-practice library in the background. It shows in Knowledge as it fills.', 'ok')
        } catch (err) {
          toast(`Couldn’t set up the best-practice library: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }
      }
    }
    setBusy(false)
    advance()
  }

  return (
    <Pane
      n={3}
      title="What do you write?"
      lede={`${scan?.languages.length ? 'Picked from your folder. ' : ''}Cloth turns on code intelligence for these, and can keep a library of current good practice for the agent to look up.`}
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Spacer />
          <Button variant="ghost" onClick={skip}>
            Skip
          </Button>
          <Button variant="primary" loading={busy} disabled={!langs.size} onClick={() => void finish()}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <span className="text-caption font-medium text-muted">Languages</span>
        <div className="flex flex-wrap gap-1.5">
          {LANGUAGES.map((l) => (
            <Chip key={l.id} on={langs.has(l.id)} onClick={() => toggle(langs, l.id, setLangs)}>
              {l.name}
              {share(l.id) != null && <span className="font-mono text-micro text-dim">{Math.round(share(l.id)! * 100)}%</span>}
            </Chip>
          ))}
        </div>
      </div>
      {offered.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-caption font-medium text-muted">Frameworks and libraries</span>
          <div className="flex flex-wrap gap-1.5">
            {offered.map((f) => (
              <Chip key={f} on={frameworks.has(f)} onClick={() => toggle(frameworks, f, setFrameworks)}>
                {f}
              </Chip>
            ))}
          </div>
        </div>
      )}
      {picked.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
          <div className="text-ui font-semibold">Code intelligence</div>
          <div className="text-caption text-dim">Go to definition, references and type errors after every edit the agent makes.</div>
          <div className="flex flex-wrap gap-1.5">
            {picked.map((l) => {
              const sv = servers.find((s) => s.id === l.id)
              if (!sv) return <Pill key={l.id}>{l.name}: checking…</Pill>
              if (sv.status === 'bundled') return <Pill key={l.id} tone="ok">{l.name}: included</Pill>
              if (sv.status === 'found') return <Pill key={l.id} tone="ok">{l.name}: {sv.program} found</Pill>
              if (sv.status === 'missing')
                return (
                  <button key={l.id} type="button" onClick={() => sv.url && void api.app.openExternal(sv.url)} className="inline-flex items-center gap-1 rounded-full border border-warn/40 px-2 text-micro font-medium text-warn hover:bg-warn/10">
                    {l.name}: install {sv.program} <ArrowSquareOut size={10} />
                  </button>
                )
              return <Pill key={l.id}>{l.name}: not available yet</Pill>
            })}
          </div>
        </div>
      )}
      <div className="flex items-start gap-3 rounded-lg border border-line bg-card p-3">
        <Switch checked={library} onChange={setLibrary} ariaLabel="Build a best-practice library" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div>
            <div className="text-ui font-semibold">Build a best-practice library</div>
            <div className="text-caption text-dim">
              An automation searches the web for current guidance on {names.slice(0, 4).join(', ') || 'your languages'}
              {names.length > 4 ? ' and more' : ''}, saves it to Knowledge, and the agent looks it up while it works.
            </div>
          </div>
          {library && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-caption text-dim">Refresh</span>
              {(['weekly', 'monthly', 'once'] as const).map((c) => (
                <Chip key={c} on={cadence === c} onClick={() => setCadence(c)}>
                  {c === 'once' ? 'Only once' : c[0].toUpperCase() + c.slice(1)}
                </Chip>
              ))}
              <span className="text-caption text-dim">· roughly {runs * 12}k tokens a run on your default model</span>
            </div>
          )}
        </div>
      </div>
    </Pane>
  )
}

/** Which programs the picked languages need (the rest stay as Settings → Dependencies marks them). */
function requiredBy(d: Dependency, langs: Set<LanguageId>): boolean {
  if (d.id === 'python') return langs.has('python')
  if (d.id === 'node') return langs.has('typescript') || langs.has('javascript')
  if (d.id === 'git') return true
  if (d.id === 'gh') return true
  return !d.optional
}

const DEP_HELP: Partial<Record<string, string>> = {
  gh: 'https://cli.github.com/manual/gh_auth_login',
  docker: 'https://docs.docker.com/desktop/'
}

function DepsStep({ advance, back, skip, report, setReport, langs }: StepProps & { report: DependencyReport | null; setReport(r: DependencyReport): void; langs: Set<LanguageId> }) {
  const [busy, setBusy] = useState(false)
  const recheck = async () => {
    setBusy(true)
    try {
      setReport(await api.deps.refresh())
    } finally {
      setBusy(false)
    }
  }
  const system = report?.items.filter((d) => d.source === 'system') ?? []
  const bundled = report?.items.filter((d) => d.source === 'bundled') ?? []
  const problems = system.filter((d) => requiredBy(d, langs) && d.status !== 'ok')
  const bundledOk = bundled.every((d) => d.status === 'ok')

  return (
    <Pane
      n={4}
      title="Check your tools"
      lede={!report ? 'Checking programs on this PC…' : problems.length ? `${problems.length} thing${problems.length > 1 ? 's' : ''} to sort out for what you picked. Cloth still works without them, with those features off.` : 'Everything you need is ready.'}
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Button variant="ghost" loading={busy} onClick={() => void recheck()}>
            Check again
          </Button>
          <Spacer />
          <Button variant="ghost" onClick={skip}>
            Skip
          </Button>
          <Button variant="primary" onClick={() => advance()}>
            Continue
          </Button>
        </>
      }
    >
      {!report ? (
        <div className="flex items-center gap-2 text-caption text-dim">
          <Spinner size={12} /> Looking for Git, GitHub CLI, Node.js, Python, Docker…
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-line">
            {system.map((d) => {
              const need = requiredBy(d, langs)
              const tone = d.status === 'ok' ? 'ok' : d.status === 'warn' ? 'warn' : need ? 'danger' : 'neutral'
              const help = d.status === 'missing' ? d.url : d.status === 'warn' ? DEP_HELP[d.id] : undefined
              return (
                <div key={d.id} className="flex items-center gap-3 border-t border-line bg-card px-3 py-2.5 first:border-t-0">
                  <span className="shrink-0">
                    {d.status === 'ok' ? <CheckCircle size={16} weight="fill" className="text-ok" /> : d.status === 'warn' ? <Warning size={16} className="text-warn" /> : need ? <XCircle size={16} className="text-danger" /> : <Circle size={16} className="text-dim" />}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2 text-ui font-semibold">
                      {d.name}
                      {d.version && <span className="font-mono text-micro font-normal text-dim">{d.version}</span>}
                      {!need && <Pill>optional</Pill>}
                    </span>
                    <span className="text-caption text-dim">{d.status !== 'ok' && d.detail ? d.detail : d.usedFor}</span>
                  </div>
                  <Pill tone={tone}>{d.status === 'ok' ? 'Ready' : d.status === 'warn' ? 'Needs attention' : need ? 'Missing' : 'Not needed'}</Pill>
                  {help && (
                    <Button size="sm" variant="outline" icon={<ArrowSquareOut size={12} />} onClick={() => void api.app.openExternal(help)}>
                      {d.status === 'missing' ? 'Get it' : 'How to fix'}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
          {bundled.length > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
              {bundledOk ? <CheckCircle size={16} weight="fill" className="shrink-0 text-ok" /> : <Warning size={16} className="shrink-0 text-warn" />}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-ui font-semibold">Shipped with Cloth</span>
                <span className="text-caption text-dim">{bundled.map((d) => d.name).join(', ')}. Updated with Cloth.</span>
              </div>
              <Pill tone={bundledOk ? 'ok' : 'warn'}>{bundledOk ? 'Ready' : 'Needs attention'}</Pill>
            </div>
          )}
        </>
      )}
    </Pane>
  )
}

function ImportStep({ advance, back, skip }: StepProps) {
  const toast = useApp((s) => s.toast)
  const [sources, setSources] = useState<ImportSource[] | null>(null)
  const [sel, setSel] = useState<{ skills: Set<string>; agents: Set<string>; mcp: Set<string> }>({ skills: new Set(), agents: new Set(), mcp: new Set() })
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.onboarding
      .importSources()
      .then((list) => {
        setSources(list)
        // Everything not already in Cloth starts ticked.
        setSel({
          skills: new Set(list.flatMap((s) => s.skills.filter((k) => !k.imported).map((k) => k.dir))),
          agents: new Set(list.flatMap((s) => s.agents.filter((a) => !a.imported).map((a) => a.file))),
          mcp: new Set(list.flatMap((s) => s.mcp.filter((m) => !m.imported).map((m) => `${s.id}|${m.name}`)))
        })
      })
      .catch(() => setSources([]))
  }, [])

  const keysOf = (s: ImportSource) => ({
    skills: s.skills.filter((k) => !k.imported).map((k) => k.dir),
    agents: s.agents.filter((a) => !a.imported).map((a) => a.file),
    mcp: s.mcp.filter((m) => !m.imported).map((m) => `${s.id}|${m.name}`)
  })
  const sourceState = (s: ImportSource): boolean | 'some' => {
    const k = keysOf(s)
    const all = [...k.skills.map((x) => sel.skills.has(x)), ...k.agents.map((x) => sel.agents.has(x)), ...k.mcp.map((x) => sel.mcp.has(x))]
    if (!all.length) return false
    return all.every(Boolean) ? true : all.some(Boolean) ? 'some' : false
  }
  const setSource = (s: ImportSource, on: boolean) => {
    const k = keysOf(s)
    const apply = (set: Set<string>, keys: string[]) => {
      const next = new Set(set)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    }
    setSel({ skills: apply(sel.skills, k.skills), agents: apply(sel.agents, k.agents), mcp: apply(sel.mcp, k.mcp) })
  }
  const toggleOne = (kind: 'skills' | 'agents' | 'mcp', key: string) => {
    const next = new Set(sel[kind])
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSel({ ...sel, [kind]: next })
  }
  const total = sel.skills.size + sel.agents.size + sel.mcp.size

  const run = async () => {
    setBusy(true)
    const selection: ImportSelection = {
      skills: [...sel.skills],
      agents: [...sel.agents],
      mcp: [...sel.mcp].map((k) => {
        const [source, ...rest] = k.split('|')
        return { source: source as ImportSelection['mcp'][number]['source'], name: rest.join('|') }
      })
    }
    try {
      const r = await api.onboarding.importItems(selection)
      const parts = [r.skills.length && `${r.skills.length} skill${r.skills.length > 1 ? 's' : ''}`, r.agents.length && `${r.agents.length} agent${r.agents.length > 1 ? 's' : ''}`, r.mcp.length && `${r.mcp.length} MCP server${r.mcp.length > 1 ? 's' : ''}`].filter(Boolean)
      toast(parts.length ? `Imported ${parts.join(', ')}.${r.errors.length ? ` ${r.errors.length} couldn’t be copied.` : ''}` : 'Nothing new to import.', r.errors.length ? 'error' : 'ok')
      advance()
    } catch (err) {
      toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Pane
      n={5}
      title="Bring over what you already use"
      lede={sources?.length === 0 ? 'Cloth didn’t find skills, agents or MCP servers from other coding tools on this PC.' : 'Cloth found skills, agents and MCP servers from other coding tools on this PC. They’re copied, so the originals stay as they are.'}
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Spacer />
          <Button variant="ghost" onClick={skip}>
            Skip
          </Button>
          <Button variant="primary" loading={busy} disabled={!total} onClick={() => void run()}>
            {total ? `Import ${total} item${total > 1 ? 's' : ''}` : 'Import'}
          </Button>
        </>
      }
    >
      {!sources ? (
        <span className="flex items-center gap-2 text-caption text-dim">
          <Spinner size={12} /> Looking in ~/.claude, ~/.cursor, ~/.codex…
        </span>
      ) : (
        sources.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-line">
            {sources.map((s) => {
              const st = sourceState(s)
              const k = keysOf(s)
              const nothingNew = !k.skills.length && !k.agents.length && !k.mcp.length
              const counts = [
                s.skills.length && `${s.skills.length} skill${s.skills.length > 1 ? 's' : ''}${s.skills.length - k.skills.length ? ` · ${s.skills.length - k.skills.length} already in Cloth` : ''}`,
                s.agents.length && `${s.agents.length} agent${s.agents.length > 1 ? 's' : ''}${s.agents.length - k.agents.length ? ` · ${s.agents.length - k.agents.length} already in Cloth` : ''}`,
                s.mcp.length && `${s.mcp.length} MCP server${s.mcp.length > 1 ? 's' : ''}${s.mcp.length - k.mcp.length ? ` · ${s.mcp.length - k.mcp.length} already in Cloth` : ''}`
              ].filter(Boolean) as string[]
              return (
                <div key={s.id} className="border-t border-line bg-card first:border-t-0">
                  <div className="flex items-start gap-3 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label={`Import from ${s.name}`}
                      disabled={nothingNew}
                      checked={st === true}
                      ref={(el) => {
                        if (el) el.indeterminate = st === 'some'
                      }}
                      onChange={(e) => setSource(s, e.target.checked)}
                      className="mt-1 h-4 w-4 accent-crimson"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 text-ui font-semibold">
                        {s.name}
                        <span className="truncate font-mono text-micro font-normal text-dim">{s.path}</span>
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {counts.map((c) => (
                          <Pill key={c}>{c}</Pill>
                        ))}
                      </span>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                      {openId === s.id ? 'Hide' : 'Review'}
                    </Button>
                  </div>
                  {openId === s.id && (
                    <div className="flex flex-col gap-0.5 border-t border-line bg-bg px-3 py-2">
                      {s.skills.map((x) => (
                        <ReviewRow key={x.dir} kind="Skill" name={x.name} detail={x.description} imported={x.imported} on={sel.skills.has(x.dir)} onToggle={() => toggleOne('skills', x.dir)} />
                      ))}
                      {s.agents.map((x) => (
                        <ReviewRow key={x.file} kind="Agent" name={x.name} detail={x.description} imported={x.imported} on={sel.agents.has(x.file)} onToggle={() => toggleOne('agents', x.file)} />
                      ))}
                      {s.mcp.map((x) => (
                        <ReviewRow key={x.name} kind="MCP" name={x.name} detail={x.summary} mono imported={x.imported} on={sel.mcp.has(`${s.id}|${x.name}`)} onToggle={() => toggleOne('mcp', `${s.id}|${x.name}`)} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}
      {sources && sources.some((s) => s.mcp.length) && (
        <Note tone="warn" icon={<Warning size={15} className="text-warn" />}>
          <b className="font-semibold text-fg">MCP servers arrive switched off.</b> They can run programs on this PC, so turn each on from the MCP page once you’ve checked it. Skills and agents are ready to use straight away.
        </Note>
      )}
    </Pane>
  )
}

function ReviewRow({ kind, name, detail, imported, on, onToggle, mono }: { kind: string; name: string; detail: string; imported: boolean; on: boolean; onToggle(): void; mono?: boolean }) {
  return (
    <label className={clsx('flex items-center gap-2.5 rounded px-1.5 py-1 text-ui', imported ? 'text-dim' : 'cursor-pointer hover:bg-elev')}>
      <input type="checkbox" disabled={imported} checked={imported || on} onChange={onToggle} className="h-3.5 w-3.5 accent-crimson" />
      <span className="w-12 shrink-0 text-micro text-dim uppercase">{kind}</span>
      <span className="shrink-0 font-medium">{name}</span>
      <span className={clsx('min-w-0 flex-1 truncate text-caption text-dim', mono && 'font-mono')}>{imported ? 'Already in Cloth' : detail}</span>
    </label>
  )
}

const MODES: { id: Mode; name: string; when: string; what: string; example: string; level: number; tint: string }[] = [
  { id: 'chat', name: 'Chat', when: 'Quick, simple fixes.', what: 'A bug, a rename, a question about the code. The agent works directly and shows each change.', example: '“Why does the login form submit twice?”', level: 1, tint: 'text-fg' },
  { id: 'ospec', name: 'OpenSpec', when: 'Fixes that need a plan first.', what: 'Writes a short proposal and task list, implements it once it’s agreed, and opens a pull request.', example: '“Add rate limiting to the public API”', level: 2, tint: 'text-ospec' },
  { id: 'ship', name: 'Spec → Ship', when: 'Large features and risky changes.', what: 'In stages: questions, spec, tickets, build and review. You sign off between stages.', example: '“Add team accounts with roles and billing”', level: 3, tint: 'text-mode' },
  { id: 'boards', name: 'Boards', when: 'A defined goal broken into tickets.', what: 'A board of tickets that agents pick up and move across. Best when you know the finish line.', example: '“Ship the new settings page: 9 tickets”', level: 0, tint: 'text-agent' }
]
const SELECTED: Record<Mode, string> = { chat: 'border-crimson-line bg-crimson-soft', ospec: 'border-ospec-line bg-ospec-soft', ship: 'border-mode-line bg-mode-soft', boards: 'border-agent/35 bg-agent-soft' }

function ModesStep({ back, done, skipped, onFinish }: { back(): void; done: Set<OnboardingStep>; skipped: Set<OnboardingStep>; onFinish(mode: Mode): Promise<void> }) {
  const [mode, setMode] = useState<Mode>('chat')
  const [busy, setBusy] = useState(false)
  const settings = useApp((s) => s.settings)!
  const hasModel = !!settings.defaultModel
  const summary = useMemo(() => NUMBERED.filter((s) => s !== 'modes'), [])
  return (
    <Pane
      n={6}
      title="Pick how to work"
      lede="Match the mode to how big the job is. You can switch any time from the message box."
      footer={
        <>
          <Button variant="ghost" onClick={back}>
            Back
          </Button>
          <Spacer />
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              await onFinish(mode)
            }}
          >
            {mode === 'boards' ? 'Open Boards' : 'Start chatting'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        {MODES.map((m) => (
          <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)} className={clsx('flex min-w-0 flex-col gap-1.5 rounded-[10px] border p-3.5 text-left', mode === m.id ? SELECTED[m.id] : 'border-line bg-card hover:border-line-strong')}>
            <span className="flex items-center gap-2">
              <span className={clsx('text-body font-semibold', m.tint)}>{m.name}</span>
              <span aria-hidden="true" className={clsx('ml-auto flex gap-[3px]', m.tint)}>
                {[1, 2, 3].map((i) => (
                  <i key={i} className={clsx('h-3 w-1.5 rounded-[2px]', m.level === 0 ? 'bg-current opacity-50' : i <= m.level ? 'bg-current' : 'bg-line')} />
                ))}
              </span>
            </span>
            <span className="text-caption text-muted">
              <b className="font-semibold text-fg">{m.when}</b> {m.what}
            </span>
            <span className="text-caption text-dim italic">{m.example}</span>
          </button>
        ))}
      </div>
      {!hasModel && mode !== 'boards' && (
        <Note tone="warn" icon={<Warning size={15} className="text-warn" />}>
          There’s no default model yet, so the chat will ask you to pick one. Connect one in step 1 or on the Run page.
        </Note>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-caption text-dim">
        {summary.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            {done.has(s) ? <CheckCircle size={13} weight="fill" className="text-ok" /> : <Circle size={13} />}
            {LABEL[s]}
            {skipped.has(s) && ' (skipped)'}
          </span>
        ))}
      </div>
    </Pane>
  )
}
