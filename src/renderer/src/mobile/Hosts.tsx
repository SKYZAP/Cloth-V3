import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, CaretRight, Check, File, FolderSimple, HardDrives, House, X } from '@phosphor-icons/react'
import type { RemoteDirEntry } from '@shared/types'
import { api } from '@/lib/api'
import { useBackHandler } from '@/lib/back'
import { useImageSrc } from '@/lib/platform'
import { useApp } from '@/lib/store'
import { EASE_DRAWER } from '@/components/BottomSheet'
import { Spinner } from '@/components/ui'
import { mobileHooks } from './bridge'

interface PickRequest {
  directory: boolean
  multiple: boolean
  title: string
  resolve(paths: string[]): void
}

const LAST_DIR = 'cloth.pickerDir'

/** Phone stand-ins for the desktop's native dialogs: a browser for the PC's folders, and a full-screen image viewer. */
export function MobileHosts() {
  const [pick, setPick] = useState<PickRequest | null>(null)
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    mobileHooks.pickPaths = (opts) =>
      new Promise((resolve) => setPick({ directory: !!opts.directory, multiple: !!opts.multiple, title: opts.title ?? (opts.directory ? 'Choose a folder' : 'Choose files'), resolve }))
    mobileHooks.openImage = setImage
    mobileHooks.notify = (text, kind) => useApp.getState().toast(text, kind)
    return () => {
      mobileHooks.pickPaths = null
      mobileHooks.openImage = null
      mobileHooks.notify = null
    }
  }, [])
  return (
    <>
      <AnimatePresence>
        {pick && (
          <FolderPicker
            key="picker"
            req={pick}
            onDone={(paths) => {
              pick.resolve(paths)
              setPick(null)
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>{image && <ImageViewer key="viewer" id={image} onClose={() => setImage(null)} />}</AnimatePresence>
    </>
  )
}

function FolderPicker({ req, onDone }: { req: PickRequest; onDone(paths: string[]): void }) {
  const [path, setPath] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_DIR)
    } catch {
      return null
    }
  })
  const [roots, setRoots] = useState<RemoteDirEntry[]>([])
  const [listing, setListing] = useState<{ path: string; parent: string | null; entries: RemoteDirEntry[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  useBackHandler(true, () => (listing ? go(listing.parent) : onDone([])))

  useEffect(() => void api.remote.roots().then(setRoots).catch(() => undefined), [])
  useEffect(() => {
    if (!path) return setListing(null)
    let live = true
    setLoading(true)
    setError(null)
    api.remote
      .listDir(path)
      .then((l) => {
        if (!live) return
        setListing(l)
        try {
          localStorage.setItem(LAST_DIR, l.path)
        } catch {
          /* storage unavailable */
        }
      })
      .catch((err) => live && (setError(err instanceof Error ? err.message : String(err)), setListing(null)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [path])

  const go = (p: string | null) => {
    setPath(p)
    if (!p) setListing(null)
  }
  const entries = listing?.entries.filter((e) => e.dir || !req.directory) ?? []
  const toggle = (p: string) => setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : req.multiple ? [...c, p] : [p]))

  return (
    <motion.div
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ duration: 0.45, ease: EASE_DRAWER }}
      className="fixed inset-0 z-[70] flex flex-col bg-bg pb-[var(--safe-bottom)] pt-[var(--safe-top)]"
    >
      <div className="flex items-center gap-2 border-b border-line px-2 py-2">
        <button onClick={() => onDone([])} className="flex h-10 w-10 items-center justify-center rounded-[10px] text-muted active:bg-elev-2" aria-label="Cancel">
          <X size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{req.title}</div>
          <div className="truncate font-mono text-[11px] text-dim">{listing?.path ?? 'On your PC'}</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!listing ? (
          <div className="p-2">
            {error && <div className="m-2 rounded-[10px] border border-crimson-line bg-crimson-soft px-3 py-2 text-[12.5px] text-crimson-hi">{error}</div>}
            {roots.map((r) => (
              <Row key={r.path} icon={r.name === 'Home' ? <House size={20} className="text-crimson-hi" /> : <HardDrives size={20} className="text-muted" />} label={r.name} sub={r.path} onClick={() => go(r.path)} />
            ))}
            {!roots.length && <div className="flex justify-center p-8"><Spinner /></div>}
          </div>
        ) : (
          <div className="p-2">
            <Row icon={<ArrowLeft size={20} className="text-muted" />} label={listing.parent ? 'Up one level' : 'All drives'} onClick={() => go(listing.parent)} />
            {loading && <div className="flex justify-center p-4"><Spinner /></div>}
            {entries.map((e) =>
              e.dir ? (
                <Row
                  key={e.path}
                  icon={<FolderSimple size={20} weight="fill" className={e.name.startsWith('.') ? 'text-dim' : 'text-crimson-hi/85'} />}
                  label={e.name}
                  onClick={() => go(e.path)}
                  trailing={
                    !req.directory && req.multiple ? (
                      <Check4 on={chosen.includes(e.path)} onClick={() => toggle(e.path)} />
                    ) : (
                      <CaretRight size={14} className="text-dim" />
                    )
                  }
                />
              ) : (
                <Row key={e.path} icon={<File size={20} className="text-dim" />} label={e.name} onClick={() => toggle(e.path)} trailing={<Check4 on={chosen.includes(e.path)} onClick={() => toggle(e.path)} />} />
              )
            )}
            {!loading && !entries.length && <div className="p-6 text-center text-[12.5px] text-dim">{req.directory ? 'No folders here' : 'Empty folder'}</div>}
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t border-line p-3">
        {req.directory ? (
          <button
            disabled={!listing}
            onClick={() => listing && onDone([listing.path])}
            className="h-12 flex-1 rounded-[14px] bg-crimson text-[14px] font-semibold text-white active:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
          >
            {listing ? `Use “${listing.path.split(/[\\/]/).filter(Boolean).pop() ?? listing.path}”` : 'Open a folder first'}
          </button>
        ) : (
          <button
            disabled={!chosen.length}
            onClick={() => onDone(chosen)}
            className="h-12 flex-1 rounded-[14px] bg-crimson text-[14px] font-semibold text-white active:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
          >
            {chosen.length ? `Add ${chosen.length} item${chosen.length > 1 ? 's' : ''}` : 'Tap files to choose'}
          </button>
        )}
      </div>
    </motion.div>
  )
}

function Row({ icon, label, sub, onClick, trailing }: { icon: React.ReactNode; label: string; sub?: string; onClick(): void; trailing?: React.ReactNode }) {
  return (
    <div role="button" onClick={onClick} className="flex min-h-[52px] items-center gap-3 rounded-[10px] px-3 py-2 active:bg-elev-2">
      <span className="flex w-6 justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px]">{label}</span>
        {sub && <span className="block truncate font-mono text-[11px] text-dim">{sub}</span>}
      </span>
      {trailing}
    </div>
  )
}

function Check4({ on, onClick }: { on: boolean; onClick(): void }) {
  return (
    <span
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={clsx('flex h-6 w-6 items-center justify-center rounded-md border-[1.5px]', on ? 'border-crimson bg-crimson text-white' : 'border-line-strong')}
    >
      {on && <Check size={13} weight="bold" />}
    </span>
  )
}

function ImageViewer({ id, onClose }: { id: string; onClose(): void }) {
  const src = useImageSrc(id)
  useBackHandler(true, onClose)
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="fixed inset-0 z-[70] flex items-center justify-center bg-black/95 p-3">
      {src ? <motion.img initial={{ scale: 0.94 }} animate={{ scale: 1 }} src={src} alt="" className="max-h-full max-w-full rounded-lg object-contain" /> : <Spinner size={20} />}
      <button onClick={onClose} className="absolute right-3 top-[calc(var(--safe-top)+12px)] flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white" aria-label="Close">
        <X size={20} />
      </button>
    </motion.div>
  )
}
