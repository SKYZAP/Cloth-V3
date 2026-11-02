import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, PendingQuestion, ToolTrace } from '../src/shared/types'
import { parseGeneratedSkill } from '../src/main/skills/skills'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup() {
  const env = makeServices()
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const model = { providerId: provider.id, modelId: 'faux-1' }
  const session = env.services.chat.create({ model, knowledgeEnabled: true, skillsEnabled: true, customTools: true, subagents: false })
  return { ...env, model, session }
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  for (let i = 0; i < ms / 10; i++) {
    const v = fn()
    if (v) return v
    await wait(10)
  }
  throw new Error('Timed out')
}

async function finish(env: ReturnType<typeof setup>) {
  for (let i = 0; i < 500 && env.services.chat.isRunning(env.session.id); i++) await wait(10)
  return env.services.chat
    .messages(env.session.id)
    .flatMap((m) => m.blocks)
    .filter((b) => b.type === 'tool')
    .map((b) => (b as { trace: ToolTrace }).trace)
}

const lastToolResult = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.at(-1) ?? '')
const toolNames = (ctx: TranscriptContext) =>
  (ctx.messages as unknown as { role: string; toolsAdded?: { name: string }[] }[]).filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name))

describe('ask_user', () => {
  it('pauses the chat until the user answers, then hands the answer to the model', async () => {
    const env = setup()
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let seen = ''
    let tools: string[] = []
    faux.setResponses([
      (ctx) => {
        tools = toolNames(ctx)
        return fauxAssistantMessage([fauxToolCall('ask_user', { question: 'Which database?', options: ['Postgres', 'SQLite', 'Postgres'] }, { id: 'ask1' })], { stopReason: 'toolUse' })
      },
      (ctx) => {
        seen = lastToolResult(ctx)
        return fauxAssistantMessage('Going with SQLite.')
      }
    ])
    await env.services.chat.send(env.session.id, 'Set up a database')
    const q = await until(() => env.services.chat.pendingQuestions(env.session.id)[0])
    expect(tools).toEqual(expect.arrayContaining(['ask_user', 'rag_index', 'skill_create', 'tool_create']))
    expect(q).toMatchObject({ question: 'Which database?', options: ['Postgres', 'SQLite'], multiple: false, allowOther: true, toolCallId: 'ask1' })
    const event = env.events.find((e) => e.channel === 'chat' && (e.payload as ChatEvent).type === 'question')
    expect((event?.payload as { question: PendingQuestion }).question.id).toBe(q.id)
    expect(env.services.chat.isRunning(env.session.id)).toBe(true)

    env.services.chat.answerQuestion(q.id, 'SQLite')
    const traces = await finish(env)
    expect(seen).toContain('The user answered: SQLite')
    expect(traces.find((t) => t.name === 'ask_user')?.status).toBe('ok')
    expect(env.services.chat.pendingQuestions(env.session.id)).toEqual([])
    expect(() => env.services.chat.answerQuestion(q.id, 'again')).toThrow(/no longer waiting/)
  })

  it('tells the model when the user skips, and gives up when the chat is stopped', async () => {
    const env = setup()
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let seen = ''
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ask_user', { question: 'Name?' }, { id: 'a1' })], { stopReason: 'toolUse' }),
      (ctx) => {
        seen = lastToolResult(ctx)
        return fauxAssistantMessage([fauxToolCall('ask_user', { question: 'Colour?' }, { id: 'a2' })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('ok')
    ])
    await env.services.chat.send(env.session.id, 'Go')
    const q1 = await until(() => env.services.chat.pendingQuestions(env.session.id)[0])
    env.services.chat.answerQuestion(q1.id, '   ')
    await until(() => env.services.chat.pendingQuestions(env.session.id).find((q) => q.question === 'Colour?'))
    expect(seen).toContain('skipped this question')
    await env.services.chat.abort(env.session.id)
    await finish(env)
    expect(env.services.chat.pendingQuestions(env.session.id)).toEqual([])
    expect(env.services.chat.isRunning(env.session.id)).toBe(false)
  })
})

describe('hub tools in chat', () => {
  it('creates tools from a chat: http right away, command only after review', async () => {
    const env = setup()
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('tool_create', { name: 'status_page', description: 'Fetch the status page', kind: 'http', config: { url: 'https://status.example.com' } }, { id: 't1' }),
          fauxToolCall('tool_create', { name: 'disk_usage', description: 'Disk usage', kind: 'command', config: { command: 'df' } }, { id: 't2' }),
          fauxToolCall('tool_create', { name: 'read', description: 'Clash with a built-in', kind: 'prompt', config: { prompt: 'x' } }, { id: 't3' })
        ],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('Done.')
    ])
    await env.services.chat.send(env.session.id, 'Make me some tools')
    // The command tool asks first (the chat is in Manual mode); declined, it stays off.
    const ask = await until(() => env.services.chat.pendingApprovals(env.session.id)[0])
    expect(ask).toMatchObject({ kind: 'tool', command: 'df', risk: 'Runs code on this PC, in any chat that calls it' })
    env.services.chat.resolveApproval(ask.id, 'deny')
    const traces = await finish(env)
    expect(env.services.custom.findByName('status_page')).toMatchObject({ enabled: true, createdBy: 'chat' })
    expect(env.services.custom.findByName('disk_usage')).toMatchObject({ enabled: false, createdBy: 'chat' })
    expect(traces.find((t) => t.id === 't2')?.result).toContain('disabled until the user reviews')
    expect(traces.find((t) => t.id === 't3')?.status).toBe('error')
    expect(env.events.filter((e) => e.channel === 'tools')).toHaveLength(2)
  })

  it('switches a code tool on when the person approves it (or at once in Auto), and other chats can then use it', async () => {
    const env = setup()
    const other = env.services.chat.create({ model: env.model, customTools: true })
    const auto = env.services.chat.create({ model: env.model, customTools: true, permissions: 'auto' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: TranscriptContext[] = []
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('tool_create', { name: 'reverse_text', description: 'Reverse text', kind: 'javascript', params: [{ name: 'text' }], config: { code: 'return args.text.split("").reverse().join("")' } }, { id: 'c' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Made it.'),
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('reverse_text', { text: 'hello' }, { id: 'r' })], { stopReason: 'toolUse' })),
      fauxAssistantMessage('olleh'),
      fauxAssistantMessage([fauxToolCall('tool_create', { name: 'disk_free', description: 'Disk free', kind: 'command', config: { command: 'df' } }, { id: 'a' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Made it.')
    ])
    await env.services.chat.send(env.session.id, 'Make a tool that reverses text')
    const ask = await until(() => env.services.chat.pendingApprovals(env.session.id)[0])
    env.services.chat.resolveApproval(ask.id, 'allow')
    const made = (await finish(env)).find((t) => t.id === 'c')
    expect(made?.result).toContain('in this chat and any other')
    expect(env.services.custom.findByName('reverse_text')).toMatchObject({ enabled: true })

    // Another chat is offered the tool and can call it.
    await env.services.chat.send(other.id, 'Reverse hello')
    for (let i = 0; i < 500 && env.services.chat.isRunning(other.id); i++) await wait(10)
    expect(JSON.stringify(seen[0])).toContain('"name":"reverse_text"')
    const call = env.services.chat.messages(other.id).flatMap((m) => m.blocks).find((b) => b.type === 'tool' && b.trace.id === 'r')
    expect(call?.type === 'tool' && call.trace).toMatchObject({ status: 'ok', result: expect.stringContaining('olleh') })

    // A chat in Auto switches it on without asking.
    await env.services.chat.send(auto.id, 'Make a disk tool')
    for (let i = 0; i < 500 && env.services.chat.isRunning(auto.id); i++) await wait(10)
    expect(env.services.chat.pendingApprovals(auto.id)).toEqual([])
    expect(env.services.custom.findByName('disk_free')).toMatchObject({ enabled: true })
  })

  it('says a clashing tool is switched off rather than only that it exists', async () => {
    const env = setup()
    env.services.custom.create({ name: 'reverse_text', description: 'x', kind: 'javascript', params: [], config: { code: 'return 1' }, enabled: false }, 'chat')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([fauxAssistantMessage([fauxToolCall('tool_create', { name: 'reverse_text', description: 'Reverse', kind: 'prompt', config: { prompt: 'x' } }, { id: 'd' })], { stopReason: 'toolUse' }), fauxAssistantMessage('ok')])
    await env.services.chat.send(env.session.id, 'Make it')
    const t = (await finish(env)).find((x) => x.id === 'd')
    expect(t?.result).toContain('It is switched off: the user can turn it on on the Tools page.')
  })
})

describe('skill generation', () => {
  it('parses a model-written SKILL.md, fenced or not', () => {
    const md = '---\nname: Drizzle Migrations\ndescription: Write Drizzle migrations. Use when changing the schema.\nversion: 1\n---\n\n# Drizzle\n\n1. Run drizzle-kit generate.'
    expect(parseGeneratedSkill(md)).toMatchObject({ name: 'drizzle-migrations', description: 'Write Drizzle migrations. Use when changing the schema.', frontmatter: { version: 1 } })
    expect(parseGeneratedSkill('Here you go:\n```markdown\n' + md + '\n```').body).toContain('drizzle-kit generate')
    expect(() => parseGeneratedSkill('I cannot help with that.')).toThrow(/usable SKILL.md/)
  })

  it('writes and saves a skill from a request, under a free name', async () => {
    const env = setup()
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let prompt = ''
    const reply = (ctx: TranscriptContext) => {
      prompt = JSON.stringify(ctx.messages)
      return fauxAssistantMessage('---\nname: git-hygiene\ndescription: Keep commits clean. Use before committing.\n---\n\n# Git hygiene\n\n1. Stage hunks, not files.')
    }
    faux.setResponses([reply, reply])
    const first = await env.services.skills.generate({ request: 'Help me keep git commits tidy', model: env.model })
    expect(first.name).toBe('git-hygiene')
    expect(first.body).toContain('Stage hunks')
    expect(prompt).toContain('Help me keep git commits tidy')
    const second = await env.services.skills.generate({ request: 'Same again', model: env.model })
    expect(second.name).toBe('git-hygiene-2')
    expect(prompt).toContain('git-hygiene')
    expect(env.events.filter((e) => e.channel === 'skills' && (e.payload as { type: string }).type === 'changed')).toHaveLength(2)
  })
})
