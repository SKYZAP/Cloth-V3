import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { createApi } from '../src/main/api'
import { makeServices } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

describe('tools page', () => {
  it('drafts a tool from a description without saving it, with a free name', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    services.custom.create({ name: 'weather_for_city', description: 'Taken', kind: 'prompt', params: [], config: { prompt: 'x' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      () =>
        fauxAssistantMessage(
          '```json\n' +
            JSON.stringify({
              name: 'weather_for_city',
              description: 'Today’s weather for a city.',
              kind: 'http',
              params: [{ name: 'city', description: 'City name' }],
              config: { url: 'https://wttr.in/{{city}}?format=3', headers: { accept: 'text/plain' } }
            }) +
            '\n```'
        )
    ])
    const draft = await createApi(services).tools.draft('Get the weather for a city')
    expect(draft).toMatchObject({ name: 'weather_for_city_2', kind: 'http', enabled: true, params: [{ name: 'city', type: 'string', required: true }] })
    expect(draft.config.headers).toContain('"accept"')
    expect(services.custom.list()).toHaveLength(1)
    await expect(createApi(services).tools.draft('  ')).rejects.toThrow(/what the tool should do/)
  })

  it('says which agents and automations use each tool', async () => {
    const { services } = makeServices()
    const api = createApi(services)
    const notes = services.rag.createCollection({ name: 'Notes' })
    services.workflows.createAutomation({
      name: 'Morning brief',
      automation: { prompt: 'Brief me', agentId: null, tools: ['web_search'], servers: [], collectionIds: [notes.id], skills: [], deliver: 'notify', collectionId: null }
    })
    const used = await api.tools.usedBy()
    expect(used.web_search).toEqual(expect.arrayContaining(['Researcher', 'Morning brief']))
    expect(used.rag_search).toContain('Morning brief')
    // Read-only agents don't count as using tools that change files.
    expect(used.edit ?? []).not.toContain('Scout')
    expect(used.edit ?? []).not.toContain('Code reviewer')
    services.workflows.stopScheduler()
  })
})
