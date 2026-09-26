// Live checks against the staged sidecars (npm run sidecars). They need network access, so they
// only run when CLOTH_LIVE_WEB=1 and the binaries are present.
import { afterAll, describe, expect, it } from 'vitest'
import { makeServices } from './helpers'

const live = process.env.CLOTH_LIVE_WEB === '1'
const { services } = makeServices()
afterAll(() => services.web.stop())

describe.skipIf(!live || !services.web.status().obscura.available)('Obscura (live)', () => {
  it('searches DuckDuckGo', async () => {
    services.settings.update({ webEngine: 'obscura' })
    const res = await services.web.search('sqlite fts5 bm25', { k: 5 })
    expect(res.engine).toBe('obscura')
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results[0].url).toMatch(/^https?:\/\//)
  }, 60_000)

  it('fetches a page as markdown', async () => {
    const page = await services.web.fetchPage('https://example.com')
    expect(page.via).toBe('obscura')
    expect(page.markdown).toMatch(/Example Domain/)
  }, 60_000)
})

describe.skipIf(!live || !services.web.status().searxng.bundled)('SearXNG sidecar (live)', () => {
  it('boots on demand and returns JSON results', async () => {
    services.settings.update({ webEngine: 'searxng' })
    const res = await services.web.search('python asyncio gather', { k: 5 })
    expect(services.web.status().searxng.running).toBe(true)
    expect(res.engine).toBe('searxng')
    expect(res.results.length).toBeGreaterThan(0)
  }, 90_000)
})
