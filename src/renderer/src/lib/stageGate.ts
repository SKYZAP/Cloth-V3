import type { ReviewFinding } from '@shared/types'

/* What a Spec → ship stage stop shows: its summary split up, and the message that sends review findings back. */

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

/** The message that sends the chosen review findings back to be fixed. */
export function fixMessage(findings: ReviewFinding[]): string {
  const axis = { standards: 'Standards', spec: 'Spec' }
  return [
    `Fix ${findings.length === 1 ? 'this review finding' : `these ${findings.length} review findings`}, then run the tests and review again:`,
    ...findings.map((f) => `- [${axis[f.axis]}] ${f.title}${f.where ? ` (${f.where})` : ''}`)
  ].join('\n')
}
