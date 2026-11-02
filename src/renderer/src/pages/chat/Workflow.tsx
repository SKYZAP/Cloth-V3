import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import { CheckCircle, ListChecks, ListBullets } from '@phosphor-icons/react'
import type { QuestionRound, SpecWorkflow, StageGate, UiMessage, WorkflowRoute, WorkflowStage } from '@shared/types'
import { routeStages } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { api } from '@/lib/api'
import { parseTicket, ticketStatus, type Ticket, type TicketStatus } from '@/lib/tickets'
import { fixMessage, isNothing, splitSummary } from '@/lib/stageGate'
import { Modal } from '@/components/ui'

export const STAGE_LABEL: Record<WorkflowStage, string> = { grill: 'Grill', spec: 'Spec', tickets: 'Tickets', build: 'Build', review: 'Review', done: 'Done' }
export const ROUTE_LABEL: Record<WorkflowRoute, string> = { quick: 'Quick', standard: 'Standard', preserve: 'Preserve' }
/** What the person does at the end of each stage (none for Build: it runs on its own). */
export const STAGE_YOU: Record<WorkflowStage, string> = { grill: 'Answer the questions', spec: 'Approve the spec and tickets', tickets: 'Approve the tickets', build: '', review: 'Accept the review', done: '' }
const APPROVE: Record<Exclude<WorkflowStage, 'done'>, string> = {
  grill: 'Approve and write the spec',
  spec: 'Approve and build',
  tickets: 'Approve and build',
  build: 'Approve and review',
  review: 'Accept and finish'
}
const GATE_TITLE: Record<Exclude<WorkflowStage, 'done'>, string> = { grill: 'Grilling done', spec: 'Approve the spec and tickets', tickets: 'Approve the tickets', build: 'Build done', review: 'Accept the review' }

const BTN = 'h-8 rounded-[9px] px-3 text-[12.5px] transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi'
const PRIMARY = clsx(BTN, 'bg-crimson font-semibold text-white hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim disabled:opacity-100')
const SECONDARY = clsx(BTN, 'border border-line-strong text-fg hover:bg-elev-2')
const GHOST = clsx(BTN, 'text-muted hover:bg-elev-2 hover:text-fg')
const CARD = 'mb-2 rounded-[14px] border border-crimson-line bg-[linear-gradient(var(--color-crimson-soft),transparent_60%)] px-4 py-3.5'

/** Where a stage sits on its route: 0-based, for "stage n of N". */
export const stageIndex = (s: WorkflowStage, route?: WorkflowRoute | null) => Math.max(0, routeStages(route).indexOf(s as Exclude<WorkflowStage, 'done'>))

/** A grilling round: each question with the recommended answer; answered ones go back as one message. */
export function RoundCard({ round, actionable, onAnswer }: { round: QuestionRound; actionable: boolean; onAnswer(text: string): Promise<void> }) {
  const [picked, setPicked] = useState<Record<number, 'yes' | 'other' | undefined>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const send = async (all = false) => {
    const lines = round.questions.map((q, i) => {
      const p = all ? 'yes' : picked[i]
      if (p === 'other' && other[i]?.trim()) return `Q${i + 1} (${q.title}): ${other[i].trim()}`
      if (p === 'yes') return `Q${i + 1} (${q.title}): yes, ${q.recommendation}`
      return null
    })
    if (!all && lines.some((l) => !l)) {
      setError('Answer every question, or accept all the recommendations.')
      return
    }
    setBusy(true)
    try {
      await onAnswer(lines.join('\n'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={CARD}>
      <h4 className="mb-0.5 flex items-center gap-2 text-[13.5px] font-semibold">
        <ListBullets size={15} weight="bold" className="shrink-0 text-crimson-hi" aria-hidden="true" />
        Questions · round {round.round}
      </h4>
      <p className="mb-1 text-[12.5px] text-dim">Each has my recommendation; “Yes” accepts it.</p>
      {round.questions.map((q, i) => (
        <div key={i} className={clsx('grid grid-cols-[24px_minmax(0,1fr)] gap-2 py-3', i > 0 && 'border-t border-line')}>
          <span className="pt-px text-[12px] font-semibold text-dim">Q{i + 1}</span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">{q.title}</div>
            {q.context && <p className="mb-2 mt-0.5 text-[13px] text-muted">{q.context}</p>}
            <div className="mt-1 flex gap-2 rounded-[9px] border border-line bg-panel px-2.5 py-1.5 text-[13px]">
              <span className="shrink-0 text-dim">Recommended</span>
              <span className="selectable min-w-0">{q.recommendation}</span>
            </div>
            {actionable && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button type="button" aria-pressed={picked[i] === 'yes'} onClick={() => (setPicked({ ...picked, [i]: picked[i] === 'yes' ? undefined : 'yes' }), setError(null))} className={clsx(BTN, 'border', picked[i] === 'yes' ? 'border-ok bg-ok/10 text-fg' : 'border-line-strong text-muted hover:bg-elev-2 hover:text-fg')}>
                  Yes
                </button>
                <button type="button" aria-pressed={picked[i] === 'other'} onClick={() => (setPicked({ ...picked, [i]: 'other' }), setError(null))} className={clsx(BTN, 'border', picked[i] === 'other' ? 'border-warn bg-warn/10 text-fg' : 'border-line-strong text-muted hover:bg-elev-2 hover:text-fg')}>
                  Something else…
                </button>
                {picked[i] === 'other' && (
                  <input
                    autoFocus
                    aria-label={`Your answer to question ${i + 1}`}
                    placeholder="Your answer…"
                    value={other[i] ?? ''}
                    onChange={(e) => setOther({ ...other, [i]: e.target.value })}
                    className="h-8 min-w-[200px] flex-1 rounded-[9px] border border-line-strong bg-bg px-2.5 text-[12.5px] outline-none focus:border-crimson-line"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      {actionable && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="mr-auto text-[12px] text-dim">{error ? <span className="text-danger-hi" role="alert">{error}</span> : round.recorded}</span>
          <button type="button" disabled={busy} onClick={() => void send(true)} className={SECONDARY}>
            Accept all
          </button>
          <button type="button" disabled={busy} onClick={() => void send()} className={PRIMARY}>
            Send answers
          </button>
        </div>
      )}
      {!actionable && round.recorded && <p className="border-t border-line pt-2 text-[12px] text-dim">{round.recorded}</p>}
    </div>
  )
}

/** A route's badge: Quick, Standard or Preserve. */
export function RouteBadge({ route }: { route: WorkflowRoute }) {
  return <span className="inline-flex h-[18px] items-center rounded-[5px] border border-mode-line bg-mode-soft px-1.5 text-[11px] font-semibold text-mode">{ROUTE_LABEL[route]}</span>
}

/** A finished stage waiting for the person's OK, with what it produced: the spec itself, the tickets as a board, or the review's findings to pick from. */
export function StageGateCard({
  gate,
  actionable,
  onApprove,
  onRevise,
  onFix,
  flow,
  onAutoContinue,
  docs
}: {
  gate: StageGate
  actionable: boolean
  onApprove(): Promise<void>
  onRevise(): void
  /** Send the chosen review findings back to be fixed. */
  onFix?(text: string): Promise<void>
  /** The chat's workflow now, for the route and whether Build goes straight on to Review. */
  flow?: SpecWorkflow | null
  onAutoContinue?(on: boolean): void
  /** The chat's folder and feature, to show the documents this stage wrote. */
  docs?: { sessionId: string; slug: string | null; version: number; active: ReadonlySet<string>; finished: ReadonlySet<string> }
}) {
  const [busy, setBusy] = useState(false)
  const route = gate.route ?? flow?.route
  const quick = route === 'quick'
  const wants = gate.stage !== 'review'
  const loaded = useSpecDocs(wants ? (docs?.sessionId ?? null) : null, docs?.slug ?? null, docs?.version ?? 0)
  // The proposed UI comes with the grilling; it's still there to compare while approving the spec.
  const showMockup = (gate.stage === 'grill' || gate.stage === 'spec') && !!loaded.mockup && !!docs
  // The Quick route writes its spec while grilling, so that stop shows it.
  const showSpec = (gate.stage === 'spec' || (gate.stage === 'grill' && quick)) && !!loaded.spec
  const showBoard = (gate.stage === 'spec' || gate.stage === 'tickets' || gate.stage === 'build') && loaded.tickets.length > 0
  const { bullets, assumed, unverified } = splitSummary(gate.summary)
  const findings = gate.stage === 'review' ? (gate.findings ?? []) : []
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set(findings.flatMap((f, i) => (f.fix ? [i] : []))))
  // The last stop before Build is where you decide whether Build waits for you once it's done.
  const beforeBuild = gate.stage === (quick ? 'grill' : 'spec')
  const autoContinue = flow?.autoContinue !== false
  const go = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={CARD}>
      <h4 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold">
        <ListChecks size={15} weight="fill" className="shrink-0 text-crimson-hi" aria-hidden="true" />
        {gate.stage === 'grill' && quick ? 'Grilling and spec done' : GATE_TITLE[gate.stage]}
        {gate.stage === 'grill' && route && <RouteBadge route={route} />}
      </h4>
      {bullets.length > 0 && (
        <ul className="mb-3 list-disc space-y-0.5 pl-[18px] text-[13px] leading-relaxed text-muted marker:text-dim">
          {bullets.map((s, i) => (
            <li key={i} className="selectable">
              {s}
            </li>
          ))}
        </ul>
      )}
      {findings.length > 0 && (
        <div className="mb-3 grid grid-cols-2 gap-2.5 mobile:grid-cols-1">
          {(['standards', 'spec'] as const).map((axis) => (
            <div key={axis} className="min-w-0 rounded-[10px] border border-line bg-panel">
              <h5 className="border-b border-line px-2.5 py-1.5 text-[12px] font-semibold text-muted">{axis === 'standards' ? 'Standards' : 'Spec'}</h5>
              {findings.every((f) => f.axis !== axis) && <p className="px-2.5 py-2 text-[12.5px] text-dim">No findings</p>}
              {findings.map((f, i) =>
                f.axis !== axis ? null : (
                  <label key={i} className={clsx('flex gap-2 px-2.5 py-2 text-[12.5px] [&+&]:border-t [&+&]:border-line', actionable && 'cursor-pointer')}>
                    <input
                      type="checkbox"
                      disabled={!actionable}
                      checked={picked.has(i)}
                      onChange={() => setPicked((p) => (p.has(i) ? new Set([...p].filter((x) => x !== i)) : new Set([...p, i])))}
                      className="mt-0.5 size-[14px] shrink-0 accent-crimson"
                    />
                    <span className="selectable min-w-0">
                      <span className={clsx('mr-1.5 inline-block rounded-[4px] border px-1 text-[10.5px] font-semibold', f.fix ? 'border-danger-line bg-danger-soft text-danger-hi' : 'border-line-strong text-dim')}>{f.fix ? 'Fix before ship' : 'Optional'}</span>
                      {f.title}
                      {f.where && <span className="mt-0.5 block font-mono text-[11px] text-dim">{f.where}</span>}
                    </span>
                  </label>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {(assumed !== null || unverified !== null) && (
        <dl className="mb-3 rounded-[10px] border border-line bg-panel text-[12.5px]">
          {assumed !== null && (
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2.5 px-2.5 py-1.5">
              <dt className="text-dim">Assumed</dt>
              <dd className={clsx('selectable', isNothing(assumed) ? 'text-dim' : 'text-fg')}>{assumed}</dd>
            </div>
          )}
          {unverified !== null && (
            <div className={clsx('grid grid-cols-[88px_minmax(0,1fr)] gap-2.5 px-2.5 py-1.5', assumed !== null && 'border-t border-line')}>
              <dt className={isNothing(unverified) ? 'text-dim' : 'text-warn'}>Unverified</dt>
              <dd className={clsx('selectable', isNothing(unverified) ? 'text-dim' : 'text-fg')}>{unverified}</dd>
            </div>
          )}
        </dl>
      )}
      {showMockup && loaded.mockup && docs && <MockupPreview sessionId={docs.sessionId} doc={loaded.mockup} compact={gate.stage === 'spec'} />}
      {showSpec && loaded.spec && <SpecPreview doc={loaded.spec} />}
      {showBoard && (
        <div className="mb-3">
          <TicketBoard tickets={loaded.tickets} active={docs?.active ?? NONE} finished={docs?.finished ?? NONE} compact />
        </div>
      )}
      {!showSpec && !showBoard && !showMockup && gate.files?.length ? (
        <p className="mb-3 truncate font-mono text-[11.5px] text-dim" title={gate.files.join('\n')}>
          {gate.files.join(' · ')}
        </p>
      ) : null}
      {actionable && beforeBuild && onAutoContinue && (
        <label className="mb-3 flex cursor-pointer items-start gap-2 text-[12.5px] text-muted">
          <input type="checkbox" checked={autoContinue} onChange={(e) => onAutoContinue(e.target.checked)} className="mt-0.5 size-[14px] shrink-0 accent-crimson" />
          <span>
            Go on without stopping when nothing needs me
            <span className="block text-dim">Build goes straight to Review, and a review with nothing to fix finishes the workflow. You’ll still see every result.</span>
          </span>
        </label>
      )}
      {actionable && (
        <div className="flex flex-wrap items-center gap-2">
          {findings.length > 0 && onFix && (
            <>
              <span className="mr-auto text-[12px] text-dim">
                {picked.size} of {findings.length} ticked
              </span>
              <button type="button" disabled={busy || picked.size === 0} onClick={() => void go(() => onFix(fixMessage(findings.filter((_, i) => picked.has(i)))))} className={PRIMARY}>
                Fix {picked.size} finding{picked.size === 1 ? '' : 's'}
              </button>
            </>
          )}
          <button type="button" disabled={busy} onClick={() => void go(onApprove)} className={findings.length > 0 && onFix ? SECONDARY : PRIMARY}>
            {gate.stage === 'grill' && quick ? 'Approve and build' : APPROVE[gate.stage]}
          </button>
          <button type="button" disabled={busy} onClick={onRevise} className={findings.length > 0 && onFix ? GHOST : SECONDARY}>
            Change something…
          </button>
        </div>
      )}
    </div>
  )
}

const NONE: ReadonlySet<string> = new Set()

/**
 * The proposed UI (docs/specs/<slug>/mockup.html), drawn in a sandboxed frame: no scripts, no access to
 * the app. It inherits the app's content rules, so external fonts and images don't load; the full page
 * opens in the browser.
 */
export function MockupPreview({ sessionId, doc, compact, fill }: { sessionId: string; doc: DocFile; compact?: boolean; fill?: boolean }) {
  return (
    <div className={clsx('flex flex-col overflow-hidden rounded-[12px] border border-line bg-panel', fill ? 'h-full min-h-[320px]' : 'mb-3')}>
      <div className="flex items-center gap-2 border-b border-line py-1 pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-dim">{doc.path}</span>
        <button
          type="button"
          onClick={() => void api.panel.open(sessionId, doc.path).catch(() => undefined)}
          className="h-7 shrink-0 rounded-[8px] px-2.5 text-[12px] text-muted hover:bg-elev-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi"
        >
          Open in browser
        </button>
      </div>
      <iframe title="Proposed UI" sandbox="" srcDoc={doc.text} className={clsx('w-full bg-white', fill ? 'min-h-0 flex-1' : compact ? 'h-[280px]' : 'h-[460px]')} />
    </div>
  )
}

/** The spec, inline: the first part shown, the rest a click away. */
function SpecPreview({ doc }: { doc: { path: string; text: string } }) {
  const [all, setAll] = useState(false)
  return (
    <div className="mb-3 overflow-hidden rounded-[12px] border border-line bg-panel">
      <div className="truncate border-b border-line px-3 py-1.5 font-mono text-[11.5px] text-dim">{doc.path}</div>
      <div className={clsx('relative px-4 pt-2 text-[13px]', !all && 'max-h-[360px] overflow-hidden')}>
        <Markdown text={doc.text} />
        {!all && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-panel" />}
      </div>
      <button
        type="button"
        onClick={() => setAll(!all)}
        aria-expanded={all}
        className="w-full border-t border-line px-3 py-2 text-left text-[12.5px] text-muted hover:bg-elev-2 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi"
      >
        {all ? 'Show less' : 'Show the whole spec'}
      </button>
    </div>
  )
}

const COLUMNS: { id: TicketStatus; label: string }[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' }
]

/** Tickets as a board: numbered cards in To do / In progress / Done; a card opens its ticket. */
export function TicketBoard({ tickets, active, finished = NONE, compact }: { tickets: Ticket[]; active: ReadonlySet<string>; finished?: ReadonlySet<string>; compact?: boolean }) {
  const [open, setOpen] = useState<Ticket | null>(null)
  const byCol = (c: TicketStatus) => tickets.filter((t) => ticketStatus(t, active, finished) === c).sort((a, b) => a.n.localeCompare(b.n))
  return (
    <>
      <div className={clsx('grid gap-2', compact ? 'grid-cols-3 mobile:grid-cols-1' : 'grid-cols-1')}>
        {COLUMNS.map((c) => {
          const list = byCol(c.id)
          return (
            <section key={c.id} aria-label={c.label} className="min-w-0 rounded-[12px] border border-line bg-bg/60 p-1.5">
              <h5 className="flex items-center gap-1.5 px-1.5 pb-1.5 pt-0.5 text-[12px] font-semibold text-muted">
                <span aria-hidden="true" className={clsx('h-2 w-2 rounded-full', c.id === 'done' ? 'bg-ok' : c.id === 'doing' ? 'bg-warn' : 'border border-line-strong')} />
                {c.label}
                <span className="font-normal tabular-nums text-dim">{list.length}</span>
              </h5>
              <div className="grid gap-1.5">
                {list.map((t) => (
                  <button
                    key={t.path}
                    type="button"
                    onClick={() => setOpen(t)}
                    className="grid gap-1 rounded-[10px] border border-line bg-panel px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi"
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="shrink-0 font-mono text-[11px] text-dim">#{t.n}</span>
                      <span className="min-w-0 text-[12.5px] font-medium leading-snug">{t.title}</span>
                    </span>
                    <span className="flex items-center gap-2 text-[11px] text-dim">
                      <span>{t.blockedBy.length ? `after ${t.blockedBy.map((b) => `#${b}`).join(', ')}` : 'can start now'}</span>
                      {t.total > 0 && (
                        <span className="ml-auto tabular-nums" title={`${t.done} of ${t.total} acceptance criteria met`}>
                          {t.done}/{t.total}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
                {!list.length && <p className="px-1.5 pb-1 text-[11.5px] text-dim">None</p>}
              </div>
            </section>
          )
        })}
      </div>
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        width={620}
        title={
          open ? (
            <span>
              <span className="mr-2 font-mono text-[12px] text-dim">#{open.n}</span>
              {open.title}
            </span>
          ) : (
            ''
          )
        }
      >
        {open && (
          <div className="text-[13px]">
            <p className="mb-2 font-mono text-[11.5px] text-dim">{open.path}</p>
            <Markdown text={open.text} />
          </div>
        )}
      </Modal>
    </>
  )
}

/** The line where a stage starts: a divider, then what the person said (their idea, or the approval). */
export function StageDivider({ message, fresh, route }: { message: UiMessage; fresh: boolean; route?: WorkflowRoute | null }) {
  const stage = message.workflowStage!
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
  const isIdea = stage === 'grill' && text && text !== 'Started Spec → Ship'
  return (
    <motion.div initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} className="mb-7">
      {isIdea && <div className="selectable mb-6 ml-auto w-fit max-w-[80%] whitespace-pre-wrap rounded-2xl border border-line bg-elev px-3.5 py-2.5">{text}</div>}
      <div className="flex items-center gap-3 text-[12px] text-dim" role="separator" aria-label={`Spec → Ship: ${STAGE_LABEL[stage]}`}>
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line-strong" />
        <span className="flex items-center gap-1.5">
          {stage !== 'grill' && <CheckCircle size={13} weight="fill" className="text-ok" aria-hidden="true" />}
          {stage !== 'grill' && <span>{text} ·</span>}
          <b className="font-semibold text-mode">{STAGE_LABEL[stage]}</b>
          {stage !== 'done' && <span className="tabular-nums">· stage {stageIndex(stage, route) + 1} of {routeStages(route).length}</span>}
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line-strong" />
      </div>
    </motion.div>
  )
}

type DocFile = { path: string; text: string }

/** The workflow's documents in the chat's folder: glossary, decision records, the spec and its tickets. */
export function useSpecDocs(sessionId: string | null, slug: string | null, version: number) {
  const [docs, setDocs] = useState<{ glossary: DocFile | null; adrs: DocFile[]; mockup: DocFile | null; spec: DocFile | null; tickets: Ticket[] }>({ glossary: null, adrs: [], mockup: null, spec: null, tickets: [] })
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const list = (dir: string) => api.panel.list(sessionId, dir).catch(() => [])
    const read = async (path: string): Promise<DocFile> => ({ path, text: (await api.panel.read(sessionId, path).catch(() => null))?.text ?? '' })
    void (async () => {
      const root = await list('')
      const glossaryPath = root.find((e) => e.name === 'GLOSSARY.md')?.path
      const adrPaths = (await list('docs/adr')).filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.path)
      const feature = slug ? await list(`docs/specs/${slug}`) : []
      const specPath = feature.find((e) => e.name === 'spec.md')?.path
      const mockupPath = feature.find((e) => e.name === 'mockup.html')?.path
      const ticketPaths = slug ? (await list(`docs/specs/${slug}/tickets`)).filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.path) : []
      const [glossary, adrs, mockup, spec, tickets] = await Promise.all([
        glossaryPath ? read(glossaryPath) : null,
        Promise.all(adrPaths.map(read)),
        mockupPath ? read(mockupPath) : null,
        specPath ? read(specPath) : null,
        Promise.all(ticketPaths.map(async (p) => {
          const d = await read(p)
          return parseTicket(d.path, d.text)
        }))
      ])
      if (!cancelled) setDocs({ glossary, adrs, mockup, spec, tickets })
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, slug, version])
  return docs
}

type DocTab = 'glossary' | 'decisions' | 'mockup' | 'spec' | 'tickets'

/** The side panel's Spec tab: the workflow's documents, read from the chat's folder; tickets as a board. */
export function SpecPanel({ sessionId, workflow, version, active, finished }: { sessionId: string; workflow: SpecWorkflow | null | undefined; version: number; active?: ReadonlySet<string>; finished?: ReadonlySet<string> }) {
  const docs = useSpecDocs(workflow ? sessionId : null, workflow?.slug ?? null, version)
  const [tab, setTab] = useState<DocTab>('glossary')
  // Every tab stays clickable (an empty one says so); the count is only a hint, and a glossary in another format counts as written.
  const tabs: { id: DocTab; label: string; count: number }[] = [
    { id: 'glossary', label: 'Glossary', count: docs.glossary?.text.trim() ? Math.max(1, docs.glossary.text.match(/^\s*(?:[-*]\s+)?\*\*[^*]+\*\*/gm)?.length ?? 0) : 0 },
    { id: 'decisions', label: 'Decisions', count: docs.adrs.length },
    ...(docs.mockup ? [{ id: 'mockup' as const, label: 'Mockup', count: 1 }] : []),
    { id: 'spec', label: 'Spec', count: docs.spec ? 1 : 0 },
    { id: 'tickets', label: 'Tickets', count: docs.tickets.length }
  ]
  if (!workflow) return <p className="px-4 py-6 text-[12.5px] text-dim">This chat isn’t running Spec → Ship. Start it from the mode menu in the message box.</p>
  const shown: DocFile[] = tab === 'glossary' ? (docs.glossary ? [docs.glossary] : []) : tab === 'decisions' ? docs.adrs : tab === 'spec' ? (docs.spec ? [docs.spec] : []) : []
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Spec documents" className="flex flex-wrap gap-0.5 px-3 pb-1.5 pt-2.5">
        {tabs.map((d) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={tab === d.id}
            onClick={() => setTab(d.id)}
            className={clsx('flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px]', tab === d.id ? 'bg-elev-2 font-semibold text-fg' : d.count ? 'text-muted hover:text-fg' : 'text-dim hover:text-muted')}
          >
            {d.label}
            {d.count > 0 && d.id !== 'spec' && d.id !== 'mockup' && <span className="text-[11px] tabular-nums text-dim">{d.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 text-[13px]">
        {tab === 'mockup' && docs.mockup ? (
          <div className="h-full pt-1">
            <MockupPreview sessionId={sessionId} doc={docs.mockup} fill />
          </div>
        ) : tab === 'tickets' ? (
          docs.tickets.length ? (
            <TicketBoard tickets={docs.tickets} active={active ?? NONE} finished={finished ?? NONE} />
          ) : (
            <p className="px-1 py-4 text-[12.5px] text-dim">Not written yet.</p>
          )
        ) : !shown.length ? (
          <p className="px-1 py-4 text-[12.5px] text-dim">Not written yet.</p>
        ) : (
          shown.map((f) => (
            <section key={f.path} className="mb-4 px-1">
              <div className="mb-1.5 mt-2 font-mono text-[11.5px] text-dim">{f.path}</div>
              <Markdown text={f.text} />
            </section>
          ))
        )}
      </div>
    </div>
  )
}
