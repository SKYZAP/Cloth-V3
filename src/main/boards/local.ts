import type { BoardProject, TicketComment, TrackerState } from '@shared/boards'
import { projectIdentifiers, type RawTicket, type Tracker } from './trackers'

/*
 * The Cloth board: a tracker kept in Cloth's own storage, for working fully offline. Its states are the agent
 * stages themselves (each state's id is the stage it stands for), so its stage map never needs setting up.
 */

const K_LOCAL = 'boards.local'

interface LocalTicket extends RawTicket {
  createdAt: number
  comments: TicketComment[]
}

interface LocalStore {
  projects: BoardProject[]
  /** project id → the last ticket number used. */
  seq: Record<string, number>
  /** project id → its tickets, newest first. */
  tickets: Record<string, LocalTicket[]>
}

export interface KvLike {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

/** The Cloth board's states: one per stage, plus cancelled. Ids are stage names. */
export const LOCAL_STATES: TrackerState[] = [
  { id: 'new', name: 'Backlog', group: 'backlog', custom: false },
  { id: 'req', name: 'Requirements', group: 'unstarted', custom: false },
  { id: 'rev', name: 'Review', group: 'unstarted', custom: false },
  { id: 'build', name: 'Building', group: 'started', custom: false },
  { id: 'pr', name: 'Ready', group: 'started', custom: false },
  { id: 'merged', name: 'Done', group: 'completed', custom: false },
  { id: 'cancelled', name: 'Cancelled', group: 'cancelled', custom: false }
]

/** Every stage maps to the state with its own name. */
export const LOCAL_STATE_MAP = { new: 'new', req: 'req', rev: 'rev', build: 'build', pr: 'pr', merged: 'merged' } as const

const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export interface LocalTracker extends Tracker {
  /** A ticket's comments, oldest first. */
  comments(projectId: string, ticketId: string): TicketComment[]
  deleteTicket(project: BoardProject, ticketId: string): Promise<void>
  renameProject(projectId: string, name: string): Promise<void>
  /** The project, its tickets and its ticket numbering. */
  deleteProject(projectId: string): Promise<void>
}

export function localTracker(kv: KvLike): LocalTracker {
  const load = (): LocalStore => {
    const s = kv.get<Partial<LocalStore>>(K_LOCAL, {})
    return { projects: s.projects ?? [], seq: s.seq ?? {}, tickets: s.tickets ?? {} }
  }
  const save = (s: LocalStore) => kv.set(K_LOCAL, s)
  /** Change one ticket in place; throws when it's gone. */
  const edit = (p: BoardProject, ticketId: string, fn: (t: LocalTicket) => void) => {
    const s = load()
    const t = s.tickets[p.id]?.find((x) => x.id === ticketId)
    if (!t) throw new Error('That ticket is no longer on the board')
    fn(t)
    save(s)
  }
  const raw = ({ createdAt: _c, comments: _m, ...t }: LocalTicket): RawTicket => t
  return {
    kind: 'cloth',
    async projects() {
      return load().projects
    },
    async states() {
      return LOCAL_STATES
    },
    async tickets(p) {
      return (load().tickets[p.id] ?? []).map(raw)
    },
    async createProject(name) {
      const s = load()
      const taken = new Set(s.projects.map((p) => p.key))
      const key = projectIdentifiers(name).find((k) => !taken.has(k)) ?? `${projectIdentifiers(name)[0].slice(0, 3)}${s.projects.length + 1}`
      const p: BoardProject = { id: id('lp'), key, name: name.trim() || 'Board' }
      s.projects.push(p)
      s.tickets[p.id] = []
      save(s)
      return p
    },
    async create(p, input) {
      const s = load()
      if (!s.projects.some((x) => x.id === p.id)) throw new Error('That project is no longer on the board')
      const n = (s.seq[p.id] ?? 0) + 1
      s.seq[p.id] = n
      const t: LocalTicket = { id: id('lt'), key: `${p.key}-${n}`, title: input.title, description: input.description, stateId: input.stateId ?? 'new', priority: 'none', url: '', createdAt: Date.now(), comments: [] }
      s.tickets[p.id] = [t, ...(s.tickets[p.id] ?? [])]
      save(s)
      return raw(t)
    },
    async setState(p, t, stateId) {
      edit(p, t.id, (x) => (x.stateId = stateId))
    },
    async setDescription(p, t, text) {
      edit(p, t.id, (x) => (x.description = text))
    },
    async comment(p, t, text) {
      edit(p, t.id, (x) => x.comments.push({ at: Date.now(), text }))
    },
    comments(projectId, ticketId) {
      return load().tickets[projectId]?.find((x) => x.id === ticketId)?.comments ?? []
    },
    async deleteTicket(p, ticketId) {
      const s = load()
      s.tickets[p.id] = (s.tickets[p.id] ?? []).filter((x) => x.id !== ticketId)
      save(s)
    },
    async renameProject(projectId, name) {
      const s = load()
      const p = s.projects.find((x) => x.id === projectId)
      if (!p) throw new Error('That project is no longer on the board')
      p.name = name.trim()
      save(s)
    },
    async deleteProject(projectId) {
      const s = load()
      s.projects = s.projects.filter((x) => x.id !== projectId)
      delete s.tickets[projectId]
      delete s.seq[projectId]
      save(s)
    }
  }
}
