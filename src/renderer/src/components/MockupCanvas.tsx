import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ArrowLeft, CaretLeft, CaretRight, DesktopTower, DeviceMobile, DownloadSimple, Minus, PaperPlaneRight, Play, Plus, SlidersHorizontal } from '@phosphor-icons/react'
import { tweakValues, type MockupBoard, type MockupInfo, type MockupTweak, type Swatch } from '@shared/swatches'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { drain, enqueue } from '@/lib/queue'
import { Button, IconButton, Segmented, Switch } from './ui'

type Values = Record<string, string | number | boolean>

const GAP = 56
const PAD = 40
const PHONE = 390

/**
 * A mockup on its canvas: every board side by side (All boards), or one board full size with its controls working
 * and its Tweaks (Play). Boards are the served pages, in sandboxed frames; tweak values reach them by postMessage.
 */
export function MockupCanvas({ swatch, base, compact }: { swatch: Swatch; /** The swatch's link (this PC's, or a network one on a phone). */ base: string; compact?: boolean }) {
  const [info, setInfo] = useState<MockupInfo | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tweaks, setTweaks] = useState<Record<string, Values>>({})

  // A new version published while it's open shows at once, unless an older one was picked.
  useEffect(() => {
    let live = true
    api.swatches.mockup(swatch.id, version ?? undefined).then(
      (m) => live && (setInfo(m), setError(null)),
      (e) => live && setError(e instanceof Error ? e.message : String(e))
    )
    return () => {
      live = false
    }
  }, [swatch.id, swatch.version, version])

  const boards = info?.boards ?? []
  const board = boards.find((b) => b.name === playing) ?? null
  const src = (b: MockupBoard) => `${base}/b/${b.name}?v=${info?.version ?? swatch.version}`
  const valuesOf = (b: MockupBoard) => tweakValues(b, tweaks[b.name])

  if (error) return <div className="grid h-full place-items-center p-6 text-center text-ui text-dim">{error}</div>
  if (!info) return <div className="grid h-full place-items-center text-caption text-dim">Loading…</div>

  const versions = info.versions
  const latest = version === null

  const exportBoards = async (names: string[]) => {
    const ok = await attempt(() => api.swatches.exportBoards(swatch.id, { names, version: info.version, tweaks: Object.fromEntries(names.map((n) => [n, valuesOf(boards.find((b) => b.name === n)!)])) }))
    if (ok) useApp.getState().toast(names.length === 1 ? 'Board exported' : `${names.length} boards exported`, 'ok')
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        {board ? (
          <Button size="sm" icon={<ArrowLeft size={13} />} onClick={() => setPlaying(null)}>
            All boards
          </Button>
        ) : (
          <span className="text-caption text-dim">
            {boards.length} board{boards.length === 1 ? '' : 's'}
          </span>
        )}
        {versions.length > 1 && (
          <select
            aria-label="Version"
            value={latest ? 'latest' : String(version)}
            onChange={(e) => setVersion(e.target.value === 'latest' ? null : Number(e.target.value))}
            className="h-7 rounded-lg border border-line-strong bg-panel px-2 text-caption text-muted"
          >
            <option value="latest">Version {versions[versions.length - 1]} (latest)</option>
            {versions
              .slice(0, -1)
              .reverse()
              .map((v) => (
                <option key={v} value={v}>
                  Version {v}
                </option>
              ))}
          </select>
        )}
        {info.design && <span className="truncate text-caption text-dim">Design: {info.design}</span>}
        <div className="flex-1" />
        {!board && (
          <>
            <Button size="sm" variant="primary" icon={<Play size={12} weight="fill" />} disabled={!boards.length} onClick={() => setPlaying(selected ?? boards[0].name)}>
              Play
            </Button>
            <Button size="sm" icon={<DownloadSimple size={13} />} onClick={() => void exportBoards(selected ? [selected] : boards.map((b) => b.name))}>
              {selected ? 'Export board' : 'Export all'}
            </Button>
          </>
        )}
      </div>
      {board ? (
        <PlayView
          key={`${board.name}:${info.version}`}
          board={board}
          src={src(board)}
          values={valuesOf(board)}
          compact={compact}
          onValues={(v) => setTweaks((t) => ({ ...t, [board.name]: v }))}
          onStep={(d) => {
            const i = boards.indexOf(board)
            setPlaying(boards[(i + d + boards.length) % boards.length].name)
          }}
          count={boards.length}
          index={boards.indexOf(board)}
          onExport={() => void exportBoards([board.name])}
        />
      ) : (
        <Board boards={boards} src={src} selected={selected} onSelect={setSelected} onPlay={setPlaying} />
      )}
      {swatch.sessionId && <AskBar sessionId={swatch.sessionId} title={swatch.title} board={board ?? boards.find((b) => b.name === selected) ?? null} version={info.version} />}
    </div>
  )
}

/** Every board at once, scaled to fit the width (zoom with the buttons); click to select, double-click to play. */
function Board({ boards, src, selected, onSelect, onPlay }: { boards: MockupBoard[]; src(b: MockupBoard): string; selected: string | null; onSelect(n: string | null): void; onPlay(n: string): void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  // Fit: two boards to a row when there's room, else one.
  const fit = useMemo(() => {
    if (!width || !boards.length) return 0.25
    const widest = Math.max(...boards.map((b) => b.width))
    const perRow = boards.length > 1 && width > 900 ? 2 : 1
    return Math.max(0.08, Math.min(1, (width - PAD * 2 - GAP * (perRow - 1)) / (widest * perRow)))
  }, [width, boards])
  const scale = zoom ?? fit
  const step = (d: number) => setZoom(Math.max(0.08, Math.min(1.5, Math.round((scale + d) * 100) / 100)))

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onClick={(e) => e.target === e.currentTarget && onSelect(null)}
        className="absolute inset-0 overflow-auto bg-[radial-gradient(var(--color-line)_1px,transparent_1px)] [background-size:22px_22px]"
      >
        <div className="flex flex-wrap content-start items-start" style={{ gap: GAP * Math.max(scale, 0.4), padding: PAD }} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
          {boards.map((b) => (
            <div key={b.name} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-caption">
                <span className={clsx('truncate', selected === b.name ? 'text-fg' : 'text-muted')} style={{ maxWidth: Math.max(120, b.width * scale) }}>
                  {b.title}
                </span>
                {b.interactive && <span className="rounded-full bg-[#6cb2ec]/15 px-1.5 text-micro text-[#8cc4f0]">Play</span>}
              </div>
              <button
                type="button"
                aria-label={`${b.title}: select, double-click to play`}
                aria-pressed={selected === b.name}
                onClick={() => onSelect(b.name)}
                onDoubleClick={() => onPlay(b.name)}
                className={clsx('relative block overflow-hidden rounded-md border bg-white text-left outline-offset-[3px]', selected === b.name ? 'border-crimson outline outline-2 outline-crimson' : 'border-line-strong hover:border-muted')}
                style={{ width: b.width * scale, height: b.height * scale }}
              >
                <iframe
                  src={src(b)}
                  title={b.title}
                  loading="lazy"
                  tabIndex={-1}
                  sandbox="allow-scripts allow-forms"
                  className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
                  style={{ width: b.width, height: b.height, transform: `scale(${scale})` }}
                />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-lg border border-line-strong bg-panel p-0.5 shadow-lg">
        <IconButton aria-label="Zoom out" title="Zoom out" onClick={() => step(-0.1)}>
          <Minus size={13} />
        </IconButton>
        <button type="button" onClick={() => setZoom(null)} title="Fit to the window" className="w-12 font-mono text-caption tabular-nums text-muted hover:text-fg">
          {Math.round(scale * 100)}%
        </button>
        <IconButton aria-label="Zoom in" title="Zoom in" onClick={() => step(0.1)}>
          <Plus size={13} />
        </IconButton>
      </div>
    </div>
  )
}

/** One board, full size (shrunk to fit), its controls working, with its Tweaks beside it. */
function PlayView({
  board,
  src,
  values,
  compact,
  onValues,
  onStep,
  count,
  index,
  onExport
}: {
  board: MockupBoard
  src: string
  values: Values
  compact?: boolean
  onValues(v: Values): void
  onStep(d: number): void
  count: number
  index: number
  onExport(): void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const [phone, setPhone] = useState(false)
  const [run, setRun] = useState(0)
  const [panel, setPanel] = useState(!compact && board.tweaks.length > 0)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const w = phone ? PHONE : board.width
  const h = board.height
  const scale = box.w ? Math.min(1, (box.w - 48) / w, (box.h - 48) / h) : 1

  // The board gets the values on load and on every change.
  const send = () => frame.current?.contentWindow?.postMessage({ type: 'cloth:tweaks', values }, '*')
  useEffect(send, [values]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
          <IconButton aria-label="Previous board" title="Previous board" disabled={count < 2} onClick={() => onStep(-1)}>
            <CaretLeft size={14} />
          </IconButton>
          <span className="min-w-0 truncate text-ui font-medium text-fg">{board.title}</span>
          <span className="shrink-0 text-caption text-dim">
            {index + 1} of {count}
          </span>
          <IconButton aria-label="Next board" title="Next board" disabled={count < 2} onClick={() => onStep(1)}>
            <CaretRight size={14} />
          </IconButton>
          <div className="flex-1" />
          <Segmented
            value={phone ? 'phone' : 'desktop'}
            onChange={(v) => setPhone(v === 'phone')}
            items={[
              { value: 'desktop', label: <DesktopTower size={14} aria-label={`${board.width} px`} />, title: `Its own width: ${board.width} px` },
              { value: 'phone', label: <DeviceMobile size={14} aria-label={`${PHONE} px`} />, title: `A phone's width: ${PHONE} px` }
            ]}
          />
          <IconButton aria-label="Restart" title="Restart the board" onClick={() => setRun((n) => n + 1)}>
            <ArrowClockwise size={14} />
          </IconButton>
          <IconButton aria-label="Export this board as a PNG" title="Export as PNG (with these tweaks)" onClick={onExport}>
            <DownloadSimple size={14} />
          </IconButton>
          {board.tweaks.length > 0 && (
            <IconButton aria-label="Tweaks" title="Tweaks" active={panel} aria-pressed={panel} onClick={() => setPanel(!panel)}>
              <SlidersHorizontal size={14} />
            </IconButton>
          )}
        </div>
        <div ref={area} className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(var(--color-line)_1px,transparent_1px)] [background-size:22px_22px]">
          <div className="absolute left-1/2 top-6 overflow-hidden rounded-lg border border-line-strong bg-white shadow-2xl" style={{ width: w * scale, height: h * scale, transform: 'translateX(-50%)' }}>
            <iframe
              key={`${run}:${phone}`}
              ref={frame}
              src={src}
              title={board.title}
              onLoad={send}
              sandbox="allow-scripts allow-forms allow-modals"
              className="absolute left-0 top-0 origin-top-left border-0"
              style={{ width: w, height: h, transform: `scale(${scale})` }}
            />
          </div>
        </div>
      </div>
      {panel && board.tweaks.length > 0 && (
        <aside aria-label="Tweaks" className="flex w-[260px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel p-4 mobile:w-[220px]">
          <div className="flex items-center">
            <span className="text-ui font-semibold text-fg">Tweaks</span>
            <div className="flex-1" />
            <button type="button" onClick={() => onValues(tweakValues(board))} className="text-caption text-dim hover:text-fg">
              Reset
            </button>
          </div>
          {board.tweaks.map((t) => (
            <TweakControl key={t.key} tweak={t} value={values[t.key]} onChange={(v) => onValues({ ...values, [t.key]: v })} />
          ))}
          <p className="mt-auto text-caption leading-snug text-dim">Tweaks change only what you see here. Ask Cloth to keep a change and it publishes a new version.</p>
        </aside>
      )}
    </div>
  )
}

function TweakControl({ tweak: t, value, onChange }: { tweak: MockupTweak; value: string | number | boolean; onChange(v: string | number | boolean): void }) {
  const id = `tweak-${t.key}`
  if (t.kind === 'boolean')
    return (
      <div className="flex items-center gap-2">
        <span className="flex-1 text-caption text-muted">{t.label}</span>
        <Switch checked={value === true} onChange={onChange} ariaLabel={t.label} />
      </div>
    )
  if (t.kind === 'enum')
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-caption text-muted">{t.label}</span>
        <div role="group" aria-label={t.label} className="flex flex-wrap gap-1">
          {(t.options ?? []).map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={value === o}
              onClick={() => onChange(o)}
              className={clsx('h-7 rounded-md border px-2 text-caption transition-colors', value === o ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line-strong text-muted hover:text-fg')}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    )
  if (t.kind === 'range')
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="flex text-caption text-muted">
          <span className="flex-1">{t.label}</span>
          <span className="font-mono tabular-nums text-fg">{String(value)}</span>
        </label>
        <input id={id} type="range" min={t.min} max={t.max} step={t.step} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} className="accent-[var(--color-crimson)]" />
      </div>
    )
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="flex-1 text-caption text-muted">
        {t.label}
      </label>
      <span className="font-mono text-caption text-dim">{String(value)}</span>
      <input id={id} type="color" value={String(value)} onChange={(e) => onChange(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-line-strong bg-transparent" />
    </div>
  )
}

/** Ask the chat that made the mockup for a change, naming the board on screen. Queued if the chat is busy. */
function AskBar({ sessionId, title, board, version }: { sessionId: string; title: string; board: MockupBoard | null; version: number }) {
  const [text, setText] = useState('')
  const send = () => {
    const t = text.trim()
    if (!t) return
    const where = board ? `the board "${board.name}" (${board.title}) of the mockup “${title}”, version ${version}` : `the mockup “${title}”, version ${version}`
    enqueue(sessionId, { text: `About ${where}: ${t}`, skills: [], agents: [], attachments: [] })
    void drain(sessionId)
    setText('')
    useApp.getState().openChatById(sessionId)
  }
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <label htmlFor="mockup-ask" className="shrink-0 text-caption text-dim">
        {board ? `On ${board.title}:` : 'On this mockup:'}
      </label>
      <input
        id="mockup-ask"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask Cloth to change it…"
        className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-panel px-2.5 text-ui text-fg placeholder:text-dim focus:border-crimson-line focus:outline-none"
      />
      <Button size="sm" variant="primary" type="submit" disabled={!text.trim()} icon={<PaperPlaneRight size={13} />}>
        Send to chat
      </Button>
    </form>
  )
}

/** Thumbnails of a mockup's boards at a version; null until made (they're made in the background). */
export function useThumbs(id: string, version?: number): Record<string, string | null> | null {
  const [thumbs, setThumbs] = useState<Record<string, string | null> | null>(null)
  const load = () => void api.swatches.thumbs(id, version).then(setThumbs, () => setThumbs({}))
  useEffect(load, [id, version]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('swatches', (e) => {
    if (e.type === 'thumbs' && e.id === id) load()
  })
  return thumbs
}
