import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Broadcast, CaretRight, Cube, Warning } from '@phosphor-icons/react'
import type { ChatSession, ContainerChange, ContainerChanges, ContainerPort } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { isMobile } from '@/lib/platform'
import { attempt, useApp } from '@/lib/store'
import { Badge, Button, confirmAction } from '@/components/ui'
import { BottomSheet } from '@/components/BottomSheet'
import { DiffView } from '@/components/DiffView'

const KIND: Record<ContainerChange['kind'], { label: string; tone: 'ok' | 'info' | 'danger' }> = {
  create: { label: 'new', tone: 'ok' },
  modify: { label: 'changed', tone: 'info' },
  delete: { label: 'deleted', tone: 'danger' }
}

/** Header pill for a container chat: shows it runs in a container and how many changes wait for review. */
export function ContainerPill({ session, running }: { session: ChatSession; running: boolean }) {
  const [data, setData] = useState<ContainerChanges | null>(null)
  const [open, setOpen] = useState(false)
  const load = () => void api.containers.changes(session.id).then(setData, () => undefined)
  // After every turn (the agent may have changed files), when the folder changes and when the sheet opens.
  useEffect(load, [session.id, session.workspace, running, open])
  const [ports, setPorts] = useState<ContainerPort[]>([])
  useEffect(() => void api.containers.ports(session.id).then(setPorts, () => undefined), [session.id, running, open])
  useEvent('containers', (e) => e.sessionId === session.id && setPorts(e.ports))

  const count = data?.changes.length ?? 0
  const servers = ports.filter((p) => p.url).length
  const image = session.container?.image ?? ''
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`Runs in a Linux container (${image}) on a copy of the folder${servers ? ` · ${servers} server${servers === 1 ? '' : 's'} running` : ''}`}
        className={clsx('flex h-[30px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors', count ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line text-muted hover:border-line-strong')}
      >
        <Cube size={14} weight={count ? 'fill' : 'regular'} className={count ? 'text-crimson-hi' : undefined} />
        <span className="mobile:hidden">{count ? `${count} change${count === 1 ? '' : 's'}` : 'Container'}</span>
        {!!count && <span className="hidden font-mono mobile:inline">{count}</span>}
        {!!servers && (
          <span className="flex items-center gap-1 text-ok">
            <Broadcast size={12} weight="bold" /> <span className="mobile:hidden">{servers}</span>
          </span>
        )}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Container" description={session.workspace ? `Copy of ${session.workspace} · ${image}` : `Empty workspace · ${image}`} snapPoints={[0.85]} portal>
        {data && <ChangesBody session={session} data={data} onData={setData} ports={ports} />}
      </BottomSheet>
    </>
  )
}

function RunningServers({ ports }: { ports: ContainerPort[] }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[12.5px] text-muted">Running servers</span>
        <span className="text-[11.5px] text-dim">Only this PC can open them</span>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-line">
        {ports.map((p) =>
          p.url ? (
            <div key={p.port} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
              <Broadcast size={14} className="shrink-0 text-ok" />
              <span className="truncate font-mono text-[12px]">localhost:{p.hostPort}</span>
              {p.hostPort !== p.port && <span className="shrink-0 text-[11.5px] text-dim">from port {p.port}</span>}
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(p.url!).then(() => useApp.getState().toast('Link copied', 'ok'))}>
                Copy link
              </Button>
              {!isMobile && (
                <Button size="sm" onClick={() => void attempt(() => api.app.openExternal(p.url!))}>
                  Open
                </Button>
              )}
            </div>
          ) : (
            <div key={p.port} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
              <Warning size={14} className="shrink-0 text-warn" />
              <span className="shrink-0 font-mono text-[12px]">port {p.port}</span>
              <span className="min-w-0 text-[11.5px] text-danger-hi">{p.error}</span>
            </div>
          )
        )}
      </div>
    </div>
  )
}

function ChangesBody({ session, data, onData, ports: all }: { session: ChatSession; data: ContainerChanges; onData(d: ContainerChanges): void; ports: ContainerPort[] }) {
  const ports = all.filter((p) => p.url || p.error)
  const servers = ports.length ? <RunningServers ports={ports} /> : null
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const conflicts = data.changes.filter((c) => c.conflict)

  const run = async (fn: () => Promise<ContainerChanges>, done: string) => {
    setBusy(true)
    const next = await attempt(fn, done)
    setBusy(false)
    if (next) onData(next)
  }
  const apply = async (paths?: string[]) => {
    const hit = conflicts.filter((c) => !paths || paths.includes(c.path))
    if (
      hit.length &&
      !(await confirmAction(`${hit.map((c) => c.path).join(', ')} also changed in your folder. Applying overwrites those changes.`, {
        title: 'Overwrite your changes?',
        confirmLabel: 'Apply anyway',
        danger: true
      }))
    )
      return
    await run(() => api.containers.apply(session.id, paths), paths ? 'Applied' : 'All changes applied')
  }
  const discard = async (paths?: string[]) => {
    if (
      !paths &&
      !(await confirmAction('Every change in the container copy is reverted to what your folder has now.', {
        title: 'Discard all changes?',
        confirmLabel: 'Discard all',
        danger: true
      }))
    )
      return
    await run(() => api.containers.discard(session.id, paths), paths ? 'Discarded' : 'All changes discarded')
  }
  const reset = async () => {
    if (
      !(await confirmAction('The container is removed and a fresh one starts on the next command. Installed packages are lost; the files in the copy stay.', {
        title: 'Reset the container?',
        confirmLabel: 'Reset'
      }))
    )
      return
    await attempt(() => api.containers.reset(session.id), 'Container reset')
  }

  if (!data.changes.length)
    return (
      <>
        {servers}
        <div className={clsx('space-y-4 py-6 text-center', servers && 'mt-4')}>
          <div className="text-[13px] text-muted">No changes yet.</div>
          <Button size="sm" variant="ghost" onClick={() => void reset()}>
            Reset container
          </Button>
        </div>
      </>
    )

  return (
    <>
      {servers}
      <div className={clsx('space-y-3 pb-4', servers && 'mt-4')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-muted">
            {data.changes.length} file{data.changes.length === 1 ? '' : 's'}
            {conflicts.length ? ` · ${conflicts.length} also changed in your folder` : ''}
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reset()}>
            Reset container
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void discard()}>
            Discard all
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !data.folder} loading={busy} onClick={() => void apply()} title={data.folder ? undefined : 'This chat has no folder to apply to'}>
            Apply all
          </Button>
        </div>
        <div className="overflow-hidden rounded-[14px] border border-line">
          {data.changes.map((c) => {
            const open = openPaths.has(c.path)
            return (
              <div key={c.path} className="border-b border-line last:border-b-0">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() =>
                      setOpenPaths((s) => {
                        const n = new Set(s)
                        if (open) n.delete(c.path)
                        else n.add(c.path)
                        return n
                      })
                    }
                  >
                    <CaretRight size={11} weight="bold" className={clsx('shrink-0 text-dim transition-transform duration-200', open && 'rotate-90')} />
                    <span className="truncate font-mono text-[12px]">{c.path}</span>
                    <Badge tone={KIND[c.kind].tone}>{KIND[c.kind].label}</Badge>
                    {c.conflict && (
                      <span title="Also changed in your folder" className="flex shrink-0 text-warn">
                        <Warning size={14} weight="fill" />
                      </span>
                    )}
                    {!c.binary && (
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-ok">+{c.added}</span> <span className="text-danger-hi">−{c.removed}</span>
                      </span>
                    )}
                  </button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discard([c.path])}>
                    Discard
                  </Button>
                  <Button size="sm" disabled={busy || !data.folder} onClick={() => void apply([c.path])}>
                    Apply
                  </Button>
                </div>
                {open && <div className="border-t border-line">{c.binary ? <div className="px-3 py-2 text-[12px] text-dim">Binary or very large file — no preview.</div> : <DiffView diff={c.diff} maxHeight={360} />}</div>}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
