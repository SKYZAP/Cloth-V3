import { describe, expect, it } from 'vitest'
import { makeServices } from './helpers'

describe('flows overview', () => {
  it('summarises runs per flow and overall, and lists the week’s schedule', async () => {
    const { services } = makeServices()
    const wf = services.workflows.create({ name: 'Check' })
    services.workflows.save(wf.id, {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { key: 'start', label: 'Start', defaultInput: '{}' } },
        { id: 'x', type: 'transform', position: { x: 300, y: 0 }, data: { key: 'check', label: 'Check the value', code: 'if (input.bad) throw new Error("value was bad" + String.fromCharCode(10) + "more detail"); return 1' } },
        { id: 'o', type: 'output', position: { x: 600, y: 0 }, data: { key: 'result', label: 'Output', value: '' } }
      ],
      edges: [
        { id: 'e1', source: 't', target: 'x' },
        { id: 'e2', source: 'x', target: 'o' }
      ],
      cron: '0 9 * * *',
      cronEnabled: true
    })
    await services.workflows.run(wf.id, {})
    await services.workflows.run(wf.id, { bad: true })
    const o = services.workflows.overview()
    const mine = o.flows.find((f) => f.id === wf.id)!
    expect(mine.runs[1].error).toBeNull()
    expect(mine.runs.map((r) => r.status)).toEqual(['error', 'ok'])
    expect(mine.runs[0]).toMatchObject({ failedStep: 'Check the value', error: expect.stringContaining('value was bad') })
    expect(mine.runs[0].error).not.toContain('more detail')
    // Daily at 09:00: seven or eight runs in the next week.
    expect(mine.upcoming.length).toBeGreaterThanOrEqual(7)
    expect(mine.upcoming.length).toBeLessThanOrEqual(8)
    expect(o.recent[0]).toMatchObject({ workflowId: wf.id, status: 'error' })
    services.workflows.stopScheduler()
  })

  it('has templates for watching a page and summarising a folder', async () => {
    const { services } = makeServices()
    const watch = services.workflows.create({ name: 'Watch', template: 'watch-page' })
    expect(watch.nodes.map((n) => n.type)).toEqual(['trigger', 'http', 'transform', 'llm', 'output'])
    // The "page as text" step turns HTML into plain text.
    const code = String(watch.nodes.find((n) => n.type === 'transform')!.data.code)
    const text = new Function('prev', code)({ body: '<html><style>p{}</style><body><h1>Pricing</h1><script>x()</script><p>Pro: $20</p></body></html>' })
    expect(text.trim()).toBe('Pricing Pro: $20')
    const folder = services.workflows.create({ name: 'Folder', template: 'summarise-folder' })
    expect(folder.nodes.map((n) => n.type)).toEqual(['trigger', 'agent', 'output'])
    services.workflows.stopScheduler()
  })
})
