import { useState } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import { ChatCircleDots, Check, PaperPlaneRight } from '@phosphor-icons/react'
import type { PendingQuestion } from '@shared/types'

/** Inline question from the agent (`ask_user`): pick an option, type an answer, or skip. */
export function QuestionCard({ question, onAnswer }: { question: PendingQuestion; onAnswer(answer: string | null): Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [other, setOther] = useState('')
  const send = async (answer: string | null) => {
    setBusy(true)
    try {
      await onAnswer(answer)
    } finally {
      setBusy(false)
    }
  }
  const multiAnswer = [...picked, other.trim()].filter(Boolean).join(', ')
  const submitTyped = () => {
    if (question.multiple) {
      if (multiAnswer) void send(multiAnswer)
    } else if (other.trim()) void send(other.trim())
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 28 }}
      className="mb-4 ml-11 overflow-hidden rounded-[14px] border border-crimson-line bg-panel shadow-[0_0_0_4px_rgb(220_38_69/0.06)] mobile:ml-0"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-elev-2 text-muted">
          <ChatCircleDots size={15} weight="fill" />
        </span>
        <span className="flex-1 text-ui font-semibold">Question for you</span>
        <span className="flex items-center gap-1 rounded-full bg-crimson-soft px-2 py-0.5 text-micro font-medium text-crimson-text">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-crimson-hi" />
          waiting for your answer
        </span>
      </div>
      <div className="space-y-3 p-3">
        <div className="selectable whitespace-pre-wrap text-body leading-relaxed text-fg">{question.question}</div>
        {question.options.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {question.options.map((o, i) => {
              const on = picked.includes(o)
              return (
                <button
                  key={o}
                  disabled={busy}
                  onClick={() => (question.multiple ? setPicked((p) => (on ? p.filter((x) => x !== o) : [...p, o])) : void send(o))}
                  className={clsx(
                    'flex min-h-9 items-center gap-2.5 rounded-lg border px-3 py-1.5 text-left text-ui transition-colors disabled:opacity-50',
                    on ? 'border-crimson-line bg-elev-2 text-fg' : 'border-line bg-bg text-muted hover:border-line-strong hover:text-fg'
                  )}
                >
                  {question.multiple ? (
                    <span className={clsx('flex h-4 w-4 shrink-0 items-center justify-center rounded border', on ? 'border-crimson bg-crimson text-white' : 'border-line-strong')}>
                      {on && <Check size={10} weight="bold" />}
                    </span>
                  ) : (
                    <span className="w-4 shrink-0 font-mono text-caption text-dim">{i + 1}</span>
                  )}
                  <span className="min-w-0 flex-1">{o}</span>
                </button>
              )
            })}
          </div>
        )}
        {question.allowOther && (
          <div className="flex items-center gap-2">
            <input
              value={other}
              disabled={busy}
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submitTyped()
                }
              }}
              aria-label="Your answer"
              placeholder={question.options.length ? 'Or type your own answer' : 'Type your answer'}
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-ui text-fg outline-none placeholder:text-dim focus:border-crimson-line"
            />
            {!question.multiple && (
              <button
                disabled={busy || !other.trim()}
                onClick={submitTyped}
                title="Send answer"
                aria-label="Send answer"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-crimson text-white transition-colors hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
              >
                <PaperPlaneRight size={14} weight="fill" />
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          {question.multiple && (
            <button
              disabled={busy || !multiAnswer}
              onClick={submitTyped}
              className="h-8 rounded-lg bg-crimson px-3.5 text-ui font-semibold text-white transition-colors hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
            >
              Send answer
            </button>
          )}
          <div className="flex-1" />
          <button
            disabled={busy}
            onClick={() => void send(null)}
            title="Let the agent continue with its best judgement"
            className="h-8 rounded-lg px-2.5 text-caption text-dim transition-colors hover:bg-elev-2 hover:text-muted disabled:opacity-50"
          >
            Skip question
          </button>
        </div>
      </div>
    </motion.div>
  )
}
