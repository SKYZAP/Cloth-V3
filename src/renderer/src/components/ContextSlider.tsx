import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Input } from '@/components/ui'

const STOPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576]

/** 131072 → "128K", 1048576 → "1M". */
export function tokenLabel(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 104_857.6) / 10}M`
  return n >= 1000 ? `${Math.round(n / 1024)}K` : String(n)
}

/**
 * A context window picker: a slider over the usual sizes (up to `max`, the most the model takes),
 * with a box for an exact number of tokens. The slider moves `value` while dragging (`onDraft`) and
 * saves on release (`onCommit`); the box saves on Enter or when it loses focus.
 */
export function ContextSlider({
  id,
  label = 'Context window',
  hint = 'How much of a chat the model can see at once',
  value,
  saved,
  max,
  disabled,
  onDraft,
  onCommit,
  children
}: {
  id: string
  label?: ReactNode
  hint?: ReactNode
  /** What the slider shows now (follows dragging). */
  value: number
  /** The saved value, to go back to when a save is refused. */
  saved: number
  /** The most the model takes; the slider ends there. */
  max: number | null
  disabled?: boolean
  onDraft(n: number): void
  onCommit(n: number): Promise<boolean> | void
  /** Notes under the slider. */
  children?: ReactNode
}) {
  const stops = STOPS.filter((s) => !max || s <= max)
  if (max && !stops.includes(max) && max > (stops.at(-1) ?? 0)) stops.push(max)
  const index = stops.reduce((best, s, i) => (Math.abs(s - value) < Math.abs(stops[best] - value) ? i : best), 0)
  const [box, setBox] = useState(String(saved))
  useEffect(() => setBox(String(saved)), [saved])

  const save = (n: number) => {
    const r = onCommit(n)
    if (r) void r.then((ok) => !ok && onDraft(saved))
  }
  const commitSlider = () => value !== saved && save(value)
  const commitBox = () => {
    const n = Math.round(Number(box.replace(/[,_\s]/g, '')))
    if (!Number.isFinite(n) || n < 512) return setBox(String(saved))
    if (n === saved) return
    onDraft(n)
    save(n)
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="text-[12.5px] font-medium">
          {label}
        </label>
        <span className="min-w-0 flex-1 text-[12px] text-dim">{hint}</span>
        <Input
          aria-label={`${typeof label === 'string' ? label : 'Context window'} in tokens`}
          type="text"
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          className="w-[96px] tabular-nums disabled:opacity-60"
          value={box}
          disabled={disabled}
          onChange={(e) => setBox(e.target.value)}
          onBlur={commitBox}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={stops.length - 1}
        step={1}
        value={index}
        disabled={disabled}
        aria-valuetext={`${tokenLabel(stops[index])} tokens`}
        onChange={(e) => onDraft(stops[Number(e.target.value)])}
        onPointerUp={commitSlider}
        onKeyUp={commitSlider}
        onBlur={commitSlider}
        className="w-full accent-[var(--color-crimson)] disabled:opacity-50"
      />
      <div className="flex justify-between text-[11px] tabular-nums text-dim" aria-hidden="true">
        {stops.map((s) => (
          <span key={s} className={clsx(s === stops[index] && 'font-medium text-fg')}>
            {tokenLabel(s)}
          </span>
        ))}
      </div>
      {children}
    </div>
  )
}
