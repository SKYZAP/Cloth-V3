import { afterEach, describe, expect, it, vi } from 'vitest'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'
import { describe as describeTicket, goalOf, parseJson } from '../src/main/boards/boards'
import { adfToText, defaultStateMap, htmlToText, textToAdf, textToHtml } from '../src/main/boards/trackers'
import type { TrackerState } from '../src/shared/boards'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
  vi.unstubAllGlobals()
})

/** A small Plane: one project, its states, and tickets that PATCH and comments change. */
function fakePlane() {
  const states = [
    { id: 's-backlog', name: 'Backlog', group: 'backlog', sequence: 1 },
    { id: 's-todo', name: 'Todo', group: 'unstarted', sequence: 2 },
    { id: 's-spec', name: 'Spec review', group: 'unstarted', sequence: 3 },
    { id: 's-prog', name: 'In Progress', group: 'started', sequence: 4 },
    { id: 's-rev', name: 'In Review', group: 'started', sequence: 5 },
    { id: 's-done', name: 'Done', group: 'completed', sequence: 6 }
  ]
  const issues: Record<string, unknown>[] = [{ id: 'i-1', name: 'Old ticket', description_html: '<p>Already there</p>', state: 's-todo', priority: 'high', sequence_id: 1 }]
  const comments: string[] = []
  const calls: string[] = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    calls.push(`${method} ${u.pathname}`)
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-tok-123')
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
    const path = u.pathname.replace('/api/v1/workspaces/team', '')
    if (path === '/projects/') return json({ results: [{ id: 'p-1', identifier: 'CL', name: 'Cloth app' }] })
    if (path === '/projects/p-1/states/') return json({ results: states })
    if (path === '/projects/p-1/issues/' && method === 'GET') return json({ results: issues, next_page_results: false })
    if (path === '/projects/p-1/issues/' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      const made = { id: `i-${issues.length + 1}`, name: body.name, description_html: body.description_html, state: body.state, priority: 'none', sequence_id: issues.length + 1 }
      issues.unshift(made)
      return json(made, 201)
    }
    const m = /^\/projects\/p-1\/issues\/([^/]+)\/(comments\/)?$/.exec(path)
    if (m && m[2]) {
      comments.push(JSON.parse(String(init.body)).comment_html)
      return json({}, 201)
    }
    if (m && method === 'PATCH') {
      const issue = issues.find((i) => i.id === m[1])!
      Object.assign(issue, Object.fromEntries(Object.entries(JSON.parse(String(init.body))).map(([k, v]) => [k, v])))
      return json(issue)
    }
    return json({ detail: 'not found' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { issues, comments, calls }
}

describe('boards helpers', () => {
  it('reads JSON from a fenced or bare reply', () => {
    expect(parseJson('Here:\n```json\n{"verdict":"approve"}\n```')).toEqual({ verdict: 'approve' })
    expect(parseJson('ok {"requirements":["a"]} done')).toEqual({ requirements: ['a'] })
    expect(parseJson('no json here')).toBeNull()
  })

  it('writes the goal and requirements, and reads the goal back', () => {
    const text = describeTicket('People see the token count.', ['Shows a count', 'Updates as you type'], ['Cost estimates'])
    expect(text).toContain('## Requirements\n- Shows a count')
    expect(goalOf(text)).toBe('People see the token count.')
    expect(goalOf('Written by a person')).toBe('Written by a person')
    expect(goalOf(htmlToText(textToHtml(text)))).toBe('People see the token count.')
    expect(adfToText(textToAdf(text))).toContain('- Updates as you type')
  })

  it('maps stages to the closest states', () => {
    const s = (id: string, name: string, group: TrackerState['group']): TrackerState => ({ id, name, group, custom: false })
    const map = defaultStateMap([s('b', 'Backlog', 'backlog'), s('t', 'Todo', 'unstarted'), s('p', 'In Progress', 'started'), s('r', 'In Review', 'started'), s('d', 'Done', 'completed')])
    expect(map).toEqual({ new: 'b', req: 't', rev: 't', build: 'p', pr: 'r', merged: 'd' })
  })
})

describe('boards', () => {
  it('connects, lists tickets by stage, and runs a new ticket through requirements and review', async () => {
    const plane = fakePlane()
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    await services.boards.connect({ kind: 'plane', baseUrl: 'https://plane.test', workspace: 'team', token: ' secret-tok-123 ' })

    const o = services.boards.overview()
    expect(o.connection).toMatchObject({ kind: 'plane', label: 'plane.test · 1 project' })
    expect(o.settings?.stateMap).toMatchObject({ new: 's-backlog', req: 's-todo', rev: 's-spec', build: 's-prog', pr: 's-rev', merged: 's-done' })
    expect(o.tickets).toEqual([expect.objectContaining({ key: 'CL-1', stage: 'req', pipeline: null, priority: 'high' })])
    // The token is never sent back to the renderer.
    expect(JSON.stringify(o)).not.toContain('secret-tok')

    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage('```json\n{"requirements":["Adds drag to reorder","Pins stay on top"],"outOfScope":[]}\n```'),
      fauxAssistantMessage('{"verdict":"revise","notes":"Drag to reorder isn\'t in the goal."}'),
      fauxAssistantMessage('{"requirements":["Pins stay on top"],"outOfScope":["Drag to reorder"]}'),
      fauxAssistantMessage('{"verdict":"approve","notes":""}')
    ])
    await services.boards.createTicket({ title: 'Pin chats', goal: 'Important chats stay at the top.', auto: true })
    let t = services.boards.overview().tickets.find((x) => x.title === 'Pin chats')
    for (let i = 0; i < 200 && t?.pipeline?.status !== 'needsYou'; i++) {
      await wait(10)
      t = services.boards.overview().tickets.find((x) => x.title === 'Pin chats')
    }
    // Sent back once, revised, approved; the build waits for a code folder.
    expect(t?.pipeline).toMatchObject({ stage: 'build', status: 'needsYou', sendBacks: 1, requirements: ['Pins stay on top'], outOfScope: ['Drag to reorder'] })
    expect(t?.pipeline?.note).toMatch(/code folder/)
    const issue = plane.issues.find((i) => i.name === 'Pin chats')!
    expect(issue.state).toBe('s-prog')
    expect(String(issue.description_html)).toContain('<li>Pins stay on top</li>')
    expect(plane.comments[0]).toContain('sent back')
    expect(plane.comments[1]).toContain('Approved')
    services.boards.stop()
  })

  it('refuses a ticket handed to agents without a goal', async () => {
    fakePlane()
    const { services } = makeServices()
    await services.boards.connect({ kind: 'plane', baseUrl: 'https://plane.test', workspace: 'team', token: 'secret-tok-123' })
    await expect(services.boards.createTicket({ title: 'x', goal: ' ', auto: true })).rejects.toThrow(/goal/)
    services.boards.stop()
  })
})
