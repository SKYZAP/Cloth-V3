import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ToolTrace } from '../src/shared/types'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const systemText = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.filter((m) => (m.role as string) === 'system'))

describe('agents', () => {
  it('starts with scout, worker and designer built in, which can be edited but not deleted', () => {
    const { services } = makeServices()
    const list = services.agents.list()
    expect(list.map((a) => a.builtin)).toEqual(['designer', 'scout', 'worker'])
    const scout = services.agents.builtin('scout')
    expect(() => services.agents.remove(scout.id)).toThrow(/built in/)
    const edited = services.agents.update(scout.id, { name: 'Renamed', instructions: 'Cite files as path:line.', fileAccess: 'write', asChat: true })
    expect(edited.name).toBe('Scout')
    expect(edited.instructions).toBe('Cite files as path:line.')
    expect(edited.fileAccess).toBe('read')
    expect(edited.asChat).toBe(false)
  })

  it('creates agents from templates with unique names', () => {
    const { services } = makeServices()
    const a = services.agents.create({ template: 'researcher' })
    expect(a).toMatchObject({ name: 'Researcher', webEnabled: true, fileAccess: 'read', builtin: null })
    expect(a.instructions).toContain('cite each claim')
    const b = services.agents.create({ template: 'researcher' })
    expect(b.name).toBe('Researcher 2')
    expect(() => services.agents.update(b.id, { name: 'researcher' })).toThrow(/already/)
  })

  it('sets a chat up from an agent and sends its instructions', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const agent = services.agents.create({ name: 'Reviewer', purpose: 'Reviews code.', instructions: 'AGENT-MARKER: be strict.', webEnabled: true, skillsAlways: ['x'], fileAccess: 'write' })
    const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false, workspace: mkdtempSync(join(tmpdir(), 'cloth-agent-')), fileAccess: 'read' })
    const set = services.chat.useAgent(chat.id, agent.id)
    expect(set).toMatchObject({ agentId: agent.id, webEnabled: true, skillsAlways: ['x'] })
    // A chat that may only read keeps that, whatever the agent may do.
    expect(set.fileAccess).toBe('read')

    const seen: TranscriptContext[] = []
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([(ctx) => (seen.push(ctx), fauxAssistantMessage('ok'))])
    await services.chat.send(chat.id, 'hi')
    for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await wait(10)
    expect(systemText(seen[0])).toContain('AGENT-MARKER')
    expect(systemText(seen[0])).toContain('working as the')
    expect(systemText(seen[0])).not.toContain('- Reviewer: Reviews code.')

    expect(services.chat.useAgent(chat.id, null).agentId).toBeNull()
  })

  it('lets the main agent delegate to a saved agent by name', async () => {
    const env = makeServices()
    const { services } = env
    const root = mkdtempSync(join(tmpdir(), 'cloth-agent-'))
    writeFileSync(join(root, 'notes.txt'), 'hello\n')
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.agents.create({ name: 'Note taker', purpose: 'Summarises notes.', instructions: 'DELEGATE-MARKER', fileAccess: 'read' })
    const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: root, fileAccess: 'write', autoApprove: 'edits', subagents: true, knowledgeEnabled: false, skillsEnabled: false, customTools: false })
    let parentSystem = ''
    let childSystem = ''
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      (ctx) => {
        parentSystem = systemText(ctx)
        return fauxAssistantMessage([fauxToolCall('task', { description: 'Summarise notes', prompt: 'Read notes.txt and summarise it.', agent: 'note taker' }, { id: 't1' })], { stopReason: 'toolUse' })
      },
      (ctx) => {
        childSystem = systemText(ctx)
        return fauxAssistantMessage('It says hello.')
      },
      fauxAssistantMessage('Done.')
    ])
    await services.chat.send(chat.id, 'summarise my notes')
    for (let i = 0; i < 300 && services.chat.isRunning(chat.id); i++) await wait(10)
    expect(parentSystem).toContain('- Note taker: Summarises notes.')
    expect(childSystem).toContain('DELEGATE-MARKER')
    expect(childSystem).toContain('read-only scout')
    const task = services.chat
      .messages(chat.id)
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool')
      .map((b) => (b as { trace: ToolTrace }).trace)
      .find((t) => t.id === 't1')!
    expect(task.status).toBe('ok')
    expect(task.subagent).toMatchObject({ agent: 'Note taker', role: 'scout' })
  })

  it('hands design work to the built-in Designer, with its design skills always on', async () => {
    const { services } = makeServices()
    for (const name of ['ui-ux-pro-max', 'frontend-design', 'web-design-guidelines']) await services.skills.create({ name, description: `${name} rules`, body: `${name.toUpperCase()}-BODY` })
    const designer = services.agents.builtin('designer')
    expect(designer).toMatchObject({ name: 'Designer', asSubagent: true, asChat: false, fileAccess: 'write', skillsAlways: ['ui-ux-pro-max', 'frontend-design', 'web-design-guidelines'] })
    expect(() => services.agents.remove(designer.id)).toThrow(/built in/)
    // Its skills and instructions can be changed; it stays a subagent.
    expect(services.agents.update(designer.id, { asChat: true, asSubagent: false }).asSubagent).toBe(true)

    const root = mkdtempSync(join(tmpdir(), 'cloth-agent-'))
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: root, fileAccess: 'write', autoApprove: 'edits', subagents: true, knowledgeEnabled: false, skillsEnabled: false, customTools: false })
    let parentSystem = ''
    let childSystem = ''
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      (ctx) => {
        parentSystem = systemText(ctx)
        return fauxAssistantMessage([fauxToolCall('task', { description: 'Design the page', prompt: 'Build a landing page.', agent: 'Designer' }, { id: 't1' })], { stopReason: 'toolUse' })
      },
      (ctx) => {
        childSystem = systemText(ctx)
        return fauxAssistantMessage('Built it.')
      },
      fauxAssistantMessage('Done.')
    ])
    await services.chat.send(chat.id, 'make me a landing page')
    for (let i = 0; i < 300 && services.chat.isRunning(chat.id); i++) await wait(10)
    expect(parentSystem).toContain('- Designer: Designs and builds UI')
    // Scout and worker stay plain roles, not named agents.
    expect(parentSystem).not.toContain('- Scout:')
    for (const name of ['ui-ux-pro-max', 'frontend-design', 'web-design-guidelines']) {
      expect(childSystem).toContain(`## Skill: ${name} (always on)`)
      expect(childSystem).toContain(`${name.toUpperCase()}-BODY`)
    }
    expect(childSystem).toContain('DESIGN.md')
    const task = services.chat
      .messages(chat.id)
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool')
      .map((b) => (b as { trace: ToolTrace }).trace)
      .find((t) => t.id === 't1')!
    expect(task.subagent).toMatchObject({ agent: 'Designer', role: 'worker' })
  })

  it('refuses to delegate to an agent that does not exist', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.agents.create({ name: 'Helper' })
    const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, subagents: true, knowledgeEnabled: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([fauxAssistantMessage([fauxToolCall('task', { description: 'x', prompt: 'y', agent: 'Nobody' }, { id: 't1' })], { stopReason: 'toolUse' }), fauxAssistantMessage('ok')])
    await services.chat.send(chat.id, 'go')
    for (let i = 0; i < 300 && services.chat.isRunning(chat.id); i++) await wait(10)
    const task = services.chat
      .messages(chat.id)
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool')
      .map((b) => (b as { trace: ToolTrace }).trace)
      .find((t) => t.id === 't1')!
    expect(task.status).toBe('error')
    expect(task.result).toMatch(/no agent called "Nobody"/)
  })

  it('runs a saved agent as a flow step, and writes it into the step for an export', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    await services.skills.create({ name: 'keep', description: 'Kept', body: 'x' })
    await services.skills.create({ name: 'drop', description: 'Dropped', body: 'x' })
    const agent = services.agents.create({ name: 'Summariser', purpose: 'Summarises text.', instructions: 'FLOW-AGENT-MARKER', webEnabled: true, skillsOff: ['drop'], model: { providerId: provider.id, modelId: 'faux-1' } })
    let system = ''
    let tools: string[] = []
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      (ctx) => {
        system = systemText(ctx)
        tools = (ctx.messages as unknown as { role: string; toolsAdded?: { name: string }[] }[]).filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name))
        return fauxAssistantMessage('Short summary.')
      }
    ])
    const wf = services.workflows.create({ name: 'Summarise' })
    services.workflows.save(wf.id, {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 'trigger' } },
        { id: 'a', type: 'agent', position: { x: 1, y: 0 }, data: { key: 'agent', prompt: 'Summarise {{input.text}}', agentId: agent.id, system: 'Keep it short.' } }
      ],
      edges: [{ id: 'e', source: 't', target: 'a' }]
    })
    const run = await services.workflows.run(wf.id, { text: 'hello' })
    expect(run.error).toBeNull()
    expect(system).toContain('FLOW-AGENT-MARKER')
    expect(system).toContain('Keep it short.')
    expect(system).toContain('- keep: Kept')
    expect(system).not.toContain('- drop:')
    expect(tools).toContain('web_search')

    const inlined = await services.workflows.withAgentsInlined(services.workflows.get(wf.id))
    const step = inlined.nodes.find((n) => n.id === 'a')!
    expect(step.data.agentId).toBeUndefined()
    expect(step.data).toMatchObject({ webEnabled: true, skills: ['keep'] })
    expect(String(step.data.system)).toContain('FLOW-AGENT-MARKER')

    services.agents.remove(agent.id)
    const failed = await services.workflows.run(wf.id, { text: 'hello' })
    expect(failed.error).toMatch(/was deleted/)
  })
})
