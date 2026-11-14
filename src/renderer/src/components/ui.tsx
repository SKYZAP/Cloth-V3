import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import clsx from 'clsx'
import { Loader2, X } from 'lucide-react'
import { isMobile, useSideBySide } from '@/lib/platform'
import { useBackHandler } from '@/lib/back'
import { SplitBack } from './SplitView'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'

const variants: Record<Variant, string> = {
  // Disabled turns grey rather than faded crimson, so it can't be mistaken for a ready primary button.
  primary: 'bg-crimson text-white hover:bg-crimson-hi shadow-[0_0_0_1px_rgb(255_255_255/0.06)_inset] disabled:bg-elev-2 disabled:text-dim disabled:shadow-none disabled:opacity-100',
  secondary: 'bg-elev-2 text-fg border border-line hover:bg-hover hover:border-line-strong',
  outline: 'border border-line text-muted hover:text-fg hover:border-line-strong hover:bg-elev',
  ghost: 'text-muted hover:text-fg hover:bg-elev-2',
  danger: 'text-danger-hi border border-danger-line hover:bg-danger-soft'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors whitespace-nowrap disabled:opacity-45 disabled:cursor-not-allowed cursor-default',
        size === 'sm' ? 'h-7 px-2.5 text-caption' : 'h-8 px-3 text-ui',
        variants[variant],
        className
      )}
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40',
        active ? 'bg-elev-2 text-fg' : 'text-dim hover:text-fg hover:bg-elev-2',
        className
      )}
    />
  )
}

const hasWidth = (c?: string) => !!c && /(^|\s)w-/.test(c)

const fieldBase =
  'rounded-md border border-line bg-panel px-2.5 text-ui text-fg placeholder:text-dim transition-colors focus:border-crimson-line focus:outline-none focus:ring-2 focus:ring-crimson-soft'

export function Input({ className, ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return <input {...rest} ref={ref} className={clsx(fieldBase, 'h-8', !hasWidth(className) && 'w-full', className)} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={clsx(fieldBase, 'py-2 leading-relaxed resize-y', !hasWidth(className) && 'w-full', className)} />
}

export function Select({ className, children, pill, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { pill?: boolean }) {
  return (
    <select
      {...rest}
      className={clsx(
        pill
          ? 'h-[30px] rounded-full border border-line bg-panel pl-3 text-caption text-muted transition-colors hover:border-line-strong hover:text-fg focus:border-crimson-line focus:outline-none'
          : clsx(fieldBase, 'h-8'),
        !hasWidth(className) && 'w-full',
        'pr-7 appearance-none bg-[length:12px] bg-[right_8px_center] bg-no-repeat',
        className
      )}
      style={{ backgroundImage: CHEVRON }}
    >
      {children}
    </select>
  )
}
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236c6c76' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`

export function Switch({ checked, onChange, label, ariaLabel, disabled }: { checked: boolean; onChange(v: boolean): void; label?: ReactNode; /** Its name when no visible label says it (a row label beside it). */ ariaLabel?: string; disabled?: boolean }) {
  return (
    <label className={clsx('inline-flex items-center gap-2 select-none', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-[18px] w-8 rounded-full transition-colors', checked ? 'bg-crimson' : 'bg-line-strong')}
      >
        <span className={clsx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all', checked ? 'left-[16px]' : 'left-[2px]')} />
      </button>
      {label && <span className="text-ui text-muted">{label}</span>}
    </label>
  )
}

type Tone = 'neutral' | 'crimson' | 'danger' | 'ok' | 'warn' | 'info' | 'dim'
const tones: Record<Tone, string> = {
  neutral: 'bg-elev-2 text-muted border-line',
  crimson: 'bg-crimson-soft text-crimson-text border-crimson-line',
  danger: 'bg-danger-soft text-danger-hi border-danger-line',
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  info: 'bg-info/10 text-info border-info/30',
  dim: 'bg-transparent text-dim border-line'
}

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center gap-1 rounded border px-1.5 py-px text-micro font-medium leading-4 whitespace-nowrap', tones[tone], className)}>
      {children}
    </span>
  )
}

export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  const color = { neutral: 'bg-dim', crimson: 'bg-crimson', danger: 'bg-danger', ok: 'bg-ok', warn: 'bg-warn', info: 'bg-info', dim: 'bg-line-strong' }[tone]
  return <span className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', color, pulse && 'pulse-crimson')} />
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={clsx('rounded-lg border border-line bg-panel', className)}>
      {children}
    </div>
  )
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('flex flex-col gap-1.5', className)}>
      <span className="text-caption font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-caption text-dim">{hint}</span>}
    </label>
  )
}

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange(v: NoInfer<T>): void; items: { value: NoInfer<T>; label: ReactNode }[]; className?: string }) {
  return (
    <div className={clsx('flex items-center gap-1 border-b border-line', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={clsx(
            'relative -mb-px flex h-9 items-center gap-1.5 px-3 text-ui font-medium transition-colors',
            value === it.value ? 'text-fg' : 'text-dim hover:text-muted'
          )}
        >
          {it.label}
          {value === it.value && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-crimson" />}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({ value, onChange, items }: { value: T; onChange(v: NoInfer<T>): void; items: { value: NoInfer<T>; label: ReactNode; title?: string }[] }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
      {items.map((it) => (
        <button
          key={it.value}
          title={it.title}
          aria-pressed={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx('h-7 rounded px-2.5 text-caption font-medium transition-colors', value === it.value ? 'bg-elev-2 text-fg shadow-sm' : 'text-dim hover:text-muted')}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose(): void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useBackHandler(open, onClose)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] mobile:items-end" onMouseDown={onClose}>
      <div
        className="flex max-h-[85vh] flex-col rounded-[10px] border border-line-strong bg-panel shadow-2xl shadow-black/60 mobile:max-h-[92vh] mobile:w-full mobile:rounded-b-none mobile:rounded-t-[22px] mobile:border-x-0 mobile:border-b-0 mobile:pb-[var(--safe-bottom)]"
        style={isMobile ? undefined : { width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-body font-semibold">{title}</div>
          <IconButton onClick={onClose} aria-label="Close">
            <X size={15} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && <div className="flex h-11 w-11 items-center justify-center rounded-[10px] border border-line bg-elev text-muted">{icon}</div>}
      <div className="text-body font-semibold">{title}</div>
      {children && <div className="max-w-sm text-ui text-dim">{children}</div>}
      {action}
    </div>
  )
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={clsx('animate-spin text-dim', className)} />
}

/** The one title style for top-level pages (Dashboard, Boards, Agents, …): no description under it. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={clsx('truncate text-title font-semibold tracking-tight', className)}>{children}</h1>
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-3.5 px-5 mobile:flex-wrap mobile:gap-x-2 mobile:gap-y-2.5 mobile:px-3 mobile:py-3">
      <SplitBack />
      <div className="min-w-0 mobile:flex-1">
        <div className="truncate text-section font-semibold tracking-tight">{title}</div>
        {subtitle && <div className="truncate text-caption text-dim mobile:whitespace-normal">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 mobile:w-full mobile:shrink mobile:flex-wrap">{actions}</div>}
    </div>
  )
}

/** Left-hand list column used by several pages. */
/** A list beside its detail. `frame`: the list sits on the window frame (no surface or divider of its own), beside a detail drawn as its own card. */
export function ListPane({ header, children, width = 272, frame = false }: { header: ReactNode; children: ReactNode; width?: number; frame?: boolean }) {
  const side = useSideBySide()
  const onFrame = frame && side
  if (onFrame)
    // On the grey frame: a raised card with a gap around it, so it doesn't merge with the sidebar.
    // Inside, hover and selected shades step up one level so rows still show against the card.
    return (
      <div className="flex h-full shrink-0 flex-col pb-2 pr-2" style={{ width }}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden raised rounded-xl border border-line">
          <div className="px-2 pb-2.5 pt-2">{header}</div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">{children}</div>
        </div>
      </div>
    )
  return (
    <div className={clsx('flex h-full shrink-0 flex-col', side ? 'border-r border-line bg-panel' : 'w-full bg-bg')} style={side ? { width } : undefined}>
      <div className="border-b border-line p-3">{header}</div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{children}</div>
    </div>
  )
}

export function ListItem({ active, onClick, children, className }: { active?: boolean; onClick?(): void; children: ReactNode; className?: string }) {
  // A narrow phone shows the list on its own, so nothing reads as selected there.
  const side = useSideBySide()
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-current={active && side ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={(e) => onClick && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), onClick())}
      className={clsx(
        'group relative mx-0.5 my-0.5 flex cursor-default items-center gap-2 rounded-[10px] py-2.5 pl-3 pr-2 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-crimson-line mobile:min-h-[56px] mobile:gap-3 mobile:py-3 mobile:text-body',
        active && side ? 'bg-elev-2 text-fg shadow-[inset_0_0_0_1px_var(--color-line-strong)]' : 'text-muted hover:bg-elev hover:text-fg mobile:text-fg active:bg-elev-2',
        className
      )}
    >
      {children}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line bg-elev px-1 font-mono text-micro text-dim">{children}</kbd>
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  return (
    <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(text)}>
      {label}
    </Button>
  )
}

export { chooseAction, confirmAction, type ConfirmChoice, type ConfirmOptions } from './ConfirmDialog'
