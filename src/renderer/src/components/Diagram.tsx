import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, Code, Copy, Maximize, Workflow, ZoomIn, ZoomOut } from 'lucide-react'
import type { Mounted, MountOptions } from 'pele'

/**
 * What diagrams may do: they come from model replies, so no images (they'd fetch from the network)
 * and no links (a click would navigate the app's window). Pele escapes text and drops scripts itself.
 */
// Pele's own zoom buttons float over the drawing's corner (covering it, and the buttons below); zoom works without them and
// the header here offers it instead, only while the diagram is scaled down to fit.
const OPTIONS: MountOptions = { images: false, links: false, zoom: { controls: false } }

/** While a reply streams in, redraw at most this often. */
const STREAM_DEBOUNCE_MS = 150

// Pele (and each diagram type) loads the first time a diagram shows.
let pele: Promise<typeof import('pele/lazy')> | null = null
const loadPele = () => (pele ??= import('pele/lazy'))

/**
 * A Mermaid diagram drawn with Pele. Until it draws (still streaming, or a mistake in it) the source
 * shows instead, with the reason once the reply is complete. "Code" switches to the source any time.
 */
export function Diagram({ source, streaming }: { source: string; streaming?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const mounted = useRef<Mounted | null>(null)
  const [drawn, setDrawn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)
  // Scaled down to fit the column: zooming in shows it full size (wheel/pinch and drag work too).
  const [zoomable, setZoomable] = useState(false)
  const syncZoom = () => {
    const z = mounted.current?.zoom
    setZoomable(!!z && z.fit < 0.999)
  }

  useEffect(() => {
    let cancelled = false
    const draw = async () => {
      const lib = await loadPele()
      if (cancelled || !host.current) return
      const opts: MountOptions = {
        ...OPTIONS,
        onRender: () => {
          setDrawn(true)
          setError(null)
          // The zoom is set up when mounting returns; read it once that has happened.
          window.setTimeout(syncZoom, 0)
        },
        onError: (err) => {
          setDrawn(false)
          setError(err instanceof Error ? err.message : String(err))
        }
      }
      try {
        // Each diagram type's code loads on demand.
        await lib.load(lib.detectType(source))
        if (cancelled || !host.current) return
        if (mounted.current) mounted.current.update(source, opts)
        else mounted.current = await lib.mountAsync(host.current, source, opts)
        if (mounted.current.error) opts.onError?.(mounted.current.error)
      } catch (err) {
        if (!cancelled) opts.onError?.(err)
      }
    }
    const t = window.setTimeout(() => void draw(), streaming ? STREAM_DEBOUNCE_MS : 0)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [source, streaming])

  useEffect(
    () => () => {
      mounted.current?.destroy()
      mounted.current = null
    },
    []
  )

  const copy = () => {
    void navigator.clipboard.writeText(source)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }
  const code = showCode || !drawn
  const btn = 'flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-elev-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line'

  return (
    <figure className="diagram my-3 overflow-hidden rounded-[10px] border border-line bg-panel">
      {/* The buttons sit in their own strip, so they never cover the drawing. */}
      <div className="flex h-8 items-center gap-0.5 border-b border-line pl-3 pr-1.5">
        <span className="mr-auto text-caption text-dim">{showCode || !drawn ? 'Mermaid' : 'Diagram'}</span>
        {drawn && !showCode && zoomable && (
          <>
            <button type="button" onClick={() => mounted.current?.zoom?.zoomBy(1 / 1.25)} title="Zoom out" aria-label="Zoom out" className={btn}>
              <ZoomOut size={13} />
            </button>
            <button type="button" onClick={() => mounted.current?.zoom?.zoomBy(1.25)} title="Zoom in (or scroll with Ctrl)" aria-label="Zoom in" className={btn}>
              <ZoomIn size={13} />
            </button>
            <button type="button" onClick={() => mounted.current?.zoom?.reset()} title="Fit to width" aria-label="Fit to width" className={btn}>
              <Maximize size={12} />
            </button>
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
          </>
        )}
        {drawn && (
          <button type="button" onClick={() => setShowCode((v) => !v)} aria-pressed={showCode} title={showCode ? 'Show the diagram' : 'Show the Mermaid code'} aria-label={showCode ? 'Show the diagram' : 'Show the Mermaid code'} className={btn}>
            {showCode ? <Workflow size={13} /> : <Code size={13} />}
          </button>
        )}
        <button type="button" onClick={copy} title="Copy the Mermaid code" aria-label={copied ? 'Copied' : 'Copy the Mermaid code'} className={btn}>
          {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
        </button>
      </div>
      {/* Pele draws here and fits the diagram to this width: until it has drawn, it keeps its width at no height. */}
      <div ref={host} className={clsx('pele-host overflow-x-auto overflow-y-hidden', showCode ? 'hidden' : drawn ? 'p-3' : 'h-0')} role="img" aria-label="Diagram" />
      {code && (
        <pre className="!m-0 !rounded-none !border-0 !bg-transparent" translate="no">
          <code>{source}</code>
        </pre>
      )}
      {!drawn && error && !streaming && (
        <figcaption className="border-t border-line px-3 py-1.5 text-caption text-dim">
          Couldn’t draw this diagram: <span className="text-muted">{error.split('\n')[0]}</span>
        </figcaption>
      )}
    </figure>
  )
}
