import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'
import { listRules, ensureRule, mergeRules, restingSelector, setDeclaration } from '../src/shared/cssEdit'
import { DEFAULT_KIT, kitCss, sanitizeKit } from '../src/shared/kit'
import { repairTokens, unknownTokens } from '../src/shared/design'
import { applyPaletteColor, buildDesign, componentLint, coolorsUrl, paletteToDesign, parsePalette, toDesignMd, contrast, DEFAULT_DESIGN, designFiles, hexToOklch, oklchToHex, parseComponentAnswer, PRESETS, sanitizeComponentCss, sanitizeComponentHtml, sanitizeDesign, scaleFrom, STEPS, type DesignInput } from '../src/shared/design'

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
    expect(Object.keys(files)).toEqual(['DESIGN.md', 'tokens.css', 'tailwind.css', 'tokens.json', 'components.css', 'components/ds-button.html', 'components/ds-input.html', 'components/ds-card.html', 'components/ds-badge.html', 'components/ds-tabs.html', 'components/ds-alert.html', 'components/ds-menu.html'])
    expect(files['components.css']).toContain('.ds-button--primary {')
    expect(files['DESIGN.md']).toContain('**Button** `.ds-button`')
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
    expect(written.map((p) => p.split(/[\\/]/).pop()).slice(0, 5)).toEqual(['DESIGN.md', 'tokens.css', 'tailwind.css', 'tokens.json', 'components.css'])
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
describe('component library', () => {
  afterEach(() => {
    faux?.unregister()
    faux = null
  })

  const answer = (name: string, color: string) =>
    `Sure!\nNAME: ${name}\nDESCRIPTION: Buttons for actions.\n=== CSS ===\n\`\`\`css\n.c-button { background: var(--color-primary); color: ${color}; border-radius: var(--radius-md); }\n\`\`\`\n=== HTML ===\n<div class="specimen"><section class="specimen-section"><div class="specimen-label">Primary</div><div class="specimen-row"><button class="c-button" onclick="alert(1)">Save</button><script>alert(2)</script></div></section></div>\n=== USAGE ===\n<button class="c-button">Save</button>`

  it('changes one selected element and splices it back, leaving the rest untouched', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const model = { providerId: provider.id, modelId: 'faux-1' }
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let scopedPrompt = ''
    faux.setResponses([
      fauxAssistantMessage(answer('Button', 'var(--color-on-primary)')),
      (ctx) => {
        scopedPrompt = JSON.stringify(ctx.messages)
        // Only the part and the rules it changes, as asked.
        return fauxAssistantMessage('NAME: Button\nDESCRIPTION: x\n=== CSS ===\n.c-button { background: var(--color-accent); color: var(--color-on-accent); }\n.c-button__icon { width: 16px; }\n=== HTML ===\n<button class="c-button">Save <span class="c-button__icon"></span></button>\n=== USAGE ===\n')
      }
    ])
    const d = services.designs.create({ name: 'Harbor' })
    const c = await services.designs.generateComponent({ designId: d.id, prompt: 'buttons', model })
    services.designs.updateComponent(c.id, { css: `${c.css}\n.c-keep { color: var(--color-text); }` })
    // specimen > section > row > button
    const changed = await services.designs.generateComponent({ designId: d.id, prompt: 'accent fill with an icon', model, componentId: c.id, scope: [0, 0, 1, 0] })
    expect(scopedPrompt).toContain('ONLY the new markup that replaces this one element')
    expect(scopedPrompt).toContain('class=\\"c-button\\">Save</button>')
    expect(changed.html).toContain('<div class="specimen-label">Primary</div>')
    expect(changed.html).toContain('<span class="c-button__icon"></span>')
    expect(changed.css).toContain('background: var(--color-accent)')
    expect(changed.css).not.toContain('var(--color-primary)')
    expect(changed.css).toContain('.c-keep { color: var(--color-text); }')
    expect(changed.css).toContain('.c-button__icon { width: 16px; }')
    expect(changed.usage).toBe(c.usage)
    expect(changed.prompt).toBe('accent fill with an icon')
    expect(changed.description).toBe('Buttons for actions.')
    await expect(services.designs.generateComponent({ designId: d.id, prompt: 'x', model, componentId: c.id, scope: [9, 9] })).rejects.toThrow(/no longer in the component/)
  })

  it('builds, refines, undoes and exports components that stay on the system', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const model = { providerId: provider.id, modelId: 'faux-1' }
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let refinePrompt = ''
    faux.setResponses([
      fauxAssistantMessage(answer('Button', '#ffffff')),
      (ctx) => {
        refinePrompt = JSON.stringify(ctx.messages)
        return fauxAssistantMessage(answer('Button', 'var(--color-on-primary)'))
      }
    ])
    const d = services.designs.create({ name: 'Harbor' })
    const c = await services.designs.generateComponent({ designId: d.id, prompt: 'buttons', model })
    expect(c).toMatchObject({ name: 'Button', description: 'Buttons for actions.', usage: '<button class="c-button">Save</button>' })
    expect(c.css.startsWith('.c-button')).toBe(true)
    expect(c.html).not.toMatch(/script|onclick/)
    expect(componentLint(c.css, c.html)).toEqual(['#ffffff'])

    const fixed = await services.designs.generateComponent({ designId: d.id, prompt: 'use tokens for the text colour', model, componentId: c.id })
    expect(refinePrompt).toContain('Change the \\"Button\\" component: use tokens for the text colour')
    expect(refinePrompt).toContain('color: #ffffff')
    expect(componentLint(fixed.css, fixed.html)).toEqual([])
    expect(fixed.history.map((h) => h.prompt)).toEqual(['buttons'])
    expect(services.designs.undoComponent(c.id).css).toContain('#ffffff')

    const edited = services.designs.updateComponent(c.id, { css: '.c-button { color: var(--color-text); } @import url(http://x.test/a.css);', name: 'Buttons' })
    expect(edited.name).toBe('Buttons')
    expect(edited.css).not.toContain('@import')
    expect(edited.prompt).toBe('Edited by hand')

    // Inspector edits in a burst share one history step.
    const steps = edited.history.length
    services.designs.updateComponent(c.id, { css: '.c-button { color: var(--color-primary); }' }, { label: 'Edited in the inspector' })
    const burst = services.designs.updateComponent(c.id, { css: '.c-button { color: var(--color-accent); }' }, { label: 'Edited in the inspector' })
    expect(burst.history.length).toBe(steps + 1)
    expect(services.designs.undoComponent(c.id).css).toContain('var(--color-text)')

    const folder = mkdtempSync(join(tmpdir(), 'cloth-components-'))
    const written = (await services.designs.export(d.id, folder)).map((p) => p.slice(folder.length + 1).replace(/\\/g, '/'))
    expect(written).toEqual(expect.arrayContaining(['components.css', 'components/buttons.html', 'DESIGN.md']))
    expect(readFileSync(join(folder, 'components', 'buttons.html'), 'utf8')).toContain('href="../tokens.css"')
    const md = readFileSync(join(folder, 'DESIGN.md'), 'utf8')
    expect(md).toContain('## Component library')
    expect(md).toContain('### Buttons')
    // Projects that follow the design get the library in their chats' instructions.
    const p = services.projects.create({ name: 'Site', designId: d.id })
    expect(await services.projects.instructions(p.id)).toContain('### Buttons')
    // A copy of the design brings its library.
    expect(services.designs.components(services.designs.duplicate(d.id).id).map((x) => x.name)).toEqual(['Buttons'])
    services.designs.remove(d.id)
    expect(services.designs.components(d.id)).toEqual([])
  })

  it('reads answers and keeps model markup safe', () => {
    expect(parseComponentAnswer('no sections here')).toBeNull()
    expect(sanitizeComponentHtml('<a href="javascript:alert(1)" onmouseover="x()">x</a><iframe src="https://e.test"></iframe><img src=x onerror=alert(1)>')).toBe('<a href="#">x</a><img src=x>')
    expect(sanitizeComponentCss('.a{background:url(https://e.test/p.png)} .b{background:url(data:image/png;base64,AAA)} </style><script>')).toBe('.a{background:none} .b{background:url(data:image/png;base64,AAA)} <script>')
    expect(componentLint('.a{color:var(--color-text, #000);background:rgb(1 2 3)}', '<i style="color:#abc"></i>')).toEqual(['rgb(1 2 3)', '#abc'])
  })
})
describe('palettes', () => {
  it('reads Coolors links, Coolors exports and colour lists', () => {
    expect(parsePalette('https://coolors.co/54494b-f1f7ed-b33951')).toEqual(['#54494b', '#f1f7ed', '#b33951'])
    expect(parsePalette('coolors.co/palette/264653-2a9d8f-e9c46a')).toEqual(['#264653', '#2a9d8f', '#e9c46a'])
    expect(parsePalette(':root { --taupe: #54494bff; --honeydew: #f1f7edff; --red: #B33951; }')).toEqual(['#54494b', '#f1f7ed', '#b33951'])
    expect(parsePalette('["54494b","f1f7ed"]')).toEqual(['#54494b', '#f1f7ed'])
    expect(parsePalette('rgba(84, 73, 75, 1), #abc')).toEqual(['#54494b', '#aabbcc'])
    // Six-letter words are not colours.
    expect(parsePalette('a decade of facade')).toEqual([])
    expect(coolorsUrl(['#54494B', '#f1f7ed'])).toBe('https://coolors.co/54494b-f1f7ed')
  })

  it('maps a palette onto the system and keeps it readable', () => {
    const colors = parsePalette('https://coolors.co/54494b-f1f7ed-b33951')
    const input = { ...DEFAULT_DESIGN, ...paletteToDesign(colors, DEFAULT_DESIGN) }
    expect(input).toMatchObject({ palette: colors, brand: '#b33951', accent: null, neutral: 'custom', neutralSeed: '#f1f7ed' })
    const d = buildDesign(input)
    expect(d.roles.light.background).toBe('#f1f7ed')
    // Exact where it is readable (light), a legible shade where it is not (dark).
    expect(d.roles.light.primary).toBe('#b33951')
    expect(d.roles.dark.primary).not.toBe('#b33951')
    expect(d.checks.filter((c) => c.ratio < c.need)).toEqual([])
    expect(toDesignMd({ name: 'P', description: '', input }, d)).toContain('Source palette: `#54494b` `#f1f7ed` `#b33951`')
  })

  it('picks a contrasting accent and re-assigns single colours', () => {
    const colors = parsePalette('coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51')
    const mapped = paletteToDesign(colors, DEFAULT_DESIGN)
    expect(mapped.brand).toBe('#e76f51')
    expect(mapped.accent).toBe('#2a9d8f')
    const input = { ...DEFAULT_DESIGN, ...mapped }
    expect(applyPaletteColor(input, '#264653', 'darkBackground').overrides?.dark.background).toBe('#264653')
    expect(applyPaletteColor(input, '#e9c46a', 'accent')).toEqual({ accent: '#e9c46a' })
    expect(sanitizeDesign({ ...input, palette: ['#fff', 'nope', '#FFFFFF'] }).palette).toEqual(['#ffffff'])
  })
})

describe('component editing', () => {
  const css = `/* buttons */
.c-btn {
  color: var(--color-text);
  padding: var(--space-2);
}
.c-btn:hover, .c-btn.is-hover { color: var(--color-primary); }
@media (max-width: 600px) {
  .c-btn { padding: 0; }
}
@keyframes spin { from { opacity: 0 } to { opacity: 1 } }`

  it('lists rules with their context and edits one declaration, keeping the rest', () => {
    const rules = listRules(css)
    expect(rules.map((r) => [r.selector, r.context])).toEqual([
      ['.c-btn', ''],
      ['.c-btn:hover, .c-btn.is-hover', ''],
      ['.c-btn', '@media (max-width: 600px)']
    ])
    const next = setDeclaration(css, 0, 'padding', 'var(--space-4)')
    expect(next).toContain('/* buttons */')
    expect(next).toContain('  padding: var(--space-4);')
    expect(listRules(next)[2].decls).toEqual([{ prop: 'padding', value: '0', important: false }])
    const added = setDeclaration(next, 1, 'background', 'var(--color-primary-soft) !important')
    expect(listRules(added)[1].decls.at(-1)).toEqual({ prop: 'background', value: 'var(--color-primary-soft)', important: true })
    expect(listRules(setDeclaration(added, 0, 'color', null))[0].decls.map((d) => d.prop)).toEqual(['padding'])
    expect(listRules('not { css')).toEqual([])
  })

  it('merges changed rules into a sheet by selector and media query', () => {
    const base = '.a { color: red; }\n@media (max-width: 600px) {\n  .a { padding: 0; }\n}\n.b { margin: 0; }'
    const out = mergeRules(base, '.a { color: blue; }\n@media (max-width:600px) { .a { padding: 4px; } .c { gap: 0; } }\n.d { top: 0; }')
    expect(listRules(out).map((r) => `${r.context}${r.selector}:${r.decls.map((x) => x.value).join(',')}`)).toEqual(['.a:blue', '@media (max-width: 600px).a:4px', '@media (max-width: 600px).c:0', '.b:0', '.d:0'])
  })

  it('creates rules once and strips states for matching', () => {
    const a = ensureRule(css, '.c-btn__icon')
    expect(a.css).toMatch(/\.c-btn__icon \{\r?\n\}/)
    expect(ensureRule(a.css, '.c-btn__icon')).toEqual(a)
    expect(restingSelector('.c-btn:hover .c-btn__icon')).toEqual({ base: '.c-btn .c-btn__icon', states: ['hover'] })
    expect(restingSelector('.c-btn.is-focus:focus-visible')).toEqual({ base: '.c-btn', states: ['focus-visible', 'focus'] })
  })

  it('finds variables the system does not define and repairs named weights', () => {
    const css = '.a { --c-gap: 4px; gap: var(--c-gap); font: var(--weight-bold) var(--text-h1) / 1 var(--font-heading); color: var(--color-nope); margin: var(--space-99, 8px); }'
    expect(unknownTokens(css, '<i style="padding: var(--pad-x)"></i>', DEFAULT_DESIGN)).toEqual(['--weight-bold', '--color-nope', '--pad-x'])
    expect(repairTokens(css)).toContain('font: 700 var(--text-h1)')
    expect(repairTokens('b { font-weight: var(--weight-h1); }')).toBe('b { font-weight: var(--weight-h1); }')
  })

  it('keeps built-in component settings valid and turns them into CSS', () => {
    const kit = sanitizeKit({ button: { radius: 'full', weight: 650, primary: 'neon', tracking: 0.0300001 }, card: { border: 'yes', padding: 99 }, nope: {} })
    expect(kit.button).toMatchObject({ radius: 'full', weight: 700, primary: 'solid', tracking: 0.03 })
    expect(kit.card).toMatchObject({ border: true, padding: 10 })
    const out = kitCss(kit)
    expect(out).toContain('border-radius: var(--radius-full)')
    expect(componentLint(kitCss(DEFAULT_KIT), '')).toEqual([])
    for (const style of ['soft', 'outline'] as const) expect(componentLint(kitCss({ ...DEFAULT_KIT, button: { ...DEFAULT_KIT.button, primary: style }, badge: { ...DEFAULT_KIT.badge, style } }), '')).toEqual([])
  })
})
