import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import { Books, CaretDown, ChatCircle, Check, FileText, FolderSimple, Hand, Lightning, ListBullets, ListChecks, Paperclip, Plus, Sparkle, Wrench, type Icon } from '@phosphor-icons/react'
import type { ChatSession, ContextUsage, WorkflowRoute, WorkflowStage } from '@shared/types'
import { useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { formatCost } from '@/lib/format'
import { ACCESS_LEVELS, accessLevel, accessOf, CHAT_MODES, chatMode, chatModeInfo, knowledgeCount, type Access, type ChatMode } from '@/lib/permissions'
import { Tooltip } from '@/components/Tooltip'
import { ContextMeter } from '@/components/Planning'
import { openSetupSection } from './setupNav'
import { ComposerPopover, effortLabel, FolderMenu, ModelEffortMenu } from './StatusLine'
import { STAGE_LABEL, stageIndex } from './Workflow'
import { routeStages } from '@shared/types'

type Update = (p: Partial<ChatSession>) => Promise<void>

export const MODE_ICON: Record<ChatMode, Icon> = { chat: ChatCircle, plan: ListBullets, spec: ListChecks, openspec: FileText }
const MODE_TONE: Record<ChatMode, string> = {
  openspec: 'border-ospec-line bg-ospec-soft text-ospec hover:bg-ospec/15',
  chat: 'border-line-strong text-muted hover:bg-elev-2 hover:text-fg',
  plan: 'border-info/35 bg-info/[0.08] text-info hover:bg-info/15',
  spec: 'border-mode-line bg-mode-soft text-mode hover:bg-mode/15'
}
const MODE_ICON_TONE: Record<ChatMode, string> = { chat: 'text-muted', plan: 'text-info', spec: 'text-mode', openspec: 'text-ospec' }
export const ACCESS_ICON: Record<Access, Icon> = { auto: Lightning, manual: Hand }
const ACCESS_ICON_TONE: Record<Access, string> = { auto: 'text-crimson-hi', manual: 'text-warn' }
/** The access chip: outlined and tinted in its own colour (Cloth's crimson for Auto, amber for Manual). */
const ACCESS_TONE: Record<Access, string> = {
  auto: 'border-crimson-line bg-crimson-soft text-crimson-text hover:bg-crimson/20',
  manual: 'border-warn/35 bg-warn/[0.08] text-warn hover:bg-warn/15'
}

/**
 * The message box's bottom row, read left to right: what to add (files, knowledge, skills, tools),
 * where it works (folder), how it works (mode), what it may do without asking (access), which model;
 * then how full the context is and the send button. Mode and access are separate buttons.
 */
export function ComposerBar({
  session,
  update,
  usage,
  compacting,
  onCompact,
  attach,
  send,
  onWorkflow,
  specArmed = false
}: {
  session: ChatSession
  update: Update
  usage: ContextUsage | null
  compacting: boolean
  onCompact(): void
  /** Files waiting to go with the message, and opening the file picker. */
  attach: { count: number; onClick(): void }
  /** The send / stop button. */
  send: ReactNode
  /** Spec → Ship: pick it (it starts with the next message) or un-pick it, leave a running one, or show its documents. */
  onWorkflow?(action: 'arm' | 'disarm' | 'stop' | 'docs'): Promise<void> | void
  /** Spec → Ship is picked and waits for the first message. */
  specArmed?: boolean
}) {
  const flow = session.workflow && session.workflow.stage !== 'done' ? session.workflow : null
  const mode: ChatMode = specArmed ? 'spec' : chatMode(session)
  const access = accessOf(session)
  const collections = useApp((s) => s.collections)
  const providers = useApp((s) => s.providers)
  const model = providers.find((p) => p.id === session.model?.providerId)?.models.find((m) => m.id === session.model?.modelId)
  const knowledge = knowledgeCount(session, collections.map((c) => c.id))
  const skillsOn = session.skillsEnabled || session.skillsAlways.length > 0
  const toolsOn = session.subagents || session.imagesEnabled || session.customTools
  const folder = session.workspace?.split(/[\\/]/).pop()

  const pickMode = async (next: ChatMode) => {
    if (next === mode) return
    // OpenSpec runs on its own: it works in Auto, and starts with the next message.
    if (next === 'openspec') {
      if (specArmed) await onWorkflow?.('disarm')
      else if (mode === 'spec') await onWorkflow?.('stop')
      return void (await update({ openspec: { step: 'setup', change: null, waitAfterPropose: false, tasks: null, pr: null, startedAt: Date.now() }, permissions: 'auto' }))
    }
    if (mode === 'openspec') await update({ openspec: null })
    if (next === 'spec') return void (await onWorkflow?.('arm'))
    if (specArmed) await onWorkflow?.('disarm')
    else if (mode === 'spec') await onWorkflow?.('stop')
    const permissions = next === 'plan' ? 'plan' : access
    if (permissions !== session.permissions) await update({ permissions })
  }
  const pickAccess = (next: Access) => {
    if (next === access) return
    // In Plan mode it is what the chat goes back to once the plan is approved.
    void update(session.permissions === 'plan' ? { access: next } : { permissions: next })
  }
  const ModeIcon = MODE_ICON[mode]
  const AccessIcon = ACCESS_ICON[access]
  const addState = [attach.count ? `${attach.count} file${attach.count === 1 ? '' : 's'} attached` : 'Files', knowledge ? `${knowledge} collection${knowledge === 1 ? '' : 's'}` : null, skillsOn ? 'skills on' : null]
  return (
    <div className="@container flex items-center gap-1 pb-2 pl-2.5 pr-2 pt-1.5">
      {/* Phones: the chips scroll sideways; the meter and send button stay put. */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 mobile:overflow-x-auto mobile:[scrollbar-width:none]">
        <ComposerPopover
          width={300}
          sheetTitle="Add"
          role="menu"
          trigger={(open, toggle) => (
            <RowIcon icon={Plus} bold label="Add" state={addState.filter(Boolean).join(' · ')} on={knowledge > 0 || skillsOn || toolsOn} count={attach.count || undefined} open={open} haspopup="menu" onClick={toggle} />
          )}
        >
          {(close) => (
            <MenuList>
              <MenuRow icon={Paperclip} iconTone="text-muted" name="Attach files" state={attach.count ? `${attach.count}` : undefined} onClick={() => (close(), attach.onClick())} />
              <div className="mx-1.5 my-1 border-t border-line" />
              <MenuRow icon={Books} name="Knowledge" state={knowledge ? `${knowledge} on` : 'Off'} on={knowledge > 0} onClick={() => (close(), openSetupSection('knowledge'))} />
              <MenuRow icon={Sparkle} name="Skills" state={skillsOn ? 'On' : 'Off'} on={skillsOn} onClick={() => (close(), openSetupSection('skills'))} />
              <MenuRow icon={Wrench} name="Tools" state={toolsOn ? 'On' : 'Default'} on={toolsOn} onClick={() => (close(), openSetupSection('tools'))} />
            </MenuList>
          )}
        </ComposerPopover>
        <ComposerPopover
          width={360}
          sheetTitle="Folder"
          trigger={(open, toggle) => (
            <Tooltip
              content={
                <>
                  <b className="font-semibold">Folder</b>
                  <span className="ml-1.5 text-dim">{session.container ? `${folder ?? 'No folder'} · Linux container` : (folder ?? 'None chosen')}</span>
                </>
              }
            >
              <button
                onClick={toggle}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`Folder: ${folder ?? 'none chosen'}`}
                className={clsx('flex h-8 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-2 text-ui transition-colors', open ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev-2 hover:text-fg')}
              >
                <FolderSimple size={17} weight={session.workspace ? 'fill' : 'regular'} className="shrink-0 text-muted" />
                <span className="hidden max-w-[140px] truncate @[800px]:inline">{folder ?? 'Folder'}</span>
              </button>
            </Tooltip>
          )}
        >
          {() => <FolderMenu session={session} update={update} />}
        </ComposerPopover>
        <span aria-hidden="true" className="mx-1.5 h-[22px] w-px shrink-0 bg-line-strong mobile:mx-1" />
        <ComposerPopover
          width={330}
          sheetTitle="Mode"
          role="menu"
          trigger={(open, toggle) => (
            <button
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`Mode: ${chatModeInfo(mode).name}${flow ? `, stage: ${STAGE_LABEL[flow.stage]}` : ''}`}
              title={flow ? `Spec → Ship · ${STAGE_LABEL[flow.stage]}` : specArmed ? 'Spec → Ship · starts with your next message' : `Mode: ${chatModeInfo(mode).name} (Shift+Tab switches Chat and Plan)`}
              className={clsx('flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border pl-2 pr-2.5 text-ui font-semibold transition-colors', MODE_TONE[mode])}
            >
              <ModeIcon size={15} weight={mode === 'chat' ? 'regular' : 'bold'} className="shrink-0" />
              {mode === 'spec' ? (
                <>
                  <span className="hidden @[640px]:inline">Spec → Ship</span>
                  <span className="hidden @[380px]:inline @[640px]:hidden mobile:inline">Spec</span>
                </>
              ) : (
                <span className="hidden @[380px]:inline mobile:inline">{chatModeInfo(mode).name}</span>
              )}
              <CaretDown size={10} weight="bold" className={clsx('shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        >
          {(close) => (
            <ModeMenu
              value={mode}
              hasFolder={!!session.workspace}
              canSpec={!!onWorkflow}
              flow={flow ? { stage: flow.stage, route: flow.route, docs: () => (close(), void onWorkflow?.('docs')) } : null}
              waiting={specArmed}
              onPick={(m) => (close(), void pickMode(m))}
            />
          )}
        </ComposerPopover>
        <ComposerPopover
          width={340}
          sheetTitle="Access"
          role="menu"
          trigger={(open, toggle) => (
            <button
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={`Access: ${accessLevel(access).name}`}
              title={`Access: ${accessLevel(access).name}${mode === 'plan' ? ' (once the plan is approved)' : ''}`}
              className={clsx('ml-1 flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border pl-2 pr-2.5 text-ui font-semibold transition-colors', ACCESS_TONE[access])}
            >
              <AccessIcon size={15} weight="fill" className="shrink-0" />
              <span className="hidden @[600px]:inline mobile:inline">{accessLevel(access).name}</span>
              <CaretDown size={10} weight="bold" className={clsx('shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        >
          {(close) => <AccessMenu value={access} planning={mode === 'plan'} onPick={(a) => (close(), pickAccess(a))} />}
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
              className={clsx('ml-0.5 flex h-8 w-full min-w-[64px] max-w-max items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[10px] px-2 text-ui transition-colors', open ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev-2 hover:text-fg')}
            >
              <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', session.model ? 'bg-fg/80' : 'bg-line-strong')} />
              <span className="min-w-[3ch] max-w-[200px] truncate mobile:max-w-[140px]">{session.model ? (model?.name ?? session.model.modelId) : 'Pick a model'}</span>
              {/* As the row narrows: the folder name gives way first, then the effort (sooner beside the wider Spec → Ship chip), then the access label. */}
              {model?.reasoning && <span className={clsx('hidden shrink-0 text-dim mobile:hidden', mode === 'spec' ? '@[860px]:inline' : '@[680px]:inline')}>– {effortLabel(session.thinking)}</span>}
              <CaretDown size={10} weight="bold" className={clsx('shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
            </button>
          )}
        >
          {(close) => <ModelEffortMenu session={session} update={update} reasoning={!!model?.reasoning} onPicked={close} />}
        </ComposerPopover>
      </div>
      {usage && usage.cost > 0 && (
        <span className="hidden shrink-0 whitespace-nowrap px-1 text-caption tabular-nums text-dim @[620px]:inline" title="Spent in this chat so far, including agents it handed work to">
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

/** A square crimson icon in the row: a dot under it when something behind it is on, or a count badge. */
function RowIcon({ icon: I, bold, label, state, on, count, open, haspopup, onClick }: { icon: Icon; bold?: boolean; label: string; state: string; on: boolean; count?: number; open?: boolean; haspopup?: 'dialog' | 'menu'; onClick(): void }) {
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
        className={clsx('relative flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors duration-200 hover:bg-elev-2 hover:text-fg', open && 'bg-elev-2 text-fg')}
      >
        <I size={18} weight={bold ? 'bold' : on ? 'fill' : 'regular'} />
        <motion.span
          initial={false}
          animate={{ scale: on && count === undefined ? 1 : 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 18 }}
          className="absolute bottom-[1px] left-1/2 -ml-0.5 h-1 w-1 rounded-full bg-fg"
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

/** Arrow keys move between a menu's options, as in any menu. */
function MenuList({ children }: { children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null)
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }
  return (
    <div ref={list} onKeyDown={onKey} className="flex flex-col overflow-y-auto p-1">
      {children}
    </div>
  )
}

/** One option: an icon, a name, an optional line under it, and a check (choices) or a state (links). */
function MenuRow({
  icon: I,
  iconTone = 'text-muted',
  iconWeight,
  name,
  sub,
  checked,
  state,
  on,
  disabled,
  autoFocus,
  onClick
}: {
  icon: Icon
  iconTone?: string
  iconWeight?: 'fill' | 'bold' | 'regular'
  name: string
  sub?: string
  checked?: boolean
  state?: string
  on?: boolean
  disabled?: boolean
  autoFocus?: boolean
  onClick(): void
}) {
  return (
    <button
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      disabled={disabled}
      autoFocus={autoFocus && !isMobile}
      onClick={onClick}
      className="grid w-full grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 rounded-[10px] px-2.5 py-2 text-left outline-none hover:bg-elev-2 focus-visible:bg-elev-2 disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <I size={16} weight={iconWeight ?? (on === false ? 'regular' : 'fill')} className={clsx('mt-0.5', iconTone)} />
      <b className="text-ui font-semibold">{name}</b>
      {checked !== undefined ? (
        <Check size={14} weight="bold" className={clsx('mt-0.5 text-fg', !checked && 'invisible')} />
      ) : (
        <span className={clsx('self-center text-caption', on ? 'text-fg' : 'text-dim')}>{state}</span>
      )}
      {sub && <span className="col-start-2 text-caption text-dim">{sub}</span>}
    </button>
  )
}

function ModeMenu({ value, hasFolder, canSpec, flow, waiting, onPick }: { value: ChatMode; hasFolder: boolean; canSpec: boolean; flow: { stage: WorkflowStage; route?: WorkflowRoute; docs(): void } | null; waiting: boolean; onPick(m: ChatMode): void }) {
  return (
    <MenuList>
      {!isMobile && (
        <div className="flex items-center px-2.5 pb-1 pt-1.5 text-caption text-dim">
          Mode
          <span className="ml-auto flex items-center gap-1">
            <Kbd>Shift</Kbd> + <Kbd>Tab</Kbd>
          </span>
        </div>
      )}
      {CHAT_MODES.filter((m) => m.id !== 'spec' || canSpec).map((m) => {
        const noFolder = (m.id === 'spec' || m.id === 'openspec') && !hasFolder && value !== m.id
        return (
          <MenuRow
            key={m.id}
            icon={MODE_ICON[m.id]}
            iconTone={MODE_ICON_TONE[m.id]}
            iconWeight={m.id === 'chat' ? 'regular' : 'bold'}
            name={m.name}
            sub={noFolder ? 'Choose a folder for this chat first.' : m.sub}
            checked={m.id === value}
            disabled={noFolder}
            autoFocus={m.id === value}
            onClick={() => onPick(m.id)}
          />
        )
      })}
      {waiting && (
        <p className="mx-1.5 mt-1 border-t border-line px-1 pb-1 pt-2 text-caption text-dim">
          <b className="font-semibold text-muted">Waiting for your first message.</b> Describe what you want to build and send it to start.
        </p>
      )}
      {flow && (
        <div className="mx-1.5 mt-1 border-t border-line pt-1">
          <p className="px-1 pb-1 pt-1.5 text-caption text-dim">
            Stage {stageIndex(flow.stage, flow.route) + 1} of {routeStages(flow.route).length}: <b className="font-semibold text-muted">{STAGE_LABEL[flow.stage]}</b>. Picking Chat or Plan leaves Spec → Ship; the documents stay.
          </p>
          <button role="menuitem" onClick={flow.docs} className="w-full rounded-[9px] px-1.5 py-1.5 text-left text-ui outline-none hover:bg-elev-2 focus-visible:bg-elev-2">
            Show the documents
          </button>
        </div>
      )}
    </MenuList>
  )
}

function AccessMenu({ value, planning, onPick }: { value: Access; planning: boolean; onPick(a: Access): void }) {
  const note = accessLevel(value).note
  return (
    <MenuList>
      {!isMobile && <div className="px-2.5 pb-1 pt-1.5 text-caption text-dim">Access</div>}
      {ACCESS_LEVELS.map((m) => (
        <MenuRow key={m.id} icon={ACCESS_ICON[m.id]} iconTone={ACCESS_ICON_TONE[m.id]} name={m.name} sub={m.sub} checked={m.id === value} autoFocus={m.id === value} onClick={() => onPick(m.id)} />
      ))}
      <p className="mx-1.5 mt-1 border-t border-line px-1 pb-0.5 pt-2 text-caption text-dim">
        {planning ? (
          <>
            <b className="font-semibold text-muted">Plan mode is read-only.</b> This applies once you approve the plan.
          </>
        ) : (
          <>
            <b className="font-semibold text-muted">{note.lead}</b> {note.rest}
          </>
        )}
      </p>
    </MenuList>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong px-1 font-sans text-micro text-muted">{children}</kbd>
}
