/**
 * Skill eval cases are checked against ONE reply: the skill is in the system prompt, the model gets the
 * user prompt, and it answers in text — no tools, no follow-up turns. Expectations have to be things a
 * grader can see in that reply. These checks catch the common ways drafted (or hand-written) ones aren't.
 */

export interface ExpectationIssue {
  kind: 'conditional' | 'action' | 'compound' | 'vague' | 'long'
  message: string
}

const SAYING = /\b(suggests?|recommends?|tells?|instructs?|shows?|mentions?|includes?|gives?|provides?|says?|states?|explains?|lists?|names?|proposes?|offers? to|asks?|describes?|points? to|quotes?|writes?|outputs?)\b/i
const DOING = /\b(searches|searched|runs|ran|executes|executed|installs|installed|downloads|opens|clicks|navigates|calls the|invokes|fetches|browses|creates? (?:a|the) file|saves? (?:a|the) file|uses? the \w+ tool)\b/i
const VAGUE = /\b(appropriate(?:ly)?|relevant|helpful|good|proper(?:ly)?|reasonable|correct(?:ly)?|clear(?:ly)?|well|nicely|sensible|useful)\b/i
const CONCRETE = /[`"“”'‘’]|\d|\b[A-Z][a-z]+[A-Z]\w*|--?\w/

export function lintExpectation(text: string): ExpectationIssue[] {
  const e = text.trim()
  if (!e) return []
  const out: ExpectationIssue[] = []
  if (/^(if|when|unless|in case|where)\b/i.test(e) || /\b(if|when) (no|any|the|it|there|a|results?|search)\b.*,/i.test(e))
    out.push({ kind: 'conditional', message: 'Conditional: one reply can’t show which case applies. State the behaviour directly, or make a separate case for each situation.' })
  if (DOING.test(e) && !SAYING.test(e))
    out.push({ kind: 'action', message: 'An action: the test is a single text reply without tools. Check what the reply says or proposes (e.g. “tells the user to run …”).' })
  const items = e.split(/,|;|\band\b|\bthen\b/i).filter((s) => s.trim().length > 2)
  if (items.length >= 4) out.push({ kind: 'compound', message: 'Several checks in one: split them, one per line, so a partly right reply scores fairly.' })
  if (VAGUE.test(e) && !CONCRETE.test(e)) out.push({ kind: 'vague', message: 'Vague: say exactly what must appear, so two graders would agree.' })
  if (e.length > 220) out.push({ kind: 'long', message: 'Long: shorter expectations are graded more consistently.' })
  return out
}

/** What drafting and grading tell the model about how a test runs. */
export const EVAL_HARNESS = `How the test runs: the skill is loaded into the system prompt and the model receives ONE user message. It answers in a single text reply — it cannot run commands, use tools, browse, see results or have a follow-up turn. A grader then reads only that reply. So "running", "searching" or "installing" can only show up as the reply telling the user to do it, or saying it would, with the exact command.`
