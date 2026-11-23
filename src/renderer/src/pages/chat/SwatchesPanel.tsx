import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ArrowUpRight, FileHtml, FileText, ImageSquare, SquaresFour, LinkSimple, Swatches as SwatchesIcon, X } from '@phosphor-icons/react'
import type { Swatch, SwatchLink } from '@shared/swatches'
import { api, useEvent } from '@/lib/api'
import { useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { closePanelSwatch, openSwatch, pickPanelSwatch, useSwatchNav } from '@/lib/swatchNav'
import { IconButton } from '@/components/ui'
import { MockupCanvas } from '@/components/MockupCanvas'

const FORMAT: Record<Swatch['format'], { label: string; icon: typeof FileHtml }> = {
  html: { label: 'Page', icon: FileHtml },
  markdown: { label: 'Document', icon: FileText },
  svg: { label: 'Image', icon: ImageSquare },
  mockup: { label: 'Mockup', icon: SquaresFour }
}

/** The side panel's Swatches tab: one of the chat's swatches, live, with the chat's others to switch to. */
export function SwatchesPanel({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const [all, setAll] = useState<Swatch[] | null>(null)
  const [network, setNetwork] = useState(false)
  const picked = useSwatchNav((s) => s.panel)
  const closed = useSwatchNav((s) => s.panelClosed)
  const load = () => void api.swatches.list().then(setAll, () => setAll([]))
  useEffect(() => {
    load()
    void api.swatches.status().then((s) => setNetwork(s.running && s.network), () => undefined)
  }, [])
  useEvent('swatches', (e) => {
    if (e.type === 'status') setNetwork(e.status.running && e.status.network)
    else load()
  })

  const mine = useMemo(() => (all ?? []).filter((s) => s.sessionId === sessionId), [all, sessionId])
  // The one asked for (a card's Open), else the chat's newest; none once it's closed.
  const shown = closed ? null : ((all ?? []).find((s) => s.id === picked) ?? mine[0] ?? null)

  // The chat's cards say "Showing" for the swatch on screen here.
  useEffect(() => {
    useSwatchNav.setState({ panelVisible: visible && !!shown, ...(shown && shown.id !== picked ? { panel: shown.id } : {}) })
  }, [visible, shown?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => useSwatchNav.setState({ panelVisible: false }), [])

  if (!all) return <div className="p-4 text-caption text-dim">Loading…</div>
  if (!shown && mine.length)
    return (
      <div className="h-full min-h-0 overflow-y-auto p-1.5">
        <div className="px-2 pb-1 pt-1 text-micro text-dim">Swatches in this chat</div>
        <SwatchList swatches={mine} current={null} />
      </div>
    )
  if (!shown)
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-[260px] space-y-2">
          <SwatchesIcon size={26} className="mx-auto text-dim" aria-hidden="true" />
          <p className="text-ui font-medium text-fg">No swatches in this chat yet</p>
          <p className="text-caption text-dim">Ask for a page, a report or a diagram as a swatch. It opens here, and by link on your other devices.</p>
        </div>
      </div>
    )
  return <SwatchView swatch={shown} others={mine} network={network} />
}

function SwatchView({ swatch, others, network }: { swatch: Swatch; others: Swatch[]; network: boolean }) {
  const [links, setLinks] = useState<SwatchLink[]>([])
  const [reload, setReload] = useState(0)
  useEffect(() => {
    void api.swatches.links(swatch.id).then(setLinks, () => setLinks([]))
  }, [swatch.id, swatch.version, network])
  const local = links.find((l) => l.kind === 'local')
  const shared = links.find((l) => l.kind !== 'local')
  // A phone can't reach this PC's 127.0.0.1: it previews through a network link.
  const preview = isMobile ? shared : local
  const copy = () => {
    const url = (shared ?? local)?.url
    if (!url) return
    void navigator.clipboard.writeText(url)
    useApp.getState().toast(shared ? 'Link copied. It opens on devices on your network.' : 'Link copied. It opens on this computer.', 'ok')
  }
  const Kind = FORMAT[swatch.format]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line py-1.5 pl-3 pr-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium text-fg" title={swatch.title}>
            {swatch.title}
          </div>
          <div className="truncate text-micro text-dim">
            {Kind.label}
            {swatch.version > 1 ? ` · version ${swatch.version}` : ''}
          </div>
        </div>
        {network && <span className="shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-micro font-medium text-ok">On network</span>}
        <IconButton className="h-7 w-7" title="Reload" aria-label="Reload" onClick={() => setReload((n) => n + 1)}>
          <ArrowClockwise size={14} />
        </IconButton>
        <IconButton className="h-7 w-7" title={shared ? 'Copy the network link' : 'Copy the link'} aria-label="Copy link" onClick={copy} disabled={!local && !shared}>
          <LinkSimple size={14} />
        </IconButton>
        <IconButton className="h-7 w-7" title="Open on the Swatches page" aria-label="Open on the Swatches page" onClick={() => openSwatch(swatch.id)}>
          <ArrowUpRight size={14} />
        </IconButton>
        <IconButton className="h-7 w-7" title="Close this swatch" aria-label={`Close ${swatch.title}`} onClick={closePanelSwatch}>
          <X size={14} />
        </IconButton>
      </div>
      <div className={clsx('min-h-0 flex-1', swatch.format === 'mockup' ? 'bg-bg' : 'bg-white')}>
        {preview && swatch.format === 'mockup' ? (
          <MockupCanvas swatch={swatch} base={preview.url} compact />
        ) : preview ? (
          <iframe
            key={`${swatch.id}:${swatch.version}:${preview.url}:${reload}`}
            src={preview.url}
            title={swatch.title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="grid h-full place-items-center bg-bg p-6 text-center text-caption text-dim">{isMobile ? 'Turn on “Share on your network” on the computer running Cloth to open swatches here.' : 'Starting the swatch server…'}</div>
        )}
      </div>
      {others.length > 1 && (
        <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-line p-1.5">
          <div className="px-2 pb-1 pt-0.5 text-micro text-dim">In this chat</div>
          <SwatchList swatches={others} current={swatch.id} />
        </div>
      )}
    </div>
  )
}

/** The chat's swatches, to pick the one the tab shows. */
function SwatchList({ swatches, current }: { swatches: Swatch[]; current: string | null }) {
  return (
    <>
      {swatches.map((s) => {
        const Icon = FORMAT[s.format].icon
        const on = s.id === current
        return (
          <button
            key={s.id}
            type="button"
            aria-current={on || undefined}
            onClick={() => pickPanelSwatch(s.id)}
            className={clsx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui transition-colors', on ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev hover:text-fg')}
          >
            <Icon size={14} className={clsx('shrink-0', on ? 'text-crimson-hi' : 'text-dim')} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{s.title}</span>
            <span className="shrink-0 text-micro text-dim">{s.version > 1 ? `v${s.version}` : FORMAT[s.format].label}</span>
          </button>
        )
      })}
    </>
  )
}
