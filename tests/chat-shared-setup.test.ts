import { describe, expect, it } from 'vitest'
import { makeServices } from './helpers'

describe('shared chat setup', () => {
  it('carries a Setup change to every other chat and to new ones', () => {
    const { services, events } = makeServices()
    const a = services.chat.create({})
    const b = services.chat.create({})
    const before = services.chat.get(b.id).updatedAt
    services.chat.update(a.id, { webEnabled: true, skillsOff: ['noisy'], contextLimit: 65_536 }, { share: true })
    const other = services.chat.get(b.id)
    expect(other).toMatchObject({ webEnabled: true, skillsOff: ['noisy'], contextLimit: 65_536 })
    // Spreading the setup doesn't move the other chat up the list.
    expect(other.updatedAt).toBe(before)
    expect(events.some((e) => e.channel === 'chat' && (e.payload as { type: string }).type === 'setup')).toBe(true)
    expect(services.chat.create({})).toMatchObject({ webEnabled: true, skillsOff: ['noisy'], contextLimit: 65_536 })
    // What a new chat is asked to have still wins.
    expect(services.chat.create({ webEnabled: false }).webEnabled).toBe(false)
  })

  it('leaves agent chats, project defaults and internal changes alone', () => {
    const { services } = makeServices()
    const agent = services.agents.create({ name: 'Scout', purpose: 'Looks around.', instructions: 'x', webEnabled: false })
    const plain = services.chat.create({})
    const agentChat = services.chat.create({})
    services.chat.useAgent(agentChat.id, agent.id)
    const project = services.projects.create({ name: 'Docs', defaults: { webEnabled: false } })
    const projectChat = services.chat.create({ projectId: project.id })

    services.chat.update(plain.id, { webEnabled: true, codeIntel: false }, { share: true })
    expect(services.chat.get(agentChat.id).webEnabled).toBe(false)
    // The project decides web for its chats; the rest of the setup is shared.
    expect(services.chat.get(projectChat.id)).toMatchObject({ webEnabled: false, codeIntel: false })

    // Without `share` (Cloth's own changes, like a skill try-out chat) nothing spreads.
    services.chat.update(plain.id, { skillsAlways: ['only-here'] })
    expect(services.chat.get(projectChat.id).skillsAlways).toEqual([])
  })

  it('uses the context limit as the chat’s context window', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.providers.setModels(provider.id, [{ id: 'faux-1', name: 'faux-1', contextWindow: 200_000, maxTokens: 2048, reasoning: false, vision: false, embedding: false }])
    const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false })
    expect((await services.chat.contextUsage(chat.id)).window).toBe(200_000)
    services.chat.update(chat.id, { contextLimit: 32_768 })
    const usage = await services.chat.contextUsage(chat.id)
    expect(usage.window).toBe(32_768)
    expect(usage.estimated).toBe(false)
  })
})
