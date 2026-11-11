import type { SkillInput } from '@shared/types'
import type { Kv } from '../core/db'
import type { SkillService } from './skills'

/**
 * Skills Cloth ships with. Each is added to the skills folder once; one the user deletes or
 * edits stays that way (`builtin.skillsSeeded` remembers what was added).
 */
export const BUILTIN_SKILLS: SkillInput[] = [
  {
    name: 'penpot',
    description:
      'How to read, edit and export designs in the self-hosted Penpot through the penpot MCP server (mcp__penpot__* tools). Use whenever a chat looks at or changes a Penpot design: mocking up a screen, inspecting a design to build it, changing colours, copy or layout, or exporting a board as an image.',
    body: `# Working in Penpot

The penpot MCP server (tools named \`mcp__penpot__…\`) edits Penpot designs through Penpot's API.
Nothing has to be open in a browser, and edits land in the file straight away: they show in the
editor on reload.

## Find your way in

1. \`list_projects\` gives teams, projects and files with their ids.
2. \`list_pages\` gives a file's pages. The first call on a big file can take 20 to 30 seconds; later calls are cached.
3. \`get_page_tree\` shows the layer tree: type, name, id, absolute position, size, first fill, text.
   Start with \`depth: 1\` on big pages, then pass \`rootId\` (with \`pageId\`) to open one board.
4. \`find_shapes\` searches names and text. Pass \`pageId\` when you know it; a whole-file search is slow.
5. \`get_shape\` gives one shape's details; \`raw: true\` gives everything Penpot stores.
6. \`get_library\` lists the file's shared colours and type styles. Use them instead of inventing values.

## Make and change things

- \`create_shape\` makes a \`board\`, \`rect\`, \`ellipse\` or \`text\`. It returns the new id; keep it.
- **x and y are relative to the parent** (\`parentId\`, a board or group), or to the page when there is
  no parent. The tree shows absolute positions, so subtract the parent's position when reusing them.
- Put screens in a board on the page, and their parts inside it with \`parentId\`.
- Shapes created later sit on top.
- Text: leave out \`width\` and the box grows to fit; give \`width\` to wrap. Style with \`textStyle\`
  (\`fontFamily\` from Google Fonts, default Inter; \`fontSize\`, \`fontWeight\`, \`color\`, \`textAlign\`,
  \`lineHeight\`). New lines in \`text\` start new paragraphs.
- \`update_shape\` changes name, position, size, fill (\`null\` removes it), stroke, radius, opacity,
  hidden, text and text style. Moving a board or group moves its contents. Resizing does not scale
  children. Changing text keeps its style but flattens mixed styles into the first one.
- \`set_layout\` turns flex layout on for a board (direction, gap, padding, alignment). Penpot moves
  the children when the file is next opened in the editor, so place them sensibly yourself too.
- \`delete_shapes\` deletes shapes and everything inside them.
- \`add_page\` and \`create_file\` add pages and files.

## Library and components

- \`audit_design_system\` (read-only) reports how far a file is built from its library: unlinked
  colours and text, values off the palette or type scale, hand-built layers repeated on most boards,
  overridden copies. Whole file by default (a minute on a big file); narrow with \`pageId\`/\`boardId\`.
- \`link_library\` links fills, strokes and text to the library's colours and type styles. Exact
  matches only by default, which changes nothing visually; \`snapColors\`/\`snapType\` also move near
  values onto the library (visible). Run it with \`dryRun: true\` first and show the person the result.
- \`create_component\` makes a component from a board, or wraps several shapes (same parent) in a new
  board first. \`add_instance\` places a copy; with \`replaceShapeIds\` it takes the place of
  hand-built layers and deletes them. Copies are skipped by \`link_library\`: link the main.

## Check your work

Use \`export_shape\` on the board you changed (PNG, \`scale: 1\` or \`2\`) and look at it before saying
you are done. An export takes about 10 seconds. If it fails with "the render found nothing to draw",
the file is in a team the server's export account is not in; say so instead of retrying.

## Care

- Ask before editing a file the user has not pointed you at, and before deleting anything you did
  not make in this chat. For experiments, create a new file and say where it is.
- Edits cannot be undone through the tools. Before a big change, note the ids and values you are
  replacing so you can put them back.
- Not available yet: images, gradients, drawing paths, resizing groups or paths, editing copies.
  Say so rather than faking them with many small shapes.
`
  },
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
