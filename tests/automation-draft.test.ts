import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServices } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup() {
  const made = makeServices()
  const provider = made.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  made.services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
  faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
  return made
}

const asked = (ctx: TranscriptContext) => JSON.stringify(ctx.messages)

describe('drafting an automation', () => {
  it('maps a valid reply through, with only things that exist', async () => {
    const { services } = setup()
    await services.skills.create({ name: 'brief', description: 'Morning brief format', body: 'x' })
    const notes = services.rag.createCollection({ name: 'Notes' })
    const folder = mkdtempSync(join(tmpdir(), 'cloth-draft-'))
    let prompt = ''
    faux!.setResponses([
      (ctx) => {
        prompt = asked(ctx)
        return fauxAssistantMessage(
          '```json\n' +
            JSON.stringify({
              name: 'morning news brief',
              prompt: 'Search the web for the top news and write a short brief.',
              tools: ['web_search', 'web_fetch'],
              servers: [],
              collectionIds: [notes.id],
              skills: ['brief'],
              watch: { kind: 'files' },
              cron: '30 8 * * 1-5',
              workspace: folder
            }) +
            '\n```'
        )
      }
    ])
    const before = services.workflows.list().length
    const draft = await services.workflows.draftAutomation('Every weekday at 8:30 give me a news brief')
    expect(draft).toEqual({
      name: 'Morning news brief',
      automation: {
        prompt: 'Search the web for the top news and write a short brief.',
        agentId: null,
        tools: ['web_search', 'web_fetch'],
        servers: [],
        collectionIds: [notes.id],
        skills: ['brief'],
        watch: { kind: 'files' },
        commands: null
      },
      cron: '30 8 * * 1-5',
      workspace: folder
    })
    // The model was shown what exists, and nothing was saved.
    expect(prompt).toContain('web_search')
    expect(prompt).toContain(notes.id)
    expect(prompt).toContain('brief')
    expect(services.workflows.list().length).toBe(before)
  })

  it('drops unknown tools, servers, collections, skills and folders, and falls back to the description', async () => {
    const { services } = setup()
    faux!.setResponses([
      () =>
        fauxAssistantMessage(
          JSON.stringify({
            name: 'A very long automation name that goes on',
            tools: ['web_search', 'made_up_tool', 'bash'],
            servers: [{ id: 'nope', tools: null }],
            collectionIds: ['col_missing'],
            skills: ['ghost'],
            watch: { kind: 'url', url: 'https://example.com/page' },
            cron: null,
            workspace: join(tmpdir(), 'cloth-no-such-folder-xyz')
          })
        )
    ])
    const draft = await services.workflows.draftAutomation('Tell me when example.com changes')
    expect(draft.name).toBe('A very long automation name')
    expect(draft.automation.prompt).toBe('Tell me when example.com changes')
    expect(draft.automation.tools).toEqual(['web_search'])
    expect(draft.automation).toMatchObject({ servers: [], collectionIds: [], skills: [], watch: { kind: 'url', url: 'https://example.com/page', everyMinutes: 60 } })
    expect(draft.workspace).toBeNull()
    expect(draft.cron).toBeNull()
  })

  it('turns an invalid cron into null', async () => {
    const { services } = setup()
    faux!.setResponses([
      () => fauxAssistantMessage(JSON.stringify({ name: 'Daily digest', prompt: 'Write a digest.', tools: [], cron: '99 99 * * *' })),
      () => fauxAssistantMessage(JSON.stringify({ name: 'Daily digest', prompt: 'Write a digest.', tools: [], cron: '0 0 9 * * *' }))
    ])
    expect((await services.workflows.draftAutomation('A daily digest')).cron).toBeNull()
    // Six fields (seconds) is not the 5-field form.
    expect((await services.workflows.draftAutomation('A daily digest')).cron).toBeNull()
  })

  it('needs a default model', async () => {
    const { services } = makeServices()
    services.settings.update({ defaultModel: null })
    await expect(services.workflows.draftAutomation('Anything')).rejects.toThrow('Set a default model in Settings to draft automations.')
  })
})
