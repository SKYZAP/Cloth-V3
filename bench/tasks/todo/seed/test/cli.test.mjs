import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = join(import.meta.dirname, '..', 'todo.mjs')
const todo = (file, ...args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, TODO_FILE: file } })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}
const fresh = () => join(mkdtempSync(join(tmpdir(), 'todo-')), 'todo.json')

test('add, list and complete tasks', () => {
  const f = fresh()
  assert.equal(todo(f, 'list').out, 'No tasks.')
  assert.equal(todo(f, 'add', 'Buy', 'milk').out, 'Added #1: Buy milk')
  assert.equal(todo(f, 'add', 'Call Sam').out, 'Added #2: Call Sam')
  assert.equal(todo(f, 'done', '1').out, 'Completed #1')
  assert.equal(todo(f, 'list').out, '[x] #1 Buy milk\n[ ] #2 Call Sam')
})

test('unknown task', () => {
  const r = todo(fresh(), 'done', '9')
  assert.equal(r.code, 1)
  assert.equal(r.err, 'No task #9')
})
