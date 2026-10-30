import type { SpecWorkflow, WorkflowRoute, WorkflowStage } from '@shared/types'
import { routeStages } from '@shared/types'

export { routeStages }

/*
 * Spec → ship: a chat mode that walks a feature through grilling, a spec, tickets, building and a
 * two-axis review. The stage instructions adapt Matt Pocock's skills (grilling, domain-modeling,
 * to-spec, to-tickets, implement, code-review; https://github.com/mattpocock/skills, MIT licence).
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
  'This chat is in the Spec → ship workflow and still writing documents: until the Build stage it may only write GLOSSARY.md and files under docs/, and run no commands. Record the decision in the spec or a ticket instead.'

/** The stage after `stage` on this route (review → done). */
export function nextStage(stage: WorkflowStage, route?: WorkflowRoute | null): WorkflowStage {
  const stages = routeStages(route)
  const i = stages.indexOf(stage as (typeof stages)[number])
  return i < 0 || i === stages.length - 1 ? 'done' : stages[i + 1]
}

export const STAGE_NAME: Record<WorkflowStage, string> = { grill: 'Grill', spec: 'Spec', tickets: 'Tickets', build: 'Build', review: 'Review', done: 'Done' }

export const ROUTE_NAME: Record<WorkflowRoute, string> = { quick: 'Quick', standard: 'Standard', preserve: 'Preserve' }

const COMMON = [
  'This chat runs the Spec → ship workflow. Each stage ends with `finish_stage`, which shows the person what the stage produced and waits for their OK; the next stage starts when they approve it. Never start the next stage on your own.',
  'Routes, agreed while grilling: Quick (a bug fix or a small, clear change): Grill, which also writes a short spec, → Build → Review, no tickets. Standard: Grill → Spec → Tickets → Build → Review. Preserve (an upgrade, migration or refactor, where behaviour must not change): the Standard stages, with today\'s behaviour pinned by tests before anything changes.',
  'Documents live in the workspace: the glossary in GLOSSARY.md; decision records in docs/adr/NNNN-slug.md, listed in docs/adr/README.md (number, title, status, one line each); a UI mockup (when the feature changes what people see) in docs/specs/<slug>/mockup.html; the spec in docs/specs/<slug>/spec.md; one file per ticket in docs/specs/<slug>/tickets/NN-slug.md; and docs/specs/README.md, one line per spec folder saying what behaviour it covers. <slug> is a short kebab-case name for the feature. Read indexes first and open only the documents this change touches; use the glossary\'s terms everywhere.',
  'Every `finish_stage` summary ends with two lines: "Assumed: …" (anything you settled without the person, or "nothing") and "Unverified: …" (anything you could not check, and why, or "nothing").',
  'At any stage, when you hit a gap only the person can close (two reasonable readings that lead to different results), ask one specific question with `ask_user`, with your recommendation, rather than guessing. Don\'t ask what you can find out yourself.'
].join('\n')

const STAGES: Record<Exclude<WorkflowStage, 'done'>, string> = {
  grill: [
    '### Stage: Grill',
    'Interview the person until you share an understanding of what to build. Map it as a tree of decisions: every decision branches into the decisions that depend on it.',
    'Work in rounds. Each round asks every decision that can be settled now (its prerequisites are already answered) with `ask_questions`: a short title, any context the person needs, and your recommended answer, worded so that "yes" accepts it. Then stop and wait. Questions that depend on another question still open belong to a later round. Round 1 always includes the route, with your recommendation.',
    'Finding facts is your job: read docs/specs/README.md, docs/adr/README.md and the glossary, then only the specs, decision records and code this request touches, and never ask what you can look up. If the request conflicts with an accepted decision record, say so in round 1 and ask whether to follow the record or replace it.',
    'Size the grilling to the request: a change the person already specified fully may need one short round; never invent questions to fill one. A default you would pick yourself is still a decision: ask it, with that default as your recommendation, rather than settling it silently. Before finishing, check that the person settled each of these that applies: what others see (exact names, inputs, outputs, wording); how it fails (each kind of failure and what the caller gets); what input is valid, including edge cases; where state lives and who sees it; what must stay exactly as it is.',
    'As terms get settled, write them to GLOSSARY.md right away (a bold term, a one- or two-sentence definition, and an "_Avoid_:" line of synonyms not to use; no implementation details). Challenge terms that clash with the glossary and sharpen vague ones. When the code contradicts what the person says, say so.',
    'Write a decision record only when all three hold: it is hard to reverse, it would surprise a future reader, and it was a real trade-off. A few sentences: the context, the decision, why, and the rejected options with why they lost; add it to docs/adr/README.md. When it replaces an earlier record, mark that one Superseded with a link to the new one.',
    'If the feature changes anything people see (a screen, panel, dialog, layout, or the flow between them), show the proposed UI before the spec: once the decisions are settled, choose the slug and write docs/specs/<slug>/mockup.html, one self-contained page showing the main screens and their states (empty, loading, error, full) with realistic content. If a UI or design skill is available, load it first. Match the existing app\'s colours, fonts, spacing and patterns. Inline all CSS, no scripts or external files (they are blocked where it is shown). Where more than one layout is plausible, show up to three labelled options with your recommendation. Skip the mockup when nothing visible changes.',
    'On the Quick route, write the spec now (as the Spec stage describes, but short: no Decisions section unless one matters) and include its checklist of acceptance criteria to build against; there are no tickets.',
    'When no decision is left open, call `finish_stage` with the route, a summary of the decisions and the files you wrote; include the slug when you wrote a mockup or (Quick) the spec.'
  ].join('\n'),
  spec: [
    '### Stage: Spec',
    'Write the spec from what was settled while grilling; do not interview again. Keep the slug the mockup used, if any, and write docs/specs/<slug>/spec.md. Aim for one to two pages: every line should be something the build or a test needs. No code or file paths; they go stale and double the review.',
    '- Problem and Solution: a few sentences each, from the person\'s point of view. When docs/specs/<slug>/mockup.html exists, link it; the spec keeps to it.',
    '- Acceptance criteria: numbered AC-1, AC-2, …, each one testable behaviour: "Given <state>, when <action>, then <exact observable result>", using the exact names, outputs, wording and failure results settled while grilling. Add "Undefined: …" where some input or state is deliberately left open. On the Preserve route, the behaviour that must not change gets its own criteria.',
    '- Changes to earlier specs: if this alters behaviour an earlier spec in docs/specs/ states, name that spec and its criteria.',
    '- Decisions: modules and interfaces to build or change, schema and API shapes, linking the decision records that apply.',
    '- Testing: the seam to test at (the highest one possible, ideally one), similar existing tests to follow. Tests run under the project\'s normal test command and name the criteria they cover.',
    '- Out of scope.',
    'Then call `finish_stage` with the slug and a short summary (how many criteria, the test seam, what is out of scope).'
  ].join('\n'),
  tickets: [
    '### Stage: Tickets',
    'Break the spec into tickets: thin vertical slices, each a narrow but complete path through every layer it needs, verifiable on its own and small enough for one fresh agent. Put any preparatory refactor first. On the Preserve route, ticket 01 pins today\'s behaviour with tests against a real running instance (a started server, process or command, called the way its users call it; not an in-process stand-in that skips parts of the stack), run against the original build first so they record what it really does, and passing there before anything is changed.',
    'Write one file per ticket, docs/specs/<slug>/tickets/NN-slug.md, numbered from 01 in dependency order: a "# NN: Title" heading, "What to build" (one or two sentences), "Covers" (the AC numbers; never restate their text), "Blocked by" (ticket numbers, or "None"), and a checklist of those ACs plus anything specific to the ticket. No file paths or code.',
    'Then call `finish_stage` listing each ticket with what it covers and waits for.'
  ].join('\n'),
  build: [
    '### Stage: Build',
    'Build against the acceptance criteria: on the Quick route, the spec\'s checklist; otherwise the tickets. Put them on the todo list in order. Work the frontier: every item whose blockers are done can start; hand independent ones to agents with `task` in parallel (role worker), each brief pointing at its ticket or criteria, the spec and the glossary rather than repeating them. Use the cheapest tier for tickets whose criteria leave nothing to work out; a stronger one only where the approach is unclear. Ask for test-first work: for each criterion, write down what must hold before and after (and what is undefined), then one failing test at the agreed seam named after the criterion, make it pass, refactor. Check each report against its criteria before marking it done; send it back with the specific defects if needed.',
    'When the folder is a git repository, each worker you start gets its own git copy of the project on a branch of its own, and its work is merged back into this branch when it finishes (the documents are committed first), so independent tickets really do build at the same time. A worker’s result says whether its work merged; on a conflict its branch is kept: merge and resolve it yourself, or send the ticket back. Leave files the running workers are changing alone, and run the tests here after each merge. Never switch this folder to another branch: workers merge into the branch it is on. When a worker stops before finishing, its error names the branch holding its work; start the next worker with continueFrom set to that branch so it carries on rather than starting over.',
    'Before starting, note the project\'s checks (type check, linter) and their current result, so the change leaves them no worse. Run the tests as you go and the full suite at the end with the project\'s normal test command; check that every new test appears in its output. Then exercise the change once through the real entry point (the app, command or public API) as its user would, or say in "Unverified" why that was not possible. Tick each criterion when it is met.',
    'When every item is done and the full suite passes, call `finish_stage` with what was built, the test and check results, and anything left partly done.'
  ].join('\n'),
  review: [
    '### Stage: Review',
    'Review everything this workflow changed, on two separate axes, with two read-only agents in parallel (`task`, role scout). They cannot run commands: first run the tests, the checks and any probes yourself and give them the results.',
    '- Standards: does the change follow the repo\'s documented standards (CLAUDE.md, CONTRIBUTING.md, linters\' configs), and are the project\'s checks no worse than before? Also flag, as judgement calls, common smells: unclear names, duplicated logic, functions reaching into other objects\' data, primitives standing in for domain types, speculative generality. The repo\'s own standards override these.',
    '- Spec: compared with docs/specs/<slug>/spec.md (and the tickets), which criteria are missing, partial or untested (every AC needs a test naming it), what was built that nobody asked for, and where code and spec now disagree. Quote the criterion for each finding.',
    'Before handing over, try to break the change through its real entry point with inputs and states the criteria don\'t cover. On the Preserve route, also check the target versions\' documented breaking changes that touch this code.',
    'Report the two axes separately, side by side; never merge them into one ranking. Then call `finish_stage` with every finding in `findings` (its axis, whether you recommend fixing it before this ships, what is wrong, where) and a short summary, so the person can pick what to fix. If they ask for fixes, make them, run the tests, and review again.'
  ].join('\n')
}

/** What the agent is told about the workflow now (null: the chat isn't running one, or it's done). */
export function workflowSection(w: SpecWorkflow | null | undefined): string | null {
  if (!w) return null
  if (w.stage === 'done') return '## Workflow: Spec → ship (done)\nThe Spec → ship workflow for this feature is finished. Carry on as a normal chat; the spec, tickets, glossary and decision records stay in docs/ for reference.'
  const route = w.route ? ` · ${ROUTE_NAME[w.route]} route` : ''
  return [`## Workflow: Spec → ship${w.slug ? ` (docs/specs/${w.slug})` : ''}${route}`, COMMON, STAGES[w.stage]].join('\n\n')
}

/** The hidden note that starts a stage once the person approves the previous one. */
export const STAGE_OPEN = '<workflow-stage name="'
export const STAGE_CLOSE = '</workflow-stage>'

export function stageNote(stage: WorkflowStage, slug: string | null, route?: WorkflowRoute | null): string {
  const what: Record<WorkflowStage, string> = {
    grill: 'Start grilling: explore the code and existing docs, then ask the first round.',
    spec: 'The grilling is approved. Write the spec now.',
    tickets: 'The spec is approved. Cut the tickets now.',
    build: route === 'quick' ? 'The grilling and spec are approved. Build now.' : 'The tickets are approved. Build them now.',
    review: 'The build is approved. Review it now.',
    done: [
      'The review is accepted. Wrap up briefly:',
      '1. Keep the spec current: update docs/specs/README.md for this folder, and where this change altered behaviour an earlier spec states, update that spec\'s criteria (or mark them replaced, with a link here). Bring this spec in line with anything that changed during the build or review.',
      '2. If decisions made while building or reviewing meet the decision-record bar and are not yet recorded, ask the person with `ask_user` (one multiple-choice question listing them) which to record, then write those and update docs/adr/README.md. Skip this when there are none.',
      '3. Then say in one line that the workflow is done, pointing at the spec folder.'
    ].join('\n')
  }
  return [`${STAGE_OPEN}${stage}">`, `${what[stage]}${slug ? ` The feature's folder is docs/specs/${slug}.` : ''}`, STAGE_CLOSE].join('\n')
}

/** The visible text of a stage's opening message. */
export function stageText(stage: WorkflowStage, route?: WorkflowRoute | null): string {
  const text: Record<WorkflowStage, string> = {
    grill: 'Started Spec → ship',
    spec: 'Approved the grilling',
    tickets: 'Approved the spec',
    build: route === 'quick' ? 'Approved the spec' : 'Approved the tickets',
    review: 'Approved the build',
    done: 'Accepted the review'
  }
  return text[stage]
}
