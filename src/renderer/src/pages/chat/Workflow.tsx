import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import { CheckCircle, ListChecks, ListBullets } from '@phosphor-icons/react'
import type { QuestionRound, SpecWorkflow, StageGate, UiMessage, WorkflowStage } from '@shared/types'
import { WORKFLOW_STAGES } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { api } from '@/lib/api'

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

/** A finished stage waiting for the person's OK. */
export function StageGateCard({ gate, actionable, onApprove, onRevise }: { gate: StageGate; actionable: boolean; onApprove(): Promise<void>; onRevise(): void }) {
  const [busy, setBusy] = useState(false)
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
      {gate.files?.length ? <p className="mb-3 truncate font-mono text-[11.5px] text-dim" title={gate.files.join('\n')}>{gate.files.join(' · ')}</p> : null}
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

type Doc = { id: 'glossary' | 'decisions' | 'spec' | 'tickets'; label: string; files: string[] }

/** The side panel's Spec tab: the workflow's documents, read from the chat's folder. */
export function SpecPanel({ sessionId, workflow, version }: { sessionId: string; workflow: SpecWorkflow | null | undefined; version: number }) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [tab, setTab] = useState<Doc['id']>('glossary')
  const [texts, setTexts] = useState<Record<string, string>>({})
  const slug = workflow?.slug ?? null
  useEffect(() => {
    let cancelled = false
    const list = (dir: string) => api.panel.list(sessionId, dir).catch(() => [])
    void (async () => {
      const root = await list('')
      const adr = (await list('docs/adr')).filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.path)
      const tickets = slug ? (await list(`docs/specs/${slug}/tickets`)).filter((e) => !e.dir && e.name.endsWith('.md')).map((e) => e.path) : []
      const spec = slug ? (await list(`docs/specs/${slug}`)).filter((e) => e.name === 'spec.md').map((e) => e.path) : []
      const next: Doc[] = [
        { id: 'glossary', label: 'Glossary', files: root.filter((e) => e.name === 'GLOSSARY.md').map((e) => e.path) },
        { id: 'decisions', label: 'Decisions', files: adr },
        { id: 'spec', label: 'Spec', files: spec },
        { id: 'tickets', label: 'Tickets', files: tickets }
      ]
      const read = await Promise.all(next.flatMap((d) => d.files).map(async (f) => [f, (await api.panel.read(sessionId, f).catch(() => null))?.text ?? ''] as const))
      if (cancelled) return
      setDocs(next)
      setTexts(Object.fromEntries(read))
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, slug, version])
  const current = docs.find((d) => d.id === tab)
  const count = (d: Doc) => (d.id === 'glossary' ? (texts[d.files[0]]?.match(/^\*\*[^*]+\*\*:/gm)?.length ?? 0) : d.files.length)
  const shown = useMemo(() => current?.files ?? [], [current])
  if (!workflow) return <p className="px-4 py-6 text-[12.5px] text-dim">This chat isn’t running Spec → ship. Start it from the permissions menu in the message box.</p>
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Spec documents" className="flex flex-wrap gap-0.5 px-3 pb-1.5 pt-2.5">
        {docs.map((d) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={tab === d.id}
            disabled={!d.files.length}
            onClick={() => setTab(d.id)}
            className={clsx('flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] disabled:opacity-40', tab === d.id ? 'bg-elev-2 font-semibold text-fg' : 'text-muted hover:text-fg')}
          >
            {d.label}
            {d.files.length > 0 && <span className="text-[11px] tabular-nums text-dim">{count(d)}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 text-[13px]">
        {!shown.length ? (
          <p className="py-4 text-[12.5px] text-dim">Not written yet.</p>
        ) : (
          shown.map((f) => (
            <section key={f} className="mb-4">
              <div className="mb-1.5 mt-2 font-mono text-[11.5px] text-dim">{f}</div>
              <Markdown text={texts[f] ?? ''} />
            </section>
          ))
        )}
      </div>
    </div>
  )
}
