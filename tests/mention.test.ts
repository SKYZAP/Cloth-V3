import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxToolCall, type Context, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ToolTrace } from '../src/shared/types'
import { makeServices } from './helpers'
import { agentSlug, mentionAt, mentionedAgents } from '../src/shared/mention'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Tool declarations travel in the transcript's system messages.
const toolsOf = (ctx: Context) =>
  ((ctx as unknown as TranscriptContext).messages as unknown as { role: string; toolsAdded?: { name: string; description?: string }[] }[]).filter((m) => m.role === 'system').flatMap((m) => m.toolsAdded ?? [])

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

describe('agent mention helpers', () => {
  it('slugs an agent name', () => {
    expect(agentSlug('Code reviewer')).toBe('code-reviewer')
    expect(agentSlug('UI  Reviewer (v2)!')).toBe('ui-reviewer-v2')
    expect(agentSlug('note_taker')).toBe('note-taker')
  })

  it('finds tagged agents at word starts only, once each, in order', () => {
    const known = new Set(['code-reviewer', 'designer'])
    expect(mentionedAgents('@code-reviewer please review this', known)).toEqual(['code-reviewer'])
    expect(mentionedAgents('ask @Designer then @code-reviewer and @designer again', known)).toEqual(['designer', 'code-reviewer'])
    expect(mentionedAgents('mail a@designer or me@code-reviewer.com', known)).toEqual([])
    expect(mentionedAgents('@nobody here', known)).toEqual([])
    expect(mentionedAgents('@code-reviewer.', known)).toEqual([])
  })

  it('reads the @query before the caret', () => {
    expect(mentionAt('@co', 3)).toEqual({ query: 'co', start: 0, end: 3 })
    expect(mentionAt('hi @Code-rev', 7)).toEqual({ query: 'cod', start: 3, end: 12 })
    expect(mentionAt('hi @', 4)).toEqual({ query: '', start: 3, end: 4 })
    expect(mentionAt('me@site', 7)).toBeNull()
    expect(mentionAt('@code done', 10)).toBeNull()
  })
})

describe('tagging an agent in a chat', () => {
  it('hands the request to the tagged agent with task, hides the hand-off block and lists the agent', async () => {
    const { services } = makeServices()
    services.agents.create({ name: 'Code reviewer', purpose: 'Reviews code.', instructions: 'Be strict.' })
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    // Subagents off: the tag still brings the task tool for this message.
    const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false, skillsEnabled: false, subagents: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage([fauxToolCall('task', { description: 'Review the change', prompt: 'Review the diff.', agent: 'Code reviewer' }, { id: 't1' })], { stopReason: 'toolUse' })
      },
      () => fauxAssistantMessage('Looks fine.'),
      () => fauxAssistantMessage('The reviewer says it looks fine.')
    ])
    await services.chat.send(chat.id, '@code-reviewer please review this', [], [], ['Code reviewer', 'Gone agent'])
    for (let i = 0; i < 300 && services.chat.isRunning(chat.id); i++) await wait(10)

    const sent = JSON.stringify(seen[0].messages.at(-1))
    expect(sent).toContain('<agent-mention name=\\"Code reviewer\\">')
    expect(sent).toContain('The user tagged @code-reviewer. Hand this request to the Code reviewer agent now with the task tool (agent: \\"Code reviewer\\")')
    expect(sent).not.toContain('Gone agent')
    expect(sent).toContain('@code-reviewer please review this')
    const task0 = toolsOf(seen[0]).find((t) => t.name === 'task')
    expect(task0).toBeDefined()
    expect(JSON.stringify(task0)).toContain('Code reviewer')

    const [user, assistant] = services.chat.messages(chat.id)
    expect(user.agents).toEqual(['Code reviewer'])
    expect(user.blocks).toEqual([{ type: 'text', text: '@code-reviewer please review this' }])
    const task = assistant.blocks.find((b): b is { type: 'tool'; trace: ToolTrace } => b.type === 'tool')!.trace
    expect(task.subagent).toMatchObject({ agent: 'Code reviewer' })
    expect(services.chat.get(chat.id).title).toBe('@code-reviewer please review this')
    expect(services.chat.list().find((s) => s.id === chat.id)?.preview).not.toContain('agent-mention')
  })

  it('drops a tag for an agent that no longer exists and sends plain text', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false, subagents: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([(ctx) => (seen.push(ctx), fauxAssistantMessage('ok'))])
    await services.chat.send(chat.id, '@ghost hi', [], [], ['Ghost'])
    for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await wait(10)
    expect(JSON.stringify(seen[0].messages.at(-1))).not.toContain('agent-mention')
    expect(toolsOf(seen[0]).map((t) => t.name)).not.toContain('task')
    const [user] = services.chat.messages(chat.id)
    expect(user.agents).toBeUndefined()
    expect(user.blocks).toEqual([{ type: 'text', text: '@ghost hi' }])
  })
})
