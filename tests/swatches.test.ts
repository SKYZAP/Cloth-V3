import { afterEach, describe, expect, it } from 'vitest'
import { guessFormat, markdownPage } from '../src/main/swatches/swatches'
import { board, boardPage, mergeBoards } from '../src/main/swatches/mockups'
import { swatchFileName, tweakValues } from '../src/shared/swatches'
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

const page = (body: string) => `<!doctype html><html><head><title>B</title></head><body>${body}</body></html>`

describe('mockups', () => {
  it('checks boards and merges a new version over the last', () => {
    const one = mergeBoards([], [{ name: 'live', title: 'While it works', width: 1440, height: 900, html: page('<script>1</script>') }])
    expect(one[0]).toMatchObject({ name: 'live', interactive: true, tweaks: [] })
    // Only the fields given change; new names go at the end; remove takes boards out.
    const two = mergeBoards(
      [...one, board({ name: 'done', width: 800, height: 600, html: page('done') })],
      [{ name: 'live', title: 'Live' }, { name: 'phone', width: 390, height: 844, html: page('p') }],
      ['done']
    )
    expect(two.map((b) => [b.name, b.title, b.width])).toEqual([
      ['live', 'Live', 1440],
      ['phone', 'phone', 390]
    ])
    expect(two[0].html).toBe(one[0].html)
    expect(() => mergeBoards([], [{ name: 'Bad Name', width: 400, height: 400, html: 'x' }])).toThrow(/slug/)
    expect(() => mergeBoards([], [{ name: 'a', width: 10, height: 400, html: 'x' }])).toThrow(/width/)
    expect(() => mergeBoards([], [{ name: 'a', width: 400, height: 400 }])).toThrow(/no html/)
    expect(() => mergeBoards(one, [], ['live'])).toThrow(/at least one/)
    expect(() => mergeBoards([], [{ name: 'a', width: 400, height: 400, html: 'x' }, { name: 'a', width: 400, height: 400, html: 'y' }])).toThrow(/twice/)
  })

  it('checks tweaks and fills in their values', () => {
    const b = board({
      name: 'a',
      width: 400,
      height: 400,
      html: 'x',
      tweaks: [
        { key: 'state', label: 'State', kind: 'enum', options: ['working', 'done'], default: 'nope' },
        { key: 'steps', label: 'Steps', kind: 'range', min: 2, max: 6, default: 9 },
        { key: 'dark', label: 'Dark', kind: 'boolean', default: true },
        { key: 'accent', label: 'Accent', kind: 'color', default: '#E54056' }
      ]
    })
    expect(b.interactive).toBe(true)
    expect(tweakValues(b)).toEqual({ state: 'working', steps: 6, dark: true, accent: '#e54056' })
    // Values of the wrong type, or an option that isn't one, fall back to the default.
    expect(tweakValues(b, { state: 'done', steps: '3', dark: false, accent: '#000000' })).toEqual({ state: 'done', steps: 6, dark: false, accent: '#000000' })
    expect(tweakValues(b, { state: 'other' }).state).toBe('working')
    expect(() => board({ name: 'a', width: 400, height: 400, html: 'x', tweaks: [{ key: '1x', kind: 'boolean', default: true }] })).toThrow(/identifier/)
    expect(() => board({ name: 'a', width: 400, height: 400, html: 'x', tweaks: [{ key: 'k', kind: 'enum', options: ['one'] }] })).toThrow(/2 to 8/)
    expect(() => board({ name: 'a', width: 400, height: 400, html: 'x', tweaks: [{ key: 'k', kind: 'color', default: 'red' }] })).toThrow(/hex/)
  })

  it('puts the design and the tweaks runtime first in the head', () => {
    const b = board({ name: 'a', width: 400, height: 400, html: page('<p>hi</p>'), tweaks: [{ key: 'dark', label: 'Dark', kind: 'boolean', default: true }] })
    const html = boardPage(b, { name: 'Cloth dark', css: ':root{--bg:#000}</style><script>x</script>' })
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('data-cloth-design="Cloth dark"'))
    expect(html.indexOf('window.tweaks')).toBeLessThan(html.indexOf('<title>'))
    expect(html).toContain('{"dark":true}')
    // The design's CSS can't close its own style element.
    expect(html).not.toContain('</style><script>x')
    expect(boardPage({ ...b, html: '<p>bare</p>' }, null)).toMatch(/^<script>.*<p>bare<\/p>$/s)
  })

  it('publishes versions, serves each board and the overview, and keeps them apart from pages', async () => {
    const { sw } = await started()
    sw.designFor = (sid) => (sid === 'c1' ? { name: 'Cloth dark', css: ':root{--accent:#e54056}' } : null)
    const { swatch, mockup } = sw.publishMockup({ title: 'Run card', sessionId: 'c1', boards: [{ name: 'live', title: 'Live', width: 1440, height: 900, html: page('<h1>Live</h1>') }] })
    expect(swatch).toMatchObject({ format: 'mockup', version: 1, boards: 1 })
    expect(mockup).toMatchObject({ version: 1, versions: [1], design: 'Cloth dark', boards: [{ name: 'live', width: 1440 }] })
    const next = sw.publishMockup({ id: swatch.id, boards: [{ name: 'live', html: page('<h1>Live 2</h1>') }, { name: 'done', width: 800, height: 600, html: page('<h1>Done</h1>') }] })
    expect(next.swatch).toMatchObject({ id: swatch.id, version: 2, title: 'Run card', boards: 2 })
    expect(next.mockup.versions).toEqual([1, 2])
    expect(sw.mockup(swatch.id, 1).boards.map((b) => b.name)).toEqual(['live'])

    const link = sw.links(swatch.id)[0].url
    const live = await fetch(`${link}/b/live`)
    expect(live.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/)
    const html = await live.text()
    expect(html).toContain('Live 2')
    expect(html).toContain('--accent:#e54056')
    expect(await (await fetch(`${link}/b/live?v=1`)).text()).toContain('<h1>Live</h1>')
    expect((await fetch(`${link}/b/nope`)).status).toBe(404)
    expect((await fetch(`${link}/b/live?v=9`)).status).toBe(404)
    const overview = await (await fetch(link)).text()
    // Each board's frame resolves, as a browser would, against the overview's own URL.
    const src = /<iframe src="([^"]+done[^"]*)"/.exec(overview)?.[1] ?? ''
    expect((await fetch(new URL(src, link))).status).toBe(200)
    expect(JSON.parse(await (await fetch(`${link}/source`)).text()).boards).toHaveLength(2)
    expect(sw.boardUrl(swatch.id, 'live', undefined, { dark: false })).toMatch(/\/b\/live\?v=2#tweaks=%7B%22dark%22%3Afalse%7D$/)

    // A page and a mockup can't be updated as each other; a page has no boards.
    const pg = sw.publish({ title: 'Page', content: '<!doctype html><p>x' })
    expect(() => sw.publish({ id: swatch.id, content: 'x' })).toThrow(/publish_mockup/)
    expect(() => sw.publishMockup({ id: pg.id, boards: [] })).toThrow(/publish_swatch/)
    expect((await fetch(`${sw.links(pg.id)[0].url}/b/live`)).status).toBe(404)
  })

  it('renders a board through the renderer it is given, and keeps 20 versions', async () => {
    const { sw } = await started()
    const calls: [string, number, number][] = []
    const fake = async (u: string, w: number, h: number) => {
      calls.push([u, w, h])
      return Buffer.from('png')
    }
    ;(sw as unknown as { render: typeof fake }).render = fake
    const { swatch } = sw.publishMockup({ title: 'M', boards: [{ name: 'a', width: 1440, height: 900, html: page('a') }] })
    const shot = await sw.snapshot(swatch.id, 'a', { width: 390, tweaks: { x: 1 } })
    expect([shot.width, shot.height, shot.png.toString()]).toEqual([390, 900, 'png'])
    expect(calls[0][0]).toMatch(/\/b\/a\?v=1#tweaks=/)
    await expect(sw.snapshot(swatch.id, 'zz')).rejects.toThrow(/no board "zz"/)
    for (let i = 0; i < 21; i++) sw.publishMockup({ id: swatch.id, boards: [{ name: 'a', html: page(`v${i}`) }] })
    const info = sw.mockup(swatch.id)
    expect(info.version).toBe(22)
    expect(info.versions).toHaveLength(20)
    expect(info.versions[0]).toBe(3)
    expect(() => sw.mockup(swatch.id, 1)).toThrow(/no longer kept/)
  })
})
