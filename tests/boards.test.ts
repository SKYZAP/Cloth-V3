import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { git } from '../src/main/panel/git'
import { makeServices } from './helpers'
import { checksReport, cleanLog, commitHeader, commitMessage, describe as describeTicket, failedChecks, goalOf, parseJson, prBody, prTitle } from '../src/main/boards/boards'
import { adfToText, defaultStateMap, htmlToText, projectIdentifiers, textToAdf, textToHtml } from '../src/main/boards/trackers'
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
  const projects: Record<string, unknown>[] = [{ id: 'p-1', identifier: 'CL', name: 'Cloth app' }]
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    const method = init.method ?? 'GET'
    calls.push(`${method} ${u.pathname}`)
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret-tok-123')
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })
    const path = u.pathname.replace('/api/v1/workspaces/team', '')
    if (path === '/projects/' && method === 'GET') return json({ results: projects })
    if (path === '/projects/' && method === 'POST') {
      const body = JSON.parse(String(init.body))
      if (projects.some((x) => x.identifier === body.identifier)) return json({ identifier: ['taken'] }, 400)
      const made = { id: `p-${projects.length + 1}`, identifier: body.identifier, name: body.name }
      projects.push(made)
      return json(made, 201)
    }
    if (/^\/projects\/[^/]+\/states\/$/.test(path)) return json({ results: states })
    if (/^\/projects\/p-[2-9]\/issues\/$/.test(path)) return json({ results: [], next_page_results: false })
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
  return { issues, comments, calls, projects }
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

  it('makes ticket key prefixes from a project name', () => {
    expect(projectIdentifiers('Billing service')).toEqual(['BS', 'BS2', 'BS3', 'BS4', 'BS5'])
    expect(projectIdentifiers('cloth')).toEqual(['CLOTH', 'CLOT2', 'CLOT3', 'CLOT4', 'CLOT5'])
    expect(projectIdentifiers('!!')[0]).toBe('PROJ')
  })
})

describe('boards', () => {
  it('connects, lists tickets by stage, and runs a new ticket through requirements and review', async () => {
    const plane = fakePlane()
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    await services.boards.connect({ kind: 'plane', baseUrl: 'https://plane.test', workspace: 'team', token: ' secret-tok-123 ' })
    services.boards.saveSettings('p-1', { trackerUpdates: true })

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

  it('links a chat project to the Plane project with its name, or creates one', async () => {
    const plane = fakePlane()
    const { services } = makeServices()
    await services.boards.connect({ kind: 'plane', baseUrl: 'https://plane.test', workspace: 'team', token: 'secret-tok-123' })

    // Same name, any case: the existing project is the board.
    const same = services.projects.create({ name: 'cloth APP', folder: null })
    expect(await services.boards.linkChatProject(same.id)).toEqual({ kind: 'plane', projectId: 'p-1', name: 'Cloth app' })
    expect(plane.projects).toHaveLength(1)

    // No such project: one is made (CL is taken, so CL2), its board takes the folder and is shown.
    const fresh = services.projects.create({ name: 'Command Line', folder: 'E:/code/cli' })
    const link = await services.boards.linkChatProject(fresh.id)
    expect(plane.projects[1]).toMatchObject({ name: 'Command Line', identifier: 'CL2' })
    expect(services.boards.overview()).toMatchObject({ projectId: link.projectId, chatProjectId: fresh.id, settings: { repo: 'E:/code/cli' } })
    expect(Object.keys(services.boards.links()).sort()).toEqual([same.id, fresh.id].sort())

    services.boards.unlinkChatProject(same.id)
    expect(Object.keys(services.boards.links())).toEqual([fresh.id])
    services.boards.stop()
  })

  it('refuses a ticket handed to agents without a goal', async () => {
    fakePlane()
    const { services } = makeServices()
    await services.boards.connect({ kind: 'plane', baseUrl: 'https://plane.test', workspace: 'team', token: 'secret-tok-123' })
    services.boards.saveSettings('p-1', { trackerUpdates: true })
    await expect(services.boards.createTicket({ title: 'x', goal: ' ', auto: true })).rejects.toThrow(/goal/)
    services.boards.stop()
  })

  it('starts with commits, PRs and ticket updates off, and keeps the other settings in range', async () => {
    fakePlane()
    const { services } = makeServices()
    await services.boards.connect({ kind: 'plane', baseUrl: 'https://plane.test', workspace: 'team', token: 'secret-tok-123' })
    expect(services.boards.overview().settings).toMatchObject({ git: 'none', trackerUpdates: false, approveRequirements: false, reviewRounds: 2, checkFixes: 2, autoMerge: false })
    // Auto-merge needs pull requests; numbers are clamped.
    expect(services.boards.saveSettings('p-1', { autoMerge: true, reviewRounds: 9, checkFixes: -1 }).settings).toMatchObject({ autoMerge: false, reviewRounds: 5, checkFixes: 0 })
    expect(services.boards.saveSettings('p-1', { git: 'pr', autoMerge: true }).settings).toMatchObject({ git: 'pr', autoMerge: true })
    expect(services.boards.saveSettings('p-1', { git: 'commit' }).settings?.autoMerge).toBe(false)
    services.boards.stop()
  })

  it('with ticket updates off, reads the tracker but changes nothing in it', async () => {
    const plane = fakePlane()
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    await services.boards.connect({ kind: 'plane', baseUrl: 'https://plane.test', workspace: 'team', token: 'secret-tok-123' })
    await expect(services.boards.createTicket({ title: 'New one', goal: 'g', auto: true })).rejects.toThrow(/Ticket updates are off/)

    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([fauxAssistantMessage('{"requirements":["Keeps it"],"outOfScope":[]}'), fauxAssistantMessage('{"verdict":"approve","notes":""}')])
    services.boards.handToAgents('i-1')
    let t = services.boards.overview().tickets[0]
    for (let i = 0; i < 200 && t?.pipeline?.status !== 'needsYou'; i++) {
      await wait(10)
      t = services.boards.overview().tickets[0]
    }
    expect(t.pipeline).toMatchObject({ stage: 'build', status: 'needsYou', requirements: ['Keeps it'] })
    // The ticket stays in Todo (the Requirements state); a sync doesn't send it back to the planner.
    await services.boards.sync()
    expect(services.boards.overview().tickets[0].pipeline?.stage).toBe('build')
    expect(plane.calls.filter((c) => !c.startsWith('GET'))).toEqual([])
    expect(plane.comments).toEqual([])
    expect(plane.issues[0].state).toBe('s-todo')
    services.boards.stop()
  })

  it('waits for you to approve the requirements when the project asks, and sends back as often as it allows', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    const o = await services.boards.connect({ kind: 'cloth' })
    services.boards.saveSettings(o.projectId!, { approveRequirements: true, reviewRounds: 1 })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage('{"requirements":["A"],"outOfScope":[]}'),
      fauxAssistantMessage('{"verdict":"revise","notes":"Too vague."}'),
      fauxAssistantMessage('{"requirements":["A, exactly"],"outOfScope":[]}'),
      fauxAssistantMessage('{"verdict":"approve","notes":""}')
    ])
    await services.boards.createTicket({ title: 'Do A', goal: 'A happens.', auto: true })
    const ticket = async () => {
      let t = services.boards.overview().tickets[0]
      for (let i = 0; i < 200 && t?.pipeline?.status !== 'needsYou'; i++) {
        await wait(10)
        t = services.boards.overview().tickets[0]
      }
      return t
    }
    // One round allowed: the first send-back already waits for you.
    let t = await ticket()
    expect(t.pipeline).toMatchObject({ stage: 'req', status: 'needsYou', sendBacks: 1 })
    expect(t.pipeline?.note).toMatch(/back once/)
    services.boards.resume(t.id)
    await wait(20)
    t = await ticket()
    expect(t.pipeline).toMatchObject({ stage: 'build', status: 'needsYou', requirements: ['A, exactly'] })
    expect(t.pipeline?.note).toMatch(/approved the requirements/)
    services.boards.stop()
  })
})

async function gitRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cloth-board-repo-'))
  const run = async (args: string[]) => {
    const r = await git(root, args)
    if (r.code !== 0) throw new Error(r.stderr)
  }
  await run(['init', '-q', '-b', 'main'])
  await run(['config', 'user.email', 'test@example.com'])
  await run(['config', 'user.name', 'Test'])
  writeFileSync(join(root, 'readme.md'), 'hello\n')
  await run(['add', '-A'])
  await run(['commit', '-q', '-m', 'start'])
  return root
}

describe('the Cloth board', () => {
  /** Plan, approve, then the implementer writes one file. */
  const buildResponses = () => [
    fauxAssistantMessage('{"requirements":["Adds notes.txt"],"outOfScope":[]}'),
    fauxAssistantMessage('{"verdict":"approve","notes":"Good."}'),
    fauxAssistantMessage([fauxToolCall('write', { path: 'notes.txt', content: 'from the agent\n' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Added notes.txt.')
  ]

  async function board() {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    const o = await services.boards.connect({ kind: 'cloth' })
    return { services, projectId: o.projectId! }
  }

  async function settle(services: Awaited<ReturnType<typeof board>>['services'], title: string) {
    let t = services.boards.overview().tickets.find((x) => x.title === title)
    for (let i = 0; i < 400 && t?.pipeline?.status !== 'needsYou' && t?.pipeline?.status !== 'error'; i++) {
      await wait(10)
      t = services.boards.overview().tickets.find((x) => x.title === title)
    }
    return t!
  }

  it('keeps projects and tickets on this PC, with no token, and records the agents as comments', async () => {
    const { services, projectId } = await board()
    const o = services.boards.overview()
    expect(o.connection).toMatchObject({ kind: 'cloth', label: 'On this PC · 1 project' })
    expect(o.projects).toEqual([expect.objectContaining({ name: 'My board' })])
    expect(o.settings?.stateMap).toEqual({ new: 'new', req: 'req', rev: 'rev', build: 'build', pr: 'pr', merged: 'merged' })

    // Ticket updates don't apply: a Cloth board always updates its own tickets.
    await services.boards.createTicket({ title: 'Manual one', goal: '', auto: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses(buildResponses().slice(0, 2))
    await services.boards.createTicket({ title: 'Agent one', goal: 'Notes exist.', auto: true })
    const t = await settle(services, 'Agent one')
    // No code folder yet: it waits at Build. The ticket's state followed the stages, and the review is a comment.
    expect(t).toMatchObject({ key: 'MB-2', stage: 'build', stateName: 'Building', url: '' })
    expect(t.pipeline?.note).toMatch(/code folder/)
    expect(t.description).toContain('- Adds notes.txt')
    expect(t.comments?.map((c) => c.text)).toEqual([expect.stringContaining('Approved')])

    // More projects, goals, closing and deleting.
    const more = await services.boards.createProject('Side project')
    expect(more.projects.map((p) => p.name)).toEqual(['My board', 'Side project'])
    expect(more.projectId).not.toBe(projectId)
    await expect(services.boards.createProject('side PROJECT')).rejects.toThrow(/already/)
    await services.boards.selectProject(projectId)
    const manual = services.boards.overview().tickets.find((x) => x.title === 'Manual one')!
    expect((await services.boards.setGoal(manual.id, 'Something useful.')).tickets.find((x) => x.id === manual.id)?.description).toContain('Something useful.')
    expect((await services.boards.closeTicket(manual.id)).tickets.map((x) => x.title)).toEqual(['Agent one'])
    expect((await services.boards.deleteTicket(t.id)).tickets).toEqual([])

    // Closing the board keeps its tickets for next time.
    await services.boards.disconnect()
    await services.boards.connect({ kind: 'cloth' })
    expect(services.boards.overview().projects).toHaveLength(2)
    services.boards.stop()
  })

  it('without commits, leaves the changes in a worktree and applies them to the code folder uncommitted', async () => {
    const { services, projectId } = await board()
    const repo = await gitRepo()
    services.boards.saveSettings(projectId, { repo })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses(buildResponses())
    await services.boards.createTicket({ title: 'Add notes', goal: 'Notes exist.', auto: true })
    const t = await settle(services, 'Add notes')
    expect(t.pipeline?.note ?? '').not.toMatch(/error/i)
    expect(t).toMatchObject({ stage: 'pr', stateName: 'Ready', pipeline: { status: 'needsYou', files: 1, local: { mode: 'none', base: 'main' } } })
    const dir = t.pipeline!.local!.dir!
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('from the agent\n')
    // Nothing committed, no branch made, the code folder untouched.
    expect((await git(repo, ['log', '--oneline'])).stdout.trim().split('\n')).toHaveLength(1)
    expect((await git(repo, ['branch', '--format=%(refname:short)'])).stdout.trim()).toBe('main')
    expect(existsSync(join(repo, 'notes.txt'))).toBe(false)

    const after = await services.boards.applyChanges(t.id)
    expect(after.tickets).toEqual([])
    // Line endings follow the machine's git settings (core.autocrlf on Windows), as in any checkout.
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('from the agent\n')
    expect((await git(repo, ['status', '--porcelain'])).stdout).toContain('notes.txt')
    expect((await git(repo, ['log', '--oneline'])).stdout.trim().split('\n')).toHaveLength(1)
    expect(existsSync(dir)).toBe(false)
    services.boards.stop()
  }, 60_000)

  it('committing locally, makes a branch with the commit and pushes nothing', async () => {
    const { services, projectId } = await board()
    const repo = await gitRepo()
    services.boards.saveSettings(projectId, { repo, git: 'commit' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses(buildResponses())
    await services.boards.createTicket({ title: 'Add notes', goal: 'Notes exist.', auto: true })
    const t = await settle(services, 'Add notes')
    expect(t.pipeline).toMatchObject({ status: 'needsYou', branch: 'boards/mb-1', local: { mode: 'commit', branch: 'boards/mb-1', base: 'main' } })
    expect((await git(repo, ['log', '--format=%s', 'boards/mb-1', '-1'])).stdout.trim()).toBe('feat: add notes')
    // The repository has no remote, so a push would have failed the step.
    expect((await git(repo, ['remote'])).stdout.trim()).toBe('')
    expect(existsSync(join(repo, 'notes.txt'))).toBe(false)

    expect((await services.boards.finish(t.id)).tickets).toEqual([])
    expect((await git(repo, ['rev-parse', '--verify', 'boards/mb-1'])).code).toBe(0)
    services.boards.stop()
  }, 60_000)
})

describe('failing checks', () => {
  it('picks failed check runs and statuses out of the rollup', () => {
    const failed = failedChecks([
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/11/job/22' },
      { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'build', status: 'IN_PROGRESS' },
      { context: 'ci/external', state: 'ERROR', targetUrl: 'https://ci.example.com/1', description: 'Build broke' },
      { name: 'skipped', status: 'COMPLETED', conclusion: 'SKIPPED' }
    ])
    expect(failed).toEqual([
      { name: 'test', url: 'https://github.com/o/r/actions/runs/11/job/22', description: '' },
      { name: 'ci/external', url: 'https://ci.example.com/1', description: 'Build broke' }
    ])
  })

  it('writes the report the fixer reads, with logs fenced', () => {
    const text = checksReport([
      { name: 'test', url: 'https://x/1', description: '', log: 'FAIL src/a.test.ts' },
      { name: 'ci/external', url: '', description: 'Build broke', log: '' }
    ])
    expect(text).toContain('### test (https://x/1)')
    expect(text).toContain('```\nFAIL src/a.test.ts\n```')
    expect(text).toContain('### ci/external\nBuild broke\n(No log available.)')
  })
})

describe('commits and pull requests', () => {
  const t = { key: 'BB-2', title: 'Increase test coverage', url: 'http://plane.test/i/2' }

  it('writes one conventional commit for the change', () => {
    expect(commitMessage({ commit: { type: 'test', subject: 'Raise coverage to 80%' }, built: { summary: 'Added specs.', testing: [] } }, t)).toBe('test: raise coverage to 80%\n\nAdded specs.\n\nRefs: BB-2 http://plane.test/i/2')
    // No planner type: a feature named after the ticket.
    expect(commitMessage({}, t).split('\n')[0]).toBe('feat: increase test coverage')
    expect(commitMessage({ commit: { type: 'oops', subject: 'x' } }, t).split('\n')[0]).toBe('feat: x')
  })

  it('accepts only conventional commit headers from the fixer', () => {
    expect(commitHeader('fix(ci): generate the prisma client before tests')).toBe('fix(ci): generate the prisma client before tests')
    expect(commitHeader('BB-2: fix failing checks')).toBeNull()
    expect(commitHeader('whatever: x')).toBeNull()
    expect(commitHeader(undefined)).toBeNull()
  })

  it('titles and describes the PR the same way every time', () => {
    expect(prTitle(t)).toBe('[Cloth][BB-2] Increase test coverage')
    const body = prBody(t, { goal: 'Get to 80%.', requirements: ['Coverage is 80%'], outOfScope: ['E2E'], built: { summary: 'Added specs.', testing: ['npm test: passed'] }, research: { notes: [], assumptions: ['Jest config stays'] } }, ['src/a.spec.ts'])
    const headings = body.split('\n').filter((l) => l.startsWith('## '))
    expect(headings).toEqual(['## Summary', '## Ticket', '## Goal', '## Acceptance criteria', '## Out of scope', '## Changes', '## Testing', '## Assumptions'])
    expect(body).toContain('- [ ] Coverage is 80%')
    expect(body).toContain('[BB-2](http://plane.test/i/2)')
  })

  it('cleans CI logs for the fixer', () => {
    expect(cleanLog('Run-Test (22)\tUNKNOWN STEP\t2026-11-14T17:56:27.2827098Z     TypeError: \x1b[31mClass extends\x1b[39m')).toBe('    TypeError: Class extends')
  })
})

