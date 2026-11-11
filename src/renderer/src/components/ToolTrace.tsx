import { useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowCounterClockwise,
  Books,
  FilePlus,
  Files,
  ListChecks,
  Robot,
  ImageSquare,
  Code,
  TreeStructure,
  NotePencil,
  TerminalWindow,
  CaretRight,
  CheckCircle,
  CircleNotch,
  FileText,
  FolderSimple,
  GlobeHemisphereWest,
  ListMagnifyingGlass,
  Sparkle,
  WarningCircle,
  Wrench,
  ChatCircleDots,
  BookmarkSimple,
  Desktop,
  type Icon
} from '@phosphor-icons/react'
import type { RagHit, ToolTrace as Trace } from '@shared/types'
import { duration, formatCost, pretty } from '@/lib/format'
import { runAbout, runCardId, runName } from '@/lib/workbar'
import { DiffStat, DiffView } from './DiffView'
import { TodoList, todosOf } from './Planning'
import { Markdown } from './Markdown'
import { GeneratedImageCard } from './GeneratedImageCard'
import { api } from '@/lib/api'

export const ICONS: Record<string, Icon> = {
  rag_search: Books,
  web_search: GlobeHemisphereWest,
  web_fetch: GlobeHemisphereWest,
  skill_list: Sparkle,
  skill_use: Sparkle,
  read_file: FileText,
  list_dir: FolderSimple,
  grep: ListMagnifyingGlass,
  read: FileText,
  ls: FolderSimple,
  find: Files,
  write: FilePlus,
  edit: NotePencil,
  bash: TerminalWindow,
  powershell: TerminalWindow,
  todo_write: ListChecks,
  task: Robot,
  agent_mention: Robot,
  lsp: Code,
  ast_grep: TreeStructure,
  ast_edit: TreeStructure,
  generate_image: ImageSquare,
  ask_user: ChatCircleDots,
  rag_index: BookmarkSimple,
  skill_create: Sparkle,
  tool_create: Wrench,
  computer: Desktop
}

function summarize(t: Trace): string {
  const a = (t.args ?? {}) as Record<string, unknown>
  if (t.name === 'rag_search') return `“${a.query ?? ''}”${Array.isArray(a.collections) && a.collections.length ? ` · ${a.collections.join(', ')}` : ''}`
  if (t.name === 'web_search') return `“${a.query ?? ''}”`
  if (t.name === 'web_fetch') return String(a.url ?? '')
  if (t.name === 'skill_use') return `${a.name ?? ''}${a.file ? ` / ${a.file}` : ''}`
  if (['read_file', 'list_dir', 'read', 'ls', 'write', 'edit'].includes(t.name)) return String(a.path ?? '.')
  if (t.name === 'find') return `${a.pattern ?? ''}${a.path ? ` in ${a.path}` : ''}`
  if (t.name === 'bash' || t.name === 'powershell') return `$ ${String(a.command ?? '').split('\n')[0]}`
  if (t.name === 'todo_write') {
    const todos = todosOf(t.args)
    const current = todos.find((x) => x.status === 'in_progress')
    return `${todos.filter((x) => x.status === 'completed').length}/${todos.length} done${current ? ` · ${current.content}` : ''}`
  }
  if (t.name === 'task') return String(a.description ?? '')
  if (t.name === 'agent_mention') return String(a.name ?? '')
  if (t.name === 'generate_image') return String(a.prompt ?? '')
  if (t.name === 'computer') {
    const at = Array.isArray(a.coordinate) ? ` [${a.coordinate.join(', ')}]` : ''
    const from = Array.isArray(a.start_coordinate) ? ` from [${a.start_coordinate.join(', ')}]` : ''
    const text = typeof a.text === 'string' ? ` “${a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text}”` : ''
    return `${String(a.action ?? '').replace(/_/g, ' ')}${from}${at}${a.scroll_direction ? ` ${a.scroll_direction}` : ''}${text}`
  }
  if (t.name === 'ask_user') return String(a.question ?? '')
  if (t.name === 'rag_index') return `→ ${a.collection ?? ''}${a.title ? ` · ${a.title}` : Array.isArray(a.urls) && a.urls.length ? ` · ${a.urls[0]}` : ''}`
  if (t.name === 'skill_create' || t.name === 'tool_create') return String(a.name ?? '')
  if (t.name === 'lsp') return [a.action, a.symbol ?? a.query, a.newName ? `→ ${a.newName}` : '', a.path ? `· ${a.path}${a.line ? `:${a.line}` : ''}` : ''].filter(Boolean).join(' ')
  if (t.name === 'ast_grep') return `${a.pattern ?? ''}${a.path ? ` in ${a.path}` : ''}`
  if (t.name === 'ast_edit') return `${a.pattern ?? ''} → ${a.rewrite ?? ''}`
  if (t.name === 'grep') return `/${a.pattern ?? ''}/ ${a.path ?? ''}`
  const s = JSON.stringify(a)
  return s === '{}' ? '' : s.slice(0, 80)
}

const refLabel = (r: RagHit) => {
  if (/^https?:\/\//.test(r.source)) {
    try {
      return new URL(r.source).hostname.replace(/^www\./, '')
    } catch {
      /* fall through */
    }
  }
  return r.headingPath ? `${r.title} › ${r.headingPath.split(' › ').pop()}` : r.title
}

/** `fresh` animates the card in — only for traces that appear live, not when loading history. */
export function ToolTraceCard({ trace, fresh, awaiting, onUndo, superseded, compact, defaultOpen }: { trace: Trace; fresh?: boolean; awaiting?: boolean; onUndo?(toolCallId: string): Promise<void>; superseded?: boolean; /** Inside a group: tighter. */ compact?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  const [undoing, setUndoing] = useState(false)
  const changes = trace.changes ?? []
  const undone = changes.length > 0 && changes.every((c) => c.undone)
  const Icon = ICONS[trace.name] ?? Wrench
  const refs = trace.references
  return (
    <motion.div
      id={trace.subagent ? runCardId(trace.id) : undefined}
      initial={fresh ? { opacity: 0, y: 8, scale: 0.98 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
      className={clsx(compact ? 'mb-1.5 rounded-[10px]' : 'mb-4 rounded-[14px]', 'overflow-hidden border bg-panel transition-colors', trace.status === 'error' ? 'border-danger-line' : 'border-line hover:border-line-strong')}
    >
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={clsx('flex w-full items-center gap-2.5 px-3 text-left', compact ? 'py-1.5' : 'py-2.5')}>
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-elev-2 text-muted">
          <Icon size={14} />
        </span>
        <span className="shrink-0 font-mono text-caption font-medium text-fg">{trace.subagent ? 'subagent' : trace.name}</span>
        {trace.subagent && (
          <span title={runAbout(trace.subagent)} className={clsx('shrink-0 text-caption', trace.subagent.agent ? 'text-agent' : 'text-fg')}>
            {runName(trace.subagent)}
          </span>
        )}
        <span className={clsx('min-w-0 flex-1 truncate text-caption', trace.name === 'skill_use' ? 'font-mono text-skill' : trace.name === 'agent_mention' ? 'text-agent' : 'text-dim')}>{summarize(trace)}</span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-caption text-dim">
          {awaiting && <span className="rounded-full bg-warn/10 px-2 py-px text-micro text-warn">{trace.name === 'ask_user' ? 'waiting for you' : 'awaiting approval'}</span>}
          {refs.length > 0 && <span>{refs.length} refs</span>}
          {trace.durationMs !== null && <span>{duration(trace.durationMs)}</span>}
          {trace.status === 'running' ? (
            <CircleNotch size={14} className="animate-spin text-crimson" />
          ) : trace.status === 'ok' ? (
            <motion.span key="ok" initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
              <CheckCircle size={15} weight="fill" className="text-ok" />
            </motion.span>
          ) : (
            <motion.span key="err" initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
              <WarningCircle size={15} weight="fill" className="text-danger-hi" />
            </motion.span>
          )}
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }} className="flex shrink-0 text-dim">
          <CaretRight size={13} />
        </motion.span>
      </button>

      {trace.subagent && !open && <SubagentBody trace={trace} />}

      {trace.image && (
        <div className="pb-3.5 pl-12 pr-3">
          <GeneratedImageCard image={trace.image} className="max-w-[440px]" />
        </div>
      )}

      {trace.computer?.thumbnail && (
        <div className="pb-3.5 pl-12 pr-3">
          <img src={trace.computer.thumbnail} alt={`Screen after ${trace.computer.action.replace(/_/g, ' ')}`} className="block max-w-[240px] rounded-lg border border-line" />
        </div>
      )}

      {trace.name === 'todo_write' && !open && !superseded && trace.status !== 'error' && (
        <div className="pb-2.5 pl-12 pr-3">
          <TodoList todos={todosOf(trace.args)} dense />
        </div>
      )}

      {changes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-2.5 pl-12 pr-3">
          {changes.map((c) => (
            <span key={c.path} className={clsx('flex items-center gap-1.5 rounded-full border border-line bg-elev py-0.5 pl-2 pr-2.5 text-caption', c.undone && 'opacity-50 line-through')}>
              {c.kind === 'create' ? <FilePlus size={12} className="text-ok" /> : <NotePencil size={12} className="text-muted" />}
              <span className="font-mono text-muted">{c.path}</span>
              <DiffStat added={c.added} removed={c.removed} />
            </span>
          ))}
          <div className="flex-1" />
          {undone ? (
            <span className="text-caption text-dim">undone</span>
          ) : (
            onUndo && (
              <button
                disabled={undoing}
                onClick={async () => {
                  setUndoing(true)
                  try {
                    await onUndo(trace.id)
                  } finally {
                    setUndoing(false)
                  }
                }}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption text-dim transition-colors hover:bg-elev-2 hover:text-fg disabled:opacity-50"
                title="Restore the files as they were before this step"
              >
                <ArrowCounterClockwise size={12} />
                Undo
              </button>
            )
          )}
        </div>
      )}

      <AnimatePresence initial={false}>
        {!open && refs.length > 0 && (
          <motion.div
            key="refs"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="flex gap-1.5 overflow-x-auto pb-2.5 pl-12 pr-3 [scrollbar-width:none]">
              {refs.slice(0, 10).map((r, i) => (
                <motion.button
                  key={r.chunkId}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.3 }}
                  title={r.source}
                  onClick={() => /^https?:\/\//.test(r.source) && void api.app.openExternal(r.source)}
                  className="flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elev py-1 pl-1 pr-2.5 text-caption text-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-elev-2 text-[9px] text-dim">{i + 1}</span>
                  <span className="truncate">{refLabel(r)}</span>
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0 }}
            animate={{ height: 'auto', transition: { type: 'spring', stiffness: 260, damping: 24 } }}
            exit={{ height: 0, transition: { type: 'spring', stiffness: 260, damping: 32 } }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pb-3 pl-12 pr-3">
              {changes.length > 0 ? (
                changes.map((c) => (
                  <Section key={c.path} label={`${c.kind === 'create' ? 'Created' : 'Changed'} ${c.path}${c.undone ? ' (undone)' : ''}`}>
                    <DiffView diff={c.diff} />
                  </Section>
                ))
              ) : (
                <Section label="Arguments">
                  <pre className="selectable max-h-48 overflow-auto rounded-lg border border-line bg-bg p-2.5 font-mono text-caption text-muted">{pretty(trace.args)}</pre>
                </Section>
              )}
              {refs.length > 0 ? (
                <Section label={`References (${refs.length})`}>
                  <div className="space-y-1.5">
                    {refs.map((r, i) => (
                      <ReferenceCard key={r.chunkId} hit={r} n={i + 1} />
                    ))}
                  </div>
                </Section>
              ) : (
                <Section label={trace.status === 'error' ? 'Error' : 'Result'}>
                  <pre className={clsx('selectable max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2.5 font-mono text-caption', trace.status === 'error' ? 'text-danger-hi' : 'text-muted')}>
                    {trace.result || (trace.status === 'running' ? 'Running…' : '(empty)')}
                  </pre>
                </Section>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** A subagent's run: its own tool calls as a compact timeline, then its report. */
function SubagentBody({ trace }: { trace: Trace }) {
  const [full, setFull] = useState(false)
  const run = trace.subagent!
  const steps = run.blocks.filter((b): b is { type: 'tool'; trace: Trace } => b.type === 'tool').map((b) => b.trace)
  const shown = run.running ? steps.slice(-6) : steps.slice(-8)
  const report = trace.status === 'ok' ? trace.result : ''
  return (
    <div className="pb-3 pl-12 pr-3">
      <div className="relative space-y-1 border-l border-line pl-3">
        {steps.length > shown.length && <div className="text-caption text-dim">… {steps.length - shown.length} earlier step{steps.length - shown.length === 1 ? '' : 's'}</div>}
        <AnimatePresence initial={false}>
          {shown.map((s) => {
            const I = ICONS[s.name] ?? Wrench
            return (
              <motion.div key={s.id} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2 text-caption">
                <I size={12} className="shrink-0 text-dim" />
                <span className="shrink-0 font-mono text-muted">{s.name}</span>
                <span className="min-w-0 flex-1 truncate text-dim">{summarize(s)}</span>
                {s.status === 'running' ? (
                  <CircleNotch size={12} className="shrink-0 animate-spin text-crimson" />
                ) : s.status === 'ok' ? (
                  <CheckCircle size={12} weight="fill" className="shrink-0 text-ok/80" />
                ) : (
                  <WarningCircle size={12} weight="fill" className="shrink-0 text-crimson-hi" />
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
        {run.running && (
          <div className="flex items-center gap-2 pt-0.5 text-caption text-dim">
            <span className="shimmer-text">{steps.length ? 'Working' : 'Starting'}</span>
            {run.current && (
              <span className="min-w-0 truncate">
                {run.current.tool} {run.current.summary}…
              </span>
            )}
          </div>
        )}
      </div>
      {!run.running && report && (
        <div className="mt-2.5 rounded-[10px] border border-line bg-bg px-3 py-2">
          <div className="mb-1 flex items-center gap-2 text-caption font-medium text-dim">
            Report
            <span className="font-normal normal-case tracking-normal">
              {steps.length} step{steps.length === 1 ? '' : 's'}
              {run.usage ? ` · ${Math.round((run.usage.input + run.usage.output) / 100) / 10}k tokens` : ''}
              {run.usage && run.usage.cost > 0 ? ` · ${formatCost(run.usage.cost)}` : ''}
            </span>
            <div className="flex-1" />
            <button onClick={() => setFull(!full)} className="font-normal normal-case tracking-normal text-dim hover:text-fg">
              {full ? 'less' : 'more'}
            </button>
          </div>
          <div className={clsx('text-ui', !full && 'line-clamp-4')}>
            <Markdown text={report} />
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-caption font-medium text-dim">{label}</div>
      {children}
    </div>
  )
}

export function ReferenceCard({ hit, n }: { hit: RagHit; n?: number }) {
  const [expanded, setExpanded] = useState(false)
  const isUrl = /^https?:\/\//.test(hit.source)
  return (
    <div className="rounded-[10px] border border-line bg-bg px-3 py-2.5">
      <div className="flex items-start gap-2">
        {n !== undefined && <span className="mt-px flex h-4 min-w-4 items-center justify-center rounded-[5px] bg-crimson-soft px-1 text-micro font-semibold text-crimson-text">{n}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isUrl ? <GlobeHemisphereWest size={12} className="shrink-0 text-dim" /> : <FileText size={12} className="shrink-0 text-dim" />}
            <span className="truncate text-ui font-medium">{hit.title}</span>
          </div>
          {hit.headingPath && <div className="truncate text-caption text-dim">{hit.headingPath}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1 font-mono text-micro text-dim">
          {hit.bm25Rank !== null && <span title="BM25 rank">kw#{hit.bm25Rank}</span>}
          {hit.vectorRank !== null && <span title="Vector rank">vec#{hit.vectorRank}</span>}
          <span className="text-muted">{hit.score.toFixed(2)}</span>
        </div>
      </div>
      <div className={clsx('selectable mt-1.5 whitespace-pre-wrap text-caption leading-relaxed text-muted', !expanded && 'line-clamp-3')} onClick={() => setExpanded(!expanded)}>
        {hit.text}
      </div>
      {isUrl ? (
        <button className="mt-1 block max-w-full truncate text-left font-mono text-micro text-dim hover:text-crimson-hi" title={hit.source} onClick={() => void api.app.openExternal(hit.source)}>
          {hit.source}
        </button>
      ) : (
        <div className="mt-1 truncate font-mono text-micro text-dim" title={hit.source}>
          {hit.source}
        </div>
      )}
    </div>
  )
}

// ─── Activity ────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What a run of tool calls did, in plain words: "Read 3 files, searched the code, edited 2 files". */
export function describeTools(traces: Trace[]): string {
  const count = (pred: (t: Trace) => boolean) => traces.filter(pred).length
  const files = (names: string[]) => new Set(traces.filter((t) => names.includes(t.name)).map((t) => String((t.args as { path?: unknown })?.path ?? ''))).size
  const parts: string[] = []
  const read = files(['read', 'read_file'])
  if (read) parts.push(`read ${plural(read, 'file')}`)
  if (count((t) => ['grep', 'find', 'ls', 'list_dir', 'ast_grep', 'lsp'].includes(t.name))) parts.push('searched the code')
  const changed = new Set(traces.flatMap((t) => (t.changes ?? []).map((c) => c.path))).size || files(['edit', 'write', 'ast_edit'])
  if (changed) parts.push(`edited ${plural(changed, 'file')}`)
  const commands = count((t) => t.name === 'bash' || t.name === 'powershell')
  if (commands) parts.push(`ran ${plural(commands, 'command')}`)
  if (count((t) => t.name === 'web_search')) parts.push('searched the web')
  const pages = count((t) => t.name === 'web_fetch')
  if (pages) parts.push(`opened ${plural(pages, 'page')}`)
  if (count((t) => t.name === 'rag_search')) parts.push('searched your knowledge')
  const skills = new Set(traces.filter((t) => t.name === 'skill_use').map((t) => String((t.args as { name?: unknown })?.name ?? '')))
  if (skills.size) parts.push(`used the ${[...skills].join(', ')} skill${skills.size > 1 ? 's' : ''}`)
  const tagged = new Set(traces.filter((t) => t.name === 'agent_mention').map((t) => String((t.args as { name?: unknown })?.name ?? '')))
  if (tagged.size) parts.push(`handed it to the ${[...tagged].join(', ')} agent${tagged.size > 1 ? 's' : ''}`)
  const external = new Map<string, number>()
  for (const t of traces) if (t.name.startsWith('mcp__')) external.set(t.name.split('__')[1], (external.get(t.name.split('__')[1]) ?? 0) + 1)
  for (const [server, n] of external) parts.push(`${plural(n, `${server} step`)}`)
  const known = new Set(['read', 'read_file', 'grep', 'find', 'ls', 'list_dir', 'ast_grep', 'lsp', 'edit', 'write', 'ast_edit', 'bash', 'powershell', 'web_search', 'web_fetch', 'rag_search', 'skill_use', 'agent_mention', 'todo_write'])
  const other = count((t) => !known.has(t.name) && !t.name.startsWith('mcp__'))
  if (other) parts.push(`${plural(other, 'other step')}`)
  const text = parts.join(', ') || `${plural(traces.length, 'step')}`
  return text[0].toUpperCase() + text.slice(1)
}

const VERBS: Record<string, string> = {
  read: 'Read',
  read_file: 'Read',
  ls: 'Listed',
  list_dir: 'Listed',
  grep: 'Searched',
  find: 'Searched',
  ast_grep: 'Searched',
  lsp: 'Looked up',
  write: 'Wrote',
  edit: 'Edited',
  ast_edit: 'Rewrote',
  bash: 'Ran',
  powershell: 'Ran',
  web_search: 'Searched',
  web_fetch: 'Fetched',
  rag_search: 'Searched',
  rag_index: 'Saved',
  skill_list: 'Listed skills',
  skill_use: 'Used skill',
  skill_create: 'Created skill',
  tool_create: 'Created tool',
  agent_mention: 'Handed to',
  computer: 'Used computer'
}

/** One step in plain words: a short verb and what it acted on ("Ran", "npm run build"). */
export function toolVerb(t: Trace): { verb: string; target: string } {
  const [, server, ...tool] = t.name.split('__')
  const verb = VERBS[t.name] ?? (t.name.startsWith('mcp__') && tool.length ? `${server} ${tool.join(' ').replace(/_/g, ' ')}` : t.name.replace(/_/g, ' '))
  const target = t.name === 'bash' || t.name === 'powershell' ? String((t.args as { command?: unknown })?.command ?? '').split('\n')[0] : t.name.startsWith('mcp__') ? argValues(t.args) : summarize(t)
  return { verb, target }
}

/** An MCP call's arguments as their values ("http://127.0.0.1:4173"), not JSON. */
function argValues(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  return Object.values(args as Record<string, unknown>)
    .filter((v) => (typeof v === 'string' && v.trim()) || typeof v === 'number')
    .map(String)
    .join(' · ')
}
