import type { SpecWorkflow, WorkflowStage } from '@shared/types'
import { WORKFLOW_STAGES } from '@shared/types'

/*
 * Spec → ship: a chat mode that walks a feature through grilling, a spec, tickets, building and a
 * two-axis review. The stage instructions adapt Matt Pocock's skills (grilling, domain-modeling,
 * to-spec, to-tickets, implement, code-review; https://github.com/mattpocock/skills, MIT licence).
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

/** The stage after `stage` (review → done). */
export function nextStage(stage: WorkflowStage): WorkflowStage {
  const i = WORKFLOW_STAGES.indexOf(stage as (typeof WORKFLOW_STAGES)[number])
  return i < 0 || i === WORKFLOW_STAGES.length - 1 ? 'done' : WORKFLOW_STAGES[i + 1]
}

export const STAGE_NAME: Record<WorkflowStage, string> = { grill: 'Grill', spec: 'Spec', tickets: 'Tickets', build: 'Build', review: 'Review', done: 'Done' }

const COMMON = [
  'This chat runs the Spec → ship workflow: Grill → Spec → Tickets → Build → Review. Each stage ends with `finish_stage`, which shows the person what the stage produced and waits for their OK; the next stage starts when they approve it. Never start the next stage on your own.',
  'Documents live in the workspace: the glossary in GLOSSARY.md, decision records in docs/adr/NNNN-slug.md, a UI mockup (when the feature changes what people see) in docs/specs/<slug>/mockup.html, the spec in docs/specs/<slug>/spec.md and one file per ticket in docs/specs/<slug>/tickets/NN-slug.md. <slug> is a short kebab-case name for the feature. Read what already exists before writing, and use the glossary\'s terms everywhere.'
].join('\n')

const STAGES: Record<Exclude<WorkflowStage, 'done'>, string> = {
  grill: [
    '### Stage 1 of 5: Grill',
    'Interview the person until you share an understanding of what to build. Map it as a tree of decisions: every decision branches into the decisions that depend on it.',
    'Work in rounds. Each round asks every decision that can be settled now (its prerequisites are already answered) with `ask_questions`: a short title, any context the person needs, and your recommended answer, worded so that "yes" accepts it. Then stop and wait. Questions that depend on another question still open belong to a later round.',
    'Finding facts is your job: read the code, the existing glossary and decision records before asking, and never ask what you can look up. The decisions are the person\'s.',
    'A default you would pick yourself is still a decision: ask it, with that default as your recommendation, rather than settling it silently. Before finishing, walk this checklist and make sure each item that applies was answered by the person:',
    '- A new project or empty folder: the language and runtime version, whether dependencies are allowed, the exact commands that start and test it, and where data and settings come from (files, environment variables, their defaults).',
    '- Anything others call or read (an HTTP API, a command, a file format, messages people see): exact names and paths, the inputs, every field of the output, the exact wording of user-visible text (summary lines, messages), and the status or exit code for success and for each kind of failure.',
    '- What is valid input, including the wrong-type and edge cases (a boolean or a string where a number is expected, empty values, control characters).',
    '- New data: where it is shown (does an existing list or read now include it?) and what happens to records that already exist.',
    '- An upgrade or migration: the exact target versions, which dependencies may change (including type packages and lock files), and which behaviour must stay exactly the same.',
    'Scale the grilling to the request: a bug fix or a change the person already specified fully may need one short round; never invent questions to fill one.',
    'As terms get settled, write them to GLOSSARY.md right away (a bold term, a one- or two-sentence definition of what it is, and an "_Avoid_:" line of synonyms not to use; no implementation details). Challenge terms that clash with the glossary, sharpen vague ones, and test relationships with concrete edge-case scenarios. When the code contradicts what the person says, say so.',
    'Write a decision record in docs/adr/ only when all three hold: it is hard to reverse, it would surprise a future reader, and it was a real trade-off. One to three sentences: the context, the decision, and why; add rejected options only when the rejection is not obvious.',
    'If the feature changes anything people see (a screen, panel, dialog, layout, or the flow between them), show the proposed UI before the spec is written. Once the decisions are settled, choose the feature slug and write docs/specs/<slug>/mockup.html: one self-contained page showing the main screens and their states (empty, loading, error, full) with realistic content. If a UI or design skill is available (for example frontend-design), load it first and follow it. Match the existing app: read its stylesheet and components and reuse its colours, fonts, spacing and patterns rather than inventing new ones. Inline all CSS, and use no scripts or external files (fonts, images, CDNs): the page is shown inside the app, where they are blocked. Where more than one layout is plausible, show up to three labelled options side by side with your recommendation. Skip the mockup when nothing visible changes.',
    'When no decision is left open, call `finish_stage` with a summary of the decisions made and the files you wrote, plus a line "Assumed: …" naming anything you still settled yourself (or "Assumed: nothing"); include the slug when you wrote a mockup, so the person sees it with the summary and can ask for changes before approving.'
  ].join('\n'),
  spec: [
    '### Stage 2 of 5: Spec',
    'Write the spec from what was settled while grilling; do not interview again (ask only if something essential is missing). Choose the feature slug (keep the one the mockup used, if any) and write docs/specs/<slug>/spec.md with these sections:',
    '- Problem: the problem from the person\'s point of view.',
    '- Solution: the solution from the person\'s point of view. When docs/specs/<slug>/mockup.html exists, the approved mockup is part of it: link it and keep the spec consistent with it.',
    '- User stories: a long numbered list, "As a <who>, I want <what>, so that <why>", covering every aspect of the feature.',
    '- Decisions: modules to build or change and their interfaces, schema and API shapes, architectural choices, linking the decision records that apply. No file paths or code; they go stale.',
    '- Testing: what makes a good test here (external behaviour only), which modules get tested, at the highest seam possible (ideally one), and similar existing tests to follow. Every test runs under the project\'s normal test command. For an upgrade, migration or refactor, the behaviour that must not change is pinned by tests through the real running app (the full request path, including error responses such as 400, 401, 403 and 404), written and passing before anything is changed.',
    '- Contract: for anything others call or read, the exact paths, fields, status or exit codes and user-visible text settled while grilling, written out so a test can check them word for word.',
    '- Out of scope.',
    '- Notes, if any.',
    'Then call `finish_stage` with the slug and a short summary (how many stories, the test seam, what is out of scope).'
  ].join('\n'),
  tickets: [
    '### Stage 3 of 5: Tickets',
    'Break the spec into tickets: thin vertical slices, each a narrow but complete path through every layer it needs (data, logic, interface, tests), each demoable or verifiable on its own and small enough for one fresh agent. Put any preparatory refactor first ("make the change easy, then make the easy change"). For an upgrade or migration, ticket 01 pins today\'s behaviour with tests through the running app, done before anything is upgraded.',
    'Write one file per ticket, docs/specs/<slug>/tickets/NN-slug.md, numbered from 01 in dependency order: a "# NN: Title" heading, "What to build" (the behaviour, from the person\'s side), "Blocked by" (the ticket numbers that must be done first, or "None"), and acceptance criteria as a checklist. No file paths or code.',
    'Then call `finish_stage` listing each ticket with what it waits for, so the person can judge the size and order.'
  ].join('\n'),
  build: [
    '### Stage 4 of 5: Build',
    'Build the tickets. Put them on the todo list (one item per ticket, in order). Work the frontier: every ticket whose blockers are done can start; hand independent ones to agents with `task` in parallel (role worker, the cheapest tier that gets it right), each brief pointing at its ticket file, the spec and the glossary rather than repeating them, and asking for test-first work: one failing test at the agreed seam, make it pass, refactor, repeat. Check each report against its ticket\'s acceptance criteria before marking it done; send it back with the specific defects if needed.',
    'When the folder is a git repository, each worker you start gets its own git copy of the project on a branch of its own, and its work is merged back into this branch when it finishes (the documents are committed first), so independent tickets really do build at the same time. A worker’s result says whether its work merged; on a conflict its branch is kept: merge and resolve it yourself, or send the ticket back. Leave files the running workers are changing alone, and run the tests here after each merge. Never switch this folder to another branch: workers merge into the branch it is on. When a worker stops before finishing, its error names the branch holding its work; start the next worker with continueFrom set to that branch so it carries on rather than starting over.',
    'Run the type check and the tests as you go, and the full suite once at the end with the project\'s normal test command; check that every new test appears in its output (a test that command never runs does not count). Tick each acceptance criterion in its ticket file when it is met.',
    'Before finishing, start the app the way the person would (its start command) and exercise the spec\'s Contract (when it has one) once by hand: one success and one failure of each kind, comparing paths, fields, codes and wording with the spec exactly.',
    'When every ticket is done and the full suite passes, call `finish_stage` with what was built, the test results, what the hand check showed, and any ticket left partly done.'
  ].join('\n'),
  review: [
    '### Stage 5 of 5: Review',
    'Review everything this workflow changed, on two separate axes, with two read-only agents in parallel (`task`, role scout):',
    '- Standards: does the change follow the repo\'s documented standards (CLAUDE.md, CONTRIBUTING.md, linters\' configs)? Also flag, as judgement calls, common smells: unclear names, duplicated logic, functions reaching into other objects\' data, the same few values passed around together, primitives standing in for domain types, repeated switches on the same thing, speculative generality. The repo\'s own standards override these.',
    '- Spec: compared with docs/specs/<slug>/spec.md and the tickets, what is missing or partial, what was built that nobody asked for, and what looks implemented but wrong. Quote the spec for each finding. Do not stop at reading: run the app and probe the Contract with hostile input (wrong types, empty and huge values, control characters, missing or wrong credentials) and check each response against the spec. For an upgrade or migration, also list the target version\'s documented breaking changes that touch this code (security, error handling, changed defaults, renamed settings) and check each one against the running app.',
    'Report the two axes separately, side by side; never merge them into one ranking. Then call `finish_stage` with the findings (severity, what, where), marking the ones you recommend fixing before this ships, so the person can decide what to fix. If they ask for fixes, make them, run the tests, and review again.'
  ].join('\n')
}

/** What the agent is told about the workflow now (null: the chat isn't running one, or it's done). */
export function workflowSection(w: SpecWorkflow | null | undefined): string | null {
  if (!w) return null
  if (w.stage === 'done') return '## Workflow: Spec → ship (done)\nThe Spec → ship workflow for this feature is finished. Carry on as a normal chat; the spec, tickets, glossary and decision records stay in docs/ for reference.'
  return [`## Workflow: Spec → ship${w.slug ? ` (docs/specs/${w.slug})` : ''}`, COMMON, STAGES[w.stage]].join('\n\n')
}

/** The hidden note that starts a stage once the person approves the previous one. */
export const STAGE_OPEN = '<workflow-stage name="'
export const STAGE_CLOSE = '</workflow-stage>'

export function stageNote(stage: WorkflowStage, slug: string | null): string {
  const what: Record<WorkflowStage, string> = {
    grill: 'Start grilling: explore the code and existing docs, then ask the first round.',
    spec: 'The grilling is approved. Write the spec now.',
    tickets: 'The spec is approved. Cut the tickets now.',
    build: 'The tickets are approved. Build them now.',
    review: 'The build is approved. Review it now.',
    done: 'The review is accepted and the workflow is done. Say so in one line, pointing at the spec folder.'
  }
  return [`${STAGE_OPEN}${stage}">`, `${what[stage]}${slug ? ` The feature's folder is docs/specs/${slug}.` : ''}`, STAGE_CLOSE].join('\n')
}

/** The visible text of a stage's opening message. */
export const STAGE_TEXT: Record<WorkflowStage, string> = {
  grill: 'Started Spec → ship',
  spec: 'Approved the grilling',
  tickets: 'Approved the spec',
  build: 'Approved the tickets',
  review: 'Approved the build',
  done: 'Accepted the review'
}
