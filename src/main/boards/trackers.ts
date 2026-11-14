import type { BoardProject, TicketPriority, TrackerKind, TrackerState } from '@shared/boards'

/** A ticket as the tracker has it. */
export interface RawTicket {
  id: string
  key: string
  title: string
  description: string
  stateId: string
  priority: TicketPriority
  url: string
}

/** What Boards needs from Plane or Jira. */
export interface Tracker {
  kind: TrackerKind
  projects(): Promise<BoardProject[]>
  states(project: BoardProject): Promise<TrackerState[]>
  tickets(project: BoardProject): Promise<RawTicket[]>
  create(project: BoardProject, input: { title: string; description: string; stateId: string | null }): Promise<RawTicket>
  setState(project: BoardProject, ticket: RawTicket, stateId: string): Promise<void>
  setDescription(project: BoardProject, ticket: RawTicket, text: string): Promise<void>
  comment(project: BoardProject, ticket: RawTicket, text: string): Promise<void>
}

export interface TrackerConfig {
  kind: TrackerKind
  baseUrl: string
  workspace?: string
  email?: string
  token: string
}

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '')

async function request(url: string, init: RequestInit & { headers: Record<string, string> }, what: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    throw new Error(`Couldn't reach the tracker (${what}): ${err instanceof Error ? err.message : err}`)
  }
  if (res.status === 401 || res.status === 403) throw new Error('The tracker refused the token. Check it in Boards → Connect.')
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`The tracker answered ${res.status} to ${what}${body ? `: ${body}` : ''}`)
  }
  if (res.status === 204) return null
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Plain text → simple HTML: "## " headings, "- " list items, paragraphs. */
export function textToHtml(text: string): string {
  const out: string[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`)
    list = []
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('- ')) list.push(t.slice(2))
    else {
      flush()
      if (t.startsWith('## ')) out.push(`<h3>${escapeHtml(t.slice(3))}</h3>`)
      else if (t) out.push(`<p>${escapeHtml(t)}</p>`)
    }
  }
  flush()
  return out.join('')
}

export function htmlToText(html: string): string {
  return html
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h[1-6][^>]*>/gi, '## ')
    .replace(/<\/(p|li|h[1-6]|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---- Plane ----

const PLANE_DEFAULT_STATES = new Set(['backlog', 'todo', 'in progress', 'done', 'cancelled'])
const planePriority = (p: unknown): TicketPriority => (['urgent', 'high', 'medium', 'low'].includes(String(p)) ? (p as TicketPriority) : 'none')
const results = <T>(v: unknown): T[] => (Array.isArray(v) ? v : ((v as { results?: T[] })?.results ?? []))

export function planeTracker(c: TrackerConfig): Tracker {
  const base = `${trimUrl(c.baseUrl)}/api/v1/workspaces/${encodeURIComponent(c.workspace ?? '')}`
  const headers = { 'X-API-Key': c.token, 'Content-Type': 'application/json' }
  const call = (path: string, what: string, init: RequestInit = {}) => request(`${base}${path}`, { ...init, headers }, what)
  const webUrl = (p: BoardProject, id: string) => `${trimUrl(c.baseUrl)}/${c.workspace}/projects/${p.id}/issues/${id}`
  const toTicket = (p: BoardProject, i: Record<string, unknown>): RawTicket => ({
    id: String(i.id),
    key: `${p.key}-${i.sequence_id}`,
    title: String(i.name ?? ''),
    description: htmlToText(String(i.description_html ?? '')),
    stateId: String(i.state ?? ''),
    priority: planePriority(i.priority),
    url: webUrl(p, String(i.id))
  })
  return {
    kind: 'plane',
    async projects() {
      const list = results<Record<string, unknown>>(await call('/projects/', 'listing projects'))
      return list.filter((p) => !p.archived_at).map((p) => ({ id: String(p.id), key: String(p.identifier ?? ''), name: String(p.name ?? '') }))
    },
    async states(p) {
      const list = results<Record<string, unknown>>(await call(`/projects/${p.id}/states/`, 'listing states'))
      return list
        .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
        .map((s) => ({
          id: String(s.id),
          name: String(s.name ?? ''),
          group: (['backlog', 'unstarted', 'started', 'completed', 'cancelled'].includes(String(s.group)) ? s.group : 'started') as TrackerState['group'],
          custom: !PLANE_DEFAULT_STATES.has(String(s.name ?? '').toLowerCase())
        }))
    },
    async tickets(p) {
      const out: RawTicket[] = []
      let cursor = ''
      for (let page = 0; page < 10; page++) {
        const res = (await call(`/projects/${p.id}/issues/?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'listing tickets')) as {
          results?: Record<string, unknown>[]
          next_cursor?: string
          next_page_results?: boolean
        }
        out.push(...results<Record<string, unknown>>(res).map((i) => toTicket(p, i)))
        if (!res?.next_page_results || !res.next_cursor) break
        cursor = res.next_cursor
      }
      return out
    },
    async create(p, input) {
      const body: Record<string, unknown> = { name: input.title, description_html: textToHtml(input.description) }
      if (input.stateId) body.state = input.stateId
      return toTicket(p, (await call(`/projects/${p.id}/issues/`, 'creating the ticket', { method: 'POST', body: JSON.stringify(body) })) as Record<string, unknown>)
    },
    async setState(p, t, stateId) {
      await call(`/projects/${p.id}/issues/${t.id}/`, 'moving the ticket', { method: 'PATCH', body: JSON.stringify({ state: stateId }) })
    },
    async setDescription(p, t, text) {
      await call(`/projects/${p.id}/issues/${t.id}/`, 'writing the requirements', { method: 'PATCH', body: JSON.stringify({ description_html: textToHtml(text) }) })
    },
    async comment(p, t, text) {
      await call(`/projects/${p.id}/issues/${t.id}/comments/`, 'posting a comment', { method: 'POST', body: JSON.stringify({ comment_html: textToHtml(text) }) })
    }
  }
}

// ---- Jira (Cloud, REST v3) ----

const JIRA_DEFAULT_STATES = new Set(['to do', 'in progress', 'done', 'backlog', 'selected for development', 'in review'])

/** Plain text → Atlassian Document Format. */
export function textToAdf(text: string): unknown {
  const content: unknown[] = []
  let list: unknown[] = []
  const para = (t: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] })
  const flush = () => {
    if (list.length) content.push({ type: 'bulletList', content: list })
    list = []
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('- ')) list.push({ type: 'listItem', content: [para(t.slice(2))] })
    else {
      flush()
      if (t.startsWith('## ')) content.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: t.slice(3) }] })
      else if (t) content.push(para(t))
    }
  }
  flush()
  return { type: 'doc', version: 1, content }
}

export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { type?: string; text?: string; content?: unknown[] }
  if (n.type === 'text') return n.text ?? ''
  const inner = (n.content ?? []).map(adfToText).join('')
  if (n.type === 'listItem') return `- ${inner.trim()}\n`
  if (n.type === 'heading') return `## ${inner}\n`
  if (n.type === 'paragraph') return `${inner}\n`
  return inner
}

const jiraPriority = (name: unknown): TicketPriority => {
  const n = String(name ?? '').toLowerCase()
  return n === 'highest' ? 'urgent' : n === 'high' ? 'high' : n === 'medium' ? 'medium' : n === 'low' || n === 'lowest' ? 'low' : 'none'
}

export function jiraTracker(c: TrackerConfig): Tracker {
  const base = trimUrl(c.baseUrl)
  const headers = {
    Authorization: `Basic ${Buffer.from(`${c.email ?? ''}:${c.token}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  const call = (path: string, what: string, init: RequestInit = {}) => request(`${base}/rest/api/3${path}`, { ...init, headers }, what)
  const toTicket = (i: { id: string; key: string; fields: Record<string, unknown> }): RawTicket => ({
    id: i.id,
    key: i.key,
    title: String(i.fields.summary ?? ''),
    description: adfToText(i.fields.description).trim(),
    stateId: String((i.fields.status as { id?: string })?.id ?? ''),
    priority: jiraPriority((i.fields.priority as { name?: string })?.name),
    url: `${base}/browse/${i.key}`
  })
  return {
    kind: 'jira',
    async projects() {
      const res = (await call('/project/search?maxResults=100', 'listing projects')) as { values?: { id: string; key: string; name: string }[] }
      return (res?.values ?? []).map((p) => ({ id: p.id, key: p.key, name: p.name }))
    },
    async states(p) {
      const res = (await call(`/project/${encodeURIComponent(p.key)}/statuses`, 'listing statuses')) as { statuses: { id: string; name: string; statusCategory?: { key?: string } }[] }[]
      const seen = new Map<string, TrackerState>()
      for (const type of res ?? [])
        for (const s of type.statuses ?? []) {
          if (seen.has(s.id)) continue
          const cat = s.statusCategory?.key
          seen.set(s.id, { id: s.id, name: s.name, group: cat === 'new' ? 'unstarted' : cat === 'done' ? 'completed' : 'started', custom: !JIRA_DEFAULT_STATES.has(s.name.toLowerCase()) })
        }
      return [...seen.values()]
    },
    async tickets(p) {
      const out: RawTicket[] = []
      let nextPageToken: string | undefined
      for (let page = 0; page < 10; page++) {
        const res = (await call('/search/jql', 'listing tickets', {
          method: 'POST',
          body: JSON.stringify({ jql: `project = "${p.key}" ORDER BY created DESC`, fields: ['summary', 'status', 'priority', 'description'], maxResults: 100, nextPageToken })
        })) as { issues?: { id: string; key: string; fields: Record<string, unknown> }[]; nextPageToken?: string }
        out.push(...(res?.issues ?? []).map(toTicket))
        if (!res?.nextPageToken) break
        nextPageToken = res.nextPageToken
      }
      return out
    },
    async create(p, input) {
      const made = (await call('/issue', 'creating the ticket', {
        method: 'POST',
        body: JSON.stringify({ fields: { project: { key: p.key }, summary: input.title, issuetype: { name: 'Task' }, description: textToAdf(input.description) } })
      })) as { id: string; key: string }
      const t: RawTicket = { id: made.id, key: made.key, title: input.title, description: input.description, stateId: '', priority: 'none', url: `${base}/browse/${made.key}` }
      if (input.stateId) await this.setState(p, t, input.stateId).catch(() => undefined)
      return t
    },
    async setState(_p, t, stateId) {
      const res = (await call(`/issue/${t.key}/transitions`, 'reading transitions')) as { transitions?: { id: string; to?: { id?: string } }[] }
      const tr = (res?.transitions ?? []).find((x) => x.to?.id === stateId)
      if (!tr) throw new Error(`Jira has no transition from ${t.key}'s status to the mapped one. Allow it in the workflow, or change the stage map.`)
      await call(`/issue/${t.key}/transitions`, 'moving the ticket', { method: 'POST', body: JSON.stringify({ transition: { id: tr.id } }) })
    },
    async setDescription(_p, t, text) {
      await call(`/issue/${t.key}`, 'writing the requirements', { method: 'PUT', body: JSON.stringify({ fields: { description: textToAdf(text) } }) })
    },
    async comment(_p, t, text) {
      await call(`/issue/${t.key}/comment`, 'posting a comment', { method: 'POST', body: JSON.stringify({ body: textToAdf(text) }) })
    }
  }
}

export const makeTracker = (c: TrackerConfig): Tracker => (c.kind === 'plane' ? planeTracker(c) : jiraTracker(c))

/** A first stage → state map: the closest state for each stage, by name and then by group. */
export function defaultStateMap(states: TrackerState[]): Record<string, string | null> {
  const byName = (re: RegExp, groups?: TrackerState['group'][]) => states.find((s) => re.test(s.name) && (!groups || groups.includes(s.group)))
  const inGroup = (g: TrackerState['group']) => states.find((s) => s.group === g)
  const started = states.filter((s) => s.group === 'started')
  const pick = (...c: (TrackerState | undefined)[]) => c.find(Boolean)?.id ?? null
  return {
    new: pick(byName(/backlog/i), inGroup('backlog'), inGroup('unstarted')),
    req: pick(byName(/^(todo|to do)$/i), inGroup('unstarted'), inGroup('backlog')),
    rev: pick(byName(/spec|refine|requirement/i), byName(/^(todo|to do)$/i), inGroup('unstarted')),
    build: pick(byName(/progress|doing|develop|build/i, ['started']), started[0]),
    pr: pick(byName(/review|\bpr\b|\bqa\b/i, ['started']), started[started.length - 1]),
    merged: pick(byName(/done|closed|complete/i, ['completed']), inGroup('completed'))
  }
}
