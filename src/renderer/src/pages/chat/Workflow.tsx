import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import { CheckCircle, ListChecks, ListBullets } from '@phosphor-icons/react'
import type { QuestionRound, SpecWorkflow, StageGate, UiMessage, WorkflowStage } from '@shared/types'
import { WORKFLOW_STAGES } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { api } from '@/lib/api'
import { parseTicket, ticketStatus, type Ticket, type TicketStatus } from '@/lib/tickets'
import { Modal } from '@/components/ui'

export const STAGE_LABEL: Record<WorkflowStage, string> = { grill: 'Grill', spec: 'Spec', tickets: 'Tickets', build: 'Build', review: 'Review', done: 'Done' }
/** What the person does at the end of each stage (none for Build: it runs on its own). */
export const STAGE_YOU: Record<WorkflowStage, string> = { grill: 'Answer the questions', spec: 'Approve the spec', tickets: 'Approve the tickets', build: '', review: 'Accept the review', done: '' }
const APPROVE: Record<Exclude<WorkflowStage, 'done'>, string> = {
  grill: 'Approve and write the spec',
  spec: 'Approve and make tickets',
  tickets: 'Approve and build',
  build: 'Approve and review',
  review: 'Accept and finish'
}
const GATE_TITLE: Record<Exclude<WorkflowStage, 'done'>, string> = { grill: 'Grilling done', spec: 'Approve the spec', tickets: 'Approve the tickets', build: 'Build done', review: 'Accept the review' }

const BTN = 'h-8 rounded-[9px] px-3 text-[12.5px] transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-crimson-hi'
const PRIMARY = clsx(BTN, 'bg-crimson font-semibold text-white hover:bg-crimson-hi')
const SECONDARY = clsx(BTN, 'border border-line-strong text-fg hover:bg-elev-2')
const CARD = 'mb-2 rounded-[14px] border border-crimson-line bg-[linear-gradient(var(--color-crimson-soft),transparent_60%)] px-4 py-3.5'

/** Where a stage sits: 1-based position for "stage n of 5". */
export const stageIndex = (s: WorkflowStage) => Math.max(0, WORKFLOW_STAGES.indexOf(s as (typeof WORKFLOW_STAGES)[number]))

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
          <span className="mr-auto text-[12px] text-dim">{error ? <span className="text-crimson-hi" role="alert">{error}</span> : round.recorded}</span>
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

/** A finished stage waiting for the person's OK, with what it produced: the spec itself, or the tickets as a board. */
export function StageGateCard({
  gate,
  actionable,
  onApprove,
  onRevise,
  docs
}: {
  gate: StageGate
  actionable: boolean
  onApprove(): Promise<void>
  onRevise(): void
  /** The chat's folder and feature, to show the documents this stage wrote. */
  docs?: { sessionId: string; slug: string | null; version: number; active: ReadonlySet<string> }
}) {
  const [busy, setBusy] = useState(false)
  const wants = gate.stage === 'spec' || gate.stage === 'tickets' || gate.stage === 'build'
  const loaded = useSpecDocs(wants ? (docs?.sessionId ?? null) : null, docs?.slug ?? null, docs?.version ?? 0)
  const showSpec = gate.stage === 'spec' && !!loaded.spec
  const showBoard = (gate.stage === 'tickets' || gate.stage === 'build') && loaded.tickets.length > 0
  return (
    <div className={CARD}>
      <h4 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold">
        <ListChecks size={15} weight="fill" className="shrink-0 text-crimson-hi" aria-hidden="true" />
        {GATE_TITLE[gate.stage]}
      </h4>
      <ul className="mb-3 list-disc space-y-0.5 pl-[18px] text-[13px] leading-relaxed text-muted marker:text-dim">
        {gate.summary.map((s, i) => (
          <li key={i} className="selectable">
            {s}
          </li>
        ))}
      </ul>
      {showSpec && loaded.spec && <SpecPreview doc={loaded.spec} />}
      {showBoard && (
        <div className="mb-3">
          <TicketBoard tickets={loaded.tickets} active={docs?.active ?? NONE} compact />
        </div>
      )}
      {!showSpec && !showBoard && gate.files?.length ? (
        <p className="mb-3 truncate font-mono text-[11.5px] text-dim" title={gate.files.join('\n')}>
          {gate.files.join(' · ')}
        </p>
      ) : null}
      {actionable && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onApprove()
              } finally {
                setBusy(false)
              }
            }}
            className={PRIMARY}
          >
            {APPROVE[gate.stage]}
          </button>
          <button type="button" disabled={busy} onClick={onRevise} className={SECONDARY}>
            Change something…
          </button>
        </div>
      )}
    </div>
  )
}

const NONE: ReadonlySet<string> = new Set()

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
export function TicketBoard({ tickets, active, compact }: { tickets: Ticket[]; active: ReadonlySet<string>; compact?: boolean }) {
  const [open, setOpen] = useState<Ticket | null>(null)
  const byCol = (c: TicketStatus) => tickets.filter((t) => ticketStatus(t, active) === c).sort((a, b) => a.n.localeCompare(b.n))
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
export function StageDivider({ message, fresh }: { message: UiMessage; fresh: boolean }) {
  const stage = message.workflowStage!
  const text = message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
  const isIdea = stage === 'grill' && text && text !== 'Started Spec → ship'
  return (
    <motion.div initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} className="mb-7">
      {isIdea && <div className="selectable mb-6 ml-auto w-fit max-w-[80%] whitespace-pre-wrap rounded-2xl border border-line bg-elev px-3.5 py-2.5">{text}</div>}
      <div className="flex items-center gap-3 text-[12px] text-dim" role="separator" aria-label={`Spec → ship: ${STAGE_LABEL[stage]}`}>
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line-strong" />
        <span className="flex items-center gap-1.5">
          {stage !== 'grill' && <CheckCircle size={13} weight="fill" className="text-ok" aria-hidden="true" />}
          {stage !== 'grill' && <span>{text} ·</span>}
          <b className="font-semibold text-mode">{STAGE_LABEL[stage]}</b>
          {stage !== 'done' && <span className="tabular-nums">· stage {stageIndex(stage) + 1} of 5</span>}
        </span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line-strong" />
      </div>
    </motion.div>
  )
}

type DocFile = { path: string; text: string }

/** The workflow's documents in the chat's folder: glossary, decision records, the spec and its tickets. */
export function useSpecDocs(sessionId: string | null, slug: string | null, version: number) {
  const [docs, setDocs] = useState<{ glossary: DocFile | null; adrs: DocFile[]; spec: DocFile | null; tickets: Ticket[] }>({ glossary: null, adrs: [], spec: null, tickets: [] })
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const list = (dir: string) => api.panel.list(sessionId, dir).catch(() => [])
    const read = async (path: string): Promise<DocFile> => ({ path, text: (await api.panel.read(sessionId, path).catch(() => null))?.text ?? '' })
    void (async () => {
      const root = await list('')
      const glossaryPath = root.find((e) => e.name === 'GLOSSARY.md')?.path
      const adrPaths = (await list('docs/adr')).filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.path)
      const specPath = slug ? (await list(`docs/specs/${slug}`)).find((e) => e.name === 'spec.md')?.path : undefined
      const ticketPaths = slug ? (await list(`docs/specs/${slug}/tickets`)).filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.path) : []
      const [glossary, adrs, spec, tickets] = await Promise.all([
        glossaryPath ? read(glossaryPath) : null,
        Promise.all(adrPaths.map(read)),
        specPath ? read(specPath) : null,
        Promise.all(ticketPaths.map(async (p) => {
          const d = await read(p)
          return parseTicket(d.path, d.text)
        }))
      ])
      if (!cancelled) setDocs({ glossary, adrs, spec, tickets })
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, slug, version])
  return docs
}

type DocTab = 'glossary' | 'decisions' | 'spec' | 'tickets'

/** The side panel's Spec tab: the workflow's documents, read from the chat's folder; tickets as a board. */
export function SpecPanel({ sessionId, workflow, version, active }: { sessionId: string; workflow: SpecWorkflow | null | undefined; version: number; active?: ReadonlySet<string> }) {
  const docs = useSpecDocs(workflow ? sessionId : null, workflow?.slug ?? null, version)
  const [tab, setTab] = useState<DocTab>('glossary')
  const tabs: { id: DocTab; label: string; count: number }[] = [
    { id: 'glossary', label: 'Glossary', count: docs.glossary?.text.match(/^\*\*[^*]+\*\*:/gm)?.length ?? 0 },
    { id: 'decisions', label: 'Decisions', count: docs.adrs.length },
    { id: 'spec', label: 'Spec', count: docs.spec ? 1 : 0 },
    { id: 'tickets', label: 'Tickets', count: docs.tickets.length }
  ]
  if (!workflow) return <p className="px-4 py-6 text-[12.5px] text-dim">This chat isn’t running Spec → ship. Start it from the mode menu in the message box.</p>
  const shown: DocFile[] = tab === 'glossary' ? (docs.glossary ? [docs.glossary] : []) : tab === 'decisions' ? docs.adrs : tab === 'spec' ? (docs.spec ? [docs.spec] : []) : []
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Spec documents" className="flex flex-wrap gap-0.5 px-3 pb-1.5 pt-2.5">
        {tabs.map((d) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={tab === d.id}
            disabled={!d.count}
            onClick={() => setTab(d.id)}
            className={clsx('flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] disabled:opacity-40', tab === d.id ? 'bg-elev-2 font-semibold text-fg' : 'text-muted hover:text-fg')}
          >
            {d.label}
            {d.count > 0 && d.id !== 'spec' && <span className="text-[11px] tabular-nums text-dim">{d.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 text-[13px]">
        {tab === 'tickets' ? (
          docs.tickets.length ? (
            <TicketBoard tickets={docs.tickets} active={active ?? NONE} />
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
