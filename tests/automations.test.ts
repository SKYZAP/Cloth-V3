import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { Automation, WorkflowEvent } from '../src/shared/types'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { plainSecrets } from '../src/main/core/context'
import { createServices } from '../src/main/services'
import { makeServices, REPO } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const toolsOffered = (ctx: TranscriptContext) =>
  (ctx.messages as unknown as { role: string; toolsAdded?: { name: string }[] }[]).filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name))
const toolResults = (ctx: TranscriptContext) => ctx.messages.filter((m) => (m.role as string) === 'toolResult').map((m) => JSON.stringify(m))
const automationEvents = (events: { payload: unknown }[]) =>
  events.map((e) => e.payload as WorkflowEvent).filter((e): e is Extract<WorkflowEvent, { type: 'automation' }> => e.type === 'automation')

const base: Automation = { prompt: 'Write my morning brief.', agentId: null, tools: [], servers: [], collectionIds: [], skills: [], watch: null, commands: null }

function setup() {
  const made = makeServices()
  const provider = made.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  made.services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
  faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
  return made
}

describe('automations', () => {
  it('saves as a one-step flow on a schedule, and can be paused', () => {
    const { services } = makeServices()
    const wf = services.workflows.createAutomation({ name: 'Morning brief', automation: { ...base, tools: ['web_search', 'web_search', ''] }, cron: '0 9 * * 1-5', cronEnabled: true })
    expect(wf.automation).toMatchObject({ prompt: 'Write my morning brief.', tools: ['web_search'] })
    expect(wf.nodes.map((n) => n.type)).toEqual(['trigger', 'agent', 'output'])
    expect(wf.nodes[1].data).toMatchObject({ automation: true, prompt: 'Write my morning brief.', tools: ['web_search'] })
    expect(wf.cronEnabled).toBe(true)

    const changed = services.workflows.saveAutomation(wf.id, { automation: { ...base, prompt: 'Something else' } })
    expect(changed.nodes[1].data.prompt).toBe('Something else')
    expect(() => services.workflows.saveAutomation(wf.id, { automation: { ...base, prompt: ' ' } })).toThrow(/what the automation should do/)
    // The old delivery choice still reads, but no longer needs (or checks) anything.
    expect(services.workflows.saveAutomation(wf.id, { automation: { ...base, deliver: 'knowledge' } }).automation?.deliver).toBe('knowledge')

    const paused = services.workflows.saveAutomation(wf.id, { cronEnabled: false })
    expect(paused).toMatchObject({ cron: '0 9 * * 1-5', cronEnabled: false, nextRunAt: null })
    expect(services.workflows.saveAutomation(wf.id, { cronEnabled: true }).cronEnabled).toBe(true)
    services.workflows.stopScheduler()
  })

  it('offers the agent exactly the picked tools, knowledge and skills, and the reporting tools, with guidance on reporting', async () => {
    const { services, events } = setup()
    await services.skills.create({ name: 'brief', description: 'Morning brief format', body: 'x' })
    await services.skills.create({ name: 'other', description: 'Not picked', body: 'x' })
    const notes = services.rag.createCollection({ name: 'Notes' })
    let tools: string[] = []
    let system = ''
    faux!.setResponses([
      (ctx) => {
        tools = toolsOffered(ctx)
        system = JSON.stringify(ctx.messages.filter((m) => (m.role as string) === 'system'))
        return fauxAssistantMessage('Three things to do today.')
      }
    ])
    const chats = services.chat.list().length
    const wf = services.workflows.createAutomation({ name: 'Morning brief', automation: { ...base, tools: ['web_search', 'read'], collectionIds: [notes.id], skills: ['brief'] } })
    const run = await services.workflows.run(wf.id, undefined)
    expect(run.error).toBeNull()
    expect(run.output).toBe('Three things to do today.')
    expect(tools).toEqual(expect.arrayContaining(['web_search', 'rag_search', 'skill_use', 'report_in_chat', 'notify', 'save_to_knowledge']))
    for (const t of ['web_fetch', 'write', 'edit', 'todo_write', 'ask_user', 'tool_create', 'task']) expect(tools).not.toContain(t)
    expect(system).toContain('brief')
    expect(system).not.toContain('Not picked')
    expect(system).toContain('Decide how to report: open a chat with the result when there')
    expect(system).toContain('report nothing if there')

    // It reported nothing: the run keeps its result, but no chat is made and nobody is notified.
    expect(automationEvents(events)).toEqual([expect.objectContaining({ ok: true, notify: false, chatId: null, summary: 'Three things to do today.' })])
    expect(services.chat.list().length).toBe(chats)
    expect(services.workflows.runs(wf.id)[0]).toMatchObject({ status: 'ok', output: 'Three things to do today.' })
    services.workflows.stopScheduler()
  })

  it('reports in one chat per run: the run, then each report', async () => {
    const { services, events } = setup()
    const seen: string[][] = []
    faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('report_in_chat', { title: 'Your morning', markdown: '- **Standup** at 9' }, { id: 'c1' })], { stopReason: 'toolUse' }),
      (ctx) => {
        seen.push(toolResults(ctx))
        return fauxAssistantMessage([fauxToolCall('report_in_chat', { title: 'More', markdown: 'Also: lunch at 12.' }, { id: 'c2' })], { stopReason: 'toolUse' })
      },
      (ctx) => {
        seen.push(toolResults(ctx))
        return fauxAssistantMessage('Reported.')
      }
    ])
    const wf = services.workflows.createAutomation({ name: 'Morning brief', automation: base })
    const run = await services.workflows.run(wf.id, undefined)
    expect(run.output).toBe('Reported.')
    const done = automationEvents(events)
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ ok: true, notify: false })
    const chatId = done[0].chatId!
    expect(chatId).toMatch(/^ses_/)
    // The tool said which chat; the second call added to the same one.
    expect(seen[0].join()).toContain(`Opened the chat ${chatId}`)
    expect(seen[1].join()).toContain(`Added to the chat ${chatId}`)
    expect(services.chat.list().filter((c) => c.title === 'Your morning')).toHaveLength(1)
    expect(services.chat.get(chatId).title).toBe('Your morning')
    const text = JSON.stringify(services.chat.messages(chatId))
    expect(text).toContain('Write my morning brief.')
    expect(text).toContain('## Your morning')
    expect(text).toContain('**Standup** at 9')
    expect(text).toContain('Also: lunch at 12.')
    // The run record says how it reported, for its run history.
    expect(services.workflows.runs(wf.id)[0].reports).toEqual([{ kind: 'chat', chatId, title: 'Your morning' }])
    services.workflows.stopScheduler()
  })

  it('notifies when its agent asks to, and always when a run fails', async () => {
    const { services, events } = setup()
    faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('notify', { title: 'Build broke', body: 'main is red since 08:12.' }, { id: 'n1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.')
    ])
    const wf = services.workflows.createAutomation({ name: 'Check', automation: base })
    const chats = services.chat.list().length
    await services.workflows.run(wf.id, undefined)
    const first = automationEvents(events)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ ok: true, notify: true, chatId: null, title: 'Build broke', summary: 'main is red since 08:12.' })
    expect(services.workflows.runs(wf.id)[0].reports).toEqual([{ kind: 'notify', title: 'Build broke' }])

    const runAs = services.agents.create({ name: 'Gone' })
    services.workflows.saveAutomation(wf.id, { automation: { ...base, agentId: runAs.id } })
    services.agents.remove(runAs.id)
    await services.workflows.run(wf.id, undefined)
    const last = automationEvents(events).at(-1)
    expect(last).toMatchObject({ ok: false, notify: true, chatId: null })
    expect(services.chat.list().length).toBe(chats)
    services.workflows.stopScheduler()
  })

  it("saves to knowledge only in the automation's own collections, by name or id", async () => {
    const { services } = setup()
    const notes = services.rag.createCollection({ name: 'Notes' })
    const secret = services.rag.createCollection({ name: 'Secret' })
    const results: string[] = []
    faux!.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('save_to_knowledge', { collection: 'notes', title: 'NestJS 11', text: '# NestJS 11\n\nExpress 5 is the default.' }, { id: 'k1' }),
          fauxToolCall('save_to_knowledge', { collection: secret.id, title: 'Leak', text: 'Should not be saved.' }, { id: 'k2' }),
          fauxToolCall('save_to_knowledge', { collection: notes.id, title: 'By id', text: 'Saved by id.' }, { id: 'k3' })
        ],
        { stopReason: 'toolUse' }
      ),
      (ctx) => {
        results.push(...toolResults(ctx))
        return fauxAssistantMessage('Saved.')
      }
    ])
    const wf = services.workflows.createAutomation({ name: 'Notes', automation: { ...base, collectionIds: [notes.id] } })
    const run = await services.workflows.run(wf.id, undefined)
    expect(run.error).toBeNull()
    expect(results.join()).toContain('to Notes.')
    expect(results.join()).toContain("not one of this automation's collections")
    expect(services.rag.listDocuments(notes.id).map((d) => d.title).sort()).toEqual(['By id', 'NestJS 11'])
    expect(services.rag.listDocuments(secret.id)).toHaveLength(0)
    expect(services.workflows.runs(wf.id)[0].reports).toEqual([
      { kind: 'knowledge', collection: 'Notes', title: 'NestJS 11' },
      { kind: 'knowledge', collection: 'Notes', title: 'By id' }
    ])

    // Without collections of its own it isn't offered at all.
    let tools: string[] = []
    faux!.setResponses([
      (ctx) => {
        tools = toolsOffered(ctx)
        return fauxAssistantMessage('ok')
      }
    ])
    services.workflows.saveAutomation(wf.id, { automation: base })
    await services.workflows.run(wf.id, undefined)
    expect(tools).toEqual(expect.arrayContaining(['report_in_chat', 'notify']))
    expect(tools).not.toContain('save_to_knowledge')
    // Nothing reported: an empty list (the run history says "nothing to report").
    expect(services.workflows.runs(wf.id)[0].reports).toEqual([])
    services.workflows.stopScheduler()
  })
})

describe('the Automation project', () => {
  const reportOnce = () =>
    faux!.setResponses([fauxAssistantMessage([fauxToolCall('report_in_chat', { title: 'Your morning', markdown: 'Hi' }, { id: 'c1' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Reported.')])
  const reportedChat = async (services: ReturnType<typeof makeServices>['services'], events: { payload: unknown }[], wfId: string) => {
    reportOnce()
    await services.workflows.run(wfId, undefined)
    return services.chat.get(automationEvents(events).at(-1)!.chatId!)
  }

  it('files report_in_chat chats under it, keeping the automation folder as the workspace', async () => {
    const { services, events, dataDir } = setup()
    const wf = services.workflows.createAutomation({ name: 'Morning brief', automation: base })
    services.workflows.save(wf.id, { workspace: dataDir })
    const chat = await reportedChat(services, events, wf.id)
    const project = services.projects.list().find((p) => p.id === chat.projectId)!
    expect(project).toMatchObject({ name: 'Automation', folder: null })
    expect(chat.workspace).toBe(dataDir)
    expect(chat.origin).toEqual({ kind: 'automation', workflowId: wf.id })
    // The next run's chat goes to the same project; no second one is made.
    const next = await reportedChat(services, events, wf.id)
    expect(next.projectId).toBe(project.id)
    expect(services.projects.list().filter((p) => p.name === 'Automation')).toHaveLength(1)
    services.workflows.stopScheduler()
  })

  it('is made again when deleted, and kept when renamed', async () => {
    const { services, events } = setup()
    const wf = services.workflows.createAutomation({ name: 'Morning brief', automation: base })
    const first = await reportedChat(services, events, wf.id)
    services.projects.update(first.projectId!, { name: 'Bots' })
    const renamed = await reportedChat(services, events, wf.id)
    expect(renamed.projectId).toBe(first.projectId)
    expect(services.projects.get(first.projectId!).name).toBe('Bots')

    services.projects.remove(first.projectId!)
    const again = await reportedChat(services, events, wf.id)
    expect(again.projectId).not.toBe(first.projectId)
    expect(services.projects.get(again.projectId!).name).toBe('Automation')
    services.workflows.stopScheduler()
  })

  it('takes in chats automations made before it existed, once, at startup', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cloth-test-'))
    const open = () => createServices({ dataDir, secrets: plainSecrets, dbFile: join(dataDir, 'cloth.db'), sidecarsDir: join(REPO, 'sidecars'), examplesDir: join(REPO, 'resources', 'examples') })
    const before = open()
    const wf = before.workflows.createAutomation({ name: 'Morning brief', automation: base })
    const old = before.chat.create({})
    const filed = before.projects.create({ name: 'Mine' })
    const elsewhere = before.chat.create({ projectId: filed.id })
    const mine = before.chat.create({})
    const run = { id: 'wfr_old', workflowId: wf.id, status: 'ok', startedAt: 1, reports: [{ kind: 'chat', chatId: old.id, title: 'Old' }, { kind: 'chat', chatId: elsewhere.id, title: 'Moved' }] }
    before.ctx.db.prepare('INSERT INTO workflow_runs (id, workflow_id, data, started_at) VALUES (?, ?, ?, ?)').run(run.id, wf.id, JSON.stringify(run), 1)
    // The first startup had nothing to move; pretend this database predates the project.
    before.ctx.kv.set('automation.chatsMigrated', false)
    before.workflows.stopScheduler()

    const after = open()
    const project = after.projects.list().find((p) => p.name === 'Automation')!
    expect(after.chat.get(old.id).projectId).toBe(project.id)
    // A chat the user had already filed elsewhere, and the user's own chats, stay put.
    expect(after.chat.get(elsewhere.id).projectId).toBe(filed.id)
    expect(after.chat.get(mine.id).projectId).toBeNull()

    // Only once: a chat moved out afterwards isn't pulled back in.
    after.chat.update(old.id, { projectId: null })
    after.workflows.stopScheduler()
    const later = open()
    expect(later.chat.get(old.id).projectId).toBeNull()
    later.workflows.stopScheduler()
  })
})
