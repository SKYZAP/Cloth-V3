// OpenSpec mode: the chat takes one change from proposal to pull request with the openspec CLI
// (@fission-ai/openspec), on its own. The agent runs the CLI with the `openspec` tool, reports each
// step with `openspec_step` (the chat's progress strip and the step cards come from those reports),
// and follows the section below, which replaces itself as the run moves on.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { OPENSPEC_STEP_LABEL, OPENSPEC_STEPS, type OpenSpecRun, type OpenSpecStep } from '@shared/types'

export const OPENSPEC_SECTION = 'openspec'

/** A new run, as the mode starts it: Set up comes first. */
export function newOpenSpecRun(waitAfterPropose = false): OpenSpecRun {
  return { step: 'setup', change: null, waitAfterPropose, tasks: null, pr: null, startedAt: Date.now() }
}

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

const MAX_OUT = 20_000
const clip = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (${s.length - MAX_OUT} more characters)` : s)

/** Run the openspec CLI in a folder. On Windows the npm shim is openspec.cmd, which needs a shell. */
export function runOpenSpec(cwd: string, args: string[], signal?: AbortSignal, timeoutMs = 5 * 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    // A shell joins the arguments: quote each one so spaces and quotes in descriptions survive.
    const quoted = win ? args.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)) : args
    execFile(win ? 'openspec.cmd' : 'openspec', quoted, { cwd, signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, shell: win, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      if (e && (e.code === 'ENOENT' || /not recognized|not found/i.test(String(stderr)))) {
        resolve({ code: 127, stdout: '', stderr: 'The openspec CLI is not installed. Install it with `npm install -g @fission-ai/openspec@latest` (Node.js 22.12 or newer), then run this again.' })
        return
      }
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: clip(String(stdout)), stderr: clip(String(stderr)) })
    })
  })
}

/** What the agent is told while a chat is in OpenSpec mode (null once it's done or off). */
export function openspecSection(run: OpenSpecRun | null | undefined, folder: string | null): string | null {
  if (!run || run.step === 'done') return null
  const initialised = !!folder && existsSync(join(folder, 'openspec'))
  const where = `Now: ${OPENSPEC_STEP_LABEL[run.step]} (step ${OPENSPEC_STEPS.indexOf(run.step as Exclude<OpenSpecStep, 'done'>) + 1} of ${OPENSPEC_STEPS.length})${run.change ? `, change \`${run.change}\`` : ''}${run.tasks ? `, tasks ${run.tasks.done} of ${run.tasks.total}` : ''}.`
  const gate = run.waitAfterPropose
    ? run.proposalApproved
      ? 'The person has read the proposal: go on from Apply.'
      : 'The person asked to read the proposal first. Once it validates, report step "apply" with `openspec_step`: that pauses the run for them. Carry on when they reply.'
    : 'Do not stop for the person between steps. Stop only when a check still fails after two rounds of fixes, or when you need a decision only they can make (ask it with `ask_user`).'
  return [
    '## Mode: OpenSpec (automated)',
    'Take the request from proposal to pull request with OpenSpec, on your own. Run the CLI with the `openspec` tool (pass its arguments; add `--json` where the command supports it). Report each step with `openspec_step` when you start it, and with step "done" at the very end. Keep your own messages short: the step cards show the progress.',
    where,
    gate,
    '',
    `1. Set up: \`openspec version --json\`. If it is missing, install it with a shell command (\`npm install -g @fission-ai/openspec@latest\`, it needs Node.js 22.12+). ${initialised ? 'The folder already has openspec/.' : 'The folder has no openspec/ yet: run `openspec init --tools none`.'} Check \`gh auth status\` with a shell command; without gh you will finish on a branch and skip the pull request.`,
    '2. Propose: read what exists (`openspec list --specs --json`, `openspec show <spec> --json`) and map the code the request touches with read-only agents (`task`, access reader). Pick a short kebab-case change name and run `openspec new change <name> --description "<one line>" --json`. For each artifact, get its instructions (`openspec instructions <artifact> --change <name> --json`) and write it: proposal.md (why and what), design.md (how), the spec deltas under specs/ (## ADDED / MODIFIED / REMOVED Requirements, each with scenarios), and tasks.md (a numbered checklist).',
    '3. Validate: `openspec validate <name> --strict --json`. Fix every finding and run it again. After two rounds of fixes that still fail, stop and tell the person what fails.',
    '4. Apply: work through tasks.md in order (`openspec instructions apply --change <name> --json`, `openspec status --change <name> --json`). Hand tasks to agents with `task` (access writer, or operator when it must run commands; the cheapest reasoning level that gets it right), independent tasks in parallel. Tick a task in tasks.md only after checking its result. After each batch, report step "apply" with `tasks` {done, total}.',
    '5. Verify: run the project\'s tests and build, run a check (`task` with kind check) to try to break the change, and validate again with --strict. Fix what is proven, at most two rounds.',
    '6. Archive: `openspec archive <name> -y --json` (it merges the spec deltas into openspec/specs).',
    '7. Ship: with shell commands, create the branch `openspec/<name>`, commit everything with a message taken from the proposal, push it, and open a pull request with `gh pr create` (title from the proposal, the proposal as the body). Never merge it. Report its URL as `pr`.',
    'Finish with `openspec_step` step "done" and a summary: what changed, what was checked, the pull request, and anything left open.'
  ].join('\n')
}

/** Whether the run must pause before Apply for the person to read the proposal. */
export function pausesBeforeApply(run: OpenSpecRun | null | undefined): boolean {
  return !!run && run.waitAfterPropose && !run.proposalApproved
}
