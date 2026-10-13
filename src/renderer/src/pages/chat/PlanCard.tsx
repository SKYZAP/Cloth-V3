import { useState } from 'react'
import { motion } from 'motion/react'
import { CheckCircle, ListChecks } from '@phosphor-icons/react'
import type { PlanProposal, UiMessage } from '@shared/types'
import { Markdown } from '@/components/Markdown'

/** A plan the agent presented in Plan mode, with the buttons to approve it while it is the latest word. */
export function PlanCard({ plan, actionable, onApprove, onRevise }: { plan: PlanProposal; actionable: boolean; onApprove(mode: 'auto' | 'manual'): Promise<void>; onRevise(): void }) {
  const [busy, setBusy] = useState(false)
  const approve = async (mode: 'auto' | 'manual') => {
    setBusy(true)
    try {
      await onApprove(mode)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mb-2 rounded-[14px] border border-crimson-line bg-[linear-gradient(var(--color-crimson-soft),transparent_60%)] px-4 py-3.5">
      <h4 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold">
        <ListChecks size={15} weight="fill" className="shrink-0 text-crimson-hi" />
        <span className="min-w-0">Plan: {plan.title}</span>
      </h4>
      <ol className="mb-3 list-decimal space-y-0.5 pl-[18px] text-[13px] leading-relaxed text-muted marker:text-dim">
        {plan.steps.map((s, i) => (
          <li key={i} className="selectable">
            {s}
          </li>
        ))}
      </ol>
      {/* Notes are secondary: Markdown's prose sizes would make them louder than the steps. */}
      {plan.notes && (
        <div className="mb-3 [&_*]:!text-[12.5px] [&_*]:!font-normal [&_*]:!leading-relaxed [&_*]:!text-dim">
          <Markdown text={plan.notes} />
        </div>
      )}
      {actionable && (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => void approve('auto')} className="h-8 rounded-[9px] bg-crimson px-3 text-[12.5px] font-semibold text-white transition-colors hover:bg-crimson-hi disabled:opacity-50">
            Approve and continue in Auto
          </button>
          <button disabled={busy} onClick={() => void approve('manual')} className="h-8 rounded-[9px] border border-line-strong px-3 text-[12.5px] text-fg transition-colors hover:bg-elev-2 disabled:opacity-50">
            Approve, ask before risky actions
          </button>
          <button disabled={busy} onClick={onRevise} className="h-8 rounded-[9px] border border-line-strong px-3 text-[12.5px] text-fg transition-colors hover:bg-elev-2 disabled:opacity-50">
            Change the plan…
          </button>
        </div>
      )}
    </div>
  )
}

/** The user line that approved a plan, kept small: it is a button press, not something typed. */
export function PlanApprovalLine({ message, fresh }: { message: UiMessage; fresh: boolean }) {
  return (
    <motion.div initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} className="mb-7 flex justify-end">
      <span className="flex items-center gap-1.5 rounded-full border border-line bg-elev px-3 py-1 text-[12px] text-muted">
        <CheckCircle size={13} weight="fill" className="text-ok" />
        Approved the plan
        <span className="text-dim">· {message.planApproval === 'manual' ? 'asks before risky actions' : 'continues in Auto'}</span>
      </span>
    </motion.div>
  )
}
