import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { Automation, WorkflowEvent } from '../src/shared/types'
import { makeServices } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const toolsOffered = (ctx: TranscriptContext) =>
  (ctx.messages as unknown as { role: string; toolsAdded?: { name: string }[] }[]).filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name))

const base: Automation = { prompt: 'Write my morning brief.', agentId: null, tools: [], servers: [], collectionIds: [], skills: [], deliver: 'chat', collectionId: null, watch: null, commands: null }

describe('automations', () => {
  it('saves as a one-step flow on a schedule, and turns into an ordinary flow on request', () => {
    const { services } = makeServices()
    const wf = services.workflows.createAutomation({ name: 'Morning brief', automation: { ...base, tools: ['web_search', 'web_search', ''] }, cron: '0 9 * * 1-5', cronEnabled: true })
    expect(wf.automation).toMatchObject({ prompt: 'Write my morning brief.', tools: ['web_search'], deliver: 'chat' })
    expect(wf.nodes.map((n) => n.type)).toEqual(['trigger', 'agent', 'output'])
    expect(wf.nodes[1].data).toMatchObject({ automation: true, prompt: 'Write my morning brief.', tools: ['web_search'] })
    expect(wf.cronEnabled).toBe(true)

    const changed = services.workflows.saveAutomation(wf.id, { automation: { ...base, prompt: 'Something else' } })
    expect(changed.nodes[1].data.prompt).toBe('Something else')
    expect(() => services.workflows.saveAutomation(wf.id, { automation: { ...base, prompt: ' ' } })).toThrow(/what the automation should do/)
    expect(() => services.workflows.saveAutomation(wf.id, { automation: { ...base, deliver: 'knowledge' } })).toThrow(/collection/)

    const flow = services.workflows.toFlow(wf.id)
    expect(flow.automation).toBeNull()
    expect(flow.nodes).toHaveLength(3)
    expect(() => services.workflows.saveAutomation(wf.id, {})).toThrow(/not an automation/)
    services.workflows.stopScheduler()
  })

  it('offers the agent exactly the picked tools, knowledge and skills, and delivers the result as a chat', async () => {
    const { services, events } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    await services.skills.create({ name: 'brief', description: 'Morning brief format', body: 'x' })
    await services.skills.create({ name: 'other', description: 'Not picked', body: 'x' })
    const notes = services.rag.createCollection({ name: 'Notes' })
    let tools: string[] = []
    let system = ''
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      (ctx) => {
        tools = toolsOffered(ctx)
        system = JSON.stringify(ctx.messages.filter((m) => (m.role as string) === 'system'))
        return fauxAssistantMessage('Three things to do today.')
      }
    ])
    const wf = services.workflows.createAutomation({ name: 'Morning brief', automation: { ...base, tools: ['web_search', 'read'], collectionIds: [notes.id], skills: ['brief'] } })
    const run = await services.workflows.run(wf.id, undefined)
    expect(run.error).toBeNull()
    expect(run.output).toBe('Three things to do today.')
    expect(tools).toEqual(expect.arrayContaining(['web_search', 'rag_search', 'skill_use']))
    for (const t of ['web_fetch', 'write', 'edit', 'todo_write', 'ask_user', 'tool_create', 'task']) expect(tools).not.toContain(t)
    expect(system).toContain('brief')
    expect(system).not.toContain('Not picked')

    const done = events.map((e) => e.payload as WorkflowEvent).find((e) => e.type === 'automation')
    expect(done).toMatchObject({ type: 'automation', ok: true, notify: false, summary: 'Three things to do today.' })
    const chatId = done?.type === 'automation' ? done.chatId : null
    expect(chatId).toBeTruthy()
    const chat = services.chat.get(chatId!)
    expect(chat.title).toBe('Morning brief')
    const text = JSON.stringify(services.chat.messages(chatId!))
    expect(text).toContain('Write my morning brief.')
    expect(text).toContain('Three things to do today.')
    services.workflows.stopScheduler()
  })

  it('notifies instead of making a chat when asked to, and always when a run fails', async () => {
    const { services, events } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([() => fauxAssistantMessage('All quiet.')])
    const wf = services.workflows.createAutomation({ name: 'Check', automation: { ...base, deliver: 'notify' } })
    await services.workflows.run(wf.id, undefined)
    const chats = services.chat.list().length
    const first = events.map((e) => e.payload as WorkflowEvent).filter((e) => e.type === 'automation')
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ ok: true, notify: true, chatId: null })

    const runAs = services.agents.create({ name: 'Gone' })
    services.workflows.saveAutomation(wf.id, { automation: { ...base, deliver: 'chat', agentId: runAs.id } })
    services.agents.remove(runAs.id)
    await services.workflows.run(wf.id, undefined)
    const last = events.map((e) => e.payload as WorkflowEvent).filter((e) => e.type === 'automation').at(-1)
    expect(last).toMatchObject({ ok: false, notify: true, chatId: null })
    expect(services.chat.list().length).toBe(chats)
    services.workflows.stopScheduler()
  })
})
