import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ArrowDown, ArrowLeft, ArrowUp, ArrowUUpLeft, CaretDown, CaretRight, CaretUpDown, Check, GitBranch, GitCommit as CommitIcon, Minus, Plus, Sparkle, Stack } from '@phosphor-icons/react'
import type { GitCommit, GitFile, GitRepo, GitStatus, WorkspaceRoot } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, confirmAction } from '@/components/ui'

const LETTER_COLOR: Record<string, string> = { M: 'text-warn', A: 'text-ok', '?': 'text-ok', D: 'text-danger-hi', R: 'text-info', C: 'text-info', U: 'text-danger-hi', T: 'text-warn' }

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

/** The panel's choice of repository, per chat: a path from `gitRepos`, or ALL for every repository's changes. */
const ALL = '*'
const repoKey = (sessionId: string) => `cloth.git.repo.${sessionId}`
function savedRepo(sessionId: string): string {
  try {
    return localStorage.getItem(repoKey(sessionId)) ?? ''
  } catch {
    return ''
  }
}

/** Git for the chat's folder (or a repository inside it): changes, diffs, staging, commits, pull and push. */
export function GitPanel({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const [root, setRoot] = useState<WorkspaceRoot | null>(null)
  // The repositories in the folder, and which one the panel shows.
  const [repos, setRepos] = useState<GitRepo[] | null>(null)
  const [pick, setPickState] = useState(() => savedRepo(sessionId))
  const setPick = (r: string) => {
    setPickState(r)
    setStatus(null)
    setLog([])
    setDiff(null)
    try {
      localStorage.setItem(repoKey(sessionId), r)
    } catch {
      /* storage unavailable */
    }
  }
  // Every repository's changes, for the All repositories view.
  const [everything, setEverything] = useState<{ repo: GitRepo; status: GitStatus }[] | null>(null)
  // The repository the git calls act on ('' is the chat's folder).
  const repo = pick === ALL ? '' : pick
  const arg = repo || undefined
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [log, setLog] = useState<GitCommit[]>([])
  const [diff, setDiff] = useState<{ file: GitFile; staged: boolean; text: string } | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)

  const refresh = useCallback(async () => {
    const [r, list] = await Promise.all([api.panel.root(sessionId), api.panel.gitRepos(sessionId).catch(() => [] as GitRepo[])])
    setRoot(r)
    setRepos(list)
    // The saved repository is gone, or the folder isn't one itself but holds some: show the first that's there.
    if (pick !== ALL && list.length && !list.some((x) => x.path === pick)) return setPick(list[0].path)
    if (pick === ALL) {
      if (list.length < 2) return setPick(list[0]?.path ?? '')
      const all = await Promise.all(list.map(async (x) => ({ repo: x, status: await api.panel.gitStatus(sessionId, x.path || undefined).catch(() => null) })))
      setEverything(all.filter((x): x is { repo: GitRepo; status: GitStatus } => !!x.status))
      return
    }
    const s = await api.panel.gitStatus(sessionId, arg).catch(() => null)
    setStatus(s)
    if (s?.repo) void api.panel.gitLog(sessionId, arg).then(setLog)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pick])

  useEffect(() => {
    setStatus(null)
    setDiff(null)
    setMessage('')
    setRepos(null)
    setEverything(null)
    setPickState(savedRepo(sessionId))
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
  const stage = (paths: string[]) => void act('stage', () => api.panel.gitStage(sessionId, paths, arg)).then(apply)
  const unstage = (paths: string[]) => void act('unstage', () => api.panel.gitUnstage(sessionId, paths, arg)).then(apply)
  const discard = async (files: GitFile[]) => {
    const untracked = files.filter((f) => f.untracked).length
    const what = files.length === 1 ? `“${files[0].path}”` : `${files.length} files`
    const ok = await confirmAction(untracked === files.length ? `${what} ${files.length === 1 ? 'is' : 'are'} deleted — ${files.length === 1 ? 'it has' : 'they have'} never been committed.` : `Your changes to ${what} are lost; ${files.length === 1 ? 'it goes' : 'they go'} back to the last committed version.${untracked ? ' New files are deleted.' : ''}`, { title: 'Discard changes?', confirmLabel: 'Discard', danger: true })
    if (!ok) return
    apply(await act('discard', () => api.panel.gitDiscard(sessionId, files.map((f) => f.path), arg)))
    setDiff(null)
  }
  const openDiff = async (file: GitFile, isStaged: boolean) => {
    const text = await act('diff', () => api.panel.gitDiff(sessionId, file.path, isStaged, arg))
    if (text !== undefined) setDiff({ file, staged: isStaged, text })
  }
  const all = !staged.length
  const commit = async () => {
    const r = await act('commit', () => api.panel.gitCommit(sessionId, message, all, arg))
    if (!r) return
    setMessage('')
    setStatus(r.status)
    void api.panel.gitLog(sessionId, arg).then(setLog)
    useApp.getState().toast(`Committed ${r.hash}`, 'ok')
  }
  const init = async () => {
    const s = await act('init', () => api.panel.gitInit(sessionId), 'Initialized a git repository')
    if (s) await refresh()
  }
  const suggest = async () => {
    const text = await act('message', () => api.panel.commitMessage(sessionId, all, arg))
    if (text) setMessage(text)
  }

  const bar = repos && repos.length > 1 ? <RepoBar repos={repos} pick={pick} onPick={setPick} /> : null
  if (root && !root.folder) return <Empty>This chat has no folder.</Empty>
  if (pick === ALL)
    return (
      <div className="flex h-full min-h-0 flex-col">
        {bar}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!everything ? (
            <Empty>Reading git status…</Empty>
          ) : (
            everything.map(({ repo: r, status: st }) => (
              <div key={r.root} className="border-b border-line py-1">
                <button onClick={() => setPick(r.path)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption hover:bg-elev" title={`Open ${r.name}`}>
                  <GitBranch size={13} className="shrink-0 text-dim" />
                  <span className="min-w-0 truncate font-medium text-fg">{r.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-micro text-dim">{r.branch ?? 'detached'}</span>
                  <span className="shrink-0 font-mono text-micro text-dim">{st.files.length ? `${st.files.length} changed` : 'clean'}</span>
                  <CaretRight size={10} className="shrink-0 text-dim" />
                </button>
                {st.files.slice(0, 50).map((f) => {
                  const { name, dir } = split(f.path)
                  const l = letter(f, f.staged && !f.unstaged)
                  return (
                    <button
                      key={f.path}
                      onClick={() => {
                        setPick(r.path)
                        void api.panel.gitDiff(sessionId, f.path, f.staged && !f.unstaged, r.path || undefined).then((text) => setDiff({ file: f, staged: f.staged && !f.unstaged, text }), () => undefined)
                      }}
                      className="flex h-7 w-full items-center gap-2 pl-7 pr-2.5 text-left text-ui hover:bg-elev"
                      title={f.path}
                    >
                      <span className={clsx('min-w-0 truncate', l === 'D' ? 'text-dim line-through' : 'text-fg/90')}>{name}</span>
                      <span className="min-w-0 flex-1 truncate text-caption text-dim">{dir}</span>
                      <span className={clsx('w-3.5 shrink-0 text-center font-mono text-caption font-semibold', LETTER_COLOR[l] ?? 'text-muted')}>{f.conflicted ? '!' : l}</span>
                    </button>
                  )
                })}
                {st.files.length > 50 && <div className="px-7 py-1 text-caption text-dim">and {st.files.length - 50} more</div>}
              </div>
            ))
          )}
        </div>
      </div>
    )
  if (status && !status.repo)
    return (
      <Empty>
        <div className="flex flex-col items-center gap-3">
          <div>{root?.folder} is not a git repository.</div>
          <Button size="sm" icon={<GitBranch size={13} />} loading={busy === 'init'} disabled={!!busy} onClick={() => void init()}>
            Initialize git repository
          </Button>
        </div>
      </Empty>
    )
  if (!status) return <Empty>Reading git status…</Empty>

  if (diff)
    return (
      <div className="flex h-full min-h-0 flex-col">
        {bar}
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-1.5 py-1.5">
          <button onClick={() => setDiff(null)} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" aria-label="Back to changes">
            <ArrowLeft size={14} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui font-medium">{split(diff.file.path).name}</div>
            <div className="truncate text-micro text-dim">
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
      {bar}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-caption">
        <GitBranch size={14} className="shrink-0 text-dim" />
        <span className="min-w-0 truncate font-medium" title={status.upstream ? `Tracking ${status.upstream}` : 'No upstream branch'}>
          {status.branch ?? 'detached HEAD'}
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="shrink-0 font-mono text-caption text-dim">
            {status.ahead > 0 && `↑${status.ahead}`} {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <div className="flex-1" />
        <button disabled={!!busy} onClick={() => void act('pull', () => api.panel.gitPull(sessionId, arg), 'Pulled').then(refresh)} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-elev hover:text-fg disabled:opacity-50" title="Pull (fast-forward only)">
          <ArrowDown size={13} /> {busy === 'pull' ? '…' : 'Pull'}
        </button>
        <button disabled={!!busy} onClick={() => void act('push', () => api.panel.gitPush(sessionId, arg), 'Pushed').then(refresh)} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-muted hover:bg-elev hover:text-fg disabled:opacity-50" title={status.upstream ? `Push to ${status.upstream}` : 'Push and set origin as upstream'}>
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
              className="w-full resize-none rounded-[10px] border border-line bg-panel py-2 pl-2.5 pr-9 text-ui outline-none placeholder:text-dim focus:border-crimson-line"
            />
            <button disabled={!!busy || !status.files.length} onClick={() => void suggest()} className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md text-dim hover:bg-elev hover:text-fg disabled:opacity-40" title="Write the message with AI (the chat's model)" aria-label="Write commit message with AI">
              <Sparkle size={14} className={busy === 'message' ? 'animate-pulse text-fg' : undefined} />
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
            <button onClick={() => setShowLog(!showLog)} className="flex w-full items-center gap-1.5 px-2.5 py-2 text-caption font-medium text-dim hover:text-muted">
              {showLog ? <CaretDown size={10} /> : <CaretRight size={10} />} Recent commits
            </button>
            {showLog &&
              log.map((c) => (
                <div key={c.hash} className="flex items-baseline gap-2 px-3 py-1 text-caption" title={`${c.author}, ${c.when}`}>
                  <span className="shrink-0 font-mono text-micro text-dim">{c.hash}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{c.subject}</span>
                  <span className="shrink-0 text-micro text-dim">{c.when.replace(' ago', '')}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Which repository the panel shows, when the folder holds more than one: each with its branch and changes. */
function RepoBar({ repos, pick, onPick }: { repos: GitRepo[]; pick: string; onPick(path: string): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('[role=menuitemradio][aria-checked=true], [role=menuitemradio]')?.focus()
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitemradio]') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLElement)
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', keys)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', keys)
    }
  }, [open])
  const cur = repos.find((r) => r.path === pick)
  const total = repos.reduce((n, r) => n + r.changes, 0)
  const count = (n: number) => n > 0 && <span className="shrink-0 rounded-full bg-info/15 px-1.5 py-px font-mono text-micro font-semibold text-info">{n}</span>
  const item = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui text-fg transition-colors hover:bg-elev-2 focus-visible:bg-elev-2 focus-visible:outline-none'
  return (
    <div ref={ref} className="relative shrink-0 border-b border-line p-1.5">
      <button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-panel px-2 text-left text-ui transition-colors hover:border-line-strong">
        {cur ? <GitBranch size={14} className="shrink-0 text-dim" /> : <Stack size={14} className="shrink-0 text-dim" />}
        <span className="min-w-0 truncate font-medium">{cur ? cur.name : 'All repositories'}</span>
        {cur?.path && <span className="min-w-0 flex-1 truncate font-mono text-micro text-dim">{cur.path}</span>}
        {!cur?.path && <span className="flex-1" />}
        {count(cur ? cur.changes : total)}
        <CaretUpDown size={12} className="shrink-0 text-dim" />
      </button>
      {open && (
        <div role="menu" className="absolute inset-x-1.5 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-xl border border-line-strong bg-panel p-1 shadow-[0_20px_50px_-10px_rgb(0_0_0/0.8)]">
          {repos.map((r) => (
            <button key={r.root} role="menuitemradio" aria-checked={r.path === pick} className={item} onClick={() => (onPick(r.path), setOpen(false))} title={r.root}>
              <GitBranch size={14} className="shrink-0 text-dim" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.name}</span>
                <span className="block truncate font-mono text-micro text-dim">
                  {r.branch ?? 'detached HEAD'}
                  {r.path ? ` · ${r.path}` : ''}
                  {r.ahead > 0 ? ` ↑${r.ahead}` : ''}
                  {r.behind > 0 ? ` ↓${r.behind}` : ''}
                </span>
              </span>
              {count(r.changes)}
              <Check size={13} className={clsx('shrink-0 text-crimson-hi', r.path !== pick && 'invisible')} />
            </button>
          ))}
          <div className="mx-1.5 my-1 border-t border-line" />
          <button role="menuitemradio" aria-checked={pick === ALL} className={item} onClick={() => (onPick(ALL), setOpen(false))}>
            <Stack size={14} className="shrink-0 text-dim" />
            <span className="min-w-0 flex-1 truncate">All repositories</span>
            {count(total)}
            <Check size={13} className={clsx('shrink-0 text-crimson-hi', pick !== ALL && 'invisible')} />
          </button>
        </div>
      )}
    </div>
  )
}

function FileList({ title, files, staged, onOpen, onAll, allLabel, actions, empty }: { title: string; files: GitFile[]; staged: boolean; onOpen(f: GitFile): void; onAll?(): void; allLabel: string; actions(f: GitFile): React.ReactNode; empty?: string }) {
  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-2.5 py-1 text-caption font-medium text-dim">
        <span>
          {title} {files.length > 0 && <span className="font-mono normal-case">{files.length}</span>}
        </span>
        {onAll && files.length > 0 && (
          <button onClick={onAll} className="text-caption normal-case tracking-normal hover:text-fg">
            {allLabel}
          </button>
        )}
      </div>
      {!files.length && empty && <div className="px-3 py-1.5 text-caption text-dim">{empty}</div>}
      {files.map((f) => {
        const { name, dir } = split(f.path)
        const l = letter(f, staged)
        return (
          <div key={f.path} role="button" tabIndex={0} onClick={() => onOpen(f)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), onOpen(f))} className="group/row flex h-7 cursor-pointer items-center gap-2 pl-3 pr-1.5 text-ui outline-none hover:bg-elev focus-visible:bg-elev focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-crimson-line" title={f.from ? `${f.from} → ${f.path}` : f.path}>
            <span className={clsx('min-w-0 truncate', l === 'D' ? 'text-dim line-through' : 'text-fg/90')}>{name}</span>
            <span className="min-w-0 flex-1 truncate text-caption text-dim">{dir}</span>
            <span className="hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex mobile:flex" onClick={(e) => e.stopPropagation()}>
              {actions(f)}
            </span>
            <span className={clsx('w-3.5 shrink-0 text-center font-mono text-caption font-semibold', LETTER_COLOR[l] ?? 'text-muted')} title={f.untracked ? 'New file' : f.conflicted ? 'Conflict' : undefined}>
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
      <table className="w-full border-collapse font-mono text-caption leading-[1.55]">
        <tbody>
          {lines
            .filter((l) => l.kind !== 'meta')
            .map((l, i) =>
              l.kind === 'hunk' ? (
                <tr key={i} className="bg-info/[0.07]">
                  <td colSpan={3} className="px-2.5 py-0.5 text-caption text-info/80">
                    {l.text}
                  </td>
                </tr>
              ) : (
                <tr key={i} className={l.kind === 'add' ? 'bg-ok/[0.10]' : l.kind === 'del' ? 'bg-danger/[0.12]' : undefined}>
                  <td className="w-px select-none whitespace-nowrap px-1.5 text-right align-top text-dim/60">{l.a}</td>
                  <td className="w-px select-none whitespace-nowrap px-1.5 text-right align-top text-dim/60">{l.b}</td>
                  <td className={clsx('selectable whitespace-pre pr-4', l.kind === 'add' ? 'text-ok' : l.kind === 'del' ? 'text-danger-hi' : 'text-fg/80')}>
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
  return <div className="grid h-full place-items-center p-6 text-center text-ui text-dim">{children}</div>
}
