import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Archive, CaretDown, ChatCircleDots, Check, FolderSimple, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import type { ChatSession, Project } from '@shared/types'
import { isMobile } from '@/lib/platform'
import { ordered } from '@shared/chat-order'

type Option = { id: string; label: string; sub?: string; icon: ReactNode; current: boolean }

/** A searchable list under a header part, like GitHub's repository and branch pickers: type to filter, ↑↓ and Enter. */
function Popover({ title, options, tabs, tab, onTab, footer, empty, onPick, onClose }: { title: string; options: Option[]; tabs?: { value: string; label: string }[]; tab?: string; onTab?(t: string): void; footer?: ReactNode; empty: string; onPick(id: string): void; onClose(): void }) {
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? options.filter((o) => o.label.toLowerCase().includes(s) || !!o.sub?.toLowerCase().includes(s)) : options
  }, [q, options])
  useEffect(() => setIndex(Math.max(0, shown.findIndex((o) => o.current))), [shown])
  useEffect(() => {
    list.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose()
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [onClose])
  return (
    <div ref={ref} role="dialog" aria-label={title} className="absolute left-0 top-full z-40 mt-1.5 w-80 max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-line-strong bg-panel shadow-[0_20px_50px_-10px_rgb(0_0_0/0.8)]">
      <div className="flex items-center justify-between px-3 pb-2 pt-2.5">
        <span className="text-caption font-semibold text-fg">{title}</span>
        <button onClick={onClose} aria-label="Close" className="flex h-6 w-6 items-center justify-center rounded-md text-dim hover:bg-elev-2 hover:text-fg">
          <X size={12} />
        </button>
      </div>
      <div className="relative mx-2.5 mb-2">
        <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" />
        <input
          autoFocus={!isMobile}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          aria-label={`Filter ${title.toLowerCase()}`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onClose())
            else if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(shown.length - 1, i + 1)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)))
            else if (e.key === 'Enter' && shown[index]) (e.preventDefault(), onPick(shown[index].id))
          }}
          className="h-8 w-full rounded-lg border border-crimson-line bg-bg pl-7 pr-2 text-ui outline-none placeholder:text-dim"
        />
      </div>
      {tabs && (
        <div className="flex gap-1 border-b border-line px-2.5 pb-2">
          {tabs.map((t) => (
            <button key={t.value} onClick={() => onTab?.(t.value)} className={clsx('rounded-md px-2 py-1 text-caption', t.value === tab ? 'bg-elev-2 font-medium text-fg' : 'text-dim hover:text-fg')}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div ref={list} className="max-h-72 overflow-y-auto p-1.5">
        {!shown.length && <div className="px-2 py-3 text-center text-caption text-dim">{empty}</div>}
        {shown.map((o, i) => (
          <button
            key={o.id}
            data-i={i}
            onMouseMove={() => setIndex(i)}
            onClick={() => onPick(o.id)}
            className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-ui', i === index ? 'bg-elev-2 text-fg' : 'text-muted')}
          >
            <span className="flex w-4 shrink-0 justify-center">{o.icon}</span>
            <span className="min-w-0 flex-1">
              <span className={clsx('block truncate', o.current && 'font-medium text-fg')}>{o.label}</span>
              {o.sub && <span className="block truncate font-mono text-micro text-dim">{o.sub}</span>}
            </span>
            <Check size={13} className={clsx('shrink-0 text-crimson-hi', !o.current && 'invisible')} />
          </button>
        ))}
      </div>
      {footer && <div className="border-t border-line p-1.5">{footer}</div>}
    </div>
  )
}

const CRUMB = 'flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-2 text-left transition-colors hover:bg-elev-2 aria-expanded:bg-elev-2'

/** The chat header's path: project, then chat. Each opens a switcher; Ctrl+P opens the chat one. */
export function Breadcrumb({
  session,
  project,
  projects,
  chats,
  showProject,
  onOpen,
  onNewChat
}: {
  session: ChatSession
  project: Project | null
  projects: Project[]
  chats: ChatSession[]
  showProject: boolean
  onOpen(id: string): void
  onNewChat(projectId: string | null): void
}) {
  const [open, setOpen] = useState<'project' | 'chat' | null>(null)
  const [tab, setTab] = useState<'recent' | 'archived'>('recent')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setTab(session.archivedAt ? 'archived' : 'recent')
        setOpen((o) => (o === 'chat' ? null : 'chat'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session.archivedAt])
  const close = () => setOpen(null)
  const known = new Set(projects.map((p) => p.id))
  const groupOf = (c: ChatSession) => (c.projectId && known.has(c.projectId) ? c.projectId : null)
  const here = chats.filter((c) => groupOf(c) === (project?.id ?? null))
  const pick = (id: string) => (close(), onOpen(id))
  // A project opens its newest chat, or starts one when it has none.
  const pickProject = (id: string) => {
    close()
    const pid = id === '' ? null : id
    if (pid === (project?.id ?? null)) return
    const newest = ordered(chats.filter((c) => !c.archivedAt && groupOf(c) === pid))[0]
    if (newest) onOpen(newest.id)
    else onNewChat(pid)
  }
  const count = (pid: string | null) => chats.filter((c) => !c.archivedAt && groupOf(c) === pid).length
  const plural = (n: number) => `${n} chat${n === 1 ? '' : 's'}`

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {showProject && (
        <>
          <div className="relative min-w-0 max-w-[40%] shrink">
            <button className={clsx(CRUMB, 'text-ui text-muted hover:text-fg')} aria-haspopup="dialog" aria-expanded={open === 'project'} onClick={() => setOpen((o) => (o === 'project' ? null : 'project'))} title={project?.folder ?? 'Switch project'}>
              {project ? <FolderSimple size={14} weight="fill" className="shrink-0" style={{ color: project.color }} /> : <ChatCircleDots size={14} className="shrink-0 text-dim" />}
              <span className="truncate">{project?.name ?? 'Chats'}</span>
            </button>
            {open === 'project' && (
              <Popover
                title="Switch project"
                empty="No project matches"
                onClose={close}
                onPick={pickProject}
                options={[
                  ...projects.map((p) => ({ id: p.id, label: p.name, sub: `${p.folder ?? 'No folder'} · ${plural(count(p.id))}`, icon: <FolderSimple size={14} weight="fill" style={{ color: p.color }} />, current: p.id === project?.id })),
                  { id: '', label: 'No project', sub: plural(count(null)), icon: <ChatCircleDots size={14} className="text-dim" />, current: !project }
                ]}
              />
            )}
          </div>
          <span className="shrink-0 text-ui text-dim" aria-hidden="true">
            /
          </span>
        </>
      )}
      <div className="relative min-w-0 shrink">
        <button className={clsx(CRUMB, 'text-body font-semibold tracking-tight text-fg')} aria-haspopup="dialog" aria-expanded={open === 'chat'} onClick={() => (setTab(session.archivedAt ? 'archived' : 'recent'), setOpen((o) => (o === 'chat' ? null : 'chat')))} title={isMobile ? session.title : `${session.title} · switch chat (Ctrl+P)`}>
          <span className="truncate">{session.title}</span>
          <CaretDown size={11} weight="bold" className="shrink-0 text-dim" />
        </button>
        {open === 'chat' && (
          <Popover
            title={project ? `Chats in ${project.name}` : 'Chats'}
            empty={tab === 'archived' ? 'No archived chats here' : 'No chat matches'}
            tabs={[
              { value: 'recent', label: 'Recent' },
              { value: 'archived', label: 'Archived' }
            ]}
            tab={tab}
            onTab={(t) => setTab(t as 'recent' | 'archived')}
            onClose={close}
            onPick={pick}
            options={(tab === 'archived' ? here.filter((c) => !!c.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)) : [...here.filter((c) => !c.archivedAt)].sort((a, b) => b.updatedAt - a.updatedAt)).map((c) => ({
              id: c.id,
              label: c.title,
              sub: c.preview?.slice(0, 80),
              icon: c.archivedAt ? <Archive size={13} className="text-dim" /> : <ChatCircleDots size={14} className="text-dim" />,
              current: c.id === session.id
            }))}
            footer={
              <button onClick={() => (close(), onNewChat(project?.id ?? null))} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-ui text-muted hover:bg-elev-2 hover:text-fg">
                <Plus size={13} weight="bold" className="w-4" /> New chat{project ? ` in ${project.name}` : ''}
                {!isMobile && <span className="ml-auto font-mono text-micro text-dim">Ctrl+N</span>}
              </button>
            }
          />
        )}
      </div>
    </div>
  )
}
