import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'
import { buildDesign, contrast, DEFAULT_DESIGN, designFiles, hexToOklch, oklchToHex, PRESETS, sanitizeDesign, scaleFrom, STEPS, type DesignInput } from '../src/shared/design'

describe('design systems', () => {
  it('converts colours through OKLCH and back', () => {
    for (const hex of ['#4f5bd5', '#dc2645', '#22a06b', '#ffffff', '#000000', '#7f7f7f']) expect(oklchToHex(hexToOklch(hex))).toBe(hex)
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1)
  })

  it('builds scales that run light to dark, keeping the hue', () => {
    const s = scaleFrom('#4f5bd5')
    const ls = STEPS.map((k) => hexToOklch(s[k]).l)
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeLessThan(ls[i - 1])
    expect(Math.abs(hexToOklch(s[500]).h - hexToOklch('#4f5bd5').h)).toBeLessThan(6)
  })

  it('picks roles that pass AA for text, in both themes, even from awkward brand colours', () => {
    for (const brand of ['#4f5bd5', '#ffd400', '#00e5ff', '#1a1a1a', '#e5e5e5']) {
      const d = buildDesign({ ...DEFAULT_DESIGN, brand })
      const failing = d.checks.filter((c) => c.ratio < c.need && c.label !== 'Input border on surface')
      expect(failing.map((c) => `${brand} ${c.mode} ${c.label} ${c.ratio.toFixed(2)}`)).toEqual([])
    }
  })

  it('writes DESIGN.md and token files that agree with each other', () => {
    const input: DesignInput = { ...DEFAULT_DESIGN, mode: 'both', accent: '#e0a43a', fontHeading: 'Fraunces' }
    const files = designFiles({ name: 'Harbor', description: 'Calm tools for ops teams.', input })
    expect(Object.keys(files)).toEqual(['DESIGN.md', 'tokens.css', 'tailwind.css', 'tokens.json'])
    const d = buildDesign(input)
    expect(files['DESIGN.md']).toContain('# Harbor — design system')
    expect(files['DESIGN.md']).toContain(`| \`--color-primary\` | \`${d.roles.dark.primary}\` | \`${d.roles.light.primary}\` |`)
    expect(files['tokens.css']).toContain(`--color-primary: ${d.roles.dark.primary};`)
    expect(files['tokens.css']).toContain(`--color-primary: ${d.roles.light.primary};`)
    expect(files['tokens.css']).toContain("--font-heading: 'Fraunces', Georgia")
    expect(files['tailwind.css']).toContain('--color-on-primary: var(--color-on-primary);')
    const json = JSON.parse(files['tokens.json'])
    expect(json.color.accent[500].$value).toBe(d.scales.accent![500])
    expect(json.color.light.primary.$value).toBe(d.roles.light.primary)

    const light = designFiles({ name: 'L', description: '', input: { ...input, mode: 'light' } })
    expect(light['tokens.css']).toContain('color-scheme: light;')
    expect(light['tokens.css']).not.toContain('prefers-color-scheme')
  })

  it('pins the exact brand colour, picks grey families and dark depth, and honours hand-picked roles', () => {
    const pinned = buildDesign({ ...DEFAULT_DESIGN, brand: '#7C3AED', pinBrand: true })
    expect(pinned.roles.light.primary).toBe('#7c3aed')
    expect(pinned.roles.dark.primary).toBe('#7c3aed')
    expect(Object.values(pinned.scales.brand)).toContain('#7c3aed')

    const grey = buildDesign({ ...DEFAULT_DESIGN, neutral: 'gray', neutralTint: 1 })
    for (const s of STEPS) expect(hexToOklch(grey.scales.neutral[s]).c).toBeLessThan(0.005)
    const slate = buildDesign({ ...DEFAULT_DESIGN, neutral: 'slate', neutralTint: 0.5 })
    expect(Math.abs(hexToOklch(slate.scales.neutral[500]).h - 255)).toBeLessThan(8)

    const deep = buildDesign({ ...DEFAULT_DESIGN, darkDepth: 0 }).roles.dark.background
    const soft = buildDesign({ ...DEFAULT_DESIGN, darkDepth: 1 }).roles.dark.background
    expect(hexToOklch(soft).l - hexToOklch(deep).l).toBeGreaterThan(0.08)

    const picked = buildDesign({ ...DEFAULT_DESIGN, overrides: { light: { primary: '#ffcc00' }, dark: {} } })
    expect(picked.roles.light.primary).toBe('#ffcc00')
    // Text on a hand-picked yellow turns dark to stay readable; the generated value is kept for "reset".
    expect(contrast(picked.roles.light.onPrimary, '#ffcc00')).toBeGreaterThan(4.5)
    expect(picked.generated.light.primary).not.toBe('#ffcc00')
    expect(picked.roles.dark.primary).toBe(picked.generated.dark.primary)
  })

  it('every preset builds readable text in its themes', () => {
    for (const p of PRESETS) {
      const input = sanitizeDesign(p.input)
      const d = buildDesign(input)
      const modes = input.mode === 'both' ? ['light', 'dark'] : [input.mode]
      const bad = d.checks.filter((c) => modes.includes(c.mode) && /^(Text on background|Muted text on surface|Label on primary button)$/.test(c.label) && c.ratio < c.need)
      expect(bad.map((c) => `${p.id} ${c.mode} ${c.label} ${c.ratio.toFixed(2)}`)).toEqual([])
    }
    const css = designFiles({ name: 'T', description: '', input: { ...DEFAULT_DESIGN, headingTracking: -0.03, headingWeight: 800 } })['tokens.css']
    expect(css).toContain('--tracking-h1: -0.03em;')
    expect(css).toContain('--weight-h1: 800;')
  })

  it('cleans up designs from a model', () => {
    const s = sanitizeDesign({ brand: '0F0', accent: 'nope', baseSize: 40, radius: -3, mode: 'neon', principles: ['Bold', '', 7, ' Quiet '] as unknown[] } as never)
    expect(s.brand).toBe('#00ff00')
    expect(s.accent).toBe(DEFAULT_DESIGN.accent)
    expect(s.baseSize).toBe(20)
    expect(s.radius).toBe(0)
    expect(s.mode).toBe(DEFAULT_DESIGN.mode)
    expect(s.principles).toEqual(['Bold', 'Quiet'])
  })
})

let faux: ReturnType<typeof registerFauxProvider> | null = null

describe('design service', () => {
  afterEach(() => {
    faux?.unregister()
    faux = null
  })

  it('saves designs, exports the files, and feeds DESIGN.md to the projects that follow it', async () => {
    const { services } = makeServices()
    const d = services.designs.create({ input: { ...DEFAULT_DESIGN, brand: '#0f766e' } })
    expect(d.name).toBe('New design')
    expect(services.designs.create().name).toBe('New design 2')
    const renamed = services.designs.update(d.id, { name: 'Harbor', input: { ...d.input, radius: 99 } as DesignInput })
    expect(renamed).toMatchObject({ name: 'Harbor', input: { brand: '#0f766e', radius: 32 } })

    const folder = mkdtempSync(join(tmpdir(), 'cloth-design-'))
    const written = await services.designs.export(d.id, folder)
    expect(written.map((p) => p.split(/[\\/]/).pop())).toEqual(['DESIGN.md', 'tokens.css', 'tailwind.css', 'tokens.json'])
    expect(readFileSync(join(folder, 'DESIGN.md'), 'utf8')).toContain('# Harbor — design system')

    const p = services.projects.create({ name: 'Ops', designId: d.id })
    expect(await services.projects.instructions(p.id)).toContain('# Harbor — design system')
    services.designs.remove(d.id)
    expect(services.projects.get(p.id).designId).toBeNull()
    expect(await services.projects.instructions(p.id)).not.toContain('design system')
  })

  it('turns a description into a design with a model, cleaning up what comes back', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage('Here you go:\n```json\n{"name":"Tidepool","description":"Calm ops tooling.","brand":"#0E7490","accent":null,"mode":"dark","fontSans":"IBM Plex Sans","baseSize":99,"radius":4,"density":"compact","principles":["Dense but calm","Keyboard first"]}\n```')
    ])
    const draft = await services.designs.generate({ prompt: 'calm dark ops dashboard, teal', model: { providerId: provider.id, modelId: 'faux-1' } })
    expect(draft).toMatchObject({ name: 'Tidepool', description: 'Calm ops tooling.', input: { brand: '#0e7490', accent: null, mode: 'dark', fontSans: 'IBM Plex Sans', baseSize: 20, radius: 4, density: 'compact' } })
    expect(draft.input.principles).toEqual(['Dense but calm', 'Keyboard first'])
    await expect(services.designs.generate({ prompt: ' ', model: { providerId: provider.id, modelId: 'faux-1' } })).rejects.toThrow(/Describe/)
  })
})