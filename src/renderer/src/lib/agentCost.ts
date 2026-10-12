import type { UiBlock, UiMessage } from '@shared/types'

/** What the subagents a reply handed work to cost, nested runs included. */
export function agentCost(message: Pick<UiMessage, 'blocks'>): number {
  const sum = (blocks: UiBlock[]): number =>
    blocks.reduce((total, b) => {
      const run = b.type === 'tool' ? b.trace.subagent : undefined
      return run ? total + (run.usage?.cost ?? 0) + sum(run.blocks) : total
    }, 0)
  return sum(message.blocks)
}
