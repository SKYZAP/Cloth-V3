import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { ArrowsHorizontal, Brain, CaretDown, Check, Desktop, Eye, MagnifyingGlass, Star } from '@phosphor-icons/react'
import { contextIsGuess, type ModelInfo, type ModelRef, type Provider } from '@shared/types'
import { useApp } from '@/lib/store'
import { fuzzyBest } from '@/lib/fuzzy'
import { isMobile } from '@/lib/platform'
import { BottomSheet } from './BottomSheet'

const SEP = '::'
const keyOf = (r: ModelRef) => `${r.providerId}${SEP}${r.modelId}`

interface Option {
  key: string
  ref: ModelRef
  model: ModelInfo
  provider: Provider
  local: boolean
}

type FilterId = 'reasoning' | 'vision' | 'local' | 'long'
const FILTERS: { id: FilterId; label: string; icon: ReactNode; test(o: Option): boolean }[] = [
  { id: 'reasoning', label: 'Reasoning', icon: <Brain size={12} />, test: (o) => o.model.reasoning },
  { id: 'vision', label: 'Images', icon: <Eye size={12} />, test: (o) => o.model.vision },
  { id: 'local', label: 'On this PC', icon: <Desktop size={12} />, test: (o) => o.local },
  { id: 'long', label: '200k+ context', icon: <ArrowsHorizontal size={12} />, test: (o) => o.model.contextWindow >= 200_000 }
]

const isLocal = (p: Provider) => p.kind === 'openai-compatible' && /\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(p.baseUrl)
const ctxLabel = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

/**
 * Model picker: a field that turns into a search box. In the chat header (`pill`) it grows into a
 * wider search field over the header; in forms it stays in place. Filters, starred models (shared
 * through Settings) and ranked matches; a bottom sheet on the phone.
 */
export function ModelPicker({
  value,
  onChange,
  kind = 'chat',
  allowNone,
  noneLabel = 'Default model',
  className,
  pill
}: {
  value: ModelRef | null | undefined
  onChange(ref: ModelRef | null): void
  kind?: 'chat' | 'embedding' | 'image'
  allowNone?: boolean
  noneLabel?: string
  className?: string
  pill?: boolean
}) {
  const { options, starred, toggleStar } = useModelOptions(kind)
  const current = value ? options.find((o) => o.key === keyOf(value)) : undefined

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Set<FilterId>>(new Set())
  const wrap = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // Grow toward the side with room: leftwards when the field sits in the right half of the window.
  const [growLeft, setGrowLeft] = useState(true)

  const label = value ? (current ? current.model.id : `${value.modelId} (unavailable)`) : allowNone ? noneLabel : options.length ? 'Select a model…' : 'No models — add a provider'
  const show = () => {
    if (open) return
    const r = wrap.current?.getBoundingClientRect()
    if (r) setGrowLeft(r.left + r.width / 2 > window.innerWidth / 2)
    setOpen(true)
  }
  const close = () => {
    setOpen(false)
    setQuery('')
    input.current?.blur()
  }
  const pick = (ref: ModelRef | null) => {
    onChange(ref)
    close()
  }
  // Outside clicks close it (the panel lives in a portal, so check both).
  useEffect(() => {
    if (!open || isMobile) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!wrap.current?.contains(t) && !panel.current?.contains(t)) close()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const keyHandler = useRef<((e: React.KeyboardEvent) => void) | null>(null)
  const body = (
    <PickerList
      options={options}
      query={query}
      filters={kind === 'chat' ? filters : null}
      onFilters={setFilters}
      starred={starred}
      onStar={toggleStar}
      currentKey={value ? keyOf(value) : null}
      unavailable={value && !current ? value : null}
      none={allowNone ? noneLabel : null}
      onPick={pick}
      bind={(handler) => (keyHandler.current = handler)}
    />
  )

  const hasWidth = /(^|\s)(w-|min-w-|flex-1)/.test(className ?? '')
  const morph = pill && open && !isMobile
  const dot = current ? (current.local ? 'bg-info' : 'bg-fg/80') : 'bg-line-strong'

  return (
    <div ref={wrap} className={clsx('relative shrink-0', pill ? 'h-[30px]' : 'h-8', !hasWidth && 'w-full', className)}>
      <label
        className={clsx(
          'absolute top-0 flex h-full items-center gap-2 border transition-[width,border-radius,background-color,border-color] duration-300 ease-[cubic-bezier(0.22,1.2,0.36,1)]',
          growLeft ? 'right-0' : 'left-0',
          pill ? 'rounded-full pl-3 pr-2.5 text-[12px]' : 'rounded-md pl-2.5 pr-2 text-[12.5px]',
          morph ? 'z-40 !rounded-[10px] border-crimson-line bg-elev shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)]' : open ? 'border-crimson-line bg-bg' : pill ? 'border-line bg-panel hover:border-line-strong' : 'border-line bg-bg hover:border-line-strong'
        )}
        style={{ width: morph ? 'min(420px, calc(100vw - 24px))' : '100%' }}
        onClick={() => (isMobile ? setOpen(true) : input.current?.focus())}
      >
        {open && !isMobile ? <MagnifyingGlass size={13} className="shrink-0 text-dim" /> : <span className={clsx('h-2 w-2 shrink-0 rounded-full', dot)} />}
        <input
          ref={input}
          readOnly={isMobile}
          value={open && !isMobile ? query : ''}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => !isMobile && show()}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && open) {
              // Don't let the Escape also close a dialog this picker sits in.
              e.stopPropagation()
              return close()
            }
            if (e.key === 'Tab') return close()
            if (!open) show()
            keyHandler.current?.(e)
          }}
          placeholder={open && !isMobile ? 'Search models…' : label}
          aria-label={`Model: ${label}`}
          aria-expanded={open}
          aria-haspopup="listbox"
          role="combobox"
          spellCheck={false}
          autoComplete="off"
          className={clsx(
            'h-full min-w-0 flex-1 cursor-default bg-transparent outline-none',
            open && !isMobile ? 'text-fg placeholder:text-dim' : pill ? 'placeholder:text-muted' : 'placeholder:text-fg',
            !open && !value && !allowNone && 'placeholder:!text-dim'
          )}
        />
        <CaretDown size={12} className={clsx('shrink-0 text-dim transition-transform duration-200', open && 'rotate-180')} />
      </label>

      {open && !isMobile && (
        <Popover anchor={wrap} panelRef={panel} width={pill ? 420 : undefined} growLeft={growLeft}>
          {body}
        </Popover>
      )}
      {isMobile && (
        <BottomSheet open={open} onClose={close} title="Choose a model" snapPoints={[0.8]} portal>
          <div className="-mx-4">
            <div className="mx-4 mb-1 flex h-10 items-center gap-2 rounded-[10px] border border-line bg-bg px-3">
              <MagnifyingGlass size={15} className="text-dim" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models…" aria-label="Search models" className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-dim" />
            </div>
            {body}
          </div>
        </BottomSheet>
      )}
    </div>
  )
}

/** The models a picker offers, the starred ones, and starring (shared through Settings). */
function useModelOptions(kind: 'chat' | 'embedding' | 'image') {
  const providers = useApp((s) => s.providers)
  const loadProviders = useApp((s) => s.loadProviders)
  const settings = useApp((s) => s.settings)
  const loadSettings = useApp((s) => s.loadSettings)
  useEffect(() => {
    if (!providers.length) void loadProviders()
  }, [providers.length, loadProviders])
  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])
  const options = useMemo<Option[]>(() => {
    const fits = (m: ModelInfo) => (kind === 'embedding' ? m.embedding : kind === 'image' ? !!m.image : !m.embedding && !m.image)
    return providers
      .filter((p) => p.enabled)
      .flatMap((p) => p.models.filter(fits).map((m) => ({ key: `${p.id}${SEP}${m.id}`, ref: { providerId: p.id, modelId: m.id }, model: m, provider: p, local: isLocal(p) })))
  }, [providers, kind])
  const starred = settings?.starredModels ?? []
  const toggleStar = (key: string) => {
    const next = starred.includes(key) ? starred.filter((k) => k !== key) : [...starred, key]
    void useApp.getState().updateSettings({ starredModels: next })
  }
  return { options, starred, toggleStar }
}

/**
 * The chat model list on its own, for a popover that also holds other choices (the status line's
 * model and effort): a search field, filters, starred models and the ranked list.
 */
export function ModelMenu({ value, onChange, autoFocus }: { value: ModelRef | null | undefined; onChange(ref: ModelRef): void; autoFocus?: boolean }) {
  const { options, starred, toggleStar } = useModelOptions('chat')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Set<FilterId>>(new Set())
  const current = value ? options.find((o) => o.key === keyOf(value)) : undefined
  const keyHandler = useRef<((e: React.KeyboardEvent) => void) | null>(null)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-3 mt-3 flex h-8 shrink-0 items-center gap-2 rounded-[10px] border border-line bg-bg px-2.5 focus-within:border-crimson-line">
        <MagnifyingGlass size={13} className="shrink-0 text-dim" />
        <input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => keyHandler.current?.(e)}
          placeholder="Search models…"
          aria-label="Search models"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-dim focus-visible:outline-none"
        />
      </div>
      <PickerList
        options={options}
        query={query}
        filters={filters}
        onFilters={setFilters}
        starred={starred}
        onStar={toggleStar}
        currentKey={value ? keyOf(value) : null}
        unavailable={value && !current ? value : null}
        none={null}
        onPick={(ref) => ref && onChange(ref)}
        bind={(handler) => (keyHandler.current = handler)}
      />
    </div>
  )
}

/** Fixed-position panel under (or above) the field, rendered at the top level so nothing clips it. */
function Popover({ anchor, panelRef, width, growLeft, children }: { anchor: React.RefObject<HTMLDivElement | null>; panelRef: React.RefObject<HTMLDivElement | null>; width?: number; growLeft: boolean; children: ReactNode }) {
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' })
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      const w = Math.min(Math.max(width ?? r.width, 360), vw - 16)
      let left = growLeft ? r.right - w : r.left
      left = Math.max(8, Math.min(left, vw - w - 8))
      const below = vh - r.bottom - 12
      const above = r.top - 12
      const up = below < 300 && above > below
      setPos({ left, width: w, maxHeight: Math.min(480, up ? above : below), ...(up ? { bottom: vh - r.top + 6 } : { top: r.bottom + 6 }) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, width, growLeft])
  return createPortal(
    <div
      ref={panelRef}
      style={pos}
      className="fixed z-[60] flex origin-top flex-col overflow-hidden rounded-[14px] border border-line-strong bg-elev/95 shadow-[0_24px_60px_-18px_rgb(0_0_0/0.85)] backdrop-blur-xl animate-[picker-in_.22s_cubic-bezier(0.22,1.2,0.36,1)]"
      onMouseDown={(e) => e.preventDefault() /* keep focus in the search field */}
    >
      {children}
    </div>,
    document.body
  )
}

type Row = { kind: 'none' } | { kind: 'unavailable'; ref: ModelRef } | { kind: 'model'; option: Option; hits: number[] }

function PickerList({
  options,
  query,
  filters,
  onFilters,
  starred,
  onStar,
  currentKey,
  unavailable,
  none,
  onPick,
  bind
}: {
  options: Option[]
  query: string
  /** null = no filter chips (embedding / image pickers). */
  filters: Set<FilterId> | null
  onFilters(f: Set<FilterId>): void
  starred: string[]
  onStar(key: string): void
  currentKey: string | null
  unavailable: ModelRef | null
  none: string | null
  onPick(ref: ModelRef | null): void
  bind(handler: (e: React.KeyboardEvent) => void): void
}) {
  const q = query.trim()
  const rows = useMemo<Row[]>(() => {
    const active = FILTERS.filter((f) => filters?.has(f.id))
    const starRank = (o: Option) => (starred.includes(o.key) ? 0 : 1)
    const matched = options
      .filter((o) => active.every((f) => f.test(o)))
      .map((o) => ({ o, m: fuzzyBest(q, [o.model.name, o.model.id, o.provider.name]) }))
      .filter((x): x is { o: Option; m: { score: number; hits: number[] } } => !!x.m)
    if (q) matched.sort((a, b) => b.m.score - a.m.score || starRank(a.o) - starRank(b.o))
    else matched.sort((a, b) => starRank(a.o) - starRank(b.o))
    const out: Row[] = []
    if (!q && none) out.push({ kind: 'none' })
    if (!q && unavailable) out.push({ kind: 'unavailable', ref: unavailable })
    for (const x of matched) out.push({ kind: 'model', option: x.o, hits: x.m.hits })
    return out
  }, [options, q, filters, starred, none, unavailable])

  const selectedIndex = rows.findIndex((r) => (r.kind === 'none' ? currentKey === null : r.kind === 'model' ? r.option.key === currentKey : r.kind === 'unavailable'))
  const [active, setActive] = useState(0)
  useEffect(() => setActive(q ? 0 : Math.max(0, selectedIndex)), [q, rows.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRef<HTMLDivElement>(null)
  const glide = useRef<HTMLDivElement>(null)
  const rowEls = useRef<(HTMLDivElement | null)[]>([])
  useLayoutEffect(() => {
    const el = rowEls.current[active]
    const g = glide.current
    if (!g) return
    if (!el) return void (g.style.opacity = '0')
    g.style.opacity = '1'
    g.style.transform = `translateY(${el.offsetTop}px)`
    g.style.height = `${el.offsetHeight}px`
    const box = list.current
    if (box) {
      if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop - 6
      else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight + 6
    }
  }, [active, rows])

  const choose = (r: Row | undefined) => {
    if (!r) return
    onPick(r.kind === 'none' ? null : r.kind === 'unavailable' ? r.ref : r.option.ref)
  }
  bind((e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (rows.length ? (a + 1) % rows.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(rows[active])
    }
  })

  const starredOptions = starred.map((k) => options.find((o) => o.key === k)).filter((o): o is Option => !!o)

  return (
    <>
      {filters && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-2 pt-3 mobile:px-4">
          {FILTERS.map((f) => {
            const on = filters.has(f.id)
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = new Set(filters)
                  if (on) next.delete(f.id)
                  else next.add(f.id)
                  onFilters(next)
                }}
                className={clsx(
                  'flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors',
                  on ? 'border-crimson-line bg-crimson-soft text-crimson-hi' : 'border-line-strong text-muted hover:text-fg'
                )}
              >
                {f.icon}
                {f.label}
              </button>
            )
          })}
        </div>
      )}
      {!q && starredOptions.length > 0 && (
        <div className={clsx('flex gap-1.5 overflow-x-auto px-3 pb-2.5 mobile:px-4', !filters && 'pt-3')} aria-label="Starred models">
          {starredOptions.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => onPick(o.ref)}
              title={`${o.provider.name} · ${o.model.id}`}
              className={clsx('flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11.5px] transition-colors', o.key === currentKey ? 'border-crimson-line text-fg' : 'border-line bg-elev-2 text-muted hover:border-line-strong hover:text-fg')}
            >
              <Star size={11} weight="fill" className="text-warn" />
              {o.model.name}
            </button>
          ))}
        </div>
      )}
      <div ref={list} role="listbox" aria-label="Models" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-line px-1.5 py-1.5 mobile:max-h-none">
        <div ref={glide} className="pointer-events-none absolute left-1.5 right-1.5 top-0 rounded-[10px] bg-hover shadow-[inset_0_0_0_1px_var(--color-line-strong)] transition-[transform,height,opacity] duration-300 ease-[cubic-bezier(0.22,1.2,0.36,1)]" />
        {rows.map((r, i) => (
          <div
            key={r.kind === 'model' ? r.option.key : r.kind}
            ref={(el) => void (rowEls.current[i] = el)}
            role="option"
            aria-selected={i === selectedIndex}
            onMouseMove={() => i !== active && setActive(i)}
            onClick={() => choose(r)}
            className="relative flex min-h-[38px] cursor-default items-center gap-2.5 rounded-[10px] px-2 py-1.5 mobile:min-h-[48px]"
          >
            <span className="w-3.5 shrink-0 text-crimson-hi">{i === selectedIndex && <Check size={13} weight="bold" />}</span>
            {r.kind === 'none' ? (
              <span className="flex-1 text-[12.5px] text-muted">{none}</span>
            ) : r.kind === 'unavailable' ? (
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">{r.ref.modelId} (unavailable)</span>
            ) : (
              <ModelRow option={r.option} hits={r.hits} starred={starred.includes(r.option.key)} onStar={() => onStar(r.option.key)} selected={i === selectedIndex} />
            )}
          </div>
        ))}
        {!rows.length && (
          <div className="px-4 py-7 text-center text-[12px] text-dim">
            {options.length ? (filters?.size ? 'No model matches all of these. Turn a filter off to see more.' : `No model matches “${q}”.`) : 'No models yet. Add a provider on the Models page.'}
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-dim mobile:hidden">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> use
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Star size={11} /> star to pin
        </span>
      </div>
    </>
  )
}

function ModelRow({ option, hits, starred, onStar, selected }: { option: Option; hits: number[]; starred: boolean; onStar(): void; selected: boolean }) {
  const m = option.model
  const guess = contextIsGuess(m)
  return (
    <>
      <span className="min-w-0 flex-1 truncate">
        <span className={clsx('text-[12.5px]', selected ? 'font-semibold text-fg' : 'text-fg')}>
          <Highlight text={m.name} hits={hits} />
        </span>
        {m.name !== m.id && <span className="ml-2 font-mono text-[10.5px] text-dim">{m.id}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {m.reasoning && <Brain size={12} className="text-dim" aria-label="Reasoning" />}
        {m.vision && <Eye size={12} className="text-dim" aria-label="Reads images" />}
        <span className="rounded border border-line px-1 text-[10px] text-dim">{option.provider.name}</span>
        <span className={clsx('w-10 text-right font-mono text-[10.5px] tabular-nums', guess ? 'text-warn' : 'text-muted')} title={guess ? "Estimated — the provider doesn't report this model's context size" : 'Context window'}>
          {guess ? '≈' : ''}
          {ctxLabel(m.contextWindow)}
        </span>
        <button
          type="button"
          aria-pressed={starred}
          aria-label={starred ? `Unstar ${m.name}` : `Star ${m.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onStar()
          }}
          className={clsx('flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-elev-2', starred ? 'text-warn' : 'text-dim hover:text-warn')}
        >
          <Star size={12} weight={starred ? 'fill' : 'regular'} />
        </button>
      </span>
    </>
  )
}

function Highlight({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>
  const set = new Set(hits)
  return (
    <>
      {[...text].map((c, i) =>
        set.has(i) ? (
          <span key={i} className="font-semibold text-crimson-hi">
            {c}
          </span>
        ) : (
          c
        )
      )}
    </>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-line-strong bg-elev-2 px-1 font-mono text-[10px] text-muted">{children}</kbd>
}
