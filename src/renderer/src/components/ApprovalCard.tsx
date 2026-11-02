import { useState } from 'react'
import { motion } from 'motion/react'
import { Desktop, FilePlus, Lightning, NotePencil, Plugs, ShieldCheck, TerminalWindow, WarningCircle } from '@phosphor-icons/react'
import type { ApprovalDecision, PendingApproval, Permissions } from '@shared/types'
import { DiffStat, DiffView } from './DiffView'

const KIND = {
  write: { icon: FilePlus, verb: 'Write file' },
  edit: { icon: NotePencil, verb: 'Edit file' },
  command: { icon: TerminalWindow, verb: 'Run command' },
  tool: { icon: Plugs, verb: 'Use tool' },
  computer: { icon: Desktop, verb: 'Use this computer' }
} as const

/**
 * Inline request for the user's go-ahead on a write, edit or shell command. A risky action (what
 * Manual asks about) says why it needs a look and offers Allow once / Deny / "Switch to Auto"
 * (which allows this one and stops asking). MCP tools set to ask can be always allowed per server.
 */
export function ApprovalCard({ approval, permissions, onDecide }: { approval: PendingApproval; permissions?: Permissions; onDecide(decision: ApprovalDecision): Promise<void> | void }) {
  const [busy, setBusy] = useState(false)
  const k = KIND[approval.kind]
  const manual = permissions === 'manual'
  // Manual asks only about risky actions; its third button switches the chat to Auto.
  const risky = !!approval.risk
  const switchToAuto = manual && approval.kind !== 'tool' && approval.kind !== 'computer'
  const decide = async (d: ApprovalDecision) => {
    setBusy(true)
    try {
      await onDecide(d)
    } finally {
      setBusy(false)
    }
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 28 }}
      className="mb-4 ml-11 overflow-hidden rounded-[14px] border border-warn/40 bg-panel shadow-[0_0_0_4px_rgb(224_164_58/0.06)]"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-warn/15 text-warn">
          <k.icon size={14} weight="fill" />
        </span>
        <span className="text-[12.5px] font-semibold">{k.verb}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{approval.kind === 'command' ? `in ${approval.path}` : approval.kind === 'tool' ? `${approval.tool?.server} · ${approval.tool?.name}` : approval.kind === 'computer' ? '' : approval.path}</span>
        {(approval.kind === 'write' || approval.kind === 'edit') && <DiffStat added={approval.added ?? 0} removed={approval.removed ?? 0} />}
        <span className="ml-1 flex items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-[10.5px] font-medium text-warn">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
          needs approval
        </span>
      </div>
      {approval.risk && (
        <div className="flex items-center gap-2 border-b border-line bg-warn/[0.08] px-3 py-2 text-[12.5px] font-medium text-warn">
          <WarningCircle size={15} weight="fill" className="shrink-0" />
          <span className="min-w-0">Needs your OK: {approval.risk}</span>
        </div>
      )}
      <div className="p-3">
        {approval.kind === 'computer' ? (
          <p className="text-[12.5px] leading-relaxed text-fg">{approval.command}</p>
        ) : approval.kind === 'tool' ? (
          <pre className="selectable max-h-[220px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2.5 font-mono text-[11.5px] text-muted">{approval.command}</pre>
        ) : approval.kind === 'command' ? (
          <pre className="selectable overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2.5 font-mono text-[12px] text-fg">
            <span className="select-none text-dim">$ </span>
            {approval.command}
          </pre>
        ) : (
          <DiffView diff={approval.diff ?? ''} maxHeight={280} />
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => void decide('allow')}
            className="h-8 rounded-lg bg-crimson px-3.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-crimson-hi disabled:bg-elev-2 disabled:text-dim"
          >
            {risky ? 'Allow once' : approval.kind === 'command' ? 'Run' : approval.kind === 'tool' || approval.kind === 'computer' ? 'Allow' : 'Apply'}
          </button>
          <button
            disabled={busy}
            onClick={() => void decide('deny')}
            className="h-8 rounded-lg border border-line-strong px-3.5 text-[12.5px] font-medium text-muted transition-colors hover:border-crimson-line hover:text-fg disabled:opacity-50"
          >
            {risky ? 'Deny' : 'Decline'}
          </button>
          <div className="flex-1" />
          {(switchToAuto || approval.kind === 'tool') && (
            <button
              disabled={busy}
              onClick={() => void decide('always')}
              title={
                switchToAuto ? 'Allow this and stop asking: the chat takes risky actions without asking too' : `Stop asking for ${approval.tool?.server} tools in this chat`
              }
              className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-dim transition-colors hover:bg-elev-2 hover:text-muted disabled:opacity-50"
            >
              {switchToAuto ? <Lightning size={14} /> : <ShieldCheck size={14} />}
              {switchToAuto ? 'Switch to Auto' : `Always allow ${approval.tool?.server} here`}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  )
}
