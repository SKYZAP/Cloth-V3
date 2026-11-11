import { useState } from 'react'
import { FileText, Layers, RefreshCw, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { SharedSkills, Skill } from '@shared/types'
import { movedOf, usesOf, type Shelf, type Usage } from './shelves'
import { api } from '@/lib/api'
import { Button, IconButton, Switch } from '@/components/ui'

export { buildShelves, type Shelf, type Usage } from './shelves'

const isOn = (modes: SharedSkills | null, name: string) => !!modes && modes.enabled && !modes.off.includes(name)

export function SkillShelf({
  shelf,
  used,
  most,
  modes,
  onOpen,
  onMode,
  onUpdate,
  onRemove
}: {
  shelf: Shelf
  used: Usage
  /** The most any skill has been used: the scale of the usage bars. */
  most: number
  modes: SharedSkills | null
  onOpen(name: string): void
  onMode(names: string[], on: boolean): void
  onUpdate(shelf: Shelf): Promise<void>
  onRemove(shelf: Shelf): void
}) {
  const [updating, setUpdating] = useState(false)
  const isSet = !!shelf.repo
  const on = shelf.skills.filter((s) => isOn(modes, s.name)).length
  const id = `shelf-${shelf.key.replace(/[^a-z0-9]+/gi, '-')}`
  return (
    <section aria-labelledby={id} className="rounded-[14px] border border-line bg-panel">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3.5">
        <span className={clsx('flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg', isSet ? 'bg-skill-soft text-skill-dot' : 'bg-elev-2 text-muted')} aria-hidden="true">
          {isSet ? <Layers size={16} /> : <FileText size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={id} className="flex items-baseline gap-2 text-body font-semibold">
            <span className="truncate">{shelf.title}</span>
            <span className="text-ui font-normal tabular-nums text-dim">{shelf.skills.length}</span>
          </h2>
          {shelf.url && (
            <button onClick={() => void api.app.openExternal(shelf.url!)} className="truncate font-mono text-caption text-dim hover:text-fg" title={shelf.url} translate="no">
              {shelf.repo}
            </button>
          )}
        </div>
        {isSet ? (
          <>
            <span className="flex items-center gap-2 text-caption text-muted">
              {on > 0 && on < shelf.skills.length && <span className="tabular-nums text-dim">{on} of {shelf.skills.length}</span>}
              <Switch checked={on === shelf.skills.length} onChange={(v) => onMode(shelf.skills.map((s) => s.name), v)} label="In chats" />
            </span>
            <Button
              icon={<RefreshCw size={13} />}
              loading={updating}
              onClick={async () => {
                setUpdating(true)
                await onUpdate(shelf).finally(() => setUpdating(false))
              }}
            >
              Update set
            </Button>
            <IconButton title="Remove set" aria-label={`Remove ${shelf.title}`} onClick={() => onRemove(shelf)}>
              <Trash2 size={14} />
            </IconButton>
          </>
        ) : (
          shelf.uses > 0 && <span className="text-caption tabular-nums text-dim">{shelf.uses} uses</span>
        )}
      </header>
      {isSet && shelf.uses === 0 && (
        <div className="mx-4 mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[9px] bg-elev px-3 py-2 text-caption text-muted">
          <span className="min-w-[220px] flex-1">None of these {shelf.skills.length} skills has been used in a chat yet.</span>
          {on > 0 ? (
            <Button size="sm" onClick={() => onMode(shelf.skills.map((s) => s.name), false)}>
              Turn off in chats
            </Button>
          ) : (
            <Button size="sm" onClick={() => onMode(shelf.skills.map((s) => s.name), true)}>
              Turn on in chats
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onRemove(shelf)}>
            Remove set
          </Button>
        </div>
      )}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2.5 p-4">
        {shelf.skills.map((s) => (
          <SkillTile key={s.name} skill={s} uses={usesOf(used, s.name)} most={most} on={isOn(modes, s.name)} always={!!modes?.always.includes(s.name)} onOpen={() => onOpen(s.name)} onMode={(v) => onMode([s.name], v)} />
        ))}
      </ul>
    </section>
  )
}

function SkillTile({ skill, uses, most, on, always, onOpen, onMode }: { skill: Skill; uses: number; most: number; on: boolean; always: boolean; onOpen(): void; onMode(on: boolean): void }) {
  const moved = movedOf(skill)
  return (
    <li
      className={clsx(
        'group relative flex min-h-[92px] flex-col rounded-[10px] border transition-colors focus-within:border-crimson-line',
        uses ? 'border-line-strong bg-elev hover:bg-elev-2' : 'border-dashed border-line-strong hover:bg-elev',
        moved && 'border-warn/40'
      )}
    >
      <button onClick={onOpen} data-focus-key={`skill:${skill.name}`} className="flex flex-1 flex-col gap-1 rounded-[10px] px-3 pb-9 pt-2.5 text-left focus-visible:outline-none">
        <span className={clsx('truncate font-mono text-caption', uses ? 'text-fg' : 'text-muted')} translate="no">
          {skill.name}
        </span>
        <span className="line-clamp-2 text-caption leading-[1.4] text-muted">{skill.description || 'No description'}</span>
      </button>
      <div className="pointer-events-none absolute inset-x-3 bottom-2.5 flex items-center gap-2.5 text-caption text-dim">
        {moved ? (
          <span className="rounded bg-warn/15 px-1.5 font-medium text-warn">moved</span>
        ) : uses ? (
          <>
            <span className="tabular-nums">{uses} uses</span>
            <span className="h-[3px] w-16 overflow-hidden rounded-full bg-line-strong" aria-hidden="true">
              <span className="block h-full rounded-full bg-skill-dot" style={{ width: `${Math.max(6, Math.round((uses / Math.max(most, 1)) * 100))}%` }} />
            </span>
          </>
        ) : (
          <span>never used</span>
        )}
        <span className="flex-1" />
        {always && <span className="text-skill">always</span>}
        {!on && <span>off in chats</span>}
        {/* On is the usual state: with a mouse, the switch shows on hover or focus; off, or on touch, it always shows. */}
        <span className={clsx('pointer-events-auto transition-opacity', on && '[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}>
          <Switch checked={on} onChange={onMode} ariaLabel={`Use ${skill.name} in chats`} />
        </span>
      </div>
    </li>
  )
}
