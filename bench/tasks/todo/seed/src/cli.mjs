import { load, nextId, save } from './store.mjs'

const USAGE = 'Usage: todo add <text> | todo list | todo done <id>'

/** Runs one command; returns the exit code. */
export function main(args, io) {
  const [command, ...rest] = args
  try {
    switch (command) {
      case 'add':
        return add(rest, io)
      case 'list':
        return list(io)
      case 'done':
        return done(rest, io)
      default:
        io.err(USAGE)
        return 1
    }
  } catch (err) {
    io.err(`Error: ${err.message}`)
    return 1
  }
}

function add(rest, io) {
  const text = rest.join(' ').trim()
  if (!text) {
    io.err('Task text is required')
    return 1
  }
  const tasks = load()
  const task = { id: nextId(tasks), text, done: false }
  tasks.push(task)
  save(tasks)
  io.out(`Added #${task.id}: ${task.text}`)
  return 0
}

function list(io) {
  const tasks = load()
  if (!tasks.length) {
    io.out('No tasks.')
    return 0
  }
  for (const t of tasks) io.out(`[${t.done ? 'x' : ' '}] #${t.id} ${t.text}`)
  return 0
}

function done(rest, io) {
  const id = Number(rest[0])
  const tasks = load()
  const task = tasks.find((t) => t.id === id)
  if (!task) {
    io.err(`No task #${rest[0] ?? ''}`)
    return 1
  }
  task.done = true
  save(tasks)
  io.out(`Completed #${task.id}`)
  return 0
}
