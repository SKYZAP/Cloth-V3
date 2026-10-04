import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ArrowDown, ArrowLeft, ArrowUp, ArrowUUpLeft, CaretDown, CaretRight, GitBranch, GitCommit as CommitIcon, Minus, Plus, Sparkle } from '@phosphor-icons/react'
import type { GitCommit, GitFile, GitStatus, WorkspaceRoot } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, confirmAction } from '@/components/ui'

const LETTER_COLOR: Record<string, string> = { M: 'text-warn', A: 'text-ok', '?': 'text-ok', D: 'text-crimson-hi', R: 'text-info', C: 'text-info', U: 'text-crimson-hi', T: 'text-warn' }

function letter(f: GitFile, staged: boolean): string {
  if (f.conflicted) return 'U'
  if (f.untracked) return 'A'
  const l = staged ? f.index : f.worktree
  return l === '.' ? 'M' : l
}

const split = (p: string) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) }
}

/** Git for the chat's folder: changes, diffs, staging, commits, pull and push. */
export function GitPanel({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const [root, setRoot] = useState<WorkspaceRoot | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [diff, setDiff] = useState<{ file: GitFile; staged: boolean; text: string } | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  const refresh = useCallback(async () => {
    const [r, s] = await Promise.all([api.panel.root(sessionId), api.panel.gitStatus(sessionId).catch(() => null)])
    setRoot(r)
    setStatus(s)
    if (s?.repo) void api.panel.gitLog(sessionId).then(setLog)
  }, [sessionId])

  useEffect(() => {
    setStatus(null)
    setDiff(null)
    setMessage('')
  }, [sessionId])
  // Poll while visible: the agent, a terminal or another app may change files at any time.
  useEffect(() => {
    if (!visible) return
    void refresh()
    const t = setInterval(() => void refresh(), 4000)
    return () => clearInterval(t)
  }, [visible, refresh])
  useEvent('chat', (e) => {
    if (e.sessionId === sessionId && e.type === 'end' && visible) void refresh()
  })

  const staged = useMemo(() => status?.files.filter((f) => f.staged) ?? [], [status])
  const changes = useMemo(() => status?.files.filter((f) => f.unstaged) ?? [], [status])

  const act = async <T,>(label: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(label)
    const out = await attempt(fn, ok)
    setBusy(null)
    return out
  }
  const apply = (s: GitStatus | undefined) => {
    if (s) setStatus(s)
  }
  const stage = (paths: string[]) => void act('stage', () => api.panel.gitStage(sessionId, paths)).then(apply)
  const unstage = (paths: string[]) => void act('unstage', () => api.panel.gitUnstage(sessionId, paths)).then(apply)
  const discard = async (files: GitFile[]) => {
    const untracked = files.filter((f) => f.untracked).length
    const what = files.length === 1 ? `“${files[0].path}”` : `${files.length} files`
    const ok = await confirmAction(untracked === files.length ? `${what} ${files.length === 1 ? 'is' : 'are'} deleted — ${files.length === 1 ? 'it has' : 'they have'} never been committed.` : `Your changes to ${what} are lost; ${files.length === 1 ? 'it goes' : 'they go'} back to the last committed version.${untracked ? ' New files are deleted.' : ''}`, { title: 'Discard changes?', confirmLabel: 'Discard', danger: true })
    if (!ok) return
    apply(await act('discard', () => api.panel.gitDiscard(sessionId, files.map((f) => f.path))))
    setDiff(null)
  }
  const openDiff = async (file: GitFile, isStaged: boolean) => {
    const text = await act('diff', () => api.panel.gitDiff(sessionId, file.path, isStaged))
    if (text !== undefined) setDiff({ file, staged: isStaged, text })
  }
  const all = !staged.length
  const commit = async () => {
    const r = await act('commit', () => api.panel.gitCommit(sessionId, message, all))
    if (!r) return
    setMessage('')
    setStatus(r.status)
    void api.panel.gitLog(sessionId).then(setLog)
    useApp.getState().toast(`Committed ${r.hash}`, 'ok')
  }
  const suggest = async () => {
    const text = await act('message', () => api.panel.commitMessage(sessionId, all))
    if (text) setMessage(text)
  }

  if (root && !root.folder) return <Empty>This chat has no folder.</Empty>
  if (status && !status.repo) return <Empty>{root?.folder} is not a git repository.</Empty>
  if (!status) return <Empty>Reading git status…</Empty>

  if (diff)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1.5">
          <button onClick={() => setDiff(null)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" aria-label="Back to changes">
            <ArrowLeft size={14} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium">{split(diff.file.path).name}</div>
            <div className="truncate text-[10.5px] text-dim">
              {diff.file.path} · {diff.staged ? 'staged' : diff.file.untracked ? 'new file' : 'not staged'}
            </div>
          </div>
          {diff.staged ? (
            <Button size="sm" icon={<Minus size={12} />} onClick={() => (unstage([diff.file.path]), setDiff(null))}>
              Unstage
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" icon={<ArrowUUpLeft size={12} />} onClick={() => void discard([diff.file])}>
                Discard
              </Button>
              <Button size="sm" icon={<Plus size={12} />} onClick={() => (stage([diff.file.path]), setDiff(null))}>
                Stage
              </Button>
            </>
          )}
        </div>
        <DiffView text={diff.text} />
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-[12px]">
        <GitBranch size={14} className="shrink-0 text-dim" />
        <span className="min-w-0 truncate font-medium" title={status.upstream ? `Tracking ${status.upstream}` : 'No upstream branch'}>
          {status.branch ?? 'detached HEAD'}
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="shrink-0 font-mono text-[11px] text-dim">
            {status.ahead > 0 && `↑${status.ahead}`} {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <div className="flex-1" />
        <button disabled={!!busy} onClick={() => void act('pull', () => api.panel.gitPull(sessionId), 'Pulled').then(refresh)} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-elev hover:text-fg disabled:opacity-50" title="Pull (fast-forward only)">
          <ArrowDown size={13} /> {busy === 'pull' ? '…' : 'Pull'}
        </button>
        <button disabled={!!busy} onClick={() => void act('push', () => api.panel.gitPush(sessionId), 'Pushed').then(refresh)} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-elev hover:text-fg disabled:opacity-50" title={status.upstream ? `Push to ${status.upstream}` : 'Push and set origin as upstream'}>
          <ArrowUp size={13} /> {busy === 'push' ? '…' : 'Push'}
        </button>
        <button onClick={() => void refresh()} className="flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-elev hover:text-fg" aria-label="Refresh" title="Refresh">
          <ArrowClockwise size={13} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-1.5 border-b border-line p-2.5">
          <div className="relative">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && message.trim() && status.files.length) {
                  e.preventDefault()
                  void commit()
                }
              }}
              rows={message.includes('\n') ? 4 : 2}
              placeholder={status.files.length ? 'Commit message (Ctrl+Enter to commit)' : 'Nothing to commit'}
              aria-label="Commit message"
              className="w-full resize-none rounded-[10px] border border-line bg-panel py-2 pl-2.5 pr-9 text-[12.5px] outline-none placeholder:text-dim focus:border-crimson-line"
            />
            <button disabled={!!busy || !status.files.length} onClick={() => void suggest()} className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-elev hover:text-crimson-hi disabled:opacity-40" title="Write the message with AI (the chat's model)" aria-label="Write commit message with AI">
              <Sparkle size={14} className={busy === 'message' ? 'animate-pulse text-crimson-hi' : undefined} />
            </button>
          </div>
          <Button variant="primary" size="sm" className="w-full" icon={<CommitIcon size={13} />} loading={busy === 'commit'} disabled={!message.trim() || !status.files.length || !!busy} onClick={() => void commit()}>
            {all ? `Commit all ${status.files.length || ''}`.trim() : `Commit ${staged.length} staged`}
          </Button>
        </div>

        {staged.length > 0 && (
          <FileList title="Staged" files={staged} staged onOpen={(f) => void openDiff(f, true)} onAll={() => unstage(staged.map((f) => f.path))} allLabel="Unstage all" actions={(f) => <RowAction title="Unstage" onClick={() => unstage([f.path])}><Minus size={12} /></RowAction>} />
        )}
        <FileList
          title="Changes"
          files={changes}
          staged={false}
          onOpen={(f) => void openDiff(f, false)}
          onAll={changes.length ? () => stage(changes.map((f) => f.path)) : undefined}
          allLabel="Stage all"
          empty={staged.length ? 'Everything is staged.' : 'No changes — the folder matches the last commit.'}
          actions={(f) => (
            <>
              <RowAction title="Discard changes" onClick={() => void discard([f])}>
                <ArrowUUpLeft size={12} />
              </RowAction>
              <RowAction title="Stage" onClick={() => stage([f.path])}>
                <Plus size={12} />
              </RowAction>
            </>
          )}
        />

        {log.length > 0 && (
          <div className="border-t border-line">
            <button onClick={() => setShowLog(!showLog)} className="flex w-full items-center gap-1.5 px-2.5 py-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim hover:text-muted">
              {showLog ? <CaretDown size={10} /> : <CaretRight size={10} />} Recent commits
            </button>
            {showLog &&
              log.map((c) => (
                <div key={c.hash} className="flex items-baseline gap-2 px-3 py-1 text-[12px]" title={`${c.author}, ${c.when}`}>
                  <span className="shrink-0 font-mono text-[10.5px] text-dim">{c.hash}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{c.subject}</span>
                  <span className="shrink-0 text-[10.5px] text-dim">{c.when.replace(' ago', '')}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FileList({ title, files, staged, onOpen, onAll, allLabel, actions, empty }: { title: string; files: GitFile[]; staged: boolean; onOpen(f: GitFile): void; onAll?(): void; allLabel: string; actions(f: GitFile): React.ReactNode; empty?: string }) {
  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim">
        <span>
          {title} {files.length > 0 && <span className="font-mono normal-case">{files.length}</span>}
        </span>
        {onAll && files.length > 0 && (
          <button onClick={onAll} className="text-[11px] normal-case tracking-normal hover:text-fg">
            {allLabel}
          </button>
        )}
      </div>
      {!files.length && empty && <div className="px-3 py-1.5 text-[12px] text-dim">{empty}</div>}
      {files.map((f) => {
        const { name, dir } = split(f.path)
        const l = letter(f, staged)
        return (
          <div key={f.path} onClick={() => onOpen(f)} className="group/row flex h-7 cursor-pointer items-center gap-2 pl-3 pr-1.5 text-[12.5px] hover:bg-elev" title={f.from ? `${f.from} → ${f.path}` : f.path}>
            <span className={clsx('min-w-0 truncate', l === 'D' ? 'text-dim line-through' : 'text-fg/90')}>{name}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-dim">{dir}</span>
            <span className="hidden shrink-0 items-center group-hover/row:flex mobile:flex" onClick={(e) => e.stopPropagation()}>
              {actions(f)}
            </span>
            <span className={clsx('w-3.5 shrink-0 text-center font-mono text-[11px] font-semibold', LETTER_COLOR[l] ?? 'text-muted')} title={f.untracked ? 'New file' : f.conflicted ? 'Conflict' : undefined}>
              {f.conflicted ? '!' : l}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function RowAction({ title, onClick, children }: { title: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-elev-2 hover:text-fg">
      {children}
    </button>
  )
}

function DiffView({ text }: { text: string }) {
  const lines = useMemo(() => {
    let a = 0
    let b = 0
    return text.split('\n').map((l) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
      if (hunk) {
        a = Number(hunk[1])
        b = Number(hunk[2])
        return { kind: 'hunk' as const, text: l, a: '', b: '' }
      }
      if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) return { kind: 'meta' as const, text: l, a: '', b: '' }
      if (l.startsWith('+')) return { kind: 'add' as const, text: l.slice(1), a: '', b: String(b++) }
      if (l.startsWith('-')) return { kind: 'del' as const, text: l.slice(1), a: String(a++), b: '' }
      if (l.startsWith('\\')) return { kind: 'meta' as const, text: l, a: '', b: '' }
      const row = { kind: 'ctx' as const, text: l.slice(1), a: String(a), b: String(b) }
      a++
      b++
      return row
    })
  }, [text])
  if (!text.trim()) return <Empty>No textual changes.</Empty>
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.55]">
        <tbody>
          {lines
            .filter((l) => l.kind !== 'meta')
            .map((l, i) =>
              l.kind === 'hunk' ? (
                <tr key={i} className="bg-info/[0.07]">
                  <td colSpan={3} className="px-2.5 py-0.5 text-[11px] text-info/80">
                    {l.text}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={l.kind === 'add' ? 'bg-ok/[0.10]' : l.kind === 'del' ? 'bg-crimson/[0.12]' : undefined}>
                  <td className="w-px select-none whitespace-nowrap px-1.5 text-right align-top text-dim/60">{l.a}</td>
                  <td className="w-px select-none whitespace-nowrap px-1.5 text-right align-top text-dim/60">{l.b}</td>
                  <td className={clsx('selectable whitespace-pre pr-4', l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-crimson-hi' : 'text-fg/80')}>
                    <span className="mr-1 select-none opacity-60">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                    {l.text || ' '}
                  </td>
                </tr>
              )
            )}
        </tbody>
      </table>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-center text-[12.5px] text-dim">{children}</div>
}
