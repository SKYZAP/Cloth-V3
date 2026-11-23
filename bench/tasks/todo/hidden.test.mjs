// Hidden acceptance tests for the todo task. Never shown to the agent.
// Usage: BENCH_DIR=<the agent's project> node --test hidden.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const cli = join(resolve(process.env.BENCH_DIR ?? '.'), 'todo.mjs')
const fresh = () => join(mkdtempSync(join(tmpdir(), 'todo-hidden-')), 'todo.json')
const todo = (file, args, env = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, TODO_TODAY: '2026-03-10', ...env, TODO_FILE: file } })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}
const ok = (file, args, env) => {
  const r = todo(file, args, env)
  assert.equal(r.code, 0, `todo ${args.join(' ')} failed: ${r.err}`)
  return r.out
}
const v1 = (tasks) => {
  const f = fresh()
  writeFileSync(f, JSON.stringify(tasks, null, 2))
  return f
}
/** A list with a spread of due dates, tags and states. */
function sample() {
  const f = fresh()
  ok(f, ['add', 'Write', 'report', '--due', '2026-03-12', '--tag', 'work'])
  ok(f, ['add', 'Pay', 'rent', '--due', '2026-03-01'])
  ok(f, ['add', '--tag', 'home', 'Fix', 'tap'])
  ok(f, ['add', 'Ship', 'it', '--due', '2026-03-01', '--tag', 'work', '--tag', 'release'])
  ok(f, ['add', 'Old', 'thing', '--due', '2026-02-01', '--tag', 'home'])
  ok(f, ['done', '5'])
  return f
}

test('existing commands are unchanged', () => {
  const f = fresh()
  assert.equal(ok(f, ['list']), 'No tasks.')
  assert.equal(ok(f, ['add', 'Buy', 'milk']), 'Added #1: Buy milk')
  assert.equal(ok(f, ['done', '1']), 'Completed #1')
  assert.equal(ok(f, ['list']), '[x] #1 Buy milk')
  const missing = todo(f, ['done', '7'])
  assert.deepEqual([missing.code, missing.err], [1, 'No task #7'])
})

test('add with a due date and tags, flags anywhere in the text', () => {
  const f = fresh()
  assert.equal(ok(f, ['add', '--tag', 'work', 'Ship', '--due', '2026-03-01', 'it', '--tag', 'release']), 'Added #1: Ship it')
  assert.equal(ok(f, ['list']), '[ ] #1 Ship it (due 2026-03-01) +work +release')
})

test('a repeated tag is kept once, in the order first given', () => {
  const f = fresh()
  ok(f, ['add', 'A', '--tag', 'b', '--tag', 'a', '--tag', 'b'])
  assert.equal(ok(f, ['list']), '[ ] #1 A +b +a')
})

test('invalid due dates are refused and nothing is saved', () => {
  const f = fresh()
  for (const bad of ['2026-02-30', '2026-13-01', '26-03-01', '2026-3-1', 'tomorrow']) {
    const r = todo(f, ['add', 'X', '--due', bad])
    assert.deepEqual([r.code, r.err], [1, `Invalid due date: ${bad} (use YYYY-MM-DD)`], bad)
  }
  assert.equal(ok(f, ['list']), 'No tasks.')
})

test('a leap day is a real date', () => {
  const f = fresh()
  ok(f, ['add', 'Leap', '--due', '2028-02-29'])
  assert.equal(ok(f, ['list']), '[ ] #1 Leap (due 2028-02-29)')
})

test('invalid tags are refused and nothing is saved', () => {
  const f = fresh()
  for (const bad of ['Work', 'a_b', 'x'.repeat(21), 'café']) {
    const r = todo(f, ['add', 'X', '--tag', bad])
    assert.deepEqual([r.code, r.err], [1, `Invalid tag: ${bad}`], bad)
  }
  assert.equal(ok(f, ['list']), 'No tasks.')
  ok(f, ['add', 'Y', '--tag', 'a-1', '--tag', 'x'.repeat(20)])
})

test('a flag with no value', () => {
  const f = fresh()
  const due = todo(f, ['add', 'X', '--due'])
  assert.deepEqual([due.code, due.err], [1, 'Missing value for --due'])
  const tag = todo(f, ['add', 'X', '--tag'])
  assert.deepEqual([tag.code, tag.err], [1, 'Missing value for --tag'])
  assert.equal(ok(f, ['list']), 'No tasks.')
})

test('list --tag', () => {
  assert.equal(ok(sample(), ['list', '--tag', 'work']), '[ ] #1 Write report (due 2026-03-12) +work\n[ ] #4 Ship it (due 2026-03-01) +work +release')
})

test('list --overdue: not done, due before today (TODO_TODAY)', () => {
  const f = sample()
  assert.equal(ok(f, ['list', '--overdue']), '[ ] #2 Pay rent (due 2026-03-01)\n[ ] #4 Ship it (due 2026-03-01) +work +release')
  // Due today is not overdue.
  assert.equal(ok(f, ['list', '--overdue'], { TODO_TODAY: '2026-03-01' }), 'No matching tasks.')
})

test('list --overdue uses the local date when TODO_TODAY is unset', () => {
  const f = fresh()
  ok(f, ['add', 'Long ago', '--due', '2001-01-01'])
  ok(f, ['add', 'Far off', '--due', '2999-01-01'])
  const env = { ...process.env, TODO_FILE: f }
  delete env.TODO_TODAY
  const r = spawnSync(process.execPath, [cli, 'list', '--overdue'], { encoding: 'utf8', env })
  assert.equal(r.stdout.trim(), '[ ] #1 Long ago (due 2001-01-01)')
})

test('list --sort due: dated first, earliest first, ties by id, then the rest', () => {
  assert.equal(
    ok(sample(), ['list', '--sort', 'due']),
    ['[x] #5 Old thing (due 2026-02-01) +home', '[ ] #2 Pay rent (due 2026-03-01)', '[ ] #4 Ship it (due 2026-03-01) +work +release', '[ ] #1 Write report (due 2026-03-12) +work', '[ ] #3 Fix tap +home'].join('\n')
  )
})

test('filters combine, and work with --sort', () => {
  const f = sample()
  assert.equal(ok(f, ['list', '--tag', 'work', '--overdue']), '[ ] #4 Ship it (due 2026-03-01) +work +release')
  assert.equal(ok(f, ['list', '--sort', 'due', '--tag', 'home']), '[x] #5 Old thing (due 2026-02-01) +home\n[ ] #3 Fix tap +home')
})

test('no matches, and no tasks', () => {
  assert.equal(ok(sample(), ['list', '--tag', 'nope']), 'No matching tasks.')
  assert.equal(ok(fresh(), ['list', '--tag', 'work']), 'No tasks.')
})

test('tags: tags of tasks not done, sorted by name, with counts', () => {
  assert.equal(ok(sample(), ['tags']), 'home 1\nrelease 1\nwork 2')
  assert.equal(ok(fresh(), ['tags']), 'No tags.')
  const f = fresh()
  ok(f, ['add', 'A', '--tag', 'x'])
  ok(f, ['done', '1'])
  assert.equal(ok(f, ['tags']), 'No tags.')
})

test('saves version 2', () => {
  const f = fresh()
  ok(f, ['add', 'Ship', 'it', '--due', '2026-03-01', '--tag', 'work'])
  ok(f, ['add', 'Plain'])
  const saved = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(saved.version, 2)
  assert.deepEqual(saved.tasks, [
    { id: 1, text: 'Ship it', done: false, due: '2026-03-01', tags: ['work'] },
    { id: 2, text: 'Plain', done: false, due: null, tags: [] }
  ])
})

test('a version 1 file still loads', () => {
  const f = v1([{ id: 1, text: 'Buy milk', done: true }, { id: 4, text: 'Call Sam', done: false }])
  assert.equal(ok(f, ['list']), '[x] #1 Buy milk\n[ ] #4 Call Sam')
  assert.equal(ok(f, ['list', '--sort', 'due']), '[x] #1 Buy milk\n[ ] #4 Call Sam')
  assert.equal(ok(f, ['tags']), 'No tags.')
})

test('reading a version 1 file never changes it', () => {
  const f = v1([{ id: 1, text: 'Buy milk', done: false }])
  const before = readFileSync(f, 'utf8')
  ok(f, ['list'])
  ok(f, ['list', '--overdue'])
  ok(f, ['tags'])
  todo(f, ['add', 'Bad', '--due', 'nope'])
  todo(f, ['done', '9'])
  assert.equal(readFileSync(f, 'utf8'), before)
})

test('the next save writes version 2, keeping ids', () => {
  const f = v1([{ id: 1, text: 'Buy milk', done: true }, { id: 4, text: 'Call Sam', done: false }])
  assert.equal(ok(f, ['add', 'New', '--tag', 'home']), 'Added #5: New')
  const saved = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(saved.version, 2)
  assert.deepEqual(saved.tasks, [
    { id: 1, text: 'Buy milk', done: true, due: null, tags: [] },
    { id: 4, text: 'Call Sam', done: false, due: null, tags: [] },
    { id: 5, text: 'New', done: false, due: null, tags: ['home'] }
  ])
})

test('done on a version 1 file writes version 2', () => {
  const f = v1([{ id: 2, text: 'Call Sam', done: false }])
  assert.equal(ok(f, ['done', '2']), 'Completed #2')
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { version: 2, tasks: [{ id: 2, text: 'Call Sam', done: true, due: null, tags: [] }] })
})

test('a newer file version is refused and left alone', () => {
  const f = fresh()
  const text = JSON.stringify({ version: 3, tasks: [] })
  writeFileSync(f, text)
  for (const args of [['list'], ['add', 'X'], ['tags']]) {
    const r = todo(f, args)
    assert.deepEqual([r.code, r.err], [1, 'Unsupported todo file version: 3'], args.join(' '))
  }
  assert.equal(readFileSync(f, 'utf8'), text)
})
