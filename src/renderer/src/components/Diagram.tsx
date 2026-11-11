import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Check, Code, Copy, Workflow } from 'lucide-react'
import type { Mounted, MountOptions } from 'pele'

/**
 * What diagrams may do: they come from model replies, so no images (they'd fetch from the network)
 * and no links (a click would navigate the app's window). Pele escapes text and drops scripts itself.
 */
const OPTIONS: MountOptions = { images: false, links: false, zoom: 'auto' }

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

  return (
    <figure className="diagram group/diagram relative my-3 overflow-hidden rounded-[10px] border border-line bg-panel">
      <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/diagram:opacity-100 motion-reduce:transition-none">
        {drawn && (
          <button type="button" onClick={() => setShowCode((v) => !v)} aria-pressed={showCode} title={showCode ? 'Show the diagram' : 'Show the Mermaid code'} aria-label={showCode ? 'Show the diagram' : 'Show the Mermaid code'} className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elev text-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line">
            {showCode ? <Workflow size={12} /> : <Code size={12} />}
          </button>
        )}
        <button type="button" onClick={copy} title="Copy the Mermaid code" aria-label={copied ? 'Copied' : 'Copy the Mermaid code'} className="flex h-6 w-6 items-center justify-center rounded border border-line bg-elev text-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crimson-line">
          {copied ? <Check size={12} /> : <Copy size={12} />}
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
