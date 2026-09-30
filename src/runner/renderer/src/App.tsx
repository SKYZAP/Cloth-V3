import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Check, ExternalLink, File, FolderOpen, KeyRound, Loader2, Play, Settings2, Square, X } from 'lucide-react'
import type { NodeRunTrace, WorkflowRun } from '@shared/types'
import { Button, Field, Input, Select, Switch, Textarea } from '@/components/ui'
import { Markdown } from '@/components/Markdown'
import type { RunnerField, RunnerState } from '../../api'
import { onRunnerEvent, runner } from './api'

export function App() {
  const [state, setState] = useState<RunnerState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  useEffect(() => {
    runner.state().then(setState, (e: Error) => setError(e.message))
  }, [])
  if (error) return <Centered>{error}</Centered>
  if (!state) return <Centered><Loader2 size={18} className="animate-spin text-dim" /></Centered>
  return (
    <div className="flex h-screen flex-col bg-bg text-fg">
      <TitleBar name={state.manifest.name} onSettings={state.hasKey ? () => setSettings(true) : undefined} />
      {!state.hasKey ? <Setup state={state} onState={setState} /> : <Main state={state} onState={setState} />}
      {settings && <SettingsSheet state={state} onState={setState} onClose={() => setSettings(false)} />}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen items-center justify-center bg-bg p-8 text-center text-[13px] text-muted">{children}</div>
}

function TitleBar({ name, onSettings }: { name: string; onSettings?: () => void }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pl-3 pr-[150px] [-webkit-app-region:drag]">
      <span className="h-2 w-2 rounded-full bg-crimson" />
      <span className="text-[12.5px] font-semibold">{name}</span>
      <span className="text-[11px] text-dim">made with Cloth</span>
      <div className="flex-1" />
      {onSettings && (
        <button onClick={onSettings} title="Settings" aria-label="Settings" className="flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-elev-2 hover:text-fg [-webkit-app-region:no-drag]">
          <Settings2 size={14} />
        </button>
      )}
    </div>
  )
}

// ─── First run: the OpenAI key ────────────────────────────────────────────────

function Setup({ state, onState }: { state: RunnerState; onState(s: RunnerState): void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      onState(await runner.setKey(key))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-[22px] font-semibold tracking-tight">{state.manifest.name}</div>
        {state.manifest.description && <div className="mt-1.5 text-[13px] leading-relaxed text-muted">{state.manifest.description}</div>}
        <div className="mt-6 rounded-2xl border border-line bg-panel p-5">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <KeyRound size={15} className="text-crimson-hi" /> Connect OpenAI
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-dim">This app uses your own OpenAI account. The key is stored encrypted on this computer and only sent to OpenAI.</div>
          <Field label="OpenAI API key" className="mt-4">
            <Input
              type="password"
              autoFocus
              value={key}
              placeholder="sk-…"
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save()}
            />
          </Field>
          {error && <div className="mt-2 text-[12px] text-crimson-hi">{error}</div>}
          <Button variant="primary" className="mt-4 w-full" loading={busy} disabled={!key.trim()} onClick={() => void save()}>
            {busy ? 'Checking the key…' : 'Save and continue'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main screen: inputs on the left, the run on the right ────────────────────

function Main({ state, onState }: { state: RunnerState; onState(s: RunnerState): void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(state.fields.map((f) => [f.key, f.value])))
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    void runner.runs().then((r) => {
      setRuns(r)
      setRunId(r[0]?.id ?? null)
    })
    return onRunnerEvent((e) => {
      if (e.type !== 'run') return
      setRuns((rs) => {
        const i = rs.findIndex((r) => r.id === e.run.id)
        if (i < 0) return [e.run, ...rs]
        const next = rs.slice()
        next[i] = e.run
        return next
      })
    })
  }, [])
  const run = runs.find((r) => r.id === runId) ?? null
  const running = run?.status === 'running'

  const start = async () => {
    setError(null)
    let input: unknown
    try {
      input = state.fields.length === 1 && state.fields[0].key === '' ? parseJson(values['']) : Object.fromEntries(state.fields.map((f) => [f.key, f.kind === 'json' ? parseJson(values[f.key]) : values[f.key]]))
    } catch (e) {
      return setError((e as Error).message)
    }
    setStarting(true)
    try {
      const r = await runner.run(input)
      setRuns((rs) => [r, ...rs.filter((x) => x.id !== r.id)])
      setRunId(r.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,380px)_1fr]">
      <div className="flex min-h-0 flex-col border-r border-line bg-panel">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <div className="text-[17px] font-semibold tracking-tight">{state.flow.name}</div>
            {(state.manifest.description || state.flow.description) && <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{state.manifest.description || state.flow.description}</div>}
          </div>
          {state.fields.map((f) => (
            <FieldInput key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((vs) => ({ ...vs, [f.key]: v }))} />
          ))}
          <Field label="Save files to">
            <button onClick={async () => onState(await runner.pickWorkspace())} className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-left text-[12.5px] text-muted hover:border-line-strong hover:text-fg" title={state.workspace}>
              <FolderOpen size={14} className="shrink-0 text-crimson-hi" />
              <span className="min-w-0 flex-1 truncate">{state.workspace}</span>
              <span className="text-[11px] text-dim">Change</span>
            </button>
          </Field>
        </div>
        <div className="space-y-2 border-t border-line p-4">
          {error && <div className="text-[12px] text-crimson-hi">{error}</div>}
          {!state.model && <div className="text-[12px] text-warn">Choose a model in Settings first.</div>}
          {running ? (
            <Button variant="danger" className="h-10 w-full text-[13px]" icon={<Square size={12} fill="currentColor" />} onClick={() => void runner.cancel(run!.id)}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" className="h-10 w-full text-[13px]" loading={starting} disabled={!state.model} icon={<Play size={13} fill="currentColor" />} onClick={() => void start()}>
              Run
            </Button>
          )}
          <div className="text-center text-[11px] text-dim">
            Model <span className="font-mono text-muted">{state.model ?? 'not chosen'}</span>
          </div>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {run ? <RunView run={run} state={state} runs={runs} onSelect={setRunId} /> : <EmptyRun />}
      </div>
    </div>
  )
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return v.trim() ? JSON.parse(v) : null
  } catch {
    throw new Error('One of the fields is not valid JSON')
  }
}

function FieldInput({ field, value, onChange }: { field: RunnerField; value: unknown; onChange(v: unknown): void }) {
  if (field.kind === 'boolean') return <Switch checked={!!value} onChange={onChange} label={field.label} />
  return (
    <Field label={field.label}>
      {field.kind === 'long' ? (
        <Textarea rows={6} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : field.kind === 'json' ? (
        <Textarea rows={5} className="font-mono text-[11.5px]" value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input type={field.kind === 'number' ? 'number' : 'text'} value={String(value ?? '')} onChange={(e) => onChange(field.kind === 'number' ? Number(e.target.value) : e.target.value)} />
      )}
    </Field>
  )
}

function EmptyRun() {
  return (
    <div className="flex h-full items-center justify-center p-10 text-center">
      <div className="max-w-xs text-[13px] leading-relaxed text-dim">Fill in the details and press Run. Progress, the result and any files the app creates show up here.</div>
    </div>
  )
}

const elapsed = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p

function RunView({ run, state, runs, onSelect }: { run: WorkflowRun; state: RunnerState; runs: WorkflowRun[]; onSelect(id: string): void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (run.status !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [run.status])
  const traces = useMemo(() => new Map(run.nodes.map((t) => [t.nodeId, t])), [run.nodes])
  const steps = state.flow.nodes.filter((n) => n.type !== 'trigger' && traces.has(n.id))
  const text = typeof run.output === 'string' ? run.output : run.output == null ? '' : '```json\n' + JSON.stringify(run.output, null, 2) + '\n```'
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <div className="flex items-center gap-3">
        <StatusPill run={run} />
        <span className="text-[12px] text-dim">{elapsed((run.finishedAt ?? now) - run.startedAt)}</span>
        <div className="flex-1" />
        {runs.length > 1 && (
          <Select value={run.id} onChange={(e) => onSelect(e.target.value)} aria-label="Earlier runs" className="w-auto text-[12px]">
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.startedAt).toLocaleString()} · {r.status === 'ok' ? 'done' : r.status === 'error' ? 'failed' : 'running'}
              </option>
            ))}
          </Select>
        )}
      </div>

      <div className="rounded-xl border border-line bg-panel p-1.5">
        {steps.length ? steps.map((n) => <Step key={n.id} label={n.label} trace={traces.get(n.id)!} />) : <div className="p-2 text-[12px] text-dim">Starting…</div>}
      </div>

      {run.error && <div className="rounded-xl border border-crimson-line bg-crimson-soft p-3 text-[12.5px] text-crimson-hi">{run.error}</div>}

      {!!run.files?.length && (
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-dim">Files</div>
          <div className="space-y-1.5">
            {run.files.map((f) => (
              <div key={f} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5">
                <File size={16} className="shrink-0 text-crimson-hi" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{fileName(f)}</div>
                  <div className="truncate text-[11px] text-dim">{f}</div>
                </div>
                <Button size="sm" variant="primary" icon={<ExternalLink size={12} />} onClick={() => void runner.openPath(f)}>
                  Open
                </Button>
                <Button size="sm" icon={<FolderOpen size={12} />} onClick={() => void runner.showInFolder(f)}>
                  Show in folder
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {run.status === 'ok' && text.trim() && (
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-dim">Result</div>
          <div className="selectable rounded-xl border border-line bg-panel p-5">
            <Markdown text={text} />
          </div>
        </div>
      )}
    </div>
  )
}

function StatusPill({ run }: { run: WorkflowRun }) {
  const s = run.status
  return (
    <span className={clsx('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium', s === 'ok' ? 'bg-ok/10 text-ok' : s === 'error' ? 'bg-crimson-soft text-crimson-hi' : 'bg-info/10 text-info')}>
      {s === 'running' ? <Loader2 size={12} className="animate-spin" /> : s === 'ok' ? <Check size={12} /> : <X size={12} />}
      {s === 'running' ? 'Running' : s === 'ok' ? 'Done' : 'Failed'}
    </span>
  )
}

function Step({ label, trace }: { label: string; trace: NodeRunTrace }) {
  const s = trace.status
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2.5 py-2">
      <span className={clsx('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', s === 'ok' ? 'bg-ok/15 text-ok' : s === 'error' ? 'bg-crimson-soft text-crimson-hi' : s === 'running' ? 'text-info' : 'text-dim')}>
        {s === 'running' ? <Loader2 size={12} className="animate-spin" /> : s === 'ok' ? <Check size={11} /> : s === 'error' ? <X size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />}
      </span>
      <span className={clsx('min-w-0 flex-1 truncate text-[12.5px]', s === 'skipped' ? 'text-dim' : 'text-fg')}>{label}</span>
      <span className="font-mono text-[11px] text-dim">{s === 'skipped' ? 'skipped' : trace.durationMs != null ? elapsed(trace.durationMs) : ''}</span>
    </div>
  )
}

// ─── Settings: key and model ──────────────────────────────────────────────────

function SettingsSheet({ state, onState, onClose }: { state: RunnerState; onState(s: RunnerState): void; onClose(): void }) {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="flex items-center">
          <div className="flex-1 text-[14px] font-semibold">Settings</div>
          <button onClick={onClose} aria-label="Close" className="flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-elev-2 hover:text-fg">
            <X size={14} />
          </button>
        </div>
        <Field label="Model" hint="Every step of the app uses this OpenAI model." className="mt-4">
          <Select
            value={state.model ?? ''}
            onChange={async (e) => {
              try {
                onState(await runner.setModel(e.target.value))
              } catch (err) {
                setError((err as Error).message)
              }
            }}
          >
            {!state.model && <option value="">Choose a model…</option>}
            {state.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        {error && <div className="mt-2 text-[12px] text-crimson-hi">{error}</div>}
        <div className="mt-5 flex items-center justify-between rounded-xl border border-line bg-bg px-3 py-2.5">
          <div className="text-[12.5px]">
            <div className="font-medium">OpenAI key</div>
            <div className="text-[11.5px] text-dim">Saved on this computer</div>
          </div>
          <Button
            size="sm"
            onClick={async () => {
              onState(await runner.clearKey())
              onClose()
            }}
          >
            Remove key
          </Button>
        </div>
      </div>
    </div>
  )
}
