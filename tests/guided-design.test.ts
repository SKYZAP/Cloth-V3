import { afterEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'
import { DEFAULT_DESIGN, DEFAULT_SAMPLE, FONT_CHOICES, buildDesign, sanitizeDesign, sanitizeSample } from '../src/shared/design'
import { CORNER_IDS, TEXT_FEELS, TEXT_FEEL_IDS, cornersOf, textFeelOf, variation, withCorners, withTextFeel } from '../src/shared/guided'

describe('guided choices', () => {
  it('sets fonts from a text feel and recognises it again', () => {
    for (const id of TEXT_FEEL_IDS) {
      const f = TEXT_FEELS[id]
      // Every feel uses fonts the preview can show and the advanced editor offers.
      expect(FONT_CHOICES.heading).toContain(f.fontHeading)
      expect(FONT_CHOICES.sans).toContain(f.fontSans)
      expect(textFeelOf(withTextFeel(DEFAULT_DESIGN, id))).toBe(id)
    }
    expect(textFeelOf({ ...DEFAULT_DESIGN, fontHeading: 'Geist', fontSans: 'DM Sans' })).toBeNull()
  })

  it('round-trips corners, with pills rounding buttons and badges and nothing else', () => {
    for (const id of CORNER_IDS) expect(cornersOf(withCorners(DEFAULT_DESIGN, id))).toBe(id)
    const pill = withCorners(DEFAULT_DESIGN, 'pill')
    expect(pill.kit.button.radius).toBe('full')
    expect(pill.kit.badge.radius).toBe('full')
    expect(pill.kit.card.radius).toBe(DEFAULT_DESIGN.kit.card.radius)
    expect(withCorners(pill, 'sharp').kit.button.radius).toBe(DEFAULT_DESIGN.kit.button.radius)
  })

  it('makes a variation that differs but stays readable', () => {
    const base = withTextFeel({ ...DEFAULT_DESIGN, brand: '#059669' }, 'clean')
    const v = variation(base, 0.3)
    expect(v.brand).not.toBe(base.brand)
    expect(textFeelOf(v)).not.toBe('clean')
    expect(cornersOf(v)).not.toBe(cornersOf(base))
    const bad = buildDesign(v).checks.filter((c) => /^(Text on background|Label on primary button)$/.test(c.label) && c.ratio < c.need)
    expect(bad).toEqual([])
  })

  it('keeps sample-screen words with a design, cleaned up', () => {
    expect(sanitizeSample(null)).toBeNull()
    const s = sanitizeSample({ app: 'Verdant Trails', title: 'Wander further', items: [{ title: 'Lisbon', meta: 'From $420', tag: 'Popular' }] })!
    expect(s.app).toBe('Verdant Trails')
    expect(s.items).toHaveLength(3)
    expect(s.items[1]).toEqual(DEFAULT_SAMPLE.items[1])
    expect(sanitizeDesign({ ...DEFAULT_DESIGN, sample: s }).sample?.title).toBe('Wander further')
    expect(sanitizeDesign({ ...DEFAULT_DESIGN, sample: null }).sample).toBeNull()
  })
})

let faux: ReturnType<typeof registerFauxProvider> | null = null

describe('looks from a description', () => {
  afterEach(() => {
    faux?.unregister()
    faux = null
  })

  it('returns three cleaned-up looks that share the sample words', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const look = (name: string, extra: object) => ({ name, why: `${name} feels right.`, brand: '#059669', mode: 'light', fontHeading: 'Sora', fontSans: 'Plus Jakarta Sans', radius: 12, density: 'spacious', ...extra })
    faux.setResponses([
      fauxAssistantMessage(
        JSON.stringify({
          sample: { app: 'Verdant', nav: ['Trips', 'Stays', 'Guides'], title: 'Go somewhere green', items: [{ title: 'Azores', meta: '7 nights from $890', tag: 'New' }] },
          looks: [look('Canopy', { pill: true }), look('Lagoon', { mode: 'dark', radius: 4 }), look('Meadow', { fontHeading: 'Fraunces', fontSans: 'Source Sans 3', baseSize: 99 })]
        })
      )
    ])
    const res = await services.designs.looks({ prompt: 'emerald green travel website', model: { providerId: provider.id, modelId: 'faux-1' } })
    expect(res.sample?.app).toBe('Verdant')
    expect(res.looks.map((l) => l.name)).toEqual(['Canopy', 'Lagoon', 'Meadow'])
    expect(res.looks[0].input.kit.button.radius).toBe('full')
    expect(res.looks[1].input).toMatchObject({ mode: 'dark', radius: 4 })
    expect(res.looks[2].input.baseSize).toBe(20)
    // The words travel with each look, so the saved design keeps its own sample screen.
    expect(res.looks.every((l) => l.input.sample?.title === 'Go somewhere green')).toBe(true)
    await expect(services.designs.looks({ prompt: ' ', model: { providerId: provider.id, modelId: 'faux-1' } })).rejects.toThrow(/Describe/)
  })
})
