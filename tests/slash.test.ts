import { describe, expect, it } from 'vitest'
import { fauxAssistantMessage, type Context } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'
import { invokedSkills, slashAt, unknownSkills } from '../src/shared/slash'

describe('slash-invoked skills', () => {
  it('sends the skill instructions to the model but shows only a chip in the UI', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'commit-style', description: 'Write conventional commits', body: 'Use the form type(scope): subject. SECRET-MARKER' })
    const seen: Context[] = []
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-slash' })
    faux.setResponses([
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage('feat(chat): add slash commands')
      }
    ])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false })
      await services.chat.send(chat.id, 'Commit message for the new composer', ['commit-style'])
      for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 20))

      const sentToModel = JSON.stringify(seen[0].messages.at(-1))
      expect(sentToModel).toContain('SECRET-MARKER')
      expect(sentToModel).toContain('Commit message for the new composer')

      const [user, assistant] = services.chat.messages(chat.id)
      expect(user.skills).toEqual(['commit-style'])
      expect(user.blocks).toEqual([{ type: 'text', text: 'Commit message for the new composer' }])
      expect(assistant.blocks[0]).toMatchObject({ type: 'text', text: 'feat(chat): add slash commands' })
      expect(services.chat.get(chat.id).title).toBe('Commit message for the new composer')
    } finally {
      faux.unregister()
    }
  })

  it('allows invoking a skill with no extra text', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'standup', description: 'Daily standup', body: 'Yesterday / today / blockers.' })
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-slash-2' })
    faux.setResponses([fauxAssistantMessage('ok')])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' } })
      await services.chat.send(chat.id, '', ['standup'])
      for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 20))
      const [user] = services.chat.messages(chat.id)
      expect(user.skills).toEqual(['standup'])
      expect(services.chat.get(chat.id).title).toBe('/standup')
    } finally {
      faux.unregister()
    }
  })

  it('keeps an inline /name in the text and applies the skill when nothing else is written', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'standup', description: 'Daily standup', body: 'Yesterday / today / blockers.' })
    const seen: Context[] = []
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-slash-3' })
    faux.setResponses([(ctx) => (seen.push(ctx), fauxAssistantMessage('ok')), (ctx) => (seen.push(ctx), fauxAssistantMessage('ok'))])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' } })
      const wait = async () => {
        for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 20))
      }
      await services.chat.send(chat.id, '/standup', ['standup'])
      await wait()
      expect(JSON.stringify(seen[0].messages.at(-1))).toContain('Apply the /standup skill.')
      await services.chat.send(chat.id, 'Use /standup for Friday', ['standup'])
      await wait()
      const last = services.chat.messages(chat.id).at(-2)!
      expect(last.blocks).toEqual([{ type: 'text', text: 'Use /standup for Friday' }])
      expect(last.skills).toEqual(['standup'])
    } finally {
      faux.unregister()
    }
  })
})

describe('chat setup', () => {
  it('sends Always skills with every request, hides Off ones, and drops switched-off tools', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'house-style', description: 'Our writing style', body: 'ALWAYS-MARKER: short sentences.' })
    await services.skills.create({ name: 'hidden', description: 'Should not be listed', body: 'x' })
    await services.skills.create({ name: 'listed', description: 'Listed normally', body: 'LISTED-BODY' })
    const seen: Context[] = []
    const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-setup' })
    faux.setResponses([(ctx) => (seen.push(ctx), fauxAssistantMessage('ok'))])
    try {
      const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      const chat = services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, webEnabled: true, knowledgeEnabled: false })
      services.chat.update(chat.id, { skillsAlways: ['house-style'], skillsOff: ['hidden'], disabledTools: ['web_fetch'] })
      await services.chat.send(chat.id, 'hi')
      for (let i = 0; i < 100 && services.chat.isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 20))
      const system = (seen[0].systemPrompt ?? '') + JSON.stringify(seen[0].messages.filter((m) => (m.role as string) === 'system'))
      expect(system).toContain('ALWAYS-MARKER')
      expect(system).toContain('- listed: Listed normally')
      expect(system).not.toContain('LISTED-BODY')
      expect(system).not.toContain('- hidden:')
      const names = (seen[0].messages as unknown as { role: string; toolsAdded?: { name: string }[] }[]).filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name))
      expect(names).toContain('web_search')
      expect(names).not.toContain('web_fetch')

      const setup = await services.chat.setup(chat.id)
      expect(setup.tools.find((t) => t.name === 'web_fetch')).toMatchObject({ on: false })
      expect(setup.tools.find((t) => t.name === 'web_search')).toMatchObject({ on: true })
      expect(setup.tools.find((t) => t.name === 'web_search')!.tokens).toBeGreaterThan(10)
      expect(setup.skills.find((s) => s.name === 'house-style')).toMatchObject({ mode: 'always' })
      expect(setup.skills.find((s) => s.name === 'hidden')).toMatchObject({ mode: 'off' })
      const listed = setup.skills.find((s) => s.name === 'listed')!
      expect(listed.mode).toBe('auto')
      expect(listed.listedTokens).toBeLessThan(listed.fullTokens + 10)
    } finally {
      faux.unregister()
    }
  })

  it('lists tools a switched-off group would add, as off', async () => {
    const { services } = makeServices()
    const chat = services.chat.create({ webEnabled: false })
    const setup = await services.chat.setup(chat.id)
    expect(setup.tools.find((t) => t.name === 'web_search')).toMatchObject({ on: false })
  })
})

describe('inline skill names', () => {
  const known = new Set(['ui-ux-pro-max', 'frontend-design'])
  it('finds invoked skills and unknown names', () => {
    expect(invokedSkills('/frontend-design make it calmer, then /ui-ux-pro-max', known)).toEqual(['frontend-design', 'ui-ux-pro-max'])
    expect(invokedSkills('see src/frontend-design and a/frontend-design', known)).toEqual([])
    expect(unknownSkills('try /foo and /frontend-design but not /usr/bin', known)).toEqual(['/foo'])
  })
  it('finds the name being typed at the caret', () => {
    expect(slashAt('check this, then /ui', 20)).toEqual({ query: 'ui', start: 17, end: 20 })
    expect(slashAt('check this, then /ui-ux rest', 20)).toEqual({ query: 'ui', start: 17, end: 23 })
    expect(slashAt('a/b', 3)).toBeNull()
  })
})
