import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CaretRight, Cube, Warning } from '@phosphor-icons/react'
import type { ChatSession, ContainerChange, ContainerChanges } from '@shared/types'
import { api } from '@/lib/api'
import { attempt } from '@/lib/store'
import { Badge, Button, confirmAction } from '@/components/ui'
import { BottomSheet } from '@/components/BottomSheet'
import { DiffView } from '@/components/DiffView'

const KIND: Record<ContainerChange['kind'], { label: string; tone: 'ok' | 'info' | 'crimson' }> = {
  create: { label: 'new', tone: 'ok' },
  modify: { label: 'changed', tone: 'info' },
  delete: { label: 'deleted', tone: 'crimson' }
}

/** Header pill for a container chat: shows it runs in a container and how many changes wait for review. */
export function ContainerPill({ session, running }: { session: ChatSession; running: boolean }) {
  const [data, setData] = useState<ContainerChanges | null>(null)
  const [open, setOpen] = useState(false)
  const load = () => void api.containers.changes(session.id).then(setData, () => undefined)
  // After every turn (the agent may have changed files) and when the sheet opens.
  useEffect(load, [session.id, running, open])

  const count = data?.changes.length ?? 0
  const image = session.container?.image ?? ''
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`Runs in a Linux container (${image}) on a copy of the folder`}
        className={clsx('flex h-[30px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors', count ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line text-muted hover:border-line-strong')}
      >
        <Cube size={14} weight={count ? 'fill' : 'regular'} className={count ? 'text-crimson-hi' : undefined} />
        <span className="mobile:hidden">{count ? `${count} change${count === 1 ? '' : 's'}` : 'Container'}</span>
        {!!count && <span className="hidden font-mono mobile:inline">{count}</span>}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Container changes" description={session.workspace ? `Copy of ${session.workspace} · ${image}` : `Empty workspace · ${image}`} snapPoints={[0.85]} portal>
        {data && <ChangesBody session={session} data={data} onData={setData} />}
      </BottomSheet>
    </>
  )
}

function ChangesBody({ session, data, onData }: { session: ChatSession; data: ContainerChanges; onData(d: ContainerChanges): void }) {
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
    if (hit.length && !(await confirmAction(`${hit.map((c) => c.path).join(', ')} also changed in your folder. Applying overwrites those changes.`, { title: 'Overwrite your changes?', confirmLabel: 'Apply anyway', danger: true }))) return
    await run(() => api.containers.apply(session.id, paths), paths ? 'Applied' : 'All changes applied')
  }
  const discard = async (paths?: string[]) => {
    if (!paths && !(await confirmAction('Every change in the container copy is reverted to what your folder has now.', { title: 'Discard all changes?', confirmLabel: 'Discard all', danger: true }))) return
    await run(() => api.containers.discard(session.id, paths), paths ? 'Discarded' : 'All changes discarded')
  }
  const reset = async () => {
    if (!(await confirmAction('The container is removed and a fresh one starts on the next command. Installed packages are lost; the files in the copy stay.', { title: 'Reset the container?', confirmLabel: 'Reset' }))) return
    await attempt(() => api.containers.reset(session.id), 'Container reset')
  }

  if (!data.changes.length)
    return (
      <div className="space-y-4 py-6 text-center">
        <div className="text-[13px] text-muted">No changes yet. Your folder is untouched until you apply something here.</div>
        <Button size="sm" variant="ghost" onClick={() => void reset()}>
          Reset container
        </Button>
      </div>
    )

  return (
    <div className="space-y-3 pb-4">
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
                      <span className="text-ok">+{c.added}</span> <span className="text-crimson-hi">−{c.removed}</span>
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
  )
}
