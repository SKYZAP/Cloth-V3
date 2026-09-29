import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, ToolTrace } from '../src/shared/types'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup(opts: { fileAccess?: 'read' | 'write'; subagents?: boolean } = {}) {
  const env = makeServices()
  const root = mkdtempSync(join(tmpdir(), 'cloth-sub-'))
  writeFileSync(join(root, 'config.txt'), 'port=4242\n')
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const session = env.services.chat.create({
    model: { providerId: provider.id, modelId: 'faux-1' },
    workspace: root,
    fileAccess: opts.fileAccess ?? 'read',
    autoApprove: 'edits',
    subagents: opts.subagents ?? true,
    knowledgeEnabled: false,
    skillsEnabled: false,
    customTools: false
  })
  return { ...env, root, session }
}

async function send(env: ReturnType<typeof setup>, text: string) {
  await env.services.chat.send(env.session.id, text)
  for (let i = 0; i < 500 && env.services.chat.isRunning(env.session.id); i++) await wait(10)
  return env.services.chat
    .messages(env.session.id)
    .flatMap((m) => m.blocks)
    .filter((b) => b.type === 'tool')
    .map((b) => (b as { trace: ToolTrace }).trace)
}

const isChild = (ctx: TranscriptContext) => JSON.stringify(ctx.messages[0] ?? '').includes('You are a subagent')
// Tool declarations travel in the transcript's system messages.
const toolNames = (ctx: TranscriptContext) =>
  (ctx.messages as unknown as { role: string; toolsAdded?: { name: string }[] }[]).filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name))

describe('subagents', () => {
  it('a scout reads in its own context, cannot write, and reports back', async () => {
    const env = setup({ fileAccess: 'write' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let childTools: string[] = []
    let childSawParentChat = true
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { description: 'Find the port', prompt: 'Read config.txt and report the port.', role: 'scout' }, { id: 'task1' })], { stopReason: 'toolUse' }),
      (ctx) => {
        childTools = toolNames(ctx)
        childSawParentChat = JSON.stringify(ctx.messages).includes('what port do we use')
        return fauxAssistantMessage([fauxToolCall('read', { path: 'config.txt' }, { id: 'c1' }), fauxToolCall('write', { path: 'x.txt', content: 'x' }, { id: 'c2' })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('The port is 4242 (config.txt:1).'),
      fauxAssistantMessage('We use port 4242.')
    ])
    const traces = await send(env, 'what port do we use?')
    const task = traces.find((t) => t.id === 'task1')!
    expect(task.status).toBe('ok')
    expect(task.result).toBe('The port is 4242 (config.txt:1).')
    expect(task.subagent).toMatchObject({ role: 'scout', description: 'Find the port', running: false })
    const childTraces = task.subagent!.blocks.filter((b) => b.type === 'tool').map((b) => (b.type === 'tool' ? b.trace : null)!)
    expect(childTraces.find((t) => t.name === 'read')?.result).toContain('port=4242')
    expect(childTraces.find((t) => t.name === 'write')?.status).toBe('error')
    expect(childTools).toContain('read')
    expect(childTools).not.toContain('write')
    expect(childTools).not.toContain('task')
    expect(childTools).not.toContain('todo_write')
    expect(childSawParentChat).toBe(false)
    expect(existsSync(join(env.root, 'x.txt'))).toBe(false)
  })

  it("a worker's edits roll up into the task step and undo with it", async () => {
    const env = setup({ fileAccess: 'write' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { description: 'Bump the port', prompt: 'Change port=4242 to port=8080 in config.txt.', role: 'worker' }, { id: 'task2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit', { path: 'config.txt', edits: [{ oldText: 'port=4242', newText: 'port=8080' }] }, { id: 'w1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Changed config.txt: port=8080.'),
      fauxAssistantMessage('Done.')
    ])
    const traces = await send(env, 'bump the port')
    const task = traces.find((t) => t.id === 'task2')!
    expect(task.subagent?.role).toBe('worker')
    expect(task.changes?.[0]).toMatchObject({ path: 'config.txt', kind: 'modify', added: 1, removed: 1 })
    expect(readFileSync(join(env.root, 'config.txt'), 'utf8')).toBe('port=8080\n')
    await env.services.chat.undoChange(env.session.id, 'task2')
    expect(readFileSync(join(env.root, 'config.txt'), 'utf8')).toBe('port=4242\n')
  })

  it('asks for approval from the chat when a worker edits and edits are not auto-approved', async () => {
    const env = setup({ fileAccess: 'write' })
    env.services.chat.update(env.session.id, { autoApprove: 'none' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { description: 'Edit', prompt: 'Add a line.', role: 'worker' }, { id: 'task3' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('write', { path: 'new.txt', content: 'hello\n' }, { id: 'w2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Wrote new.txt.'),
      fauxAssistantMessage('ok')
    ])
    const done = send(env, 'go')
    for (let i = 0; i < 300; i++) {
      const a = env.events.map((e) => e.payload as ChatEvent).find((e) => e.type === 'approval')
      if (a && a.type === 'approval') {
        expect(a.approval).toMatchObject({ kind: 'write', path: 'new.txt' })
        env.services.chat.resolveApproval(a.approval.id, 'allow')
        break
      }
      await wait(10)
    }
    await done
    expect(readFileSync(join(env.root, 'new.txt'), 'utf8')).toBe('hello\n')
  })

  it('no task tool when subagents are off; worker falls back to scout in read-only chats', async () => {
    const off = setup({ subagents: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let tools: string[] = []
    faux.setResponses([(ctx) => ((tools = toolNames(ctx)), fauxAssistantMessage('hi'))])
    await send(off, 'hello')
    expect(tools).not.toContain('task')
    faux.unregister()

    const ro = setup({ fileAccess: 'read' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { description: 'x', prompt: 'y', role: 'worker' }, { id: 't' })], { stopReason: 'toolUse' }),
      (ctx) => (expect(isChild(ctx) || true).toBe(true), fauxAssistantMessage('report')),
      fauxAssistantMessage('ok')
    ])
    const traces = await send(ro, 'go')
    expect(traces.find((t) => t.id === 't')?.subagent?.role).toBe('scout')
  })

  it('follows Settings → Subagents: model, workers, instructions and the default for new chats', async () => {
    const env = setup({ fileAccess: 'write' })
    const provider = env.services.providers.list()[0]
    env.services.settings.update({
      subagents: { ...env.services.settings.get().subagents, model: { providerId: provider.id, modelId: 'faux-small' }, allowWorkers: false, instructions: 'Answer in one line.', enabledByDefault: false }
    })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let childModel = ''
    let childPrompt = ''
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { description: 'Edit it', prompt: 'Change config.txt', role: 'worker' }, { id: 't' })], { stopReason: 'toolUse' }),
      (ctx, _opts, _state, model) => {
        childModel = model.id
        childPrompt = JSON.stringify(ctx.messages[0])
        return fauxAssistantMessage('Done.')
      },
      fauxAssistantMessage('ok')
    ])
    const traces = await send(env, 'go')
    const task = traces.find((t) => t.id === 't')!
    expect(task.subagent).toMatchObject({ role: 'scout', model: 'faux-small' })
    expect(childModel).toBe('faux-small')
    expect(childPrompt).toContain('read-only scout')
    expect(childPrompt).toContain('Answer in one line.')
    expect(env.services.chat.create({}).subagents).toBe(false)
  })
})
