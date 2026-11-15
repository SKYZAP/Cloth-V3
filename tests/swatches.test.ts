import { afterEach, describe, expect, it } from 'vitest'
import { guessFormat, markdownPage } from '../src/main/swatches/swatches'
import { swatchFileName } from '../src/shared/swatches'
import { makeServices } from './helpers'

let stop: (() => Promise<void>) | null = null
afterEach(async () => {
  await stop?.()
  stop = null
})

async function started() {
  const { services } = makeServices()
  services.settings.update({ swatchPort: 20000 + Math.floor(Math.random() * 20000), swatchNetwork: false })
  const status = await services.swatches.restart()
  stop = () => services.swatches.stop()
  return { sw: services.swatches, status }
}

describe('swatches', () => {
  it('works out the format and a file name', () => {
    expect(guessFormat('<!doctype html><p>x')).toBe('html')
    expect(guessFormat('<svg viewBox="0 0 1 1"></svg>')).toBe('svg')
    expect(guessFormat('# Report\n\nHello')).toBe('markdown')
    expect(swatchFileName({ title: 'Q3 sales: summary!', format: 'markdown' })).toBe('q3-sales-summary.md')
    expect(markdownPage('A <b>', '# Hi')).toContain('<title>A &lt;b&gt;</title>')
  })

  it('serves a swatch at its secret link, sandboxed, and only there', async () => {
    const { sw, status } = await started()
    expect(status).toMatchObject({ running: true, network: false, error: null })
    const s = sw.publish({ title: 'Chart', content: '<!doctype html><h1>Hello</h1>', sessionId: 'c1' })
    expect(s).toMatchObject({ format: 'html', version: 1, sessionId: 'c1' })
    const [link] = sw.links(s.id)
    expect(link.kind).toBe('local')
    const res = await fetch(link.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<h1>Hello</h1>')
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox /)
    // A wrong key, or no key, finds nothing.
    expect((await fetch(link.url.replace(/\/[\w-]+$/, '/' + 'x'.repeat(24)))).status).toBe(404)
    expect((await fetch(link.url.replace(/\/[\w-]+$/, ''))).status).toBe(404)
  })

  it('updates in place, renders markdown, and a new link retires the old one', async () => {
    const { sw } = await started()
    const s = sw.publish({ title: 'Notes', content: '# One' })
    const next = sw.publish({ id: s.id, content: '# Two\n\n- a' })
    expect(next).toMatchObject({ id: s.id, version: 2, title: 'Notes', format: 'markdown' })
    const old = sw.links(s.id)[0].url
    const page = await (await fetch(old)).text()
    expect(page).toContain('<h1>Two</h1>')
    const fresh = sw.newLink(s.id)[0].url
    expect(fresh).not.toBe(old)
    expect((await fetch(old)).status).toBe(404)
    expect((await fetch(fresh)).status).toBe(200)
    expect(sw.list().map((x) => x.id)).toEqual([s.id])
    sw.remove(s.id)
    expect((await fetch(fresh)).status).toBe(404)
    expect(sw.list()).toEqual([])
  })

  it('refuses empty content and unknown ids', async () => {
    const { sw } = await started()
    expect(() => sw.publish({ title: 'x', content: '  ' })).toThrow(/empty/)
    expect(() => sw.publish({ id: 'sw0000000000000000', content: 'x' })).toThrow(/no swatch/)
  })
})
