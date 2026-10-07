import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { CaretDown, Code, Cube, Desktop, FolderDashed, FolderSimple, FolderSimplePlus, GlobeHemisphereWest, X } from '@phosphor-icons/react'
import { DEFAULT_CONTAINER } from '@shared/types'
import type { AutoApprove, ChatSession, ContainerStatus, ContextUsage, Project, ThinkingLevel } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { Button } from '@/components/ui'
import { ModelMenu } from '@/components/ModelPicker'
import { ContextMeter } from '@/components/Planning'
import { BottomSheet } from '@/components/BottomSheet'

const EFFORTS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]
export const effortLabel = (t: ThinkingLevel) => EFFORTS.find((e) => e.value === t)?.label ?? t

type Update = (p: Partial<ChatSession>) => Promise<void>

/** Under the message box: where the agent works, with which model and effort, and how full the context is. */
export function StatusLine({ session, update, usage, compacting, onCompact }: { session: ChatSession; update: Update; usage: ContextUsage | null; compacting: boolean; onCompact(): void }) {
  const providers = useApp((s) => s.providers)
  const model = providers.find((p) => p.id === session.model?.providerId)?.models.find((m) => m.id === session.model?.modelId)
  const folder = session.workspace?.split(/[\\/]/).pop()
  const access = session.container ? 'container' : session.fileAccess === 'write' ? (session.shell ? 'edits + shell' : 'edits') : session.shell ? 'read + shell' : 'read only'
  return (
    <div className="@container pointer-events-auto mx-auto mt-1.5 flex w-[min(740px,calc(100%-64px))] items-center gap-1 px-1 mobile:w-[calc(100%-20px)]" aria-label="Chat essentials" role="group">
      <StatusButton
        label={
          <>
            {session.container ? <Cube size={13} className="shrink-0" /> : folder ? <FolderSimple size={13} weight="fill" className="shrink-0" /> : <FolderDashed size={13} className="shrink-0" />}
            <span className={clsx('min-w-0 max-w-[180px] truncate', !folder && 'mobile:hidden')}>{folder ?? 'No folder'}</span>
            {folder && <span className="hidden shrink-0 whitespace-nowrap text-dim @[560px]:inline mobile:hidden">{access}</span>}
          </>
        }
        title={session.workspace ?? 'Choose a folder for the agent to work in'}
        width={360}
        sheetTitle="Folder"
      >
        {() => <FolderMenu session={session} update={update} />}
      </StatusButton>
      <StatusButton
        label={
          <>
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', session.model ? 'bg-fg/80' : 'bg-line-strong')} />
            <span className="min-w-0 max-w-[200px] truncate">{session.model ? (model?.name ?? session.model.modelId) : 'Pick a model'}</span>
            {model?.reasoning && <span className="shrink-0 whitespace-nowrap text-dim">– {effortLabel(session.thinking)}</span>}
          </>
        }
        title="Model and reasoning effort"
        width={440}
        sheetTitle="Model"
      >
        {(close) => <ModelEffortMenu session={session} update={update} reasoning={!!model?.reasoning} onPicked={close} />}
      </StatusButton>
      <div className="flex-1" />
      <ContextMeter usage={usage} busy={compacting} onCompact={onCompact} />
    </div>
  )
}

/** A quiet button that opens its own small popover above it (a bottom sheet on the phone). */
function StatusButton({ label, title, width, sheetTitle, children }: { label: ReactNode; title: string; width: number; sheetTitle: string; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || isMobile) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      // The model list's own portals (none today) and this popover count as inside.
      if (!wrap.current?.contains(t)) setOpen(false)
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
    <div ref={wrap} className="relative min-w-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        className={clsx('flex h-7 min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12px] transition-colors', open ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev hover:text-fg')}
      >
        {label}
        <CaretDown size={10} className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-180')} />
      </button>
      {isMobile ? (
        <BottomSheet open={open} onClose={close} title={sheetTitle} portal>
          {children(close)}
        </BottomSheet>
      ) : (
        <AnimatePresence>
          {open && (
            <motion.div
              role="dialog"
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

function ModelEffortMenu({ session, update, reasoning, onPicked }: { session: ChatSession; update: Update; reasoning: boolean; onPicked(): void }) {
  const list = (
    <div key="list" className="flex min-h-0 flex-1 flex-col" style={{ height: isMobile ? undefined : 360 }}>
      <ModelMenu autoFocus={!isMobile} value={session.model} onChange={(model) => void update({ model }).then(() => !reasoning && onPicked())} />
    </div>
  )
  const effort = (
    <div key="effort" className={clsx('shrink-0 px-3 py-2.5', isMobile ? 'border-b border-line' : 'border-t border-line')}>
      <div className="mb-1.5 text-[11.5px] text-dim">{reasoning ? 'Reasoning effort' : "This model doesn't reason, so it has no effort setting."}</div>
      {reasoning && (
        <>
          <Segmented value={session.thinking} onChange={(thinking) => void update({ thinking })} options={EFFORTS} label="Reasoning effort" />
          <div className="mt-1.5 text-[11px] text-dim">Higher effort thinks longer before answering: slower, better on tricky changes.</div>
        </>
      )}
    </div>
  )
  // On the phone the model list runs long, so the effort switch goes first where it can be reached.
  return <>{isMobile ? [effort, list] : [list, effort]}</>
}

const ACCESS: { value: string; label: string; patch: Partial<ChatSession> }[] = [
  { value: 'read', label: 'Read', patch: { fileAccess: 'read', shell: false } },
  { value: 'edit', label: 'Edit', patch: { fileAccess: 'write', shell: false } },
  { value: 'shell', label: 'Edit + shell', patch: { fileAccess: 'write', shell: true } }
]

function FolderMenu({ session, update }: { session: ChatSession; update: Update }) {
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    void api.projects.list().then(setProjects, () => undefined)
  }, [])
  const choose = async () => {
    const [dir] = await api.app.pickPaths({ directory: true, title: 'Choose a folder for this chat' })
    if (dir) await update({ workspace: dir })
  }
  const folders = [...new Set(projects.map((p) => p.folder).filter((f): f is string => !!f && f !== session.workspace))].slice(0, 4)
  const access = session.fileAccess === 'write' ? (session.shell ? 'shell' : 'edit') : 'read'
  const shell = session.container || window.cloth.platform !== 'win32' ? 'bash' : 'PowerShell'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto overflow-x-hidden p-3">
      <div className={clsx('flex items-center gap-2 rounded-[10px] border px-2.5 py-2', session.workspace ? 'border-line bg-bg' : 'border-dashed border-line-strong')}>
        {session.workspace ? <FolderSimple size={15} weight="fill" className="shrink-0 text-muted" /> : <FolderDashed size={15} className="shrink-0 text-dim" />}
        <span className={clsx('min-w-0 flex-1 truncate font-mono text-[11.5px]', session.workspace ? 'text-fg' : 'text-dim')} title={session.workspace ?? undefined}>
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
          <button key={f} onClick={() => void update({ workspace: f })} title={f} className="flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-[12.5px] text-muted hover:bg-elev-2 hover:text-fg">
            <FolderSimple size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{f.split(/[\\/]/).pop()}</span>
            <span className="max-w-[45%] truncate font-mono text-[10.5px] text-dim">{f.split(/[\\/]/).slice(0, -1).join('\\')}</span>
          </button>
        ))}
        <button onClick={() => void choose()} className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-muted hover:bg-elev-2 hover:text-fg">
          <FolderSimplePlus size={14} className="shrink-0" />
          Choose a folder…
        </button>
      </div>
      <Field label="Runs in">
        <Segmented
          value={session.container ? 'container' : 'local'}
          onChange={(v) => void update(v === 'container' ? { container: session.container ?? DEFAULT_CONTAINER, fileAccess: 'write', shell: true } : { container: null })}
          options={[
            { value: 'local', label: 'This PC', icon: Desktop },
            { value: 'container', label: 'Linux container', icon: Cube }
          ]}
          label="Runs in"
        />
      </Field>
      {session.container && <ContainerOptions session={session} update={update} />}
      {(session.workspace || session.container) && (
        <>
          <Field label="Access" hint={access === 'read' ? 'Read, list and search files.' : access === 'edit' ? 'Also write and edit files; each change can be undone.' : `Also run commands (${shell}) in the folder.`}>
            <Segmented value={access} onChange={(v) => void update(ACCESS.find((a) => a.value === v)!.patch)} options={ACCESS} label="Access" disabled={session.container ? ['read', 'edit'] : []} />
          </Field>
          <Field label="Approvals">
            <Segmented<AutoApprove>
              value={session.autoApprove}
              onChange={(autoApprove) => void update({ autoApprove })}
              options={[
                { value: 'none', label: 'Ask first' },
                { value: 'edits', label: 'Allow edits' },
                { value: 'all', label: 'Allow all' }
              ]}
              label="Approvals"
            />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={session.codeIntel} onChange={(e) => void update({ codeIntel: e.target.checked })} className="accent-crimson" />
            <Code size={13} />
            Code intelligence <span className="text-dim">(TypeScript, Python)</span>
          </label>
        </>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="text-[11.5px] text-dim">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-dim">{hint}</div>}
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
              size === 'sm' ? 'h-6 rounded-[6px] px-1.5 text-[11.5px]' : 'h-7 rounded-[7px] px-2 text-[12px]',
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
        <div className="flex items-center gap-2 rounded-[10px] border border-warn/40 bg-warn/[0.07] px-2.5 py-2 text-[11.5px] text-warn">
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
            className="h-8 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-2.5 font-mono text-[12px] outline-none focus:border-crimson-line"
          />
          {['node:22', 'python:3.12'].filter((i) => i !== settings.image).map((i) => (
            <button key={i} onClick={() => void update({ container: { ...settings, image: i } })} className="h-8 shrink-0 rounded-[10px] border border-line px-2 font-mono text-[11px] text-muted hover:border-line-strong hover:text-fg">
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
