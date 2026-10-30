import { useEffect, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { CaretRight, ChatsCircle, Check, FolderDashed, FolderOpen, FolderSimple, Palette, PencilSimple, Plus } from '@phosphor-icons/react'
import { PROJECT_COLORS, type ChatSession, type Project, type ProjectDefaults, type ProjectInput } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { Button, Field, Input, Modal, Select, Textarea, confirmAction } from '@/components/ui'
import type { DesignSystem } from '@shared/design'
import { effortLabel } from '@shared/effort'
import { ModelPicker } from '@/components/ModelPicker'

/** The chat settings a project can hand to new chats (everything but the workspace, which is its folder). */
const DEFAULT_KEYS = ['model', 'collectionIds', 'knowledgeEnabled', 'skillsEnabled', 'webEnabled', 'customTools', 'fileAccess', 'shell', 'autoApprove', 'subagents', 'codeIntel', 'imagesEnabled', 'thinking', 'container'] as const

export function defaultsFrom(chat: ChatSession): ProjectDefaults {
  const out: ProjectDefaults = {}
  for (const k of DEFAULT_KEYS) (out as Record<string, unknown>)[k] = chat[k]
  return out
}

/** A short, readable list of what new chats in the project start with. */
function describeDefaults(d: ProjectDefaults, folder: string | null): string[] {
  const out: string[] = []
  if (d.model) out.push(d.model.modelId)
  if (d.container) out.push(`Linux container (${d.container.image})`)
  if (folder) out.push(d.fileAccess === 'write' ? 'can edit files' : 'read-only files')
  if (folder && d.shell) out.push('shell')
  if (d.webEnabled) out.push('web')
  if (d.knowledgeEnabled === false) out.push('no knowledge')
  if (d.subagents === false) out.push('no subagents')
  if (d.autoApprove && d.autoApprove !== 'none') out.push(d.autoApprove === 'all' ? 'auto-approve all' : 'auto-approve edits')
  if (d.thinking && d.thinking !== 'off') out.push(`thinking: ${effortLabel(d.thinking)}`)
  return out
}

/** Create or edit a project. `from` is the open chat, offered as the source of starting settings. */
export function ProjectDialog({
  open,
  project,
  from,
  onClose,
  onSaved,
  onDeleted
}: {
  open: boolean
  project: Project | null
  from: ChatSession | null
  onClose(): void
  onSaved(p: Project): void
  onDeleted(id: string): void
}) {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [color, setColor] = useState(PROJECT_COLORS[0])
  const [instructions, setInstructions] = useState('')
  const [defaults, setDefaults] = useState<ProjectDefaults>({})
  const [designId, setDesignId] = useState<string | null>(null)
  const [designs, setDesigns] = useState<DesignSystem[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(project?.name ?? '')
    setFolder(project?.folder ?? null)
    setColor(project?.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)])
    setInstructions(project?.instructions ?? '')
    setDefaults(project?.defaults ?? {})
    setDesignId(project?.designId ?? null)
    if (open) void api.design.list().then(setDesigns, () => undefined)
  }, [open, project])

  const pickFolder = async () => {
    const [dir] = await api.app.pickPaths({ directory: true, title: 'Project folder' })
    if (!dir) return
    setFolder(dir)
    if (!name.trim()) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? '')
  }

  const save = async () => {
    setSaving(true)
    const input: ProjectInput = { name, folder, color, instructions, defaults, designId }
    const saved = await attempt(() => (project ? api.projects.update(project.id, input) : api.projects.create(input)), project ? 'Project saved' : 'Project created')
    setSaving(false)
    if (saved) onSaved(saved)
  }

  const remove = async () => {
    if (!project) return
    if (!(await confirmAction(`“${project.name}” is removed from the sidebar. Its chats are kept — they move to Chats.`, { title: 'Delete project?', confirmLabel: 'Delete project', danger: true }))) return
    const ok = await attempt(() => api.projects.remove(project.id), 'Project deleted')
    if (ok !== null) onDeleted(project.id)
  }

  const summary = describeDefaults(defaults, folder)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={project ? 'Edit project' : 'New project'}
      width={540}
      footer={
        <>
          {project && !project.builtin && (
            <Button variant="ghost" className="mr-auto !text-crimson-hi" onClick={() => void remove()}>
              Delete project
            </Button>
          )}
          {project?.builtin && <span className="mr-auto text-[12px] text-dim">Built in</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!name.trim()} onClick={() => void save()}>
            {project ? 'Save project' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end gap-3">
          <Field label="Name" className="flex-1">
            <Input value={name} autoFocus={!isMobile} placeholder="e.g. Billing service" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex gap-1 pb-1.5" role="radiogroup" aria-label="Colour">
            {PROJECT_COLORS.map((c) => (
              <button key={c} role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: c }}>
                {c === color && <Check size={11} weight="bold" className="text-white" />}
              </button>
            ))}
          </div>
        </div>

        <Field label="Folder" hint="Optional.">
          <div className={clsx('flex items-center gap-2.5 rounded-[10px] border px-3 py-2', folder ? 'border-line bg-elev' : 'border-dashed border-line-strong')}>
            {folder ? <FolderSimple size={17} weight="fill" style={{ color }} /> : <FolderDashed size={17} className="text-dim" />}
            <span className={clsx('min-w-0 flex-1 truncate font-mono text-[12px]', folder ? 'text-fg' : 'text-dim')}>{folder ?? 'No folder'}</span>
            {folder && (
              <Button size="sm" variant="ghost" onClick={() => setFolder(null)}>
                Clear
              </Button>
            )}
            <Button size="sm" onClick={() => void pickFolder()}>
              Choose…
            </Button>
          </div>
        </Field>

        <Field label="Instructions" hint="Added to every chat, with the folder's AGENTS.md or CLAUDE.md.">
          <Textarea rows={4} value={instructions} placeholder="e.g. TypeScript monorepo. Run tests with pnpm test. Keep changes small." onChange={(e) => setInstructions(e.target.value)} />
        </Field>

        {!!designs.length && (
          <Field label="Design system" hint="Its DESIGN.md is added to the project's chats.">
            <Select value={designId ?? ''} onChange={(e) => setDesignId(e.target.value || null)}>
              <option value="">None</option>
              {designs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="rounded-[14px] border border-line bg-elev p-3">
          <div className="text-[11.5px] font-medium text-muted">New chats start with</div>
          <div className="mt-2">
            <ModelPicker value={defaults.model ?? null} allowNone noneLabel="Default model" onChange={(model) => setDefaults((d) => ({ ...d, model }))} />
          </div>
          <div className="mt-2 text-[12px] text-dim">{summary.length ? summary.join(' · ') : 'Cloth’s usual chat settings'}</div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {from && (
              <Button size="sm" onClick={() => setDefaults(defaultsFrom(from))} title={`Knowledge, tools, file access, approvals and model from “${from.title}”`}>
                Use settings from “{from.title.length > 28 ? `${from.title.slice(0, 28)}…` : from.title}”
              </Button>
            )}
            {!!Object.keys(defaults).length && (
              <Button size="sm" variant="ghost" onClick={() => setDefaults({})}>
                Reset
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** A project's row in the chat sidebar: collapse toggle, name, chat count, and quick actions. */
export function ProjectHeader({
  project,
  ...rest
}: {
  project: Project
  count: number
  collapsed: boolean
  running: boolean
  /** Left out when the project has no chats: there is nothing to fold away. */
  onToggle?(): void
  onNewChat(): void
  onEdit(): void
}) {
  const Icon = rest.collapsed ? FolderSimple : FolderOpen
  // "Design system" opens its design system in the editor, or the list to pick one for it.
  return (
    <GroupHeader
      {...rest}
      name={project.name}
      title={project.folder ?? undefined}
      icon={<Icon size={16} weight="fill" className="shrink-0" style={{ color: project.color }} />}
      newChatLabel="New chat in this project"
      onDesign={() => useApp.getState().openDesign({ designId: project.designId ?? undefined, projectId: project.id })}
    />
  )
}

/** The row above the chats that belong to no project, collapsible like a project's. */
export function ChatsHeader(props: { count: number; collapsed: boolean; running: boolean; onToggle(): void; onNewChat(): void }) {
  return <GroupHeader {...props} name="Chats" icon={<ChatsCircle size={16} weight="fill" className="shrink-0 text-dim" />} newChatLabel="New chat" />
}

function GroupHeader({
  name,
  title,
  icon,
  count,
  collapsed,
  running,
  newChatLabel,
  onToggle,
  onNewChat,
  onEdit,
  onDesign
}: {
  name: string
  title?: string
  icon: ReactNode
  count: number
  collapsed: boolean
  running: boolean
  newChatLabel: string
  onToggle?(): void
  onNewChat(): void
  onEdit?(): void
  onDesign?(): void
}) {
  return (
    <div
      {...(onToggle && {
        onClick: onToggle,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), onToggle()),
        tabIndex: 0,
        role: 'button',
        'aria-expanded': !collapsed
      })}
      className="group mx-0.5 mt-2 flex h-9 cursor-default items-center gap-1.5 rounded-[10px] pl-1.5 pr-1 outline-none hover:bg-elev focus-visible:ring-2 focus-visible:ring-crimson-line mobile:h-11"
    >
      {/* Without a toggle the caret's space stays, so names line up with the folders that have one. */}
      <span className={clsx('flex text-dim transition-transform duration-200', !collapsed && 'rotate-90', !onToggle && 'invisible')} aria-hidden="true">
        <CaretRight size={11} weight="bold" />
      </span>
      {icon}
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold mobile:text-[14px]" title={title}>
        {name}
      </span>
      {running && <span className="pulse-crimson h-1.5 w-1.5 shrink-0 rounded-full bg-crimson" />}
      <span className="font-mono text-[10.5px] text-dim group-focus-within:hidden group-hover:hidden mobile:hidden">{count}</span>
      <div className="hidden items-center group-focus-within:flex group-hover:flex mobile:flex" onClick={(e) => e.stopPropagation()}>
        {onEdit && (
          <button onClick={onEdit} title="Edit project" aria-label="Edit project" className="flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-hover hover:text-fg mobile:h-9 mobile:w-9">
            <PencilSimple size={14} />
          </button>
        )}
        {onDesign && (
          <button onClick={onDesign} title="Design system" aria-label="Design system" className="flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-hover hover:text-fg mobile:h-9 mobile:w-9">
            <Palette size={14} />
          </button>
        )}
        <button onClick={onNewChat} title={newChatLabel} aria-label={newChatLabel} className="flex h-7 w-7 items-center justify-center rounded-lg text-dim hover:bg-hover hover:text-fg mobile:h-9 mobile:w-9">
          <Plus size={14} weight="bold" />
        </button>
      </div>
    </div>
  )
}
