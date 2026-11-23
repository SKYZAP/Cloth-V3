import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Where the tasks live: $TODO_FILE, or todo.json in the current folder. */
export const storePath = () => resolve(process.env.TODO_FILE ?? 'todo.json')

/** The saved tasks, oldest first: [{ id, text, done }]. A missing file is an empty list. */
export function load(path = storePath()) {
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function save(tasks, path = storePath()) {
  writeFileSync(path, `${JSON.stringify(tasks, null, 2)}\n`)
}

/** The next free id: one more than the highest so far (ids are never reused). */
export const nextId = (tasks) => tasks.reduce((n, t) => Math.max(n, t.id), 0) + 1
