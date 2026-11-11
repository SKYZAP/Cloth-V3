import type { FindingAxis, ReviewFinding } from '@shared/types'

/* What a Spec → Ship stage stop shows: its summary split up, and the message that sends review findings back. */

/** Splits a stage summary into its bullets and the "Assumed:" / "Unverified:" lines every stage ends with. */
export function splitSummary(summary: string[]): { bullets: string[]; assumed: string | null; unverified: string | null } {
  let assumed: string | null = null
  let unverified: string | null = null
  const bullets: string[] = []
  for (const line of summary) {
    const m = /^(assumed|unverified)\s*:\s*(.*)$/i.exec(line.trim())
    if (!m) bullets.push(line)
    else if (m[1].toLowerCase() === 'assumed') assumed = m[2].trim() || 'nothing'
    else unverified = m[2].trim() || 'nothing'
  }
  return { bullets, assumed, unverified }
}

export const isNothing = (s: string) => /^(nothing|none|n\/a)\.?$/i.test(s.trim())

/** What each kind of finding is called on the review's stop. */
export const AXIS_NAME: Record<FindingAxis, string> = { spec: 'Spec', break: 'Break', safety: 'Safety', standards: 'Standards' }

/** The message that sends the chosen review findings back to be fixed. */
export function fixMessage(findings: ReviewFinding[]): string {
  return [
    `Fix ${findings.length === 1 ? 'this review finding' : `these ${findings.length} review findings`}, then run the tests and check them again:`,
    ...findings.map((f) => `- [${AXIS_NAME[f.axis] ?? f.axis}] ${f.title}${f.where ? ` (${f.where})` : ''}${f.proof ? `; shown by \`${f.proof.command}\`` : ''}`)
  ].join('\n')
}
