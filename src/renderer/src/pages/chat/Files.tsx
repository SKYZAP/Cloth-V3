import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ArrowLeft, ArrowSquareOut, CaretDown, CaretRight, Cube, File, FileCode, FileImage, FileText, FolderDashed, FolderOpen, FolderSimple, MagnifyingGlass, Paperclip, TextT } from '@phosphor-icons/react'
import type { WorkspaceEntry, WorkspaceFile, WorkspaceRoot } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { Button } from '@/components/ui'
import { takeWorkspaceFile, useSetupNav } from './setupNav'

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|cpp|c|h|rb|php|swift|css|scss|html|json|yaml|yml|toml|sql|sh|ps1|vue|svelte)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i

function icon(e: WorkspaceEntry, open: boolean) {
  if (e.dir) return open ? <FolderOpen size={14} weight="fill" className="text-info/80" /> : <FolderSimple size={14} weight="fill" className="text-info/70" />
  if (IMAGE.test(e.name)) return <FileImage size={14} />
  if (CODE.test(e.name)) return <FileCode size={14} />
  if (/\.(md|txt|rst)$/i.test(e.name)) return <FileText size={14} />
  return <File size={14} />
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The chat's folder (or its container copy) as a tree, with a preview. */
export function Files({ sessionId, visible, onAttach, onInsert, onPickFolder }: { sessionId: string; visible: boolean; onAttach(f: WorkspaceFile): void; onInsert(path: string): void; onPickFolder(): void }) {
  const [root, setRoot] = useState<WorkspaceRoot | null>(null)
  const [dirs, setDirs] = useState<Record<string, WorkspaceEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [file, setFile] = useState<WorkspaceFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (dir: string) => {
      try {
        const entries = await api.panel.list(sessionId, dir)
        setDirs((d) => ({ ...d, [dir]: entries }))
        setError(null)
      } catch (err) {
        if (dir === '') setError(err instanceof Error ? err.message : String(err))
      }
    },
    [sessionId]
  )
  const refresh = useCallback(async () => {
    const r = await api.panel.root(sessionId)
    setRoot(r)
    if (!r.path) return
    // Re-read every open folder (the agent may have changed things).
    await Promise.all(['', ...open].map((d) => load(d)))
  }, [sessionId, open, load])

  useEffect(() => {
    setDirs({})
    setOpen(new Set())
    setFile(null)
    setRoot(null)
  }, [sessionId])
  useEffect(() => {
    if (visible) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId])
  useEvent('chat', (e) => {
    if (e.sessionId === sessionId && e.type === 'end' && visible) void refresh()
  })

  const toggle = (dir: string) => {
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        if (!dirs[dir]) void load(dir)
      }
      return next
    })
  }
  const preview = async (path: string) => {
    const f = await attempt(() => api.panel.read(sessionId, path))
    if (f) setFile(f)
  }
  // A file clicked in the chat (a path in a reply, a tool's changed file): show it once this tab is on screen.
  const request = useSetupNav((n) => n.file)
  useEffect(() => {
    if (!request || !visible) return
    takeWorkspaceFile(request.seq)
    void preview(request.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq, visible])

  const q = filter.trim().toLowerCase()
  const rows = useMemo(() => {
    const out: { e: WorkspaceEntry; depth: number }[] = []
    const walk = (dir: string, depth: number) => {
      for (const e of dirs[dir] ?? []) {
        if (q) {
          // Filtering looks through everything loaded so far, flat.
          if (e.name.toLowerCase().includes(q)) out.push({ e, depth: 0 })
          if (e.dir && dirs[e.path]) walk(e.path, 0)
          continue
        }
        out.push({ e, depth })
        if (e.dir && open.has(e.path)) walk(e.path, depth + 1)
      }
    }
    walk('', 0)
    return out
  }, [dirs, open, q])

  if (root && !root.path)
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="space-y-3">
          <FolderDashed size={28} className="mx-auto text-dim" />
          <div className="text-ui text-dim">This chat has no folder yet.</div>
          {!isMobile && (
            <Button size="sm" icon={<FolderSimple size={13} />} onClick={onPickFolder}>
              Choose a folder
            </Button>
          )}
        </div>
      </div>
    )

  if (file) return <Preview file={file} sessionId={sessionId} onBack={() => setFile(null)} onAttach={() => onAttach(file)} onInsert={() => onInsert(file.path)} />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-panel px-2 focus-within:border-crimson-line">
          <MagnifyingGlass size={12} className="shrink-0 text-dim" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter open folders" aria-label="Filter files" className="min-w-0 flex-1 bg-transparent text-caption outline-none placeholder:text-dim" />
        </div>
        <button onClick={() => void refresh()} className="flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-elev hover:text-fg" aria-label="Refresh" title="Refresh">
          <ArrowClockwise size={13} />
        </button>
      </div>
      {root?.container && (
        <div className="flex shrink-0 items-start gap-2 border-b border-line bg-info/[0.06] px-3 py-2 text-caption text-muted">
          <Cube size={13} className="mt-0.5 shrink-0 text-info" />
          The container's copy of your folder — changes reach your folder when you apply them.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error && <div className="px-3 py-2 text-caption text-warn">{error}</div>}
        {rows.map(({ e, depth }) => (
          <button
            key={e.path}
            onClick={() => (e.dir ? toggle(e.path) : void preview(e.path))}
            title={e.path}
            className={clsx('flex h-[26px] w-full items-center gap-1.5 pr-2 text-left text-ui hover:bg-elev', e.ignored ? 'text-dim opacity-55 hover:opacity-100' : 'text-muted hover:text-fg')}
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <span className="flex w-3 shrink-0 justify-center text-dim">{e.dir && !q ? open.has(e.path) ? <CaretDown size={10} /> : <CaretRight size={10} /> : null}</span>
            <span className="shrink-0">{icon(e, open.has(e.path))}</span>
            <span className="min-w-0 flex-1 truncate">{q ? e.path : e.name}</span>
            {!e.dir && <span className="shrink-0 text-micro text-dim">{size(e.size)}</span>}
          </button>
        ))}
        {root?.path && dirs[''] && !rows.length && <div className="px-3 py-2 text-caption text-dim">{q ? 'Nothing matches in the open folders.' : 'The folder is empty.'}</div>}
      </div>
    </div>
  )
}

function Preview({ file, sessionId, onBack, onAttach, onInsert }: { file: WorkspaceFile; sessionId: string; onBack(): void; onAttach(): void; onInsert(): void }) {
  const lines = useMemo(() => (file.text ?? '').split('\n'), [file.text])
  const name = file.path.split('/').pop()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1.5">
        <button onClick={onBack} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" aria-label="Back to files">
          <ArrowLeft size={14} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui font-medium">{name}</div>
          <div className="truncate text-micro text-dim">
            {file.path} · {size(file.size)}
            {file.truncated ? ' · first 1 MB' : ''}
          </div>
        </div>
        {file.kind !== 'binary' && (
          <button onClick={onAttach} className="flex h-7 items-center gap-1 rounded-md px-2 text-caption text-muted hover:bg-elev hover:text-fg" title="Attach this file to your next message">
            <Paperclip size={13} /> Attach
          </button>
        )}
        <button onClick={onInsert} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" title="Insert the path into your message" aria-label="Insert path">
          <TextT size={14} />
        </button>
        {!isMobile && (
          <button onClick={() => void attempt(() => api.panel.open(sessionId, file.path))} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" title="Open with the default app" aria-label="Open">
            <ArrowSquareOut size={14} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {file.kind === 'image' ? (
          <div className="grid min-h-full place-items-center bg-[repeating-conic-gradient(rgb(255_255_255/0.04)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4">
            <img src={`data:${file.mimeType};base64,${file.data}`} alt={name} className="max-w-full object-contain" />
          </div>
        ) : file.kind === 'binary' ? (
          <div className="p-6 text-center text-ui text-dim">A binary file — no preview.</div>
        ) : (
          <table className="w-full border-collapse font-mono text-caption leading-[1.55]">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="w-px select-none whitespace-nowrap px-2.5 text-right align-top text-dim/70">{i + 1}</td>
                  <td className="selectable whitespace-pre pr-4 text-fg/90">{l || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
