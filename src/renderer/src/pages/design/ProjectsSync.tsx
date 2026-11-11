import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CaretRight, FolderSimple } from '@phosphor-icons/react'
import type { DesignFileState, DesignProjectSync } from '@shared/design'
import { api } from '@/lib/api'
import { attempt } from '@/lib/store'
import { Button, Modal, Spinner } from '@/components/ui'
import { DiffView } from '@/components/DiffView'

const STATE: Record<DesignFileState, { label: string; cls: string }> = {
  current: { label: 'up to date', cls: 'text-dim' },
  outdated: { label: 'out of date', cls: 'text-info' },
  missing: { label: 'not written', cls: 'text-muted' },
  edited: { label: 'edited by hand', cls: 'text-warn' }
}

/** Which projects use the system, whether their copy of its files is current, and writing updates with a diff. */
export function ProjectsSync({ designId, version }: { designId: string; version: number }) {
  const [list, setList] = useState<DesignProjectSync[] | null>(null)
  const load = () => void api.design.projects(designId).then(setList, () => setList([]))
  // Re-check after edits to the system (it saves a moment after each change).
  useEffect(load, [designId, version]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!list)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  const withFolder = list.filter((p) => p.folder)
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-[min(860px,calc(100%-40px))] gap-3 py-5">
        <p className="text-ui text-dim">
          A project that follows this system gets its DESIGN.md in every chat. Writing puts the files in the project's <span className="font-mono">design/</span> folder: tokens, the Tailwind theme, the component pages and the shadcn theme. Files you edited there are never overwritten without asking.
        </p>
        {withFolder.map((p) => (
          <ProjectRow key={p.projectId} designId={designId} project={p} onChanged={(next) => setList((l) => l!.map((x) => (x.projectId === next.projectId ? next : x)))} reload={load} />
        ))}
        {!withFolder.length && <div className="rounded-[12px] border border-dashed border-line p-4 text-ui text-dim">No projects with a folder yet. Create one from the chat list to write the system into it.</div>}
        {list.length > withFolder.length && <p className="text-caption text-dim">{list.length - withFolder.length} project{list.length - withFolder.length === 1 ? ' has' : 's have'} no folder, so nothing can be written there.</p>}
      </div>
    </div>
  )
}

function ProjectRow({ designId, project, onChanged, reload }: { designId: string; project: DesignProjectSync; onChanged(p: DesignProjectSync): void; reload(): void }) {
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const count = (s: DesignFileState) => project.files.filter((f) => f.state === s).length
  const outdated = count('outdated')
  const missing = count('missing')
  const edited = count('edited')
  const written = project.files.length - missing
  const status = !written ? 'Not written' : outdated + edited + missing === 0 ? 'Up to date' : [outdated + missing && `${outdated + missing} file${outdated + missing === 1 ? '' : 's'} to update`, edited && `${edited} edited by hand`].filter(Boolean).join(' · ')

  const write = async (paths: string[]) => {
    setBusy(true)
    const next = await attempt(() => api.design.writeProject(designId, project.projectId, paths))
    setBusy(false)
    if (next) onChanged(next)
  }
  const showDiff = async (path: string) => {
    const text = await attempt(() => api.design.projectDiff(designId, project.projectId, path))
    if (text !== undefined) setDiff({ path, text })
  }
  const link = async (on: boolean) => {
    await attempt(() => api.projects.update(project.projectId, { designId: on ? designId : null }))
    reload()
  }
  const safe = project.files.filter((f) => f.state === 'outdated' || f.state === 'missing').map((f) => f.path)

  return (
    <div className="rounded-[14px] border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          <CaretRight size={11} className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-90')} />
          <FolderSimple size={16} weight="fill" className="shrink-0" style={{ color: project.color }} />
          <span className="min-w-0">
            <span className="flex items-baseline gap-2">
              <span className="truncate text-ui font-medium">{project.name}</span>
              {project.linked && <span className="shrink-0 text-caption text-ok">follows this system</span>}
            </span>
            <span className="block truncate font-mono text-caption text-dim">{project.folder}</span>
          </span>
        </button>
        <span className={clsx('text-caption', edited ? 'text-warn' : outdated + missing ? 'text-muted' : 'text-dim')}>{status}</span>
        {safe.length > 0 && (
          <Button size="sm" variant="primary" loading={busy} onClick={() => void write(safe)}>
            {written ? `Update ${safe.length} file${safe.length === 1 ? '' : 's'}` : 'Write files'}
          </Button>
        )}
        {project.linked ? (
          <Button size="sm" variant="ghost" onClick={() => void link(false)}>
            Stop following
          </Button>
        ) : (
          !safe.length && (
            <Button size="sm" onClick={() => void link(true)}>
              Follow this system
            </Button>
          )
        )}
      </div>
      {open && (
        <ul className="grid gap-0.5 border-t border-line p-1.5">
          {project.files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 rounded-[8px] px-2 py-1 hover:bg-elev">
              <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted">design/{f.path}</span>
              <span className={clsx('shrink-0 text-caption', STATE[f.state].cls)}>{STATE[f.state].label}</span>
              {f.state !== 'current' && (
                <button onClick={() => void showDiff(f.path)} className="shrink-0 rounded px-1.5 text-caption text-dim hover:bg-elev-2 hover:text-fg">
                  Diff
                </button>
              )}
              {f.state === 'edited' && (
                <button onClick={() => void write([f.path])} className="shrink-0 rounded px-1.5 text-caption text-warn hover:bg-elev-2">
                  Overwrite
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!diff} onClose={() => setDiff(null)} title={diff ? `design/${diff.path}` : ''} width={820}>
        {diff && (
          <>
            <p className="mb-2 text-caption text-dim">Red is what the project has now; green is what the design system would write.</p>
            <DiffView diff={diff.text} maxHeight={520} />
          </>
        )}
      </Modal>
    </div>
  )
}
