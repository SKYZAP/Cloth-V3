import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import QRCode from 'qrcode'
import { ArrowSquareOut, Copy, DownloadSimple, FileHtml, FileText, ImageSquare, LinkSimple, MagnifyingGlass, PencilSimple, QrCode, Swatches as SwatchesIcon, Trash, WifiHigh, WifiSlash } from '@phosphor-icons/react'
import type { Swatch, SwatchLink, SwatchServerStatus } from '@shared/swatches'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { timeAgo } from '@/lib/format'
import { isMobile, useSideBySide } from '@/lib/platform'
import { useSwatchNav } from '@/lib/swatchNav'
import { Button, Empty, IconButton, Input, ListItem, ListPane, PageHeader, Switch, confirmAction } from '@/components/ui'
import { SplitDetail, SplitRoot } from '@/components/SplitView'

const FORMAT: Record<Swatch['format'], { label: string; icon: typeof FileHtml }> = {
  html: { label: 'Page', icon: FileHtml },
  markdown: { label: 'Document', icon: FileText },
  svg: { label: 'Image', icon: ImageSquare }
}

/** Swatches: the pages chats publish, previewed here and opened by link on this PC or (when shared) other devices. */
export function SwatchesPage() {
  const [items, setItems] = useState<Swatch[] | null>(null)
  const [status, setStatus] = useState<SwatchServerStatus | null>(null)
  const [network, setNetwork] = useState(false)
  const [filter, setFilter] = useState('')
  const selected = useSwatchNav((s) => s.selected)
  const [open, setOpen] = useState(!!selected)
  const side = useSideBySide()

  const load = async () => {
    const [list, st, settings] = await Promise.all([api.swatches.list(), api.swatches.status(), api.settings.get()])
    setItems(list)
    setStatus(st)
    setNetwork(settings.swatchNetwork)
  }
  useEffect(() => {
    void load()
  }, [])
  useEvent('swatches', (e) => {
    if (e.type === 'status') setStatus(e.status)
    else void api.swatches.list().then(setItems)
  })

  // The newest is shown until one is picked (on a wide screen).
  const active = items?.find((s) => s.id === selected) ?? (side ? items?.[0] : undefined)
  const q = filter.trim().toLowerCase()
  const shown = useMemo(() => (items ?? []).filter((s) => !q || s.title.toLowerCase().includes(q)), [items, q])

  const setShared = async (on: boolean) => {
    setNetwork(on)
    await attempt(() => api.settings.update({ swatchNetwork: on }))
  }

  return (
    <SplitRoot open={open && !!active} onBack={() => setOpen(false)}>
      <ListPane
        frame={!isMobile}
        width={290}
        header={
          <div className="space-y-2">
            <div className="relative">
              <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
              <Input className="pl-7" placeholder="Search swatches" aria-label="Search swatches" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            {!isMobile && (
              <div className="flex items-center gap-2 rounded-[10px] border border-line px-2.5 py-2">
                {network ? <WifiHigh size={15} className="shrink-0 text-ok" aria-hidden="true" /> : <WifiSlash size={15} className="shrink-0 text-dim" aria-hidden="true" />}
                <div className="min-w-0 flex-1">
                  <div className="text-ui font-medium text-fg">Share on your network</div>
                  <div className="text-caption text-dim">{network ? 'Phones and computers on this network can open the links.' : 'Links open on this PC only.'}</div>
                </div>
                <Switch checked={network} onChange={(v) => void setShared(v)} ariaLabel="Share swatches on your network" />
              </div>
            )}
            {status?.error && <div className="px-1 text-caption text-danger">{status.error}</div>}
          </div>
        }
      >
        {items && !items.length && <div className="px-3 py-4 text-caption text-dim">Nothing yet. Ask a chat for a report, dashboard or diagram “as a swatch”.</div>}
        {items && items.length > 0 && !shown.length && <div className="px-3 py-4 text-caption text-dim">No swatch matches “{filter}”.</div>}
        {shown.map((s) => {
          const F = FORMAT[s.format]
          return (
            <ListItem
              key={s.id}
              active={active?.id === s.id}
              onClick={() => {
                useSwatchNav.setState({ selected: s.id })
                setOpen(true)
              }}
            >
              <F.icon size={16} className="shrink-0 text-dim" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui text-fg">{s.title}</div>
                <div className="truncate text-caption text-dim">
                  {F.label} · {timeAgo(s.updatedAt)}
                  {s.version > 1 ? ` · version ${s.version}` : ''}
                </div>
              </div>
            </ListItem>
          )
        })}
      </ListPane>
      <SplitDetail>
        <div className={clsx('flex h-full min-h-0 flex-col', !isMobile && 'pb-2 pr-2')}>
          <div className={clsx('flex min-h-0 flex-1 flex-col overflow-hidden', !isMobile && 'rounded-xl border border-line bg-bg')}>
            {active ? (
              <SwatchView key={active.id} swatch={active} network={network && !!status?.running} />
            ) : (
              <div className="h-[60%]">
                <Empty icon={<SwatchesIcon size={20} />} title="Pages your chats make">
                  Ask a chat for something to look at or share, like a report, a dashboard, a chart or a small tool, and it publishes a swatch. It opens here, and on your phone or other computers once you share swatches on your network.
                </Empty>
              </div>
            )}
          </div>
        </div>
      </SplitDetail>
    </SplitRoot>
  )
}

function SwatchView({ swatch, network }: { swatch: Swatch; network: boolean }) {
  const [links, setLinks] = useState<SwatchLink[]>([])
  const [qr, setQr] = useState<{ url: string; data: string } | null>(null)
  useEffect(() => {
    void api.swatches.links(swatch.id).then(setLinks)
  }, [swatch.id, swatch.version, network])
  const local = links.find((l) => l.kind === 'local')
  const others = links.filter((l) => l.kind !== 'local')
  // A phone can't reach this PC's 127.0.0.1: it previews through a network link.
  const preview = isMobile ? others[0] : local

  const copy = (url: string) => {
    void navigator.clipboard.writeText(url)
    useApp.getState().toast('Link copied', 'ok')
  }
  const showQr = async (url: string) => {
    if (qr?.url === url) return setQr(null)
    setQr({ url, data: await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#09090c', light: '#ffffff' } }) })
  }
  const [editing, setEditing] = useState<string | null>(null)
  const saveTitle = async () => {
    const title = editing?.trim()
    setEditing(null)
    if (title && title !== swatch.title) await attempt(() => api.swatches.rename(swatch.id, title))
  }
  const remove = async () => {
    if (!(await confirmAction(`Delete “${swatch.title}”? Its links stop working everywhere. This can’t be undone.`, { title: 'Delete swatch?', danger: true, confirmLabel: 'Delete' }))) return
    await attempt(() => api.swatches.remove(swatch.id))
    useSwatchNav.setState({ selected: null })
  }
  const newLink = async () => {
    if (!(await confirmAction('Make a new link for this swatch? Links you shared before stop working.', { title: 'Make a new link?', confirmLabel: 'Make new link' }))) return
    const next = await attempt(() => api.swatches.newLink(swatch.id))
    if (next) setLinks(next)
  }

  return (
    <>
      <PageHeader
        title={
          editing !== null ? (
            <Input
              autoFocus
              aria-label="Swatch name"
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveTitle()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            swatch.title
          )
        }
        subtitle={`${FORMAT[swatch.format].label} · updated ${timeAgo(swatch.updatedAt)}${swatch.version > 1 ? ` · version ${swatch.version}` : ''}`}
        actions={
          <>
            {local && !isMobile && (
              <Button size="sm" icon={<ArrowSquareOut size={13} />} onClick={() => void api.app.openExternal(local.url)}>
                Open in browser
              </Button>
            )}
            <IconButton title="Rename" aria-label="Rename" onClick={() => setEditing(swatch.title)}>
              <PencilSimple size={15} />
            </IconButton>
            {!isMobile && (
              <IconButton title="Save as a file" aria-label="Save as a file" onClick={() => void attempt(() => api.swatches.saveAs(swatch.id))}>
                <DownloadSimple size={15} />
              </IconButton>
            )}
            <IconButton title="Make a new link (old links stop working)" aria-label="Make a new link" onClick={() => void newLink()}>
              <LinkSimple size={15} />
            </IconButton>
            <IconButton title="Delete" aria-label="Delete" onClick={() => void remove()}>
              <Trash size={15} />
            </IconButton>
          </>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-5 py-2 mobile:px-3">
        {links.map((l) => (
          <div key={l.url} className="flex min-w-0 items-center gap-1 rounded-full border border-line bg-elev py-0.5 pl-2.5 pr-1 text-caption">
            <span className="shrink-0 text-dim">{l.label}</span>
            <span className="selectable min-w-0 max-w-[260px] truncate font-mono text-muted" title={l.url}>
              {l.url.replace(/^http:\/\//, '').replace(/\/s\/.*/, '')}
            </span>
            <button type="button" onClick={() => copy(l.url)} title="Copy link" aria-label={`Copy the ${l.label} link`} className="flex h-6 w-6 items-center justify-center rounded-full text-dim hover:bg-elev-2 hover:text-fg">
              <Copy size={12} />
            </button>
            {l.kind !== 'local' && (
              <button type="button" onClick={() => void showQr(l.url)} title="Show a QR code to open it on a phone" aria-label={`QR code for the ${l.label} link`} aria-pressed={qr?.url === l.url} className="flex h-6 w-6 items-center justify-center rounded-full text-dim hover:bg-elev-2 hover:text-fg">
                <QrCode size={12} />
              </button>
            )}
          </div>
        ))}
        {!network && !isMobile && <span className="text-caption text-dim">Turn on “Share on your network” to open it on other devices.</span>}
      </div>
      {qr && (
        <div className="flex shrink-0 items-center gap-4 border-b border-line px-5 py-3">
          <img src={qr.data} alt="QR code for the swatch link" className="h-32 w-32 rounded-md" />
          <div className="text-caption text-muted">Scan with a phone on the same network to open this swatch. Anyone with the link can view it.</div>
        </div>
      )}
      <div className="min-h-0 flex-1 bg-white">
        {preview ? (
          <iframe
            key={`${swatch.id}:${swatch.version}:${preview.url}`}
            src={preview.url}
            title={swatch.title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="grid h-full place-items-center bg-bg p-6 text-center text-ui text-dim">{isMobile ? 'Turn on “Share on your network” on the PC to open swatches here.' : 'Starting the swatch server…'}</div>
        )}
      </div>
    </>
  )
}
