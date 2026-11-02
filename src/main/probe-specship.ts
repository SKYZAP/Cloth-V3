// Dev-only probe (CLOTH_PROBE=specship): runs a whole Spec → Ship feature on a small fixture project with a real model,
// accepting every recommendation and approving every stage, and writes what it cost and produced to report.json.
// Model: CLOTH_PROBE_MODEL (a model id, or part of one), from the providers already set up in CLOTH_HOME.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Services } from './services'
import type { QuestionRound, UiBlock, UiMessage } from '@shared/types'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const PROBE_IDEA = [
  'Add due dates to todos.',
  '- `todo add "<text>" --due YYYY-MM-DD` stores a due date with the todo. A date that is not a real calendar date in that format prints `Invalid due date: <value>` to stderr and exits with code 1 without saving anything.',
  '- `todo list` shows a todo\'s due date after its text as ` (due YYYY-MM-DD)`. A todo that is not done and whose due date is before today shows ` (overdue)` instead.',
  '- `todo list --overdue` shows only the overdue todos.',
  '- Today\'s date comes from the TODO_TODAY environment variable (YYYY-MM-DD) when it is set, otherwise from the clock.',
  '- Todos without a due date, and todos files written before this change, keep working exactly as now.'
].join('\n')

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'todo', version: '1.0.0', type: 'module', bin: { todo: 'bin/todo.js' }, scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# todo\n\nA tiny todo list for the terminal.\n\n```\ntodo add "Buy milk"\ntodo list\ntodo done 1\n```\n\nTodos are kept in `todos.json` in the current folder, or in the file named by `TODO_FILE`.\n',
  'src/todos.js': `import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** The todos saved in \`file\` (none when it doesn't exist yet). */
export function load(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

export function save(file, todos) {
  writeFileSync(file, JSON.stringify(todos, null, 2) + '\\n')
}

/** A new list with \`text\` added as the next todo. */
export function add(todos, text) {
  if (!text || !text.trim()) throw new Error('A todo needs some text')
  const id = todos.reduce((max, t) => Math.max(max, t.id), 0) + 1
  return [...todos, { id, text: text.trim(), done: false }]
}

/** A new list with todo \`id\` marked done. */
export function complete(todos, id) {
  if (!todos.some((t) => t.id === id)) throw new Error(\`No todo with id \${id}\`)
  return todos.map((t) => (t.id === id ? { ...t, done: true } : t))
}

/** One line of \`todo list\`. */
export function format(todo) {
  return \`\${todo.done ? '[x]' : '[ ]'} \${todo.id}. \${todo.text}\`
}
`,
  'bin/todo.js': `#!/usr/bin/env node
import { add, complete, format, load, save } from '../src/todos.js'

const file = process.env.TODO_FILE ?? 'todos.json'
const [command, ...args] = process.argv.slice(2)

try {
  if (command === 'add') {
    save(file, add(load(file), args.join(' ')))
  } else if (command === 'list') {
    for (const todo of load(file)) console.log(format(todo))
  } else if (command === 'done') {
    save(file, complete(load(file), Number(args[0])))
  } else {
    console.error('Usage: todo add <text> | todo list | todo done <id>')
    process.exit(1)
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
`,
  'test/todos.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, complete, format } from '../src/todos.js'

test('add numbers todos from 1', () => {
  const todos = add(add([], 'a'), 'b')
  assert.deepEqual(todos.map((t) => t.id), [1, 2])
})

test('add refuses empty text', () => {
  assert.throws(() => add([], '  '), /needs some text/)
})

test('complete marks one todo done', () => {
  assert.equal(complete(add([], 'a'), 1)[0].done, true)
})

test('complete refuses an unknown id', () => {
  assert.throws(() => complete([], 3), /No todo with id 3/)
})

test('format shows the box, id and text', () => {
  assert.equal(format({ id: 2, text: 'Buy milk', done: true }), '[x] 2. Buy milk')
})
`,
  '.gitignore': 'node_modules\ntodos.json\n'
}

type Stage = string
interface StageStats {
  /** Replies (turns), not single model calls. */
  calls: number
  tokens: number
  cachedTokens: number
  outputTokens: number
  cost: number
  agentRuns: number
  agentTokens: number
  agentCost: number
}

function stats(messages: UiMessage[]) {
  const per: Record<Stage, StageStats> = {}
  let stage: Stage = 'start'
  const at = (s: Stage) => (per[s] ??= { calls: 0, tokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0, agentRuns: 0, agentTokens: 0, agentCost: 0 })
  const agents = (blocks: UiBlock[], s: StageStats) => {
    for (const b of blocks) {
      const run = b.type === 'tool' ? b.trace.subagent : undefined
      if (!run) continue
      s.agentRuns++
      s.agentTokens += (run.usage?.input ?? 0) + (run.usage?.cached ?? 0) + (run.usage?.output ?? 0)
      s.agentCost += run.usage?.cost ?? 0
      agents(run.blocks, s)
    }
  }
  for (const m of messages) {
    if (m.workflowStage) stage = m.workflowStage
    if (m.role !== 'assistant') continue
    const s = at(stage)
    // One reply (a turn may hold several model calls; its usage is their sum).
    s.calls++
    s.tokens += (m.usage?.input ?? 0) + (m.usage?.cached ?? 0) + (m.usage?.output ?? 0)
    s.cachedTokens += m.usage?.cached ?? 0
    s.outputTokens += m.usage?.output ?? 0
    s.cost += m.usage?.cost ?? 0
    agents(m.blocks, s)
  }
  return per
}

const acceptAll = (round: QuestionRound) => round.questions.map((q, i) => `Q${i + 1} (${q.title}): yes, ${q.recommendation}`).join('\n')

function sh(cwd: string, cmd: string, args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function listFiles(dir: string, base = ''): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.name === 'node_modules' ? [] : e.isDirectory() ? listFiles(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]))
}

export async function probeSpecShip(s: Services, outDir: string, note: (m: string) => void): Promise<void> {
  const want = process.env.CLOTH_PROBE_MODEL ?? 'gpt-6-luna'
  const provider = s.providers.list().find((p) => p.models.some((m) => m.id === want || m.id.includes(want)))
  if (!provider) throw new Error(`No provider has a model matching ${want}`)
  const model = { providerId: provider.id, modelId: provider.models.find((m) => m.id === want || m.id.includes(want))!.id }
  note(`model ${model.modelId} via ${provider.name}`)

  // The fixture project, in git.
  const ws = join(outDir, 'project')
  mkdirSync(ws, { recursive: true })
  for (const [path, text] of Object.entries(FIXTURE)) {
    mkdirSync(join(ws, path, '..'), { recursive: true })
    writeFileSync(join(ws, path), text)
  }
  const git = (...args: string[]) => sh(ws, 'git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', ...args])
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'Todo list')
  const startCommit = git('rev-parse', 'HEAD').out.trim()

  const chat = s.chat.create({ model, workspace: ws, permissions: 'auto', subagents: true, webEnabled: false, knowledgeEnabled: false, mcpServers: [] })
  const id = chat.id
  const t0 = Date.now()
  const events: string[] = []
  const log = (m: string) => {
    const line = `${((Date.now() - t0) / 1000).toFixed(0)}s ${m}`
    events.push(line)
    note(line)
  }
  await s.chat.startWorkflow(id, PROBE_IDEA)
  log('started')
  const deadline = t0 + Number(process.env.CLOTH_PROBE_MINUTES ?? 90) * 60_000
  let nudges = 0
  let idle = 0
  while (Date.now() < deadline) {
    await wait(1500)
    for (const q of s.chat.pendingQuestions(id)) {
      log(`ask_user: ${q.question.slice(0, 120)} → ${q.options[0] ?? 'your recommendation'}`)
      s.chat.answerQuestion(q.id, q.options.length ? (q.multiple ? q.options.join(', ') : q.options[0]) : 'Go with your recommendation.')
    }
    for (const a of s.chat.pendingApprovals(id)) s.chat.resolveApproval(a.id, 'allow')
    if (s.chat.isRunning(id)) {
      idle = 0
      continue
    }
    // A finished build or a clean review may go on by itself a moment after the turn ends.
    if (++idle < 3) continue
    const w = s.chat.get(id).workflow
    if (!w) break
    if (w.stage === 'done') {
      log('done')
      break
    }
    const last = s.chat.messages(id).at(-1)
    const traces = last?.role === 'assistant' ? last.blocks.flatMap((b) => (b.type === 'tool' ? [b.trace] : [])) : []
    const round = traces.findLast((t) => t.questions)?.questions
    const gate = traces.findLast((t) => t.stageGate && t.status !== 'error')?.stageGate
    if (round && !gate) {
      log(`round ${round.round}: ${round.questions.length} questions, accepting all`)
      await s.chat.send(id, acceptAll(round))
    } else if (gate) {
      log(`gate ${gate.stage}: ${gate.summary.length} lines${gate.findings ? `, ${gate.findings.length} findings (${gate.findings.filter((f) => f.fix).length} to fix)` : ''}; approving`)
      await s.chat.advanceWorkflow(id)
    } else if (nudges++ < 4) {
      log(`stage ${w.stage}: turn ended without a gate; nudging`)
      await s.chat.send(id, 'Carry on with this stage, then call finish_stage.')
    } else {
      log('gave up: no progress')
      break
    }
    idle = 0
  }
  // Let the final commit land.
  for (let i = 0; i < 40 && s.chat.isRunning(id); i++) await wait(1500)
  await wait(3000)

  const messages = s.chat.messages(id)
  const perStage = stats(messages)
  const total = Object.values(perStage).reduce((a, b) => ({ tokens: a.tokens + b.tokens + b.agentTokens, cost: a.cost + b.cost + b.agentCost, calls: a.calls + b.calls }), { tokens: 0, cost: 0, calls: 0 })
  const tests = sh(ws, 'node', ['--test'])
  const gates = messages.flatMap((m) => m.blocks).flatMap((b) => (b.type === 'tool' && b.trace.stageGate ? [b.trace.stageGate] : []))
  const report = {
    model,
    minutes: Math.round((Date.now() - t0) / 600) / 100,
    finalStage: s.chat.get(id).workflow?.stage ?? null,
    route: s.chat.get(id).workflow?.route ?? null,
    slug: s.chat.get(id).workflow?.slug ?? null,
    total,
    perStage,
    events,
    gates,
    tests: { code: tests.code, tail: tests.out.split('\n').slice(-25).join('\n') },
    commits: git('log', '--format=%h %s', `${startCommit}..HEAD`).out.trim().split('\n').filter(Boolean),
    uncommitted: git('status', '--porcelain').out.trim(),
    files: listFiles(ws)
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(outDir, 'transcript.json'), JSON.stringify(messages, null, 2))
  log(`report: ${total.tokens} tokens, $${total.cost.toFixed(3)}, tests exit ${tests.code}`)
}
