import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { Code, Cube, Desktop, FolderDashed, FolderSimple, FolderSimplePlus, GlobeHemisphereWest, X } from '@phosphor-icons/react'
import { DEFAULT_CONTAINER } from '@shared/types'
import type { ChatSession, ContainerStatus, Project } from '@shared/types'
import { EFFORT_OPTIONS, effortLabel, normalizeEffort } from '@shared/effort'
import { api } from '@/lib/api'
import { isMobile } from '@/lib/platform'
import { Button } from '@/components/ui'
import { ModelMenu } from '@/components/ModelPicker'
import { BottomSheet } from '@/components/BottomSheet'

export { effortLabel }

type Update = (p: Partial<ChatSession>) => Promise<void>

/**
 * A control in the message box's row that opens its own small popover above it (a bottom sheet on the
 * phone). `trigger` draws the button; it gets whether the popover is open and the toggle.
 */
export function ComposerPopover({
  trigger,
  width,
  sheetTitle,
  role = 'dialog',
  shrink = false,
  children
}: {
  trigger(open: boolean, toggle: () => void): ReactNode
  width: number
  sheetTitle: string
  role?: 'dialog' | 'menu'
  /** Let the trigger give up width (and truncate) when the row is tight. */
  shrink?: boolean
  children(close: () => void): ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || isMobile) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const close = () => setOpen(false)
  return (
    <div ref={wrap} className={shrink ? 'relative min-w-0' : 'relative shrink-0'}>
      {trigger(open, () => setOpen(!open))}
      {isMobile ? (
        <BottomSheet open={open} onClose={close} title={sheetTitle} portal>
          {children(close)}
        </BottomSheet>
      ) : (
        <AnimatePresence>
          {open && (
            <motion.div
              role={role}
              aria-label={sheetTitle}
              initial={{ opacity: 0, y: 6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12 } }}
              transition={{ type: 'spring', stiffness: 460, damping: 32 }}
              style={{ width, transformOrigin: 'bottom left' }}
              className="absolute bottom-full left-0 z-40 mb-2 flex max-h-[min(520px,70vh)] flex-col overflow-hidden rounded-[14px] border border-line-strong bg-elev shadow-[0_24px_60px_-18px_rgb(0_0_0/0.85)]"
            >
              {children(close)}
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </div>
  )
}

export function ModelEffortMenu({ session, update, reasoning, onPicked }: { session: ChatSession; update: Update; reasoning: boolean; onPicked(): void }) {
  const list = (
    <div key="list" className="flex min-h-0 flex-1 flex-col" style={{ height: isMobile ? undefined : 360 }}>
      <ModelMenu autoFocus={!isMobile} value={session.model} onChange={(model) => void update({ model }).then(() => !reasoning && onPicked())} />
    </div>
  )
  const effort = reasoning && (
    <div key="effort" className={clsx('shrink-0 px-3 py-2.5', isMobile ? 'border-b border-line' : 'border-t border-line')}>
      <div className="mb-1.5 text-caption text-dim">Reasoning effort</div>
      {reasoning && (
        <>
          <Segmented value={normalizeEffort(session.thinking)} onChange={(thinking) => void update({ thinking })} options={EFFORT_OPTIONS} label="Reasoning effort" />
        </>
      )}
    </div>
  )
  // On the phone the model list runs long, so the effort switch goes first where it can be reached.
  return <>{isMobile ? [effort, list] : [list, effort]}</>
}

export function FolderMenu({ session, update }: { session: ChatSession; update: Update }) {
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    void api.projects.list().then(setProjects, () => undefined)
  }, [])
  const choose = async () => {
    const [dir] = await api.app.pickPaths({ directory: true, title: 'Choose a folder for this chat' })
    if (dir) await update({ workspace: dir })
  }
  const folders = [...new Set(projects.map((p) => p.folder).filter((f): f is string => !!f && f !== session.workspace))].slice(0, 4)
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto overflow-x-hidden p-3">
      {!isMobile && <div className="-mb-1.5 text-caption text-dim">Folder</div>}
      <div className={clsx('flex items-center gap-2 rounded-[10px] border px-2.5 py-2', session.workspace ? 'border-line bg-bg' : 'border-dashed border-line-strong')}>
        {session.workspace ? <FolderSimple size={15} weight="fill" className="shrink-0 text-muted" /> : <FolderDashed size={15} className="shrink-0 text-dim" />}
        <span className={clsx('min-w-0 flex-1 truncate font-mono text-caption', session.workspace ? 'text-fg' : 'text-dim')} title={session.workspace ?? undefined}>
          {session.workspace ?? "No folder: the agent can't read files"}
        </span>
        {session.workspace && (
          <button onClick={() => void update({ workspace: null })} aria-label="Clear the folder" title="Clear the folder" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim hover:bg-elev-2 hover:text-fg">
            <X size={12} />
          </button>
        )}
      </div>
      <div className="grid gap-0.5">
        {folders.map((f) => (
          <button key={f} onClick={() => void update({ workspace: f })} title={f} className="flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-ui text-muted hover:bg-elev-2 hover:text-fg">
            <FolderSimple size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{f.split(/[\\/]/).pop()}</span>
            <span className="max-w-[45%] truncate font-mono text-micro text-dim">{f.split(/[\\/]/).slice(0, -1).join('\\')}</span>
          </button>
        ))}
        <button onClick={() => void choose()} className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-ui text-muted hover:bg-elev-2 hover:text-fg">
          <FolderSimplePlus size={14} className="shrink-0" />
          Choose a folder…
        </button>
      </div>
      <Field label="Runs in">
        <Segmented
          value={session.container ? 'container' : 'local'}
          onChange={(v) => void update(v === 'container' ? { container: session.container ?? DEFAULT_CONTAINER, fileAccess: 'write', shell: true } : { container: null })}
          options={[
            { value: 'local', label: 'This computer', icon: Desktop },
            { value: 'container', label: 'Linux container', icon: Cube }
          ]}
          label="Runs in"
        />
      </Field>
      {session.container && <ContainerOptions session={session} update={update} />}
      {(session.workspace || session.container) && (
        <label className="flex cursor-pointer items-center gap-2 text-caption text-muted">
          <input type="checkbox" checked={session.codeIntel} onChange={(e) => void update({ codeIntel: e.target.checked })} className="accent-crimson" />
          <Code size={13} />
          Code intelligence <span className="text-dim">(TypeScript, Python)</span>
        </label>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="text-caption text-dim">{label}</div>
      {children}
      {hint && <div className="text-caption text-dim">{hint}</div>}
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled = [],
  size = 'md'
}: {
  value: T
  onChange(v: T): void
  options: { value: T; label: string; icon?: typeof Desktop }[]
  label: string
  disabled?: string[]
  size?: 'sm' | 'md'
}) {
  return (
    <div role="group" aria-label={label} className={clsx('flex border border-line bg-bg', size === 'sm' ? 'rounded-[8px] p-[2px]' : 'rounded-[10px] p-[3px]')}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            aria-pressed={on}
            disabled={disabled.includes(o.value)}
            onClick={() => onChange(o.value)}
            className={clsx(
              'flex min-w-0 flex-1 items-center justify-center gap-1.5 transition-colors disabled:opacity-40',
              size === 'sm' ? 'h-6 rounded-[6px] px-1.5 text-caption' : 'h-7 rounded-[7px] px-2 text-caption',
              on ? 'bg-elev-2 text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_2px_6px_rgb(0_0_0/0.35)]' : 'text-dim hover:text-muted'
            )}
          >
            {o.icon && <o.icon size={13} weight={on ? 'fill' : 'regular'} className="shrink-0" />}
            <span className="truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Image and network for a container chat, and a warning when Docker can't be reached. */
function ContainerOptions({ session, update }: { session: ChatSession; update: Update }) {
  const settings = session.container ?? DEFAULT_CONTAINER
  const [image, setImage] = useState(settings.image)
  const [docker, setDocker] = useState<ContainerStatus | null>(null)
  useEffect(() => setImage(settings.image), [settings.image])
  useEffect(() => {
    void api.containers.status(true).then(setDocker, () => undefined)
  }, [])
  const saveImage = () => {
    const next = image.trim()
    if (next && next !== settings.image) void update({ container: { ...settings, image: next } })
    else setImage(settings.image)
  }
  return (
    <>
      {docker && !docker.available && (
        <div className="flex items-center gap-2 rounded-[10px] border border-warn/40 bg-warn/[0.07] px-2.5 py-2 text-caption text-warn">
          <span className="min-w-0 flex-1">{docker.error}</span>
          <Button size="sm" variant="ghost" onClick={() => void api.containers.status(true).then(setDocker)}>
            Check again
          </Button>
        </div>
      )}
      <Field label="Image">
        <div className="flex gap-1.5">
          <input
            value={image}
            onChange={(e) => setImage(e.target.value)}
            onBlur={saveImage}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            spellCheck={false}
            aria-label="Docker image"
            className="h-8 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-2.5 font-mono text-caption outline-none focus:border-crimson-line"
          />
          {['node:22', 'python:3.12'].filter((i) => i !== settings.image).map((i) => (
            <button key={i} onClick={() => void update({ container: { ...settings, image: i } })} className="h-8 shrink-0 rounded-[10px] border border-line px-2 font-mono text-caption text-muted hover:border-line-strong hover:text-fg">
              {i}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Network">
        <Segmented
          value={settings.network ? 'on' : 'off'}
          onChange={(v) => void update({ container: { ...settings, network: v === 'on' } })}
          options={[
            { value: 'on', label: 'Online', icon: GlobeHemisphereWest },
            { value: 'off', label: 'Offline', icon: X }
          ]}
          label="Network"
        />
      </Field>
    </>
  )
}
