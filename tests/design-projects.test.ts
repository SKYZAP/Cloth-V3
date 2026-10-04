import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDesign, DEFAULT_DESIGN, designFiles, toDesignMd } from '../src/shared/design'
import { shadcnVars, toShadcnCss } from '../src/shared/shadcn'
import { makeServices } from './helpers'

describe('shadcn theme', () => {
  it('maps roles to shadcn variables, with the accent as highlight', () => {
    const input = { ...DEFAULT_DESIGN, accent: '#e0a43a' }
    const d = buildDesign(input)
    const v = shadcnVars(d.roles.dark, d, 'dark')
    expect(v.primary).toBe(d.roles.dark.primary)
    expect(v['primary-foreground']).toBe(d.roles.dark.onPrimary)
    expect(v.accent).toBe(d.roles.dark.surfaceRaised)
    expect(v.highlight).toBe(d.roles.dark.accent)
    const css = toShadcnCss(input, d)
    expect(css).toContain(':root {')
    expect(css).toContain('.dark {')
    expect(css).toContain('--color-highlight: var(--highlight);')
    expect(css).toContain(`--radius: ${d.radii.md}px;`)
  })

  it('writes one theme block for a single-theme system, and the shadcn files with the export', () => {
    const input = { ...DEFAULT_DESIGN, mode: 'light' as const }
    expect(toShadcnCss(input)).not.toContain('.dark {')
    const files = designFiles({ name: 'Calm', description: '', input })
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['shadcn/app/globals.css', 'shadcn/components.json', 'shadcn/components/ui/button.tsx', 'shadcn/lib/utils.ts']))
    expect(toDesignMd({ name: 'Calm', description: '', input })).toContain('## shadcn/ui')
  })
})

describe('design systems in projects', () => {
  it('writes files, notices updates, and never mistakes a hand edit for an update', async () => {
    const { services } = makeServices()
    const folder = mkdtempSync(join(tmpdir(), 'cloth-design-'))
    const design = services.designs.create({ name: 'Calm' })
    const project = services.projects.create({ name: 'Site', folder })
    let [p] = await services.designs.projectSync(design.id)
    expect(p.linked).toBe(false)
    expect(new Set(p.files.map((f) => f.state))).toEqual(new Set(['missing']))

    p = await services.designs.writeProject(design.id, project.id, p.files.map((f) => f.path))
    expect(p.linked).toBe(true)
    expect(p.files.every((f) => f.state === 'current')).toBe(true)
    expect(existsSync(join(folder, 'design', 'DESIGN.md'))).toBe(true)
    expect(readFileSync(join(folder, 'design', 'shadcn', 'app', 'globals.css'), 'utf8')).toContain('@theme inline')

    // A change to the system makes the written files out of date; a file edited by hand is flagged.
    services.designs.update(design.id, { input: { ...design.input, brand: '#0f8a5f' } })
    writeFileSync(join(folder, 'design', 'tokens.json'), '{"mine": true}\n')
    ;[p] = await services.designs.projectSync(design.id)
    const state = Object.fromEntries(p.files.map((f) => [f.path, f.state]))
    expect(state['tokens.css']).toBe('outdated')
    expect(state['tokens.json']).toBe('edited')
    expect(await services.designs.projectDiff(design.id, project.id, 'tokens.json')).toContain('-{"mine": true}')
  })

  it('makes new projects follow the default system', () => {
    const { services } = makeServices()
    const design = services.designs.create({ name: 'House style' })
    services.settings.update({ defaultDesignId: design.id })
    expect(services.projects.create({ name: 'New' }).designId).toBe(design.id)
    expect(services.projects.create({ name: 'Opted out', designId: null }).designId).toBeNull()
  })
})
