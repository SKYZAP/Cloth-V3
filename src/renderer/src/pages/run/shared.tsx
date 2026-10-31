import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, Check, Copy } from '@phosphor-icons/react'
import type { HubFit, RunDevice, RunEvent, Runner, RunnerStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { Button, IconButton, Input, Select, Spinner } from '@/components/ui'

export type Progress = Extract<RunEvent, { type: 'progress' }>
export type Kind = Progress['kind']

export const GB = 1024 ** 3
export const MiB = 1024 ** 2

const narrowQuery = window.matchMedia('(max-width: 760px)')
const subscribeNarrow = (cb: () => void) => {
  narrowQuery.addEventListener('change', cb)
  return () => narrowQuery.removeEventListener('change', cb)
}
/** Too narrow for the list beside the detail: the detail opens in an inspector instead. */
export function useNarrow(): boolean {
  const narrow = useSyncExternalStore(subscribeNarrow, () => narrowQuery.matches)
  return isMobile || narrow
}

export const stopped = (id: string): RunnerStatus => ({ id, state: 'stopped' })
export const live = (s: RunnerStatus) => s.state === 'running' || s.state === 'starting'
export const progressKey = (kind: Kind, id: string) => `${kind}:${id}`
export const active = (p: Progress | undefined) => (p && (p.state === 'downloading' || p.state === 'extracting') ? p : null)
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function fileSize(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`
  return `${Math.max(1, Math.round(n / MiB))} MB`
}

/** 8.2e9 → "8B", 1.5e9 → "1.5B", 270e6 → "270M". */
export function paramCount(n: number | null): string | null {
  if (!n) return null
  if (n >= 1e9) return `${n >= 1e10 ? Math.round(n / 1e9) : Math.round(n / 1e8) / 10}B`
  return `${Math.round(n / 1e6)}M`
}

/** 131072 → "128K". */
export function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1024)}K` : String(n)
}

export function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export const FIT: Record<HubFit, { label: string; tone: string }> = {
  gpu: { label: 'Fits on the GPU', tone: 'border-ok/30 bg-ok/10 text-ok' },
  ram: { label: 'Needs system memory', tone: 'border-warn/30 bg-warn/10 text-warn' },
  'too-big': { label: 'Too big for this PC', tone: 'border-danger-line bg-danger-soft text-danger-hi' }
}

export function FitPill({ fit, className }: { fit: HubFit; className?: string }) {
  return <span className={clsx('inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap', FIT[fit].tone, className)}>{FIT[fit].label}</span>
}

export function Section({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-[12px] border border-line bg-elev', className)}>
      {title && (
        <div className="flex min-h-[38px] items-center gap-2 border-b border-line px-3.5 py-2">
          <h2 className="min-w-0 flex-1 text-[12.5px] font-semibold">{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

export function Row({ label, children, top }: { label: ReactNode; children: ReactNode; top?: boolean }) {
  return (
    <>
      <span className={clsx('text-[12px] text-muted', top && 'self-start pt-1.5')}>{label}</span>
      <div className="min-w-0">{children}</div>
    </>
  )
}

/** A text box that saves when it loses focus (or on Enter); a refused value goes back to the saved one. */
export function CommitInput({ value, onCommit, ...rest }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onCommit(v: string): Promise<boolean> }) {
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

export function PathRow({ value, locked, onChoose, onClear, extra }: { value: string | null; locked: boolean; onChoose(): void; onClear?(): void; extra?: ReactNode }) {
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

export function ProgressBar({ p, onCancel, label }: { p: Progress; onCancel?(): void; label?: ReactNode }) {
  const pct = p.total > 0 ? Math.min(100, (p.received / p.total) * 100) : 0
  const text =
    p.state === 'extracting'
      ? `Unpacking${p.file ? ` ${p.file}` : ''}…`
      : `${p.file ? `${p.file.split('/').pop()} · ` : ''}${fileSize(p.received)}${p.total > 0 ? ` of ${fileSize(p.total)}` : ''}`
  return (
    <div className="grid gap-1.5">
      {label && <div className="text-[12px] font-medium">{label}</div>}
      <div className="flex items-center gap-2">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <div className={clsx('h-full rounded-full bg-crimson transition-[width] motion-reduce:transition-none', p.state === 'extracting' && 'animate-pulse')} style={{ width: `${p.state === 'extracting' ? 100 : pct}%` }} />
        </div>
        <span className="w-10 shrink-0 text-right text-[11.5px] tabular-nums text-dim">{p.state === 'extracting' ? '' : `${Math.floor(pct)}%`}</span>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <span className="truncate text-[11.5px] tabular-nums text-dim" translate="no">
        {text}
      </span>
    </div>
  )
}

export function Devices({ runner, locked, onSelect }: { runner: Runner; locked: boolean; onSelect(device: string | null): void }) {
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
    <div className="flex min-w-0 items-center gap-2">
      <Select aria-label="GPU" value={runner.device ?? ''} disabled={locked} className="min-w-0 flex-1 disabled:opacity-60" onChange={(e) => onSelect(e.target.value || null)}>
        <option value="">Default (llama.cpp decides)</option>
        {runner.device && !known && <option value={runner.device}>{runner.device}</option>}
        {devices?.map((d) => (
          <option key={d.id} value={d.id}>
            {d.id}: {d.description} ({Math.round(d.totalMiB / 1024)} GB)
          </option>
        ))}
      </Select>
      <IconButton aria-label="Refresh devices" title="Refresh devices" disabled={!runner.serverPath || loading} onClick={() => void load(true)}>
        {loading ? <Spinner size={13} /> : <ArrowClockwise size={14} />}
      </IconButton>
    </div>
  )
}

const MAX_LINES = 2000

/** `tall`: in a wide layout the log fills the window's height. */
export function LogCard({ id, tall }: { id: string; tall?: boolean }) {
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
    <Section
      title="Log"
      aside={
        <Button size="sm" variant="ghost" icon={copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />} disabled={!lines.length} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      }
    >
      <div
        ref={box}
        role="log"
        aria-label="llama-server output"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className={clsx('selectable max-h-[280px] overflow-y-auto overscroll-contain px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-crimson-line', tall && lines.length > 0 && '@[1040px]:h-[calc(100vh-330px)] @[1040px]:max-h-none')}
        translate="no"
      >
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all">
            {line || ' '}
          </div>
        ))}
        {!lines.length && <p className="font-sans text-[12px] text-dim">Nothing yet. The runner’s output shows here once it starts.</p>}
      </div>
    </Section>
  )
}
