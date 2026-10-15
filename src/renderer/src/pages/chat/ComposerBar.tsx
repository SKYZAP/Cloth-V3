import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { Books, CaretDown, Check, FolderSimple, Hand, Lightning, ListChecks, Sparkle, Wrench, type Icon } from '@phosphor-icons/react'
import type { ChatSession, ContextUsage, Permissions } from '@shared/types'
import { useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { formatCost } from '@/lib/format'
import { knowledgeCount, PERMISSION_MODES, permissionMode } from '@/lib/permissions'
import { Tooltip } from '@/components/Tooltip'
import { ContextMeter } from '@/components/Planning'
import { openSetupSection } from './setupNav'
import { ComposerPopover, effortLabel, FolderMenu, ModelEffortMenu } from './StatusLine'
import { STAGE_LABEL, stageIndex } from './Workflow'

type Update = (p: Partial<ChatSession>) => Promise<void>

export const MODE_ICON: Record<Permissions, Icon> = { auto: Lightning, manual: Hand, plan: ListChecks }
const MODE_TONE: Record<Permissions, string> = {
  auto: 'border-crimson-line bg-crimson-soft text-crimson-hi',
  manual: 'border-warn/35 bg-warn/[0.08] text-warn',
  plan: 'border-info/35 bg-info/[0.08] text-info'
}

/**
 * The message box's bottom row: what the chat draws on (knowledge, skills, tools, folder), how it
 * works (permissions, model and effort), how full the context is, and the send button.
 */
export function ComposerBar({
  session,
  update,
  usage,
  compacting,
  onCompact,
  leading,
  send,
  onWorkflow
}: {
  session: ChatSession
  update: Update
  usage: ContextUsage | null
  compacting: boolean
  onCompact(): void
  /** Controls before the row's icons (the attach button). */
  leading?: ReactNode
  /** The send / stop button. */
  send: ReactNode
  /** Spec → ship: start it (the draft becomes the idea), leave it, or show its documents. */
  onWorkflow?(action: 'start' | 'stop' | 'docs'): void
}) {
  const flow = session.workflow && session.workflow.stage !== 'done' ? session.workflow : null
  const collections = useApp((s) => s.collections)
  const providers = useApp((s) => s.providers)
  const model = providers.find((p) => p.id === session.model?.providerId)?.models.find((m) => m.id === session.model?.modelId)
  const knowledge = knowledgeCount(session, collections.map((c) => c.id))
  const skillsOn = session.skillsEnabled || session.skillsAlways.length > 0
  const toolsOn = session.subagents || session.imagesEnabled || session.customTools
  const folder = session.workspace?.split(/[\\/]/).pop()
  return (
    <div className="@container flex items-center gap-1 pb-2 pl-2.5 pr-2 pt-1.5">
      {/* Phones: the icons and chips scroll sideways; the meter and send button stay put. */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 mobile:overflow-x-auto mobile:[scrollbar-width:none]">
        {leading}
        {/* Too tight for everything: these three also live in the side panel's Setup tab. */}
        <div className="hidden @[440px]:contents mobile:contents">
        <RowIcon icon={Books} label="Knowledge" state={knowledge ? `${knowledge} collection${knowledge === 1 ? '' : 's'} on · opens Setup` : 'Off · opens Setup'} on={knowledge > 0} count={knowledge || undefined} onClick={() => openSetupSection('knowledge')} />
        <RowIcon icon={Sparkle} label="Skills" state={skillsOn ? 'On · opens Setup' : 'Off · opens Setup'} on={skillsOn} onClick={() => openSetupSection('skills')} />
        <RowIcon icon={Wrench} label="Tools" state="Opens Setup" on={toolsOn} onClick={() => openSetupSection('tools')} />
        </div>
        <ComposerPopover
          width={360}
          sheetTitle="Folder"
          trigger={(open, toggle) => (
            <RowIcon icon={FolderSimple} label="Folder" state={session.container ? `${folder ?? 'No folder'} · Linux container` : (folder ?? 'None chosen')} on={!!session.workspace} open={open} haspopup="dialog" onClick={toggle} />
          )}
        >
          {() => <FolderMenu session={session} update={update} />}
        </ComposerPopover>
        <span aria-hidden="true" className="mx-2 h-[22px] w-px shrink-0 bg-line-strong mobile:mx-1" />
        {flow && (
          <ComposerPopover
            width={300}
            sheetTitle="Spec → ship"
            role="menu"
            trigger={(open, toggle) => (
              <button
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`Spec → ship, stage: ${STAGE_LABEL[flow.stage]}`}
                title={`Spec → ship · ${STAGE_LABEL[flow.stage]}`}
                className="mr-1.5 flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-mode-line bg-mode-soft pl-2 pr-2.5 text-[12.5px] font-semibold text-mode transition-colors hover:bg-mode/15"
              >
                <ListChecks size={15} weight="bold" className="shrink-0" />
                <span className="hidden @[520px]:inline mobile:inline">Spec → ship</span>
                <CaretDown size={10} weight="bold" className={clsx('shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
              </button>
            )}
          >
            {(close) => (
              <div className="grid p-1">
                <p className="px-2.5 pb-1.5 pt-2 text-[11.5px] text-dim">
                  Stage {stageIndex(flow.stage) + 1} of 5: <b className="font-semibold text-muted">{STAGE_LABEL[flow.stage]}</b>
                </p>
                <button role="menuitem" onClick={() => (close(), onWorkflow?.('docs'))} className="rounded-[9px] px-2.5 py-2 text-left text-[13px] hover:bg-elev-2 focus-visible:bg-elev-2 focus-visible:outline-none">
                  Show the documents
                </button>
                <button role="menuitem" onClick={() => (close(), onWorkflow?.('stop'))} className="rounded-[9px] px-2.5 py-2 text-left text-[13px] hover:bg-elev-2 focus-visible:bg-elev-2 focus-visible:outline-none">
                  Leave Spec → ship
                  <span className="block text-[11.5px] text-dim">The chat carries on as a normal chat; the documents stay.</span>
                </button>
              </div>
            )}
          </ComposerPopover>
        )}
        <ComposerPopover
          width={340}
          sheetTitle="Permissions"
          role="menu"
          trigger={(open, toggle) => {
            const I = MODE_ICON[session.permissions]
            return (
              <button
                onClick={toggle}
                aria-haspopup="menu"
                aria-expanded={open}
                title={`Permissions: ${permissionMode(session.permissions).name} (Shift+Tab to switch)`}
                aria-label={`Permissions: ${permissionMode(session.permissions).name}`}
                className={clsx('flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border pl-2 pr-2.5 text-[12.5px] font-semibold transition-colors', MODE_TONE[session.permissions])}
              >
                <I size={15} weight="fill" className="shrink-0" />
                <span className="hidden @[440px]:inline mobile:inline">{permissionMode(session.permissions).name}</span>
                <CaretDown size={10} weight="bold" className={clsx('shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
              </button>
            )
          }}
        >
          {(close) => (
            <PermissionsMenu
              value={session.permissions}
              onPick={(permissions) => {
                close()
                if (permissions !== session.permissions) void update({ permissions })
              }}
              workflow={onWorkflow && !flow ? { available: !!session.workspace, start: () => (close(), onWorkflow('start')) } : undefined}
            />
          )}
        </ComposerPopover>
        <ComposerPopover
          width={440}
          sheetTitle="Model"
          shrink
          trigger={(open, toggle) => (
            <button
              onClick={toggle}
              aria-haspopup="dialog"
              aria-expanded={open}
              title="Model and reasoning effort"
              className={clsx('ml-1 flex h-8 w-full min-w-0 max-w-max items-center gap-1.5 whitespace-nowrap rounded-[10px] px-2 text-[12.5px] transition-colors', open ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev-2 hover:text-fg')}
            >
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', session.model ? 'bg-fg/80' : 'bg-line-strong')} />
              <span className="max-w-[200px] truncate mobile:max-w-[140px]">{session.model ? (model?.name ?? session.model.modelId) : 'Pick a model'}</span>
              {model?.reasoning && <span className="hidden shrink-0 text-dim @[680px]:inline mobile:hidden">– {effortLabel(session.thinking)}</span>}
              <CaretDown size={10} weight="bold" className={clsx('shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        >
          {(close) => <ModelEffortMenu session={session} update={update} reasoning={!!model?.reasoning} onPicked={close} />}
        </ComposerPopover>
      </div>
      {usage && usage.cost > 0 && (
        <span className="hidden shrink-0 whitespace-nowrap px-1 text-[12px] tabular-nums text-dim @[620px]:inline" title="Spent in this chat so far, including agents it handed work to">
          {formatCost(usage.cost)}
        </span>
      )}
      <div className="hidden shrink-0 @[400px]:block">
        <ContextMeter usage={usage} busy={compacting} onCompact={onCompact} />
      </div>
      <div className="ml-1 shrink-0">{send}</div>
    </div>
  )
}

/** A square crimson icon in the row: a dot under it when that thing is on, or a count badge. */
function RowIcon({ icon: I, label, state, on, count, open, haspopup, onClick }: { icon: Icon; label: string; state: string; on: boolean; count?: number; open?: boolean; haspopup?: 'dialog'; onClick(): void }) {
  return (
    <Tooltip
      content={
        <>
          <b className="font-semibold">{label}</b>
          <span className="ml-1.5 text-dim">{state}</span>
        </>
      }
    >
      <motion.button
        whileTap={{ scale: 0.86 }}
        transition={{ type: 'spring', stiffness: 700, damping: 14 }}
        onClick={onClick}
        aria-label={label}
        aria-haspopup={haspopup}
        aria-expanded={haspopup ? !!open : undefined}
        className={clsx('relative flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] text-crimson-hi transition-colors duration-200 hover:bg-crimson-soft', open && 'bg-crimson-soft')}
      >
        <I size={18} weight={on ? 'fill' : 'regular'} />
        <motion.span
          initial={false}
          animate={{ scale: on && count === undefined ? 1 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 18 }}
          className="absolute bottom-[1px] left-1/2 -ml-0.5 h-1 w-1 rounded-full bg-crimson-hi"
        />
        <AnimatePresence>
          {count !== undefined && (
            <motion.span
              key={count}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              className="absolute right-0 top-0 h-[15px] min-w-[15px] rounded-full border-2 border-panel bg-crimson px-[3px] text-center text-[9.5px] font-bold leading-[11px] text-white"
            >
              {count}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
    </Tooltip>
  )
}

function PermissionsMenu({ value, onPick, workflow }: { value: Permissions; onPick(p: Permissions): void; workflow?: { available: boolean; start(): void } }) {
  const list = useRef<HTMLDivElement>(null)
  // Arrow keys move between the options, as in any menu.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }
  const note = permissionMode(value).note
  return (
    <div className="flex flex-col overflow-y-auto">
      {!isMobile && (
        <div className="flex items-center px-3 pb-1.5 pt-2.5 text-[11.5px] text-dim">
          Permissions
          <span className="ml-auto flex items-center gap-1">
            <Kbd>Shift</Kbd> + <Kbd>Tab</Kbd>
          </span>
        </div>
      )}
      <div ref={list} onKeyDown={onKey} className="grid px-1">
        {PERMISSION_MODES.map((m, i) => {
          const I = MODE_ICON[m.id]
          const on = m.id === value
          return (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={on}
              autoFocus={!isMobile && (on || (i === 0 && !PERMISSION_MODES.some((x) => x.id === value)))}
              onClick={() => onPick(m.id)}
              className="grid w-full grid-cols-[22px_minmax(0,1fr)_16px] gap-x-2.5 gap-y-0.5 rounded-[10px] px-2.5 py-2 text-left outline-none hover:bg-elev-2 focus-visible:bg-elev-2"
            >
              <I size={16} weight="fill" className={clsx('mt-0.5', m.id === 'auto' ? 'text-crimson-hi' : m.id === 'manual' ? 'text-warn' : 'text-info')} />
              <b className="text-[13px] font-semibold">{m.name}</b>
              <Check size={14} weight="bold" className={clsx('row-start-1 mt-0.5 text-crimson-hi', !on && 'invisible')} style={{ gridColumn: 3 }} />
              <span className="col-start-2 text-[12px] text-dim">{m.sub}</span>
            </button>
          )
        })}
      </div>
      <div className="mx-1.5 mb-1.5 mt-1 border-t border-line px-1.5 pb-0.5 pt-2 text-[11.5px] text-dim">
        <b className="font-semibold text-muted">{note.lead}</b> {note.rest}
      </div>
      {workflow && (
        <div className="mx-1 mb-1 border-t border-line pt-1">
          <button
            role="menuitem"
            disabled={!workflow.available}
            title={workflow.available ? undefined : 'Choose a folder for this chat first'}
            onClick={workflow.start}
            className="grid w-full grid-cols-[22px_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 rounded-[10px] px-2.5 py-2 text-left outline-none hover:bg-elev-2 focus-visible:bg-elev-2 disabled:opacity-50"
          >
            <ListChecks size={16} weight="bold" className="mt-0.5 text-mode" />
            <b className="text-[13px] font-semibold">Start Spec → ship</b>
            <span className="col-start-2 text-[12px] text-dim">Grill, spec, tickets, build and review, with your OK between stages. What you've typed becomes the idea.</span>
          </button>
        </div>
      )}
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong px-1 font-sans text-[10.5px] text-muted">{children}</kbd>
}
