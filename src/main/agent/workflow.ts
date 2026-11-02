import type { SpecWorkflow, StageGate, WorkflowRoute, WorkflowStage } from '@shared/types'
import { routeStages } from '@shared/types'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export { routeStages }

/*
 * Spec → Ship: a chat mode that walks a feature through grilling, a spec, tickets, building and a
 * two-axis review. The stage instructions adapt Matt Pocock's skills (grilling, domain-modeling,
 * to-spec, to-tickets, implement-spec, tdd, code-review, diagnosing-bugs; https://github.com/mattpocock/skills, MIT licence;
 * last compared with v1.3.2).
 * Sized routes, numbered acceptance criteria with pre/postconditions, a living spec index and an ADR
 * index follow 2026 spec-driven practice (Kiro, OpenSpec, Böckeler's review of SDD tools, and the
 * "Ask or Assume" and spec-driven test-generation papers).
 */

/** The system prompt section that carries the workflow's current stage. */
export const WORKFLOW_SECTION = 'workflow'

/** Files a chat may write before the Build stage: the glossary and anything under docs/. */
export function isDocPath(rel: string): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  return p === 'GLOSSARY.md' || p === 'GLOSSARY-MAP.md' || (p.startsWith('docs/') && !p.includes('..'))
}

/** Before Build the chat only writes documents: no code changes, no commands. */
export function docsOnly(w: SpecWorkflow | null | undefined): boolean {
  return !!w && (w.stage === 'grill' || w.stage === 'spec' || w.stage === 'tickets')
}

export const DOCS_ONLY_REFUSAL =
  'This chat is in the Spec → Ship workflow and still writing documents: until the Build stage it may only write GLOSSARY.md and files under docs/, and run no commands. Record the decision in the spec or a ticket instead.'

/** The stage after `stage` on this route (review → done). */
export function nextStage(stage: WorkflowStage, route?: WorkflowRoute | null): WorkflowStage {
  if (stage === 'tickets') return 'build'
  const stages = routeStages(route)
  const i = stages.indexOf(stage as (typeof stages)[number])
  return i < 0 || i === stages.length - 1 ? 'done' : stages[i + 1]
}

export const STAGE_NAME: Record<WorkflowStage, string> = { grill: 'Grill', spec: 'Spec', tickets: 'Tickets', build: 'Build', review: 'Review', done: 'Done' }

export const ROUTE_NAME: Record<WorkflowRoute, string> = { quick: 'Quick', standard: 'Standard', preserve: 'Preserve' }

const COMMON = [
  'This chat runs the Spec → Ship workflow. Each stage ends with `finish_stage`, which shows the person what the stage produced and waits for their OK; the next stage starts when they approve it. Never start the next stage on your own.',
  'Each stage starts with a fresh conversation: what earlier stages settled is in the documents and in the handover at the top of the stage\'s first message. Trust the handover; open a document only for the part you need, and don\'t re-read code an earlier stage already summarised unless you are about to change it.',
  'Keep command output small: run tests with a quiet or failures-only reporter and filter long output (Select-String, grep, tail); Cloth cuts the middle of long output.',
  'Routes, chosen at the start of grilling: Quick (a bug fix, or a small, clear change in one area): Grill, which also writes a short spec, → Build → Review, no tickets; a bug fix is diagnosed before it is changed. Standard: Grill → Spec (the spec and its tickets, approved together) → Build → Review. Preserve (an upgrade, migration or refactor, where behaviour must not change): the Standard stages, with today\'s behaviour pinned by tests before anything changes.',
  'Documents live in the workspace: the glossary in GLOSSARY.md; decision records in docs/adr/NNNN-slug.md, listed in docs/adr/README.md (number, title, status, one line each); a UI mockup (when the feature changes what people see) in docs/specs/<slug>/mockup.html; the spec in docs/specs/<slug>/spec.md; one file per ticket in docs/specs/<slug>/tickets/NN-slug.md; and docs/specs/README.md, one line per spec folder saying what behaviour it covers. <slug> is a short kebab-case name for the feature. Read indexes first and open only the documents this change touches; use the glossary\'s terms everywhere.',
  'Every `finish_stage` summary ends with two lines: "Assumed: …" (anything you settled without the person, or "nothing") and "Unverified: …" (anything you could not check, and why, or "nothing").',
  'At any stage, when you hit a gap only the person can close (two reasonable readings that lead to different results), ask one specific question with `ask_user`, with your recommendation, rather than guessing. Don\'t ask what you can find out yourself.'
].join('\n')

// Spec and Tickets are one stage now; a chat still at the old Tickets stage follows the Spec stage's text.
const STAGES: Record<Exclude<WorkflowStage, 'done' | 'tickets'>, string> = {
  grill: [
    '### Stage: Grill',
    'Interview the person until you share an understanding of what to build. Map it as a tree of decisions: every decision branches into the decisions that depend on it.',
    'Work in rounds. Each round asks every decision that can be settled now (its prerequisites are already answered) with `ask_questions`: a short title, any context the person needs, and your recommended answer, worded so that "yes" accepts it. Then stop and wait. Questions that depend on another question still open belong to a later round.',
    'Choose the route yourself before round 1, from the request and what the code shows: Quick for a bug fix or a small, clear change in one area; Preserve when behaviour must stay exactly as it is (an upgrade, migration or refactor); Standard for anything else, such as a new feature or a change across several parts. Send it with round 1 (`route` on `ask_questions`, or on `finish_stage` when there is no round) and give the reason in a line of that round\'s context; do not ask about it. Ask only when two routes are equally reasonable and lead to really different work. If the answers show the task is bigger or smaller than it looked, switch the route (send the new one with the next round) and say why. The person can always overrule it.',
    'Finding facts is your job: read docs/specs/README.md, docs/adr/README.md and the glossary, then only the specs, decision records and code this request touches, and never ask what you can look up. For a wide lookup, send a read-only agent (`task`, role scout) with a short brief and ask the rest of the round meanwhile: only the questions that depend on its answer wait for it. If the request conflicts with an accepted decision record, say so in round 1 and ask whether to follow the record or replace it.',
    'Size the grilling to the request: a change the person already specified fully may need one short round; never invent questions to fill one. On the Quick route, when the request and the code leave no real decision open, ask no round at all: write the spec and finish, giving the route to `finish_stage`, and list in "Assumed" what you settled. A default you would pick yourself is still a decision: ask it, with that default as your recommendation, rather than settling it silently. Before finishing, check that the person settled each of these that applies: what others see (exact names, inputs, outputs, wording); how it fails (each kind of failure and what the caller gets); what input is valid, including edge cases; where state lives and who sees it; what must stay exactly as it is.',
    'As terms get settled, write them to GLOSSARY.md right away (a bold term, a one- or two-sentence definition, and an "_Avoid_:" line of synonyms not to use; no implementation details). Only terms specific to this project belong there, defined by what they are; general programming ideas don\'t, even if the code uses them a lot. Challenge terms that clash with the glossary and sharpen vague ones. Test the boundaries between terms with concrete edge-case scenarios ("a customer cancels one item of a shipped order: what happens?") until the person is precise. When the code contradicts what the person says, say so.',
    'Write a decision record only when all three hold: it is hard to reverse, it would surprise a future reader, and it was a real trade-off. Keep it short: one to three sentences on the context, the decision and why; add the rejected options only when the rejection is not obvious, and consequences only when they would surprise. Add it to docs/adr/README.md. When it replaces an earlier record, mark that one Superseded with a link to the new one.',
    'If the feature changes anything people see (a screen, panel, dialog, layout, or the flow between them), show the proposed UI before the spec: once the decisions are settled, choose the slug and write docs/specs/<slug>/mockup.html, one self-contained page showing the main screens and their states (empty, loading, error, full) with realistic content. If a UI or design skill is available, load it first. Match the existing app\'s colours, fonts, spacing and patterns. Inline all CSS, no scripts or external files (they are blocked where it is shown). Where more than one layout is plausible, show up to three labelled options with your recommendation. Skip the mockup when nothing visible changes.',
    'On the Quick route, write the spec now (as the Spec stage describes, but short: no Decisions section unless one matters) and include its checklist of acceptance criteria to build against; there are no tickets. For a bug, settle the symptom, not the cause: what happens, what should happen instead, how to trigger it, and since when if known. Its criteria are the corrected behaviour and a regression test that fails before the fix. Don\'t guess at the cause yet: nothing can be run until Build.',
    'When no decision is left open, call `finish_stage` with the route, a summary of the decisions and the files you wrote; include the slug when you wrote a mockup or (Quick) the spec.'
  ].join('\n'),
  spec: [
    '### Stage: Spec',
    'Write the spec from what was settled while grilling; do not interview again. Keep the slug the mockup used, if any, and write docs/specs/<slug>/spec.md. Aim for one to two pages: every line should be something the build or a test needs. No code or file paths; they go stale and double the review.',
    '- Problem and Solution: a few sentences each, from the person\'s point of view. When docs/specs/<slug>/mockup.html exists, link it; the spec keeps to it.',
    '- Acceptance criteria: numbered AC-1, AC-2, …, each one testable behaviour: "Given <state>, when <action>, then <exact observable result>", using the exact names, outputs, wording and failure results settled while grilling. Add "Undefined: …" where some input or state is deliberately left open. On the Preserve route, the behaviour that must not change gets its own criteria.',
    '- Changes to earlier specs: if this alters behaviour an earlier spec in docs/specs/ states, name that spec and its criteria.',
    '- Decisions: modules and interfaces to build or change, schema and API shapes, linking the decision records that apply. Prefer deep modules: a small interface with the behaviour behind it, so callers and tests learn little and changes stay in one place. Where a mockup or prototype settled a state machine, type or schema more precisely than prose can, quote just that part.',
    '- Testing: the seam to test at (the highest one possible, ideally one; an existing seam before a new one), with one line on what testing there catches and what it misses, and similar existing tests to follow. Tests run under the project\'s normal test command and name the criteria they cover.',
    '- Out of scope.',
    'Then cut the tickets in the same stage, as below, so the person approves the spec and its tickets together.',
    'Break the spec into tickets: thin vertical slices, each a narrow but complete path through every layer it needs, verifiable on its own and small enough for one fresh agent. Put any preparatory refactor first: make the change easy, then make the easy change. A wide mechanical change (renaming or retyping something used everywhere) can\'t land as one green slice: sequence it as expand–contract instead, a ticket adding the new form beside the old, then tickets moving the callers over in batches (each blocked by the expand, the suite green after each), then one removing the old form, blocked by every batch. On the Preserve route, ticket 01 pins today\'s behaviour with tests against a real running instance (a started server, process or command, called the way its users call it; not an in-process stand-in that skips parts of the stack), run against the original build first so they record what it really does, and passing there before anything is changed. They live in the project\'s normal test suite, not a side script, so every later run checks them.',
    'Write one file per ticket, docs/specs/<slug>/tickets/NN-slug.md, numbered from 01 in dependency order: a "# NN: Title" heading, "What to build" (one or two sentences), "Covers" (the AC numbers; never restate their text), "Blocked by" (ticket numbers, or "None"), and a checklist of those ACs plus anything specific to the ticket. No file paths or code.',
    'Then call `finish_stage` with the slug and a short summary: how many criteria, the test seam, what is out of scope, and each ticket with what it covers and waits for.'
  ].join('\n'),
  build: [
    '### Stage: Build',
    'Build against the acceptance criteria: on the Quick route, the spec\'s checklist; otherwise the tickets. Put them on the todo list in order. Work the frontier: every item whose blockers are done can start; hand independent ones to agents with `task` in parallel (role worker), each brief pointing at its ticket or criteria, the spec and the glossary rather than repeating them. Use the cheapest tier for tickets whose criteria leave nothing to work out; a stronger one only where the approach is unclear. Ask for test-first work, one slice at a time: for each criterion, write down what must hold before and after (and what is undefined), then one failing test at the agreed seam named after the criterion, then only enough code to make it pass; no tests written ahead in bulk. Tests go through the public interface, never mock the module\'s own collaborators or check through a side door (the database instead of the interface), and take expected values from the spec or a worked example, never recomputed the way the code computes them. Leave refactoring to the review. Check each report against its criteria before marking it done, from the report, the files it lists (`git diff --stat`) and the tests; open a file only where the report, the diff or a failing test points, never to redo a worker\'s reading. Send it back with the specific defects if needed.',
    'When the folder is a git repository, each worker you start gets its own git copy of the project on a branch of its own, and its work is merged back into this branch when it finishes (the documents are committed first), so independent tickets really do build at the same time. A worker’s result says whether its work merged; on a conflict its branch is kept: merge and resolve it yourself, or send the ticket back. Leave files the running workers are changing alone, and after each batch of merges run the tests those tickets touch (the full suite runs once, at the end). Never switch this folder to another branch: workers merge into the branch it is on. When a worker stops before finishing, its error names the branch holding its work; start the next worker with continueFrom set to that branch so it carries on rather than starting over.',
    'Before starting, note the project\'s checks (type check, linter) and their current result, so the change leaves them no worse. Run the tests as you go and the full suite at the end with the project\'s normal test command; check that every new test appears in its output. Then exercise the change once through the real entry point (the app, command or public API) as its user would, or say in "Unverified" why that was not possible. Tick each criterion in its file (`- [x]` in the ticket, or on the Quick route in the spec\'s checklist) as soon as it is met and checked, yourself, in this folder: that is how the person\'s board shows a ticket as done. A criterion that is not met stays unticked.',
    'A bug fix is diagnosed before any code changes (show no secrets in commands or output; write <REDACTED>):',
    '1. Build a feedback loop first: one command, already run once, that goes red on this exact symptom. Prefer a failing test at a seam that reaches the bug; otherwise a script against the running app, a CLI run diffed against known-good output, or a replayed captured request. Make it fast and give the same result every run; for a bug that only sometimes happens, raise how often it fails (loop it, add load) until it fails often. Form no theory before this command exists. If you cannot build one, say what you tried and ask the person (`ask_user`) for access, a captured log or permission to add instrumentation.',
    '2. Shrink it: cut inputs, steps and setup one at a time, re-running after each cut, until every part left is needed to make it fail.',
    '3. List three to five ranked causes, each with the prediction that would confirm it ("if X is the cause, changing Y makes it pass"), and show them in one line before testing them.',
    '4. Test one prediction at a time. Tag every debug log with one prefix, such as [DEBUG-a4f2]. For slowness, measure a baseline before changing anything.',
    '5. Turn the shrunk case into a failing regression test at a seam where the real bug pattern happens; if you forced the failure by editing code or a fixture, diff against the original to prove the edit landed. Then fix, watch it pass, and re-run the original loop. If no seam can hold the real pattern, say so under "Unverified".',
    '6. Remove the tagged logs (search for the prefix) and any throwaway scripts, and name the cause that proved true in the `finish_stage` summary.',
    'When every item is done and the full suite passes, call `finish_stage` with what was built, the test and check results, and anything left partly done; list a ticket left with unticked criteria in `unfinished`.'
  ].join('\n'),
  review: [
    '### Stage: Review',
    'Review everything this workflow changed, on two separate axes, with two read-only agents in parallel (`task`, role scout). They cannot run commands. Build\'s last test and check results are in the handover: rerun them only if something changed since, and run any probes yourself. Give each reviewer the change itself (the handover names the diff: the changed files and `git diff` from the commit Build started at) rather than asking it to explore the codebase.',
    '- Standards: does the change follow the repo\'s documented standards (CLAUDE.md, CONTRIBUTING.md, linters\' configs), and are the project\'s checks no worse than before? Also flag, as judgement calls, these smells (Fowler): names that don\'t say what a thing is or does; the same logic in more than one place; a function using another object\'s data more than its own; the same few values always passed together; a string or number standing in for a domain concept; the same switch on the same type repeated; one change scattered across many files; one module changed for unrelated reasons; abstraction or options nothing asks for; long chains of calls through other objects; a layer that only passes calls on; a subtype ignoring most of what it inherits. Name the smell and the fix. The repo\'s own standards override these; skip anything a tool already enforces.',
    '- Spec: compared with docs/specs/<slug>/spec.md (and the tickets), which criteria are missing, partial or have no test exercising them, which look implemented but behave wrongly, what was built that nobody asked for, and where code and spec now disagree. Quote the criterion for each finding.',
    'Before handing over, try to break the change through its real entry point with inputs and states the criteria don\'t cover. On the Preserve route, also check the target versions\' documented breaking changes that touch this code. For a bug fix, undo the fix and check the regression test fails, then restore it.',
    'Report the two axes separately, side by side; never merge them into one ranking. Then call `finish_stage` with every finding in `findings` (its axis, whether you recommend fixing it before this ships, what is wrong, where) and a short summary, so the person can pick what to fix. Recommend fixing only what changes behaviour or leaves a criterion untested; naming, traceability and style gaps (a test that covers a criterion without naming it, a clearer name) are optional. If they ask for fixes, make them, run the tests, and review again.'
  ].join('\n')
}

/** What the agent is told about the workflow now (null: the chat isn't running one, or it's done). */
export function workflowSection(w: SpecWorkflow | null | undefined): string | null {
  if (!w) return null
  if (w.stage === 'done') return '## Workflow: Spec → Ship (done)\nThe Spec → Ship workflow for this feature is finished. Carry on as a normal chat; the spec, tickets, glossary and decision records stay in docs/ for reference.'
  const route = w.route ? ` · ${ROUTE_NAME[w.route]} route` : ''
  return [`## Workflow: Spec → Ship${w.slug ? ` (docs/specs/${w.slug})` : ''}${route}`, COMMON, STAGES[w.stage === 'tickets' ? 'spec' : w.stage]].join('\n\n')
}

/** Numbers of the tickets in this folder that still have an unticked criterion ("02"), in order. */
export async function openTickets(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: string[] = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => '')
    if (/^\s*[-*]\s*\[ \]/m.test(text)) out.push((/^(\d+)/.exec(name)?.[1] ?? name.replace(/\.md$/, '')).padStart(2, '0'))
  }
  return out
}

/** The hidden note that starts a stage once the person approves the previous one. */
export const STAGE_OPEN = '<workflow-stage name="'
export const STAGE_CLOSE = '</workflow-stage>'

export function stageNote(stage: WorkflowStage, slug: string | null, route?: WorkflowRoute | null): string {
  const what: Record<WorkflowStage, string> = {
    grill: 'Start grilling: explore the code and existing docs, then ask the first round.',
    spec: 'The grilling is approved. Write the spec and its tickets now.',
    tickets: 'The spec is approved. Cut the tickets now.',
    build: route === 'quick' ? 'The grilling and spec are approved. Build now.' : 'The spec and tickets are approved. Build them now.',
    review: 'The build is approved. Review it now.',
    done: [
      'The review is accepted. Wrap up in a few steps, from the handover alone: don\'t explore the code. Cloth has already listed this spec in docs/specs/README.md.',
      '1. Only where the handover shows this change altered behaviour an earlier spec states, or the review found the code and this spec disagree, update that spec\'s criteria (or mark them replaced, with a link here). Otherwise skip this.',
      route === 'quick'
        ? '2. Skip decision records unless one decision made here clearly meets the bar (hard to reverse, surprising, a real trade-off); then ask the person with `ask_user` whether to record it.'
        : '2. If decisions made while building or reviewing meet the decision-record bar and are not yet recorded, ask the person with `ask_user` (one multiple-choice question listing them) which to record, then write those and update docs/adr/README.md. Skip this when there are none.',
      '3. Then say in one line that the workflow is done, pointing at the spec folder.'
    ].join('\n')
  }
  return [`${STAGE_OPEN}${stage}">`, `${what[stage]}${slug ? ` The feature's folder is docs/specs/${slug}.` : ''}`, STAGE_CLOSE].join('\n')
}

/** The visible text of a stage's opening message. */
export function stageText(stage: WorkflowStage, route?: WorkflowRoute | null): string {
  const text: Record<WorkflowStage, string> = {
    grill: 'Started Spec → Ship',
    spec: 'Approved the grilling',
    tickets: 'Approved the spec',
    build: route === 'quick' ? 'Approved the spec' : 'Approved the spec and tickets',
    review: 'Approved the build',
    done: 'Accepted the review'
  }
  return text[stage]
}

/** What the next stage is handed instead of the earlier conversation. */
export interface Handover {
  route?: WorkflowRoute | null
  slug: string | null
  /** Each finished stage's gate, oldest first (the latest per stage). */
  gates: StageGate[]
  /** What the person wrote during the stage just approved (their change requests), oldest first. */
  said: string[]
  /** For the review: the commit Build started from and the files changed since. */
  base?: string
  changed?: string[]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** The handover at the top of a stage's first message: the earlier stages' results, in place of their conversation. */
export function handoverText(h: Handover): string {
  const docs = h.slug ? `docs/specs/${h.slug}/ (spec.md, tickets/, mockup.html when there is one)` : 'not chosen yet'
  const lines = [
    'Spec → Ship handover. The earlier stages were moved out of this conversation to save context (the person still sees them); their results are below and in the documents.',
    `Route: ${ROUTE_NAME[h.route ?? 'standard']}. Feature folder: ${docs}. Glossary: GLOSSARY.md. Decision records: docs/adr/README.md.`
  ]
  for (const g of h.gates) {
    lines.push('', `${STAGE_NAME[g.stage]} reported:`, ...g.summary.map((l) => `- ${l}`))
    if (g.files?.length) lines.push(`- Files: ${g.files.join(', ')}`)
    for (const f of g.findings ?? []) lines.push(`- Finding (${f.axis}, ${f.fix ? 'fix before shipping' : 'optional'}): ${f.title}${f.where ? ` (${f.where})` : ''}`)
  }
  if (h.said.length) lines.push('', 'What the person said during the last stage:', ...h.said.map((t) => `- ${clip(t.replace(/\s+/g, ' ').trim(), 600)}`))
  if (h.base) {
    const files = h.changed ?? []
    lines.push('', `The change: \`git diff ${h.base}\`, ${files.length} file${files.length === 1 ? '' : 's'}${files.length ? `: ${files.slice(0, 60).join(', ')}${files.length > 60 ? ', …' : ''}` : ''}.`)
  }
  return lines.join('\n')
}

/** The line docs/specs/README.md gets for a feature once its workflow is done, or null when it is already listed. */
export function specIndexLine(readme: string, slug: string, spec: string): string | null {
  if (readme.includes(`(${slug}/`) || readme.includes(`${slug}/spec.md`)) return null
  const title = /^#\s+(.+?)\s*$/m.exec(spec)?.[1]?.replace(/^spec:\s*/i, '') ?? slug
  return `- [${slug}](${slug}/spec.md): ${title}`
}
