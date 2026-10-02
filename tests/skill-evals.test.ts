import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { lintExpectation } from '../src/shared/skillEvals'
import { makeServices } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

const kinds = (e: string) => lintExpectation(e).map((i) => i.kind)

describe('skill eval expectations', () => {
  it('flags expectations a single reply cannot show (from a real drafted find-skills case)', () => {
    expect(kinds('If search results are available, names a relevant skill and explains briefly what it does.')).toContain('conditional')
    expect(kinds('If no suitable result is found, says so and offers direct help or suggests `npx skills init` for creating a skill.')).toContain('conditional')
    expect(kinds('Searches with a relevant query such as `react performance` using `npx skills find`.')).toContain('action')
    expect(kinds('If a suitable skill is found, gives its name, a brief description, install command, and skills.sh link.')).toEqual(expect.arrayContaining(['conditional', 'compound']))
    expect(kinds('Treats the question as a possible skill-discovery request rather than only giving general React advice.')).toEqual([])
    // Rewritten so the reply itself can show them:
    expect(kinds('Tells the user to run `npx skills find react performance`.')).toEqual([])
    expect(kinds('Includes an install command in the form `npx skills add <owner/repo@skill>`.')).toEqual([])
    expect(kinds('Does not claim a specific skill exists without search results.')).toEqual([])
    expect(kinds('Gives a helpful answer.')).toContain('vague')
  })

  it('drafts cases with the test setup explained, and drops expectations the reply cannot show', async () => {
    const { services } = makeServices()
    await services.skills.create({ name: 'find-skills', description: 'Find installable skills', body: 'Run `npx skills find <query>`. Present the install command `npx skills add <owner/repo@skill>`.' })
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let asked = ''
    faux.setResponses([
      (ctx: TranscriptContext) => {
        asked = JSON.stringify(ctx.messages)
        return fauxAssistantMessage(
          JSON.stringify({
            cases: [
              { prompt: 'Is there a skill for PR reviews?', expectations: ['Tells the user to run `npx skills find pr review`.', 'Searches for a review skill with `npx skills find`.', 'If results are found, names one.'] },
              { prompt: 'What is 2+2?', expectations: ['Answers 4 without suggesting a skill.'] },
              { prompt: 'Only bad ones', expectations: ['Installs the skill.'] }
            ]
          })
        )
      }
    ])
    const cases = await services.skills.draftEvals('find-skills', { providerId: provider.id, modelId: 'faux-1' })
    expect(asked).toContain('cannot run commands, use tools')
    expect(asked).toContain('should NOT use the skill')
    expect(cases.map((c) => [c.prompt, c.expectations])).toEqual([
      ['Is there a skill for PR reviews?', ['Tells the user to run `npx skills find pr review`.']],
      ['What is 2+2?', ['Answers 4 without suggesting a skill.']]
    ])
  })
})
