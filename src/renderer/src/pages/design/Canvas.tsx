import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Cube, Plus, SquaresFour } from '@phosphor-icons/react'
import { sanitizeComponentCss, sanitizeComponentHtml, SPECIMEN_CSS, toCss, type DesignInput } from '@shared/design'
import { kitCss } from '@shared/kit'
import { elementAt, pathOf, samePath, type Path } from './htmlEdit'

export type CanvasTheme = 'dark' | 'light' | 'both'

export interface FrameSpec {
  key: string
  kind: 'kit' | 'custom'
  title: string
  html: string
  css: string
  warn?: boolean
}

export interface Selection {
  frame: string
  path: Path | null
}

export interface CanvasHandle {
  fit(): void
  zoomBy(f: number): void
  /** Pan so a frame is in view (zooming in a little if the board is very small). */
  reveal(key: string): void
  /** The selected element in the first visible copy of the frame (for computed styles). */
  element(frame: string, path: Path): Element | null
}

const GAP = 48
const SECTION = 56

// ─── Frame ────────────────────────────────────────────────────────────────────

/** A component preview. Styles and markup are written into the frame directly, so edits don't reload it. */
function Frame({ input, html, css, theme, width, fontCss, editing, onHeight, setDoc }: { input: DesignInput; html: string; css: string; theme: 'light' | 'dark'; width: number; fontCss: string; editing: boolean; onHeight(h: number): void; setDoc(d: Document | null): void }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const skeleton = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><style data-fonts></style><style data-tokens></style><style>${SPECIMEN_CSS}\nhtml,body{overflow:hidden}</style><style data-kit></style><style data-component></style></head><body></body></html>`,
    []
  )
  const doc = () => (ready ? (ref.current?.contentDocument ?? null) : null)
  const measure = useCallback(() => {
    const d = ref.current?.contentDocument
    if (d?.body) onHeight(Math.max(80, Math.ceil(d.documentElement.scrollHeight)))
  }, [onHeight])
  const style = (sel: string, text: string) => {
    const el = doc()?.querySelector(`style[${sel}]`)
    if (el && el.textContent !== text) el.textContent = text
  }
  useEffect(() => style('data-fonts', fontCss), [ready, fontCss])
  useEffect(() => style('data-tokens', toCss(input)), [ready, input])
  useEffect(() => style('data-kit', kitCss(input.kit)), [ready, input.kit])
  useEffect(() => style('data-component', sanitizeComponentCss(css)), [ready, css])
  useEffect(() => {
    const d = doc()
    if (d) d.documentElement.setAttribute('data-theme', theme)
  }, [ready, theme])
  useEffect(() => {
    const d = doc()
    // Never replace the markup under the user's caret.
    if (!d || editing) return
    const next = sanitizeComponentHtml(html)
    if (d.body.innerHTML !== next) d.body.innerHTML = next
  }, [ready, html, editing])
  // Re-measure after every change, and once fonts arrive.
  useLayoutEffect(() => {
    if (!ready) return
    measure()
    const d = doc()
    void d?.fonts?.ready.then(measure)
    const t = setTimeout(measure, 250)
    return () => clearTimeout(t)
  })
  useEffect(() => {
    setDoc(doc())
    return () => setDoc(null)
  }, [ready])

  return <iframe ref={ref} title="Component preview" sandbox="allow-same-origin" srcDoc={skeleton} onLoad={() => setReady(true)} className={clsx('block border-0 bg-transparent', !editing && 'pointer-events-none')} style={{ width, height: '100%' }} />
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

interface Props {
  input: DesignInput
  frames: FrameSpec[]
  theme: CanvasTheme
  phone: boolean
  fontCss: string
  selection: Selection | null
  onSelect(s: Selection | null): void
  /** Commit in-place text editing: the element's new inner HTML. */
  onText(frame: string, path: Path, inner: string): void
  onDelete(frame: string, path: Path): void
  onNew(): void
  newActive: boolean
  zoomLabel(z: number): void
  /** The frames were re-rendered (elements handed out earlier may be stale). */
  onLayout(): void
}

export const Canvas = forwardRef<CanvasHandle, Props>(function Canvas({ input, frames, theme, phone, fontCss, selection, onSelect, onText, onDelete, onNew, newActive, zoomLabel, onLayout }, handle) {
  const viewport = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 40, y: 40, z: 0.75 })
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [vw, setVw] = useState(1000)
  const docs = useRef(new Map<string, Document>())
  const [hover, setHover] = useState<{ frame: string; path: Path | null } | null>(null)
  const [editing, setEditing] = useState<{ frame: string; path: Path } | null>(null)
  const [, force] = useState(0)
  const fitted = useRef(false)

  useEffect(() => zoomLabel(view.z), [view.z, zoomLabel])
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    const ro = new ResizeObserver(() => setVw(el.clientWidth))
    ro.observe(el)
    setVw(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Masonry layout per section; frame widths follow the device width and how many themes are shown.
  const single = phone ? 390 : 620
  const themes: ('light' | 'dark')[] = theme === 'both' ? ['dark', 'light'] : [theme]
  const frameW = single * themes.length + (themes.length - 1) * 16
  const cols = Math.max(1, Math.min(phone ? 4 : 3, Math.floor((Math.max(vw, 700) / 0.6 - 80) / (frameW + GAP)) || 1))
  const layout = useMemo(() => {
    const out: { key: string; x: number; y: number; w: number; h: number }[] = []
    const headers: { label: string; y: number }[] = []
    let top = 0
    for (const kind of ['kit', 'custom'] as const) {
      const list = frames.filter((f) => f.kind === kind)
      headers.push({ label: kind === 'kit' ? 'Built-in' : 'Library', y: top })
      top += SECTION
      const colH = Array.from({ length: cols }, () => top)
      const items = kind === 'custom' ? [...list.map((f) => f.key), '__new'] : list.map((f) => f.key)
      for (const key of items) {
        const c = colH.indexOf(Math.min(...colH))
        const h = key === '__new' ? 160 : (heights[key] ?? 240) + 34
        out.push({ key, x: c * (frameW + GAP), y: colH[c], w: frameW, h })
        colH[c] += h + GAP
      }
      top = Math.max(...colH) + GAP
    }
    return { frames: out, headers, width: cols * (frameW + GAP) - GAP, height: top }
  }, [frames, heights, cols, frameW])

  const fit = useCallback(() => {
    const el = viewport.current
    if (!el) return
    const z = Math.min(1, Math.max(0.2, (el.clientWidth - 64) / layout.width))
    setView({ x: Math.max(32, (el.clientWidth - layout.width * z) / 2), y: 32, z })
  }, [layout.width])
  useEffect(() => {
    if (fitted.current || !frames.length) return
    fitted.current = true
    fit()
  }, [frames.length, fit])
  // A different device width or theme layout changes the board's size: fit it again.
  const firstLayout = useRef(true)
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false
      return
    }
    fit()
  }, [phone, theme])

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const z = Math.min(2, Math.max(0.15, v.z * factor))
      return { z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z }
    })
  useImperativeHandle(handle, () => ({
    fit,
    zoomBy: (f) => {
      const el = viewport.current
      zoomAt(f, (el?.clientWidth ?? 800) / 2, (el?.clientHeight ?? 600) / 2)
    },
    reveal: (key) => {
      const el = viewport.current
      const pos = layout.frames.find((f) => f.key === key)
      if (!el || !pos) return
      setView((v) => {
        const z = Math.max(v.z, Math.min(1, (el.clientWidth - 64) / pos.w))
        return { z, x: (el.clientWidth - pos.w * z) / 2 - pos.x * z, y: 40 - pos.y * z }
      })
    },
    element: (frame, path) => {
      const d = docs.current.get(`${frame}:0`)
      return d ? elementAt(d.body, path) : null
    }
  }))

  // Wheel pans; ctrl/⌘ + wheel (and trackpad pinch) zooms at the cursor. Non-passive so the page doesn't scroll.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top)
      else setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Dragging anywhere pans; a press that doesn't move is a click (select).
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d) {
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true
      if (d.moved) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
      return
    }
    setHover(hit(e.clientX, e.clientY))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const h = hit(e.clientX, e.clientY)
    if (editing && !(h && h.frame === editing.frame && samePath(h.path, editing.path))) commitEdit()
    onSelect(h ? { frame: h.frame, path: frames.find((f) => f.key === h.frame)?.kind === 'custom' ? h.path : null } : null)
    viewport.current?.focus()
  }

  /** The frame (and element, for library components) under a screen point. */
  const hit = (cx: number, cy: number): { frame: string; path: Path | null } | null => {
    const els = document.elementsFromPoint(cx, cy)
    const host = els.find((el) => el instanceof HTMLElement && el.dataset.frameCopy) as HTMLElement | undefined
    if (!host) {
      const header = els.find((el) => el instanceof HTMLElement && el.dataset.frameHeader) as HTMLElement | undefined
      return header ? { frame: header.dataset.frameHeader!, path: null } : null
    }
    const frame = host.dataset.frameKey!
    if (frames.find((f) => f.key === frame)?.kind !== 'custom') return { frame, path: null }
    const doc = docs.current.get(`${frame}:${host.dataset.frameCopy === 'light' && theme === 'both' ? 1 : 0}`)
    if (!doc) return { frame, path: null }
    const r = host.getBoundingClientRect()
    const target = doc.elementFromPoint((cx - r.left) / view.z, (cy - r.top) / view.z)
    if (!target || target === doc.body || target === doc.documentElement) return { frame, path: null }
    // Inline SVG parts select their <svg>.
    const el = target.closest('svg') ?? target
    return { frame, path: pathOf(el, doc.body) }
  }

  // ─── In-place text editing ────────────────────────────────────────────────
  const editTarget = () => {
    if (!editing) return null
    const d = docs.current.get(`${editing.frame}:0`)
    return d ? elementAt(d.body, editing.path) : null
  }
  const original = useRef('')
  const committed = useRef(true)
  const commitEdit = (cancel = false) => {
    if (committed.current) return
    committed.current = true
    const el = editTarget() as HTMLElement | null
    const cur = editing
    setEditing(null)
    if (!el || !cur) return
    el.removeAttribute('contenteditable')
    if (cancel) el.innerHTML = original.current
    else if (el.innerHTML !== original.current) onText(cur.frame, cur.path, el.innerHTML)
  }
  const startEdit = (cx: number, cy: number) => {
    const h = hit(cx, cy)
    if (!h?.path || frames.find((f) => f.key === h.frame)?.kind !== 'custom') return
    const d = docs.current.get(`${h.frame}:0`)
    let el = d ? (elementAt(d.body, h.path) as HTMLElement | null) : null
    // Double-clicking an icon edits the text beside it.
    while (el && !el.textContent?.trim()) el = el.parentElement
    if (!el || !d || el === d.body) return
    const path = pathOf(el, d.body)
    if (!path) return
    original.current = el.innerHTML
    committed.current = false
    el.setAttribute('contenteditable', 'plaintext-only')
    el.focus()
    const r = d.defaultView?.frameElement?.getBoundingClientRect()
    const range = r ? d.caretRangeFromPoint((cx - r.left) / view.z, (cy - r.top) / view.z) : null
    if (range) {
      const sel = d.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') commitEditRef.current(true)
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        commitEditRef.current()
      }
    }
    el.addEventListener('keydown', onKey)
    el.addEventListener('blur', () => commitEditRef.current(), { once: true })
    setEditing({ frame: h.frame, path })
    onSelect({ frame: h.frame, path })
  }
  const commitEditRef = useRef(commitEdit)
  commitEditRef.current = commitEdit

  // Selection boxes are measured from the live frames, so re-measure after layout settles.
  useEffect(() => {
    const t = setTimeout(() => {
      force((n) => n + 1)
      onLayout()
    }, 60)
    return () => clearTimeout(t)
  }, [heights, selection, frames])

  const box = (frame: string, path: Path | null, copy: number) => {
    if (!path) return null
    const d = docs.current.get(`${frame}:${copy}`)
    const el = d ? elementAt(d.body, path) : null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }

  const stroke = 1.5 / view.z
  return (
    <div
      ref={viewport}
      tabIndex={0}
      className="relative min-h-0 flex-1 cursor-default touch-none overflow-hidden bg-[radial-gradient(circle,rgb(255_255_255/0.06)_1px,transparent_1px)] bg-[length:22px_22px] outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={(e) => startEdit(e.clientX, e.clientY)}
      onKeyDown={(e) => {
        if (editing) return
        if ((e.key === 'Delete' || e.key === 'Backspace') && selection?.path) {
          e.preventDefault()
          onDelete(selection.frame, selection.path)
        }
        if (e.key === 'Escape' && selection) onSelect(selection.path?.length ? { frame: selection.frame, path: selection.path.length > 1 ? selection.path.slice(0, -1) : null } : null)
        if ((e.key === '=' || e.key === '+') && (e.ctrlKey || e.metaKey)) (e.preventDefault(), zoomAt(1.2, vw / 2, 300))
        if (e.key === '-' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), zoomAt(1 / 1.2, vw / 2, 300))
        if (e.key === '0' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), fit())
      }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, width: layout.width, height: layout.height }}>
        {layout.headers.map((h) => (
          <div key={h.label} className="absolute left-0 flex items-center gap-2 font-medium text-dim" style={{ top: h.y + 8, fontSize: 13 / Math.max(view.z, 0.5) }}>
            {h.label === 'Built-in' ? <SquaresFour size={14 / Math.max(view.z, 0.5)} /> : <Cube size={14 / Math.max(view.z, 0.5)} />}
            {h.label}
          </div>
        ))}
        {layout.frames.map((pos) => {
          if (pos.key === '__new')
            return (
              <button
                key="__new"
                data-frame-header="__new"
                onClick={onNew}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                className={clsx('absolute flex flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed text-[15px]', newActive ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line-strong text-dim hover:text-fg')}
                style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }}
              >
                <Plus size={24} />
                New component
              </button>
            )
          const f = frames.find((x) => x.key === pos.key)!
          const selected = selection?.frame === f.key
          return (
            <div key={f.key} className="absolute" style={{ left: pos.x, top: pos.y, width: pos.w }}>
              <div data-frame-header={f.key} className={clsx('flex h-[30px] items-center gap-1.5 px-1 text-[13px]', selected ? 'text-crimson-hi' : 'text-muted')}>
                {f.kind === 'kit' ? <SquaresFour size={13} /> : <Cube size={13} />}
                <span className="truncate font-medium">{f.title}</span>
                {f.warn && <span className="h-1.5 w-1.5 rounded-full bg-warn" title="Uses colours outside the tokens" />}
              </div>
              <div className="flex gap-4">
                {themes.map((t, copy) => {
                  const hb = hover?.frame === f.key && !samePath(hover.path, selection?.frame === f.key ? selection.path : null) ? box(f.key, hover.path, copy) : null
                  const sb = selected ? box(f.key, selection!.path, copy) : null
                  return (
                    <div
                      key={t}
                      data-frame-key={f.key}
                      data-frame-copy={t}
                      className={clsx('relative overflow-hidden rounded-[14px] shadow-[0_10px_40px_-18px_rgb(0_0_0/0.8)]', selected && !selection?.path ? 'ring-2 ring-crimson' : hover?.frame === f.key && !hover.path ? 'ring-1 ring-crimson-line' : 'ring-1 ring-line')}
                      style={{ width: single, height: heights[f.key] ?? 240 }}
                    >
                      <Frame
                        input={input}
                        html={f.html}
                        css={f.css}
                        theme={t}
                        width={single}
                        fontCss={fontCss}
                        editing={editing?.frame === f.key}
                        onHeight={(h) => copy === 0 && setHeights((cur) => (cur[f.key] === h ? cur : { ...cur, [f.key]: h }))}
                        setDoc={(d) => {
                          if (d) docs.current.set(`${f.key}:${copy}`, d)
                          else docs.current.delete(`${f.key}:${copy}`)
                        }}
                      />
                      {/* While text is edited the frame takes the pointer; otherwise the canvas does. */}
                      {!(editing?.frame === f.key) && <div className="absolute inset-0" />}
                      {hb && <Box rect={hb} stroke={stroke} kind="hover" />}
                      {sb && <Box rect={sb} stroke={stroke} kind={editing?.frame === f.key ? 'edit' : 'select'} />}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      {!frames.length && <Hint>Loading components…</Hint>}
    </div>
  )
})

function Box({ rect, stroke, kind }: { rect: { left: number; top: number; width: number; height: number }; stroke: number; kind: 'hover' | 'select' | 'edit' }) {
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: rect.left - stroke,
        top: rect.top - stroke,
        width: rect.width + stroke * 2,
        height: rect.height + stroke * 2,
        border: `${stroke}px ${kind === 'hover' ? 'dashed' : 'solid'} ${kind === 'edit' ? '#3b82f6' : '#e11d48'}`,
        background: kind === 'select' ? 'rgb(225 29 72 / 0.06)' : undefined,
        borderRadius: 2 * stroke
      }}
    />
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 grid place-items-center text-[13px] text-dim">{children}</div>
}
