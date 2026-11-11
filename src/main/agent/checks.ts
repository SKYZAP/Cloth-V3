import type { ReviewFinding, SubagentRun } from '@shared/types'

/*
 * Verifiers prove what they report by running it (after pstack's interrogate and swarm skills,
 * https://github.com/cursor/plugins/tree/main/pstack, MIT licence): each finding comes with the command
 * that shows it and what that printed. A report without its verdict, or a finding without a command and
 * its output, proves nothing: the first is a gap (never a pass), the second is dropped as unproven.
 */

/** What a verifier is told about its job and its report. */
export const VERIFIER_INSTRUCTIONS = [
  'You are a verifier: you check work by running it, never by reading alone. Use the real entry point (the app, command or public API, as the project\'s docs/verify/README.md says when it exists) and the project\'s tests; write probe scripts or extra tests where that is the quickest proof.',
  'Prove every finding by running code: a failing test, a repro script, or command output showing the wrong behaviour. Report only what a run showed. Leave out style, naming, structure and risks that need some future change to matter.',
  'When you are working in your own throwaway copy of the project (the job says so), change whatever your probes need: nothing you change there is kept. Otherwise change nothing.',
  'Report in exactly this shape; it is all the other agent sees, and a report in any other shape counts as no check at all:',
  'Result: pass | issues | blocked',
  'Then one block per finding:',
  '### Finding: <what is wrong, one line>',
  'Criterion: <the acceptance criterion it breaks, e.g. AC-3, or none>',
  'Command: `<the exact command, runnable from the project folder, that shows it>`',
  'Observed: <the relevant part of what it printed>',
  'Expected: <what the spec or intent requires instead>',
  'Fix before ship: yes | no',
  'Then a line "Checked:" listing what you ran that passed (command and what it showed), and a line "Blocked by:" when something stopped you. Keep it under ~500 words. Show no secrets: write <REDACTED>.'
].join('\n')

export interface CheckReport {
  verdict: NonNullable<SubagentRun['verdict']>
  /** Findings that came with a command and its output. */
  findings: ReviewFinding[]
  /** Titles of findings that came without proof (dropped). */
  unproven: string[]
  /** Why the report is a gap, when it is. */
  gap?: string
}

const field = (block: string, name: string): string | undefined => {
  const m = new RegExp(`^\\s*[-*]?\\s*\\**${name}\\**\\s*:\\s*(.*)$`, 'im').exec(block)
  return m?.[1]?.trim() || undefined
}

/** The command in a `Command:` line, without its backticks. */
const command = (s: string | undefined) => s?.replace(/^`+|`+$/g, '').trim() || undefined

/** Read a verifier's report: its verdict and its proven findings. */
export function parseCheckReport(text: string, axis: ReviewFinding['axis'] = 'break'): CheckReport {
  const m = /^\s*\**result\**\s*:\s*\**\s*(pass|passed|issues|issue|blocked)\b/im.exec(text ?? '')
  if (!m) return { verdict: 'gap', findings: [], unproven: [], gap: 'its report has no "Result: pass | issues | blocked" line' }
  const word = m[1].toLowerCase()
  const verdict: CheckReport['verdict'] = word.startsWith('pass') ? 'pass' : word === 'blocked' ? 'blocked' : 'issues'
  const findings: ReviewFinding[] = []
  const unproven: string[] = []
  // Each block runs from its "### Finding:" heading to the next one (or the Checked:/Blocked by: lines).
  const blocks = text.split(/^\s*#{2,4}\s*finding\s*:?\s*/im).slice(1)
  for (const raw of blocks) {
    const block = raw.split(/^\s*\**(checked|blocked by)\**\s*:/im)[0]
    const title = block.split('\n')[0].trim()
    if (!title) continue
    const cmd = command(field(block, 'command'))
    const observed = field(block, 'observed')
    if (!cmd || !observed) {
      unproven.push(title)
      continue
    }
    const criterion = field(block, 'criterion')
    const expected = field(block, 'expected')
    const fix = !/^no\b/i.test(field(block, 'fix before ship') ?? 'yes')
    findings.push({
      axis,
      fix,
      title,
      ...(criterion && !/^none\b/i.test(criterion) ? { where: criterion } : {}),
      proof: { command: cmd, observed, ...(expected ? { expected } : {}) },
      status: 'open'
    })
  }
  if (verdict === 'issues' && !findings.length)
    return { verdict: 'gap', findings, unproven, gap: unproven.length ? 'it reported issues but none came with a command and its output' : 'it reported issues but listed none' }
  return { verdict, findings, unproven }
}

/** The note the delegating agent gets after a verifier's report: what counts and what to do about a gap. */
export function checkNote(r: CheckReport): string {
  if (r.verdict === 'gap')
    return `Incomplete check: ${r.gap}. Send this check again once with the same brief; if the second report is incomplete too, it is a gap: list it under "Unverified", never as a pass.`
  const parts = [`Verdict: ${r.verdict}; ${r.findings.length} proven finding${r.findings.length === 1 ? '' : 's'}.`]
  if (r.unproven.length) parts.push(`Dropped as unproven (no command and output): ${r.unproven.join('; ')}.`)
  return parts.join(' ')
}
