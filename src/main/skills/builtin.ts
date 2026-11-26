import type { SkillInput } from '@shared/types'
import type { Kv } from '../core/db'
import type { SkillService } from './skills'

/**
 * Skills Cloth ships with. Each is added to the skills folder once; one the user deletes or
 * edits stays that way (`builtin.skillsSeeded` remembers what was added).
 */
export const BUILTIN_SKILLS: SkillInput[] = [
  {
    // Adapted from pstack's create-verification-skill and maintain-verification-skill
    // (https://github.com/cursor/plugins/tree/main/pstack, MIT licence).
    name: 'verify-guide',
    description:
      "How to write and keep up a project's verification guide (docs/verify/README.md): how an agent launches the app, checks it is healthy, drives it as its user would, captures evidence and cleans up. Use when a project has no guide yet, when a guide is wrong or out of date, or when Spec → Ship's Build asks for one.",
    body: `# Writing a verification guide

A verification guide lets an agent that has never seen the project prove a feature works by using
it the way its user does, and leave evidence behind. It lives at \`docs/verify/README.md\`, with one
file per feature area under \`docs/verify/features/\`. Write it for a reader who opens it cold.

## 1. Find out how the project runs

Before writing anything, work out from the repo (README, package scripts, Makefile, Dockerfile, CI):
- the main surface: a UI in a browser, a desktop app, a CLI or TUI, an HTTP API, a library, a service;
- how it starts locally, and what signal says it is ready (a log line, a port answering, a file);
- how an agent can drive it: the project's own harness first (end-to-end tests, scripts), then a
  generic one: Playwright for web pages, a plain process for a CLI, HTTP requests for an API;
- what evidence can be captured: output, screenshots, response bodies, files or rows written;
- whether two copies can run side by side (ports, data folders), and how to give a run its own
  empty data folder.

If it doesn't build or start, fix that first (or report it): a guide for a broken build is useless.

## 2. Write docs/verify/README.md

Sections, in this order:
- **Launch**: the exact command, the readiness signal and how long to wait, how to start with an
  empty data folder or test account, and how to stop it.
- **Doctor**: a read-only check that the running copy is worth driving (health URL, version
  command, a page that must load).
- **Drive**: the recipe for using it as its user would, with real selectors, commands and URLs from
  the repo, not invented ones.
- **Evidence**: what to capture for a claim to count (the command and its output, a screenshot, the
  file or row written) and where to put it.
- **Cleanup**: stop only what this run started (never kill processes by name) and remove its
  scratch data, never the evidence.
- **Gotchas**: preconditions and traps found while proving it (logins, seeds, slow first start).

Then \`docs/verify/features/README.md\` listing 3 to 5 feature areas to start with, and one file
each with: Sub-features; How to get to it (as the user); Driving it; Gotchas.

## 3. Prove it

Run the guide once, end to end: launch, doctor, drive one mapped feature, capture its evidence,
clean up, and check the evidence survived cleanup. A guide that was never run is a draft, not a
deliverable. If you proved it somewhere that differs from the real setup, list what differs under
Gotchas: those parts are unverified.

## Rules

- Test through the real user path, never internal setters or test-only endpoints.
- Check side effects (files, rows, messages), not just what is shown.
- Mock only at boundaries the product already has (a payment provider's test mode, a fake mail
  server it ships with).
- Never weaken a step to make it pass: record the missing precondition under Gotchas instead.
- Show no secrets in the guide or the evidence: use the project's test accounts and write
  <REDACTED>.

## Keeping it up to date

When a feature changes how it is reached or driven, update its file in the same change. When a
step in the guide fails for reasons other than a real bug (a renamed selector, a new setup step),
fix the guide, prove that part again, and say so.
`
  }
]

const SEEDED_KEY = 'builtin.skillsSeeded'

/** Adds the built-in skills that are missing and were never added before. Returns their names. */
export async function seedBuiltinSkills(skills: Pick<SkillService, 'list' | 'create'>, kv: Pick<Kv, 'get' | 'set'>, builtins = BUILTIN_SKILLS): Promise<string[]> {
  const seeded = kv.get<string[]>(SEEDED_KEY, [])
  const have = new Set((await skills.list()).map((s) => s.name))
  const added: string[] = []
  for (const s of builtins) {
    if (seeded.includes(s.name) || have.has(s.name)) continue
    await skills.create(s)
    added.push(s.name)
  }
  const done = builtins.map((s) => s.name).filter((n) => seeded.includes(n) || have.has(n) || added.includes(n))
  if (done.length !== seeded.length) kv.set(SEEDED_KEY, [...new Set([...seeded, ...done])])
  return added
}
