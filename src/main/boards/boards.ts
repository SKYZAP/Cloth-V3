import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  STAGES,
  TRACKER_NAMES,
  goalOf,
  type BoardAgents,
  type BoardLink,
  type BoardOverview,
  type BoardProject,
  type BoardProjectSettings,
  type BoardTicket,
  type NewTicketInput,
  type Stage,
  type TicketPipeline,
  type TrackerConnectInput,
  type TrackerConnection,
  type TrackerState
} from '@shared/boards'
import type { ModelRef } from '@shared/types'
import { errorMessage, type Ctx } from '../core/context'
import type { SettingsService } from '../core/settings'
import type { AgentService } from '../agent/agents'
import type { ProjectService } from '../agent/projects'
import { agentScope, type AgentRuntime } from '../agent/chat'
import type { ToolScope } from '../agent/tools'
import { git, repoRoot } from '../panel/git'
import { defaultStateMap, makeTracker, type RawTicket, type Tracker, type TrackerConfig } from './trackers'
import { LOCAL_STATE_MAP, localTracker, type LocalTracker } from './local'

/*
 * Boards keeps one tracker connection, the chosen project, each project's settings, and a pipeline record
 * per ticket handed to agents. The tracker stays the source of truth for tickets; Cloth moves them between
 * the mapped states as its agents work, writes requirements into the description, and comments reviews.
 */

const K_CONN = 'boards.connection'
const K_PROJECT = 'boards.project'
const K_SETTINGS = 'boards.settings'
const K_PIPES = 'boards.pipelines'
/** chat project id → its board. */
const K_LINKS = 'boards.links'
const SYNC_MS = 60_000
const MAX_RUNNING = 2
/** Send-backs from review before the ticket waits for you, unless the project sets its own. */
const REVIEW_ROUNDS = 2
/** Fixes an agent pushes for failing checks on its own before it hands the PR to you, unless the project sets its own. */
const CHECK_FIXES = 2
// Bare `node` isn't here: `node -e …` runs any code, and these run with nobody watching.
const DEFAULT_COMMANDS = ['npm test', 'npm run', 'npx tsc', 'npx vitest', 'pnpm test', 'pnpm run', 'yarn test']
const clamp = (n: unknown, lo: number, hi: number, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback)

interface StoredConn extends Omit<TrackerConfig, 'token' | 'kind'> {
  kind: TrackerConfig['kind'] | 'cloth'
  /** Encrypted, base64. Empty for a Cloth board. */
  token: string
}
type StoredPipe = TicketPipeline & { projectId: string; key: string; title: string }

export interface BoardDeps {
  runtime: AgentRuntime
  agents: AgentService
  settings: SettingsService
  projects: ProjectService
}

function exec(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        reject(new Error(missing ? `${cmd} isn't installed or isn't on the PATH.` : (String(stderr || stdout || err.message).trim().split('\n').slice(-3).join(' '))))
      } else resolve(String(stdout))
    })
  })
}

const gitRun = async (cwd: string, args: string[]) => {
  const r = await git(cwd, args, { timeoutMs: 120_000 })
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`)
  return r.stdout
}

/** The first {...} JSON object in a reply (agents often wrap it in a fence). */
export function parseJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  for (const candidate of [fenced, text]) {
    if (!candidate) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T
    } catch {
      /* try the next */
    }
  }
  return null
}

/** The ticket's description as Cloth writes it back: the goal, then the requirements. */
export function describe(goal: string, requirements: string[], outOfScope: string[]): string {
  const parts = [`## Goal`, goal.trim()]
  if (requirements.length) parts.push('', '## Requirements', ...requirements.map((r) => `- ${r}`))
  if (outOfScope.length) parts.push('', '## Out of scope', ...outOfScope.map((r) => `- ${r}`))
  parts.push('', 'Written by Cloth agents.')
  return parts.join('\n')
}

export { goalOf } from '@shared/boards'

const PLANNER = `You write requirements for a software ticket. Read the code in the workspace where it helps you be concrete.
Write acceptance criteria someone can check, each one sentence, only what the goal asks for. Note what is out of scope.
Reply with only a JSON object: {"requirements": ["..."], "outOfScope": ["..."]}.`

const REVIEWER = `You review requirements written for a software ticket. Check each one against the goal: approve when they cover the goal
and add nothing it doesn't ask for; otherwise send them back and say exactly which ones to change and why.
Reply with only a JSON object: {"verdict": "approve" | "revise", "notes": "..."}.`

const CODE_REVIEWER = `You review a pull request's diff against the ticket's requirements. Approve when the change meets them and has no
obvious bugs; otherwise say what is wrong. Reply with only a JSON object: {"verdict": "approve" | "revise", "notes": "..."}.`

/** Checks GitHub reports as failed (check runs and commit statuses). */
const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']

export interface RollupCheck {
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
  description?: string
}

export interface FailedCheck {
  name: string
  url: string
  description: string
}

/** The failed checks in a PR's status rollup, by name. */
export function failedChecks(roll: RollupCheck[]): FailedCheck[] {
  return roll
    .filter((c) => FAILED.includes(String(c.conclusion ?? c.state ?? '')))
    .map((c) => ({ name: c.name || c.context || 'Unnamed check', url: c.detailsUrl || c.targetUrl || '', description: c.description ?? '' }))
}

/** The PR's failing checks with the end of each one's log, as the fixer reads them. */
export function checksReport(checks: (FailedCheck & { log: string })[]): string {
  return checks.map((c) => [`### ${c.name}${c.url ? ` (${c.url})` : ''}`, c.description, c.log ? '```\n' + c.log + '\n```' : '(No log available.)'].filter(Boolean).join('\n')).join('\n\n')
}

const FIXER = `The pull request for this ticket failed its checks on GitHub. You are in a git worktree on the PR's branch.
Read the failing checks and their logs below, find the cause in the code, and fix it. Reproduce the failure with the
project's own commands first when you can, and run them again after the fix. Keep the change to what the checks need:
don't rework the feature, and don't weaken, skip or delete tests or checks to make them pass.
Don't commit or push: Cloth does that when you finish. End with a short summary of what was wrong and what you changed.`

const IMPLEMENTER = `You implement a software ticket in this workspace, a git worktree on its own branch. Meet every requirement,
stay inside them, follow the code's existing conventions, and run the project's tests or type checks when you can.
Don't commit or push: Cloth does that when you finish. End with a short summary of what you changed.`

const IMPLEMENTER_NO_GIT = `You implement a software ticket in this workspace, a separate git worktree. Meet every requirement,
stay inside them, follow the code's existing conventions, and run the project's tests or type checks when you can.
Don't commit, push or make branches: your changes are left as they are for the person to review and apply.
End with a short summary of what you changed.`

export class BoardService {
  private tracker: Tracker | null = null
  private projects: BoardProject[] = []
  private states = new Map<string, TrackerState[]>()
  private raw = new Map<string, RawTicket[]>()
  private syncedAt: number | null = null
  private syncError: string | undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private running = new Map<string, AbortController>()
  private queue: string[] = []
  private syncing: Promise<void> | null = null

  constructor(
    private ctx: Ctx,
    private deps: BoardDeps
  ) {
    const c = this.storedConn()
    if (c) this.tracker = this.trackerFor(c)
    // Steps cut off when Cloth closed wait for the user to resume them.
    const pipes = this.pipes()
    let changed = false
    for (const p of Object.values(pipes))
      if (p.status === 'running' || p.status === 'queued') {
        p.status = 'paused'
        p.note = 'Cloth closed during this step. Resume to run it again.'
        changed = true
      }
    if (changed) this.ctx.kv.set(K_PIPES, pipes)
  }

  /** Start syncing in the background (the app calls this once it's up). */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sync().catch(() => undefined), SYNC_MS)
    void this.sync().catch(() => undefined)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const a of this.running.values()) a.abort()
  }

  // ---- Connection ----

  private storedConn(): StoredConn | null {
    return this.ctx.kv.get<StoredConn | null>(K_CONN, null)
  }

  private trackerFor(c: StoredConn): Tracker {
    if (c.kind === 'cloth') return localTracker(this.ctx.kv)
    return makeTracker({ ...c, kind: c.kind, token: this.ctx.secrets.decrypt(Buffer.from(c.token, 'base64')) })
  }

  /** The connected board is a Cloth board (everything on this PC). */
  private isLocal(): boolean {
    return this.tracker?.kind === 'cloth'
  }

  private local(): LocalTracker | null {
    return this.isLocal() ? (this.tracker as LocalTracker) : null
  }

  /** Cloth may change the tracker's tickets: always on a Cloth board, else when the project allows ticket updates. */
  private writes(s: BoardProjectSettings): boolean {
    return this.isLocal() || s.trackerUpdates
  }

  /** A comment on the ticket, when Cloth may write to it; failures are only logged. */
  private async note(p: BoardProject, t: RawTicket, s: BoardProjectSettings, text: string): Promise<void> {
    if (!this.tracker || !this.writes(s)) return
    await this.tracker.comment(p, t, text).catch((err) => this.ctx.log('boards', `couldn't comment on ${t.key}: ${errorMessage(err)}`))
  }

  private connection(): TrackerConnection | null {
    const c = this.storedConn()
    if (!c) return null
    if (c.kind === 'cloth') return { kind: 'cloth', baseUrl: '', label: `On this PC · ${this.projects.length} project${this.projects.length === 1 ? '' : 's'}` }
    let host = c.baseUrl
    try {
      host = new URL(c.baseUrl).host
    } catch {
      /* keep the raw value */
    }
    return { kind: c.kind, baseUrl: c.baseUrl, workspace: c.workspace, email: c.email, label: `${host} · ${this.projects.length} project${this.projects.length === 1 ? '' : 's'}` }
  }

  async connect(input: TrackerConnectInput): Promise<BoardOverview> {
    let tracker: Tracker
    let stored: StoredConn
    if (input.kind === 'cloth') {
      // Nothing to check: the board lives in Cloth's own storage. A first board gets a project to start in.
      tracker = localTracker(this.ctx.kv)
      if (!(await tracker.projects()).length) await tracker.createProject!('My board')
      stored = { kind: 'cloth', baseUrl: '', token: '' }
    } else {
      const baseUrl = (input.baseUrl ?? '').trim()
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Enter the full address, starting with https://')
      if (!input.token?.trim()) throw new Error('Enter the API token')
      if (input.kind === 'plane' && !input.workspace?.trim()) throw new Error('Enter the workspace slug (the part after the address in Plane links)')
      if (input.kind === 'jira' && !input.email?.trim()) throw new Error('Enter the email of the Jira account the token belongs to')
      const config: TrackerConfig = { kind: input.kind, baseUrl, workspace: input.workspace?.trim(), email: input.email?.trim(), token: input.token.trim() }
      tracker = makeTracker(config)
      stored = { ...config, token: Buffer.from(this.ctx.secrets.encrypt(config.token)).toString('base64') }
    }
    const projects = await tracker.projects()
    // One tracker at a time: whatever was running on the old one stops.
    for (const a of this.running.values()) a.abort()
    this.running.clear()
    this.queue = []
    this.ctx.kv.set(K_CONN, stored)
    this.ctx.kv.set(K_PROJECT, projects[0]?.id ?? null)
    this.tracker = tracker
    this.projects = projects
    this.states.clear()
    this.raw.clear()
    this.syncedAt = null
    await this.sync()
    return this.overview()
  }

  async disconnect(): Promise<void> {
    for (const a of this.running.values()) a.abort()
    this.running.clear()
    this.queue = []
    this.ctx.kv.set(K_CONN, null)
    this.ctx.kv.set(K_PROJECT, null)
    this.tracker = null
    this.projects = []
    this.states.clear()
    this.raw.clear()
    this.changed()
  }

  // ---- Projects and settings ----

  private projectId(): string | null {
    return this.ctx.kv.get<string | null>(K_PROJECT, null)
  }

  private project(id = this.projectId()): BoardProject | null {
    return this.projects.find((p) => p.id === id) ?? null
  }

  private skey(projectId: string): string {
    return `${this.storedConn()?.kind ?? 'none'}:${projectId}`
  }

  private settingsFor(projectId: string): BoardProjectSettings {
    const all = this.ctx.kv.get<Record<string, BoardProjectSettings>>(K_SETTINGS, {})
    const saved = all[this.skey(projectId)] as Partial<BoardProjectSettings> | undefined
    // A Cloth board's states are its stages, so its map is fixed.
    const stateMap = this.isLocal()
      ? { ...LOCAL_STATE_MAP }
      : ({ ...defaultStateMap(this.states.get(projectId) ?? []), ...Object.fromEntries(Object.entries(saved?.stateMap ?? {}).filter(([, v]) => v)) } as BoardProjectSettings['stateMap'])
    const git = saved?.git === 'commit' || saved?.git === 'pr' ? saved.git : 'none'
    return {
      repo: saved?.repo ?? null,
      stateMap,
      git,
      trackerUpdates: saved?.trackerUpdates === true,
      approveRequirements: saved?.approveRequirements === true,
      reviewRounds: clamp(saved?.reviewRounds, 1, 5, REVIEW_ROUNDS),
      checkFixes: clamp(saved?.checkFixes, 0, 5, CHECK_FIXES),
      // Auto-merge needs a pull request to merge.
      autoMerge: git === 'pr' && saved?.autoMerge === true,
      agents: saved?.agents ?? { planner: null, reviewer: null, implementer: null },
      commands: saved?.commands ?? DEFAULT_COMMANDS
    }
  }

  /** A new project on a Cloth board, shown at once. */
  async createProject(name: string): Promise<BoardOverview> {
    const local = this.local()
    if (!local) throw new Error('Make projects in Plane or Jira itself; Cloth makes projects only on a Cloth board')
    if (!name.trim()) throw new Error('Enter a name for the project')
    if (this.projects.some((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())) throw new Error(`There is already a project called “${name.trim()}”`)
    const p = await local.createProject!(name.trim())
    this.projects = [...this.projects, p]
    this.ctx.kv.set(K_PROJECT, p.id)
    await this.sync()
    return this.overview()
  }

  async selectProject(id: string): Promise<BoardOverview> {
    if (!this.projects.some((p) => p.id === id)) throw new Error('That project is no longer in the tracker')
    this.ctx.kv.set(K_PROJECT, id)
    await this.sync()
    return this.overview()
  }

  saveSettings(projectId: string, patch: Partial<BoardProjectSettings>): BoardOverview {
    const all = this.ctx.kv.get<Record<string, BoardProjectSettings>>(K_SETTINGS, {})
    const next = { ...this.settingsFor(projectId), ...patch }
    if (patch.stateMap) next.stateMap = { ...this.settingsFor(projectId).stateMap, ...patch.stateMap }
    if (patch.agents) next.agents = { ...this.settingsFor(projectId).agents, ...patch.agents }
    if (patch.commands) next.commands = patch.commands.map((c) => c.trim()).filter(Boolean)
    next.reviewRounds = clamp(next.reviewRounds, 1, 5, REVIEW_ROUNDS)
    next.checkFixes = clamp(next.checkFixes, 0, 5, CHECK_FIXES)
    if (next.git !== 'pr') next.autoMerge = false
    all[this.skey(projectId)] = next
    this.ctx.kv.set(K_SETTINGS, all)
    this.changed()
    return this.overview()
  }

  // ---- Chat projects ----

  /** Links to boards on the connected tracker, for chat projects that still exist. */
  links(): Record<string, BoardLink> {
    const kind = this.storedConn()?.kind
    const all = this.ctx.kv.get<Record<string, BoardLink>>(K_LINKS, {})
    return Object.fromEntries(Object.entries(all).filter(([id, l]) => l.kind === kind && this.deps.projects.find(id)))
  }

  /**
   * Link a chat project to the tracker project with the same name (any case), making one in Plane when
   * there is none. The board's code folder starts as the chat project's folder, and the board is shown.
   */
  async linkChatProject(chatProjectId: string): Promise<BoardLink> {
    const cp = this.deps.projects.get(chatProjectId)
    const conn = this.storedConn()
    if (!this.tracker || !conn) throw new Error('Set up a board in Boards first: a Cloth board, Plane or Jira')
    const name = TRACKER_NAMES[conn.kind]
    this.projects = await this.tracker.projects()
    const want = cp.name.trim().toLowerCase()
    let bp = this.projects.find((p) => p.name.trim().toLowerCase() === want)
    if (!bp) {
      if (!this.tracker.createProject) throw new Error(`${name} has no project named “${cp.name}”. Create it in ${name}, then link again.`)
      bp = await this.tracker.createProject(cp.name.trim())
      this.projects = [...this.projects, bp]
      this.ctx.log('boards', `Created the ${name} project ${bp.name} (${bp.key}) for ${cp.name}`)
    }
    if (!this.settingsFor(bp.id).repo && cp.folder) this.saveSettings(bp.id, { repo: cp.folder })
    const link: BoardLink = { kind: conn.kind, projectId: bp.id, name: bp.name }
    this.ctx.kv.set(K_LINKS, { ...this.ctx.kv.get<Record<string, BoardLink>>(K_LINKS, {}), [chatProjectId]: link })
    this.ctx.kv.set(K_PROJECT, bp.id)
    await this.sync()
    return link
  }

  unlinkChatProject(chatProjectId: string): void {
    const all = this.ctx.kv.get<Record<string, BoardLink>>(K_LINKS, {})
    delete all[chatProjectId]
    this.ctx.kv.set(K_LINKS, all)
    this.changed()
  }

  // ---- Sync ----

  async sync(): Promise<void> {
    if (this.syncing) return this.syncing
    this.syncing = this.doSync().finally(() => (this.syncing = null))
    return this.syncing
  }

  private async doSync(): Promise<void> {
    const t = this.tracker
    if (!t) return
    try {
      if (!this.projects.length) this.projects = await t.projects()
      let pid = this.projectId()
      if (!this.project(pid)) {
        pid = this.projects[0]?.id ?? null
        this.ctx.kv.set(K_PROJECT, pid)
      }
      const p = this.project(pid)
      if (!p) return
      const [states, tickets] = await Promise.all([t.states(p), t.tickets(p)])
      this.states.set(p.id, states)
      this.raw.set(p.id, tickets)
      await this.reconcile(p, tickets)
      await this.checkPrs(p)
      this.syncedAt = Date.now()
      this.syncError = undefined
    } catch (err) {
      this.syncError = errorMessage(err)
    }
    this.changed()
  }

  /** Changes made in the tracker come back: a ticket moved to the Requirements state waits there for you to resume it; one moved to the merged state is done. */
  private async reconcile(p: BoardProject, tickets: RawTicket[]): Promise<void> {
    const s = this.settingsFor(p.id)
    const pipes = this.pipes()
    let changed = false
    for (const t of tickets) {
      const pipe = pipes[this.pkey(t.id)]
      if (!pipe || this.running.has(t.id) || pipe.status === 'done') continue
      if (t.stateId === s.stateMap[pipe.stage]) continue
      if (s.stateMap.merged && t.stateId === s.stateMap.merged) {
        pipe.status = 'done'
        changed = true
      } else if (this.writes(s) && t.stateId === s.stateMap.req && STAGES.indexOf(pipe.stage) > STAGES.indexOf('req') && pipe.stage !== 'pr') {
        // Only when Cloth moves tickets itself: with updates off the tracker's state stays where it was, so it says nothing.
        // Anyone with access to the tracker can move a ticket, so agents don't start again on their own: it waits for you.
        Object.assign(pipe, { stage: 'req', status: 'needsYou', note: 'Moved back to Requirements in the tracker. Resume to write the requirements again.', activity: undefined, review: undefined, sendBacks: 0, updatedAt: Date.now() })
        changed = true
      }
    }
    if (changed) this.ctx.kv.set(K_PIPES, pipes)
  }

  overview(): BoardOverview {
    const conn = this.connection()
    const pid = this.projectId()
    const p = this.project(pid)
    const states = p ? (this.states.get(p.id) ?? []) : []
    const settings = p ? this.settingsFor(p.id) : null
    const pipes = this.pipes()
    const tickets: BoardTicket[] = []
    const local = this.local()
    if (p && settings)
      for (const t of this.raw.get(p.id) ?? []) {
        const pipe = pipes[this.pkey(t.id)] ?? null
        const state = states.find((s) => s.id === t.stateId)
        if (pipe?.status === 'done') continue
        if (!pipe && (state?.group === 'completed' || state?.group === 'cancelled' || t.stateId === settings.stateMap.merged)) continue
        // Without agents, the column comes from the tracker state (the first stage mapped to it).
        const mapped = STAGES.find((st) => settings.stateMap[st] === t.stateId)
        const stage: Stage = pipe?.stage ?? mapped ?? (state?.group === 'started' ? 'build' : 'new')
        tickets.push({ id: t.id, key: t.key, title: t.title, priority: t.priority, stateId: t.stateId, stateName: state?.name ?? '', stage, url: t.url, description: t.description, pipeline: pipe ? this.publicPipe(pipe) : null, ...(local ? { comments: local.comments(p.id, t.id) } : {}) })
      }
    const chatProjectId = p ? (Object.entries(this.links()).find(([, l]) => l.projectId === p.id)?.[0] ?? null) : null
    return { connection: conn, projects: this.projects, projectId: p?.id ?? null, states, settings, tickets, syncedAt: this.syncedAt, chatProjectId, error: this.syncError }
  }

  private publicPipe(p: StoredPipe): TicketPipeline {
    const { projectId: _p, key: _k, title: _t, ...rest } = p
    return rest
  }

  // ---- Tickets ----

  async createTicket(input: NewTicketInput): Promise<BoardOverview> {
    const t = this.tracker
    const p = this.project()
    if (!t || !p) throw new Error('Connect a tracker and pick a project first')
    const title = input.title.trim()
    const goal = input.goal.trim()
    if (!title) throw new Error('Enter a title')
    if (input.auto && !goal) throw new Error('Enter a goal: the planner writes the requirements from it')
    const s = this.settingsFor(p.id)
    if (!this.writes(s)) throw new Error(`Ticket updates are off for this project, so Cloth won't create tickets in ${TRACKER_NAMES[t.kind]}. Turn on “Allow ticket sync and updates” in Project settings, or create the ticket in ${TRACKER_NAMES[t.kind]}.`)
    const made = await t.create(p, { title, description: goal ? describe(goal, [], []) : '', stateId: s.stateMap.new })
    this.raw.set(p.id, [made, ...(this.raw.get(p.id) ?? [])])
    if (input.auto) this.startPipeline(p, made, goal, { ...s.agents, ...input.agents })
    this.changed()
    void this.sync()
    return this.overview()
  }

  /** Hand an existing ticket to agents; its description (or the goal in it) is the goal. */
  handToAgents(ticketId: string, agents?: Partial<BoardAgents>): BoardOverview {
    const p = this.project()
    const t = p && this.raw.get(p.id)?.find((x) => x.id === ticketId)
    if (!p || !t) throw new Error('That ticket is no longer on the board')
    const goal = goalOf(t.description) || t.title
    this.startPipeline(p, t, goal, { ...this.settingsFor(p.id).agents, ...agents })
    return this.overview()
  }

  private startPipeline(p: BoardProject, t: RawTicket, goal: string, agents: BoardAgents): void {
    const pipes = this.pipes()
    pipes[this.pkey(t.id)] = { projectId: p.id, key: t.key, title: t.title, stage: 'req', status: 'queued', goal, requirements: [], outOfScope: [], sendBacks: 0, agents, updatedAt: Date.now() }
    this.ctx.kv.set(K_PIPES, pipes)
    this.enqueue(t.id)
  }

  pause(ticketId: string): BoardOverview {
    this.running.get(ticketId)?.abort()
    this.queue = this.queue.filter((q) => q !== ticketId)
    this.update(ticketId, { status: 'paused', note: 'Paused. Resume to run this step again.', activity: undefined })
    return this.overview()
  }

  resume(ticketId: string): BoardOverview {
    const pipe = this.pipes()[this.pkey(ticketId)]
    if (!pipe) throw new Error('Agents aren\'t on for this ticket')
    // Built without a PR: nothing runs any more; the changes wait to be applied or the ticket marked done.
    if (pipe.stage === 'pr' && pipe.local) return this.overview()
    if (pipe.stage === 'pr' && !pipe.fixing) {
      // Nothing to rerun: the PR is open; go back to watching its checks.
      this.update(ticketId, { status: 'running', note: undefined })
      void this.sync()
      return this.overview()
    }
    // A ticket stopped after review sent it back twice gets one more round.
    this.update(ticketId, { status: 'queued', note: undefined, sendBacks: pipe.status === 'needsYou' && pipe.stage === 'req' ? 0 : pipe.sendBacks })
    this.enqueue(ticketId)
    return this.overview()
  }

  /** Queue an agent to fix the PR's failing checks and push to the same PR. */
  fixChecks(ticketId: string): BoardOverview {
    const pipe = this.pipes()[this.pkey(ticketId)]
    if (!pipe || pipe.stage !== 'pr' || !pipe.pr) throw new Error('This ticket has no open pull request')
    if (this.running.has(ticketId) || this.queue.includes(ticketId)) return this.overview()
    this.update(ticketId, { fixing: true, status: 'queued', note: undefined })
    this.enqueue(ticketId)
    return this.overview()
  }

  /** Take agents off a ticket; it stays in the tracker as it is. */
  stopAgents(ticketId: string): BoardOverview {
    this.running.get(ticketId)?.abort()
    this.queue = this.queue.filter((q) => q !== ticketId)
    const pipes = this.pipes()
    delete pipes[this.pkey(ticketId)]
    this.ctx.kv.set(K_PIPES, pipes)
    this.changed()
    return this.overview()
  }

  /** The ticket and its project, with its pipeline when agents are on. */
  private find(ticketId: string): { p: BoardProject; t: RawTicket; s: BoardProjectSettings; pipe: StoredPipe | null } {
    const pipe = this.pipes()[this.pkey(ticketId)] ?? null
    const p = this.project(pipe?.projectId ?? this.projectId())
    const t = p && this.raw.get(p.id)?.find((x) => x.id === ticketId)
    if (!p || !t) throw new Error('That ticket is no longer on the board')
    return { p, t, s: this.settingsFor(p.id), pipe }
  }

  /**
   * Copy a ticket's finished changes into the project's code folder as uncommitted changes (from its worktree,
   * or from its local branch), then mark it done. Refuses, changing nothing, when they don't apply cleanly.
   */
  async applyChanges(ticketId: string): Promise<BoardOverview> {
    const { p, t, s, pipe } = this.find(ticketId)
    const local = pipe?.local
    if (!pipe || pipe.stage !== 'pr' || !local) throw new Error('This ticket has no finished changes to apply')
    if (!s.repo || !existsSync(s.repo)) throw new Error('Pick the code folder for this project in Project settings first')
    const root = await repoRoot(s.repo)
    if (!root) throw new Error(`${s.repo} isn't a git repository`)
    let patch: string
    if (local.mode === 'none') {
      if (!local.dir || !existsSync(local.dir)) throw new Error('The copy holding these changes is gone, so there is nothing to apply')
      await gitRun(local.dir, ['add', '-A'])
      patch = await gitRun(local.dir, ['diff', '--cached', '--binary'])
    } else {
      if (!local.branch) throw new Error('This ticket has no branch to apply')
      patch = await gitRun(root, ['diff', '--binary', `${local.base}...${local.branch}`])
    }
    if (!patch.trim()) throw new Error('There are no changes to apply')
    const file = join(this.ctx.dataDir, 'boards', `${t.key.toLowerCase()}.patch`)
    await mkdir(join(this.ctx.dataDir, 'boards'), { recursive: true })
    await writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`)
    try {
      await gitRun(root, ['apply', '--check', '--whitespace=nowarn', file]).catch((err) => {
        throw new Error(`The changes don't apply cleanly to ${s.repo}, so nothing was changed. ${errorMessage(err)}`)
      })
      await gitRun(root, ['apply', '--whitespace=nowarn', file])
    } finally {
      await rm(file, { force: true }).catch(() => undefined)
    }
    await this.close(p, t, s, { ...local, applied: true }, `Cloth applied the changes to ${s.repo}, uncommitted.`)
    return this.overview()
  }

  /** Change a ticket's goal: what the planner works from. Written to the ticket too when Cloth may update it. */
  async setGoal(ticketId: string, goal: string): Promise<BoardOverview> {
    const { p, t, s, pipe } = this.find(ticketId)
    const text = goal.trim()
    if (!text) throw new Error('Enter a goal')
    if (pipe && this.running.has(ticketId)) throw new Error('Pause the agents before changing the goal')
    if (pipe) this.update(ticketId, { goal: text })
    else if (!this.writes(s)) throw new Error(`Ticket updates are off for this project: change the description in ${TRACKER_NAMES[this.tracker!.kind]}`)
    if (this.writes(s)) {
      const description = describe(text, pipe?.requirements ?? [], pipe?.outOfScope ?? [])
      await this.tracker!.setDescription(p, t, description)
      t.description = description
    }
    this.changed()
    return this.overview()
  }

  /** Mark a ticket built without a PR done. Its worktree (and uncommitted changes) goes; a local branch stays. */
  async finish(ticketId: string): Promise<BoardOverview> {
    const { p, t, s, pipe } = this.find(ticketId)
    if (!pipe?.local) throw new Error('Only a ticket built without a pull request is marked done here; a PR finishes when it merges')
    await this.close(p, t, s, pipe.local, pipe.local.mode === 'commit' ? `Marked done. The work is on the local branch ${pipe.local.branch}.` : 'Marked done without applying the changes.')
    return this.overview()
  }

  private async close(p: BoardProject, t: RawTicket, s: BoardProjectSettings, local: NonNullable<StoredPipe['local']>, comment: string): Promise<void> {
    if (local.mode === 'none' && local.dir) await this.dropWorktree(local.dir, s)
    this.update(t.id, { status: 'done', local, note: undefined, activity: undefined })
    await this.note(p, t, s, comment)
    await this.moveTo(p, t, s, 'merged')
  }

  private async dropWorktree(dir: string, s: BoardProjectSettings): Promise<void> {
    const root = s.repo && existsSync(s.repo) ? await repoRoot(s.repo) : null
    if (root) await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => undefined)
    if (root) await git(root, ['worktree', 'prune']).catch(() => undefined)
  }

  /** Close a ticket on a Cloth board: it moves to Done and leaves the board; agents on it stop. */
  async closeTicket(ticketId: string): Promise<BoardOverview> {
    const local = this.local()
    if (!local) throw new Error('Close tickets in the tracker itself')
    const { p, t, s, pipe } = this.find(ticketId)
    this.running.get(ticketId)?.abort()
    this.queue = this.queue.filter((q) => q !== ticketId)
    if (pipe?.local?.mode === 'none' && pipe.local.dir) await this.dropWorktree(pipe.local.dir, s)
    if (pipe) this.update(ticketId, { status: 'done', activity: undefined })
    await local.setState(p, t, 'merged')
    t.stateId = 'merged'
    this.changed()
    return this.overview()
  }

  /** Delete a ticket from a Cloth board, with its agents' record and any worktree holding its changes. */
  async deleteTicket(ticketId: string): Promise<BoardOverview> {
    const local = this.local()
    if (!local) throw new Error('Delete tickets in the tracker itself')
    const { p, s, pipe } = this.find(ticketId)
    this.running.get(ticketId)?.abort()
    this.queue = this.queue.filter((q) => q !== ticketId)
    if (pipe?.local?.mode === 'none' && pipe.local.dir) await this.dropWorktree(pipe.local.dir, s)
    const pipes = this.pipes()
    delete pipes[this.pkey(ticketId)]
    this.ctx.kv.set(K_PIPES, pipes)
    await local.deleteTicket(p, ticketId)
    this.raw.set(p.id, (this.raw.get(p.id) ?? []).filter((x) => x.id !== ticketId))
    this.changed()
    return this.overview()
  }

  // ---- Pipeline ----

  private pkey(ticketId: string): string {
    return `${this.storedConn()?.kind ?? 'none'}:${ticketId}`
  }

  private pipes(): Record<string, StoredPipe> {
    return this.ctx.kv.get<Record<string, StoredPipe>>(K_PIPES, {})
  }

  private update(ticketId: string, patch: Partial<StoredPipe>): StoredPipe | null {
    const pipes = this.pipes()
    const cur = pipes[this.pkey(ticketId)]
    if (!cur) return null
    pipes[this.pkey(ticketId)] = { ...cur, ...patch, updatedAt: Date.now() }
    this.ctx.kv.set(K_PIPES, pipes)
    this.changed()
    return pipes[this.pkey(ticketId)]
  }

  private enqueue(ticketId: string): void {
    if (!this.queue.includes(ticketId) && !this.running.has(ticketId)) this.queue.push(ticketId)
    this.changed()
    this.pump()
  }

  private pump(): void {
    while (this.running.size < MAX_RUNNING && this.queue.length) {
      const id = this.queue.shift()!
      const ctl = new AbortController()
      this.running.set(id, ctl)
      void this.drive(id, ctl.signal)
        .catch((err) => {
          if (!ctl.signal.aborted && !(err as { quiet?: boolean }).quiet) this.update(id, { status: 'error', note: errorMessage(err), activity: undefined })
        })
        .finally(() => {
          this.running.delete(id)
          this.pump()
        })
    }
  }

  /** Run the ticket's stages until it reaches a PR, waits for the user, or fails. */
  private async drive(ticketId: string, signal: AbortSignal): Promise<void> {
    for (let guard = 0; guard < 12 && !signal.aborted; guard++) {
      const pipe = this.pipes()[this.pkey(ticketId)]
      if (!pipe) return
      const p = this.project(pipe.projectId)
      const raw = this.raw.get(pipe.projectId)?.find((t) => t.id === ticketId)
      if (!p || !raw || !this.tracker) throw new Error('The ticket or its project is no longer in the tracker')
      if (pipe.stage === 'pr') {
        if (!pipe.fixing) return
        this.update(ticketId, { status: 'running', note: undefined })
        await this.fix(p, raw, this.settingsFor(p.id), pipe, signal)
        return
      }
      if (pipe.stage === 'new') return
      const s = this.settingsFor(p.id)
      await this.moveTo(p, raw, s, pipe.stage)
      this.update(ticketId, { status: 'running', note: undefined })
      if (pipe.stage === 'req') await this.plan(p, raw, s, pipe, signal)
      else if (pipe.stage === 'rev') {
        const ok = await this.review(p, raw, pipe, signal)
        if (!ok) return
      } else if (pipe.stage === 'build') await this.build(p, raw, s, pipe, signal)
      else return
    }
  }

  private async moveTo(p: BoardProject, t: RawTicket, s: BoardProjectSettings, stage: Stage | 'merged'): Promise<void> {
    const target = s.stateMap[stage]
    if (!target || t.stateId === target || !this.tracker || !this.writes(s)) return
    try {
      await this.tracker.setState(p, t, target)
      t.stateId = target
    } catch (err) {
      this.ctx.log('boards', `couldn't move ${t.key}: ${errorMessage(err)}`)
    }
  }

  private model(agentId: string | null): { model: ModelRef; system: string | null; saved: ReturnType<AgentService['find']> } {
    const saved = this.deps.agents.find(agentId)
    const model = saved?.model ?? this.deps.settings.get().defaultModel
    if (!model) throw new Error('No default model in Settings, and the agent for this step has none of its own')
    const system = saved ? [`You are the "${saved.name}" agent. ${saved.purpose}`, saved.instructions.trim()].filter(Boolean).join('\n\n') : null
    return { model, system, saved }
  }

  private readScope(repo: string | null, saved: ReturnType<AgentService['find']>): ToolScope {
    const base: ToolScope = { collectionIds: [], skillsEnabled: false, webEnabled: false, customTools: false, workspace: repo && existsSync(repo) ? repo : null, fileAccess: 'read', permissions: () => 'manual', autoApprove: () => 'none', codeIntel: false }
    return saved ? { ...agentScope(saved, base), fileAccess: 'read', shell: false, codeIntel: false, autoApprove: () => 'none' } : base
  }

  private async ask(agentId: string | null, role: string, prompt: string, repo: string | null, signal: AbortSignal, onActivity: (a: string) => void): Promise<string> {
    const { model, system, saved } = this.model(agentId)
    const res = await this.deps.runtime.run({
      model,
      prompt,
      systemPrompt: [system, role].filter(Boolean).join('\n\n'),
      scope: this.readScope(repo, saved),
      thinking: saved?.thinking ?? undefined,
      maxTurns: 20,
      signal,
      onEvent: (_turn, progress) => progress.current && onActivity(progress.current.summary || progress.current.tool)
    })
    return res.text
  }

  private async plan(p: BoardProject, t: RawTicket, s: BoardProjectSettings, pipe: StoredPipe, signal: AbortSignal): Promise<void> {
    this.update(t.id, { activity: 'Writing criteria' })
    const revise = pipe.review?.verdict === 'revise' ? `\n\nThe reviewer sent the last version back:\n${pipe.review.notes}\n\nThe last version:\n${pipe.requirements.map((r) => `- ${r}`).join('\n')}` : ''
    const text = await this.ask(pipe.agents.planner, PLANNER, `Ticket ${t.key}: ${t.title}\n\nGoal: ${pipe.goal}${revise}`, s.repo, signal, (a) => this.update(t.id, { activity: a }))
    const out = parseJson<{ requirements?: unknown; outOfScope?: unknown }>(text)
    const requirements = Array.isArray(out?.requirements) ? out.requirements.map(String).filter(Boolean) : []
    if (!requirements.length) throw new Error('The planner didn\'t return any requirements. Resume to try again.')
    const outOfScope = Array.isArray(out?.outOfScope) ? out.outOfScope.map(String).filter(Boolean) : []
    // With ticket updates off the requirements stay in Cloth (on the pipeline), and the ticket keeps its description.
    if (this.writes(s)) {
      await this.tracker!.setDescription(p, t, describe(pipe.goal, requirements, outOfScope))
      t.description = describe(pipe.goal, requirements, outOfScope)
    }
    this.update(t.id, { requirements, outOfScope, stage: 'rev', activity: undefined })
  }

  /** False when the ticket went back to the planner too often and now waits for the user. */
  private async review(p: BoardProject, t: RawTicket, pipe: StoredPipe, signal: AbortSignal): Promise<boolean> {
    this.update(t.id, { activity: 'Reviewing' })
    const s = this.settingsFor(p.id)
    const text = await this.ask(pipe.agents.reviewer, REVIEWER, `Ticket ${t.key}: ${t.title}\n\nGoal: ${pipe.goal}\n\nRequirements:\n${pipe.requirements.map((r) => `- ${r}`).join('\n')}\n\nOut of scope:\n${pipe.outOfScope.map((r) => `- ${r}`).join('\n') || '(none)'}`, s.repo, signal, (a) => this.update(t.id, { activity: a }))
    const out = parseJson<{ verdict?: string; notes?: string }>(text)
    const verdict = out?.verdict === 'approve' ? 'approve' : 'revise'
    const notes = String(out?.notes ?? (out ? '' : text)).trim()
    await this.note(p, t, s, verdict === 'approve' ? `Cloth review: the requirements match the goal. Approved.${notes ? `\n${notes}` : ''}` : `Cloth review: sent back to the planner.\n${notes}`)
    if (verdict === 'approve') {
      if (s.approveRequirements) {
        // The person reads the requirements before any code is written; Resume starts the build.
        this.update(t.id, { review: { verdict, notes }, stage: 'build', status: 'needsYou', note: 'The reviewer approved the requirements. Check them, then resume to build.', activity: undefined })
        return false
      }
      this.update(t.id, { review: { verdict, notes }, stage: 'build', activity: undefined })
      return true
    }
    const sendBacks = pipe.sendBacks + 1
    if (sendBacks >= s.reviewRounds) {
      const times = sendBacks === 1 ? 'once' : sendBacks === 2 ? 'twice' : `${sendBacks} times`
      this.update(t.id, { review: { verdict, notes }, sendBacks, stage: 'req', status: 'needsYou', note: `Review sent the requirements back ${times}. Edit the goal${this.isLocal() ? '' : ' in the tracker'}, or resume for one more round.`, activity: undefined })
      return false
    }
    this.update(t.id, { review: { verdict, notes }, sendBacks, stage: 'req', activity: undefined })
    return true
  }

  private async build(p: BoardProject, t: RawTicket, s: BoardProjectSettings, pipe: StoredPipe, signal: AbortSignal): Promise<void> {
    if (!s.repo || !existsSync(s.repo)) {
      this.update(t.id, { status: 'needsYou', note: 'Pick the code folder for this project in Project settings, then resume.', activity: undefined })
      throw Object.assign(new Error('no repo'), { quiet: true })
    }
    const root = await repoRoot(s.repo)
    if (!root) throw new Error(`${s.repo} isn't a git repository`)
    const base = (await gitRun(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    // Without commits the worktree is detached: no branch is made, and the changes stay uncommitted in it.
    const branch = s.git === 'none' ? undefined : (pipe.branch ?? `boards/${t.key.toLowerCase()}`)
    this.update(t.id, { branch, activity: 'Setting up the worktree' })
    const dir = await this.worktree(root, branch ?? null, base, t.key)
    const { model, system, saved } = this.model(pipe.agents.implementer)
    const scope = this.writeScope(join(dir, relative(root, s.repo)), s, saved)
    this.update(t.id, { activity: 'Starting' })
    await this.deps.runtime.run({
      model,
      prompt: `Ticket ${t.key}: ${t.title}\n\nGoal: ${pipe.goal}\n\nRequirements:\n${pipe.requirements.map((r) => `- ${r}`).join('\n')}\n\nOut of scope:\n${pipe.outOfScope.map((r) => `- ${r}`).join('\n') || '(none)'}`,
      systemPrompt: [system, s.git === 'none' ? IMPLEMENTER_NO_GIT : IMPLEMENTER].filter(Boolean).join('\n\n'),
      scope,
      thinking: saved?.thinking ?? undefined,
      maxTurns: 80,
      signal,
      onEvent: (_turn, progress) => this.update(t.id, { files: progress.files.length, ...(progress.current ? { activity: progress.current.summary || progress.current.tool } : {}) })
    })
    if (signal.aborted) return
    if (s.git === 'none') {
      const changed = (await gitRun(dir, ['status', '--porcelain'])).trim()
      if (!changed) throw new Error('The implementer finished without changing anything. Resume to try again.')
      const files = changed.split('\n').length
      this.update(t.id, { stage: 'pr', status: 'needsYou', files, local: { mode: 'none', base, dir }, note: 'The changes are ready, uncommitted, in their own copy of the code. Apply them to your code folder, or open that copy to look first.', activity: undefined })
      await this.moveTo(p, t, s, 'pr')
      await this.note(p, t, s, `Cloth built this ticket. ${files} file${files === 1 ? '' : 's'} changed, uncommitted, in ${dir}.`)
      return
    }
    this.update(t.id, { activity: 'Committing' })
    await gitRun(dir, ['add', '-A'])
    const changed = (await gitRun(dir, ['status', '--porcelain'])).trim()
    if (!changed && !(await gitRun(dir, ['log', `${base}..HEAD`, '--oneline'])).trim()) throw new Error('The implementer finished without changing anything. Resume to try again.')
    if (changed) await gitRun(dir, ['commit', '-m', `${t.key}: ${t.title}`])
    if (s.git === 'commit' || !branch) {
      // Nothing leaves this PC: the commit stays on the local branch, and the worktree goes (the branch keeps it).
      await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
      this.update(t.id, { stage: 'pr', status: 'needsYou', local: { mode: 'commit', base, branch }, note: `Committed to the local branch ${branch}. Nothing was pushed. Apply the changes to your code folder, or merge the branch yourself.`, activity: undefined })
      await this.moveTo(p, t, s, 'pr')
      await this.note(p, t, s, `Cloth built this ticket and committed it to the local branch ${branch}.`)
      return
    }
    this.update(t.id, { activity: 'Pushing the branch' })
    await gitRun(dir, ['push', '-u', 'origin', branch])
    this.update(t.id, { activity: 'Opening the pull request' })
    const body = `${t.url}\n\n${describe(pipe.goal, pipe.requirements, pipe.outOfScope)}`
    let url = ''
    try {
      url = (await exec('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], dir)).trim()
    } catch {
      url = (await exec('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', `${t.key}: ${t.title}`, '--body', body], dir)).trim().split('\n').pop() ?? ''
    }
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0)
    if (!number) throw new Error(`GitHub didn't return a pull request link (${url || 'nothing'})`)
    await this.note(p, t, s, `Cloth opened a pull request: ${url}`)
    this.update(t.id, { stage: 'pr', status: 'running', pr: { number, url, checks: 'pending', merging: false }, activity: undefined })
    await this.moveTo(p, t, s, 'pr')
    await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
    if (s.autoMerge) await this.tryAutoMerge(p, t, root, base, branch, signal)
    this.update(t.id, { status: s.autoMerge ? 'running' : 'needsYou', note: s.autoMerge ? undefined : 'Waiting for you to review and merge.' })
  }

  /** The ticket's worktree on `branch` (made from `start` when the branch doesn't exist yet). */
  private async worktree(root: string, branch: string | null, start: string, key: string): Promise<string> {
    // Named by board kind too: a Cloth board's CL-1 and a Plane board's CL-1 are different tickets.
    const dir = join(this.ctx.dataDir, 'boards', 'worktrees', `${this.storedConn()?.kind ?? 'none'}-${key.toLowerCase()}`)
    if (!existsSync(dir)) {
      await mkdir(join(this.ctx.dataDir, 'boards', 'worktrees'), { recursive: true })
      if (!branch) await gitRun(root, ['worktree', 'add', '--detach', dir, start])
      else {
        const exists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
        await gitRun(root, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, start])
      }
    } else if (branch && (await git(dir, ['symbolic-ref', '-q', 'HEAD'])).code !== 0) {
      // Left detached by a run without commits, before the project allowed them: put its work on the branch.
      await gitRun(dir, ['checkout', '-B', branch])
    }
    return dir
  }

  /** The implementer edits files in its worktree and runs only the project's allowed commands. */
  private writeScope(workspace: string, s: BoardProjectSettings, saved: ReturnType<AgentService['find']>): ToolScope {
    const scope: ToolScope = { collectionIds: [], skillsEnabled: true, webEnabled: false, customTools: false, workspace, fileAccess: 'write', shell: true, commandAllow: s.commands, permissions: () => 'manual', autoApprove: () => 'edits', codeIntel: false }
    return saved ? { ...agentScope(saved, scope), fileAccess: 'write', shell: true, commandAllow: s.commands, autoApprove: () => 'edits', codeIntel: false } : scope
  }

  /** The failing checks' logs (GitHub Actions jobs; other checks give only their name and link), tails only. */
  private async checkLogs(checks: FailedCheck[], root: string): Promise<(FailedCheck & { log: string })[]> {
    let budget = 40_000
    const out: (FailedCheck & { log: string })[] = []
    for (const c of checks.slice(0, 8)) {
      const job = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(c.url)
      const run = /\/actions\/runs\/(\d+)/.exec(c.url)
      let log = ''
      if (budget > 0 && (job || run)) {
        try {
          const full = await exec('gh', job ? ['run', 'view', '--job', job[2], '--log-failed'] : ['run', 'view', run![1], '--log-failed'], root, 90_000)
          log = full.slice(-Math.min(12_000, budget)).trim()
          budget -= log.length
        } catch (err) {
          log = `(Couldn't fetch the log: ${errorMessage(err)})`
        }
      }
      out.push({ ...c, log })
    }
    return out
  }

  /** An agent fixes the PR's failing checks in a worktree on its branch, then Cloth pushes to the same PR. */
  private async fix(p: BoardProject, t: RawTicket, s: BoardProjectSettings, pipe: StoredPipe, signal: AbortSignal): Promise<void> {
    const pr = pipe.pr!
    if (!s.repo || !existsSync(s.repo)) {
      this.update(t.id, { status: 'needsYou', note: 'Pick the code folder for this project in Project settings, then fix the checks again.', activity: undefined })
      throw Object.assign(new Error('no repo'), { quiet: true })
    }
    const root = await repoRoot(s.repo)
    if (!root) throw new Error(`${s.repo} isn't a git repository`)
    const branch = pipe.branch ?? `boards/${t.key.toLowerCase()}`
    this.update(t.id, { activity: 'Reading the failing checks' })
    const view = JSON.parse(await exec('gh', ['pr', 'view', String(pr.number), '--json', 'state,headRefOid,statusCheckRollup'], root, 30_000)) as { state: string; headRefOid: string; statusCheckRollup?: RollupCheck[] }
    if (view.state !== 'OPEN') throw new Error(`PR #${pr.number} is ${view.state.toLowerCase()}, so there's nothing to fix`)
    const failed = failedChecks(view.statusCheckRollup ?? [])
    if (!failed.length) {
      // Fixed in the meantime (or re-run and passed): back to watching.
      this.update(t.id, { fixing: false, status: 'running', note: undefined, activity: undefined, pr: { ...pr, failing: [] } })
      return
    }
    const logs = await this.checkLogs(failed, root)
    this.update(t.id, { pr: { ...pr, failing: failed.map((c) => c.name), fixedSha: view.headRefOid }, activity: 'Setting up the worktree' })
    await gitRun(root, ['fetch', 'origin', branch])
    const dir = await this.worktree(root, branch, `origin/${branch}`, t.key)
    // Pick up anything pushed to the branch since (a person's commits, an earlier fix).
    await gitRun(dir, ['merge', '--ff-only', `origin/${branch}`]).catch(() => {
      throw new Error(`The local ${branch} branch has commits GitHub doesn't, so Cloth won't push over it. Sync the branch, then fix the checks again.`)
    })
    const { model, system, saved } = this.model(pipe.agents.implementer)
    this.update(t.id, { activity: 'Starting' })
    const res = await this.deps.runtime.run({
      model,
      prompt: `Ticket ${t.key}: ${t.title}\n\nGoal: ${pipe.goal}\n\nRequirements:\n${pipe.requirements.map((r) => `- ${r}`).join('\n')}\n\nPull request: ${pr.url}\n\nFailing checks:\n\n${checksReport(logs)}`,
      systemPrompt: [system, FIXER].filter(Boolean).join('\n\n'),
      scope: this.writeScope(join(dir, relative(root, s.repo)), s, saved),
      thinking: saved?.thinking ?? undefined,
      maxTurns: 80,
      signal,
      onEvent: (_turn, progress) => progress.current && this.update(t.id, { activity: progress.current.summary || progress.current.tool })
    })
    if (signal.aborted) return
    await gitRun(dir, ['add', '-A'])
    if (!(await gitRun(dir, ['status', '--porcelain'])).trim()) {
      await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
      const why = res.text.trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
      this.update(t.id, { fixing: false, status: 'needsYou', note: `The agent didn't find a change that fixes the checks.${why ? ` ${why}` : ''}`, activity: undefined })
      return
    }
    this.update(t.id, { activity: 'Committing the fix' })
    await gitRun(dir, ['commit', '-m', `${t.key}: fix failing checks`])
    this.update(t.id, { activity: 'Pushing the fix' })
    await gitRun(dir, ['push', 'origin', branch])
    await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
    const fixes = (pr.fixes ?? 0) + 1
    await this.note(p, t, s, `Cloth pushed a fix for the failing checks (${failed.map((c) => c.name).join(', ')}) to ${pr.url}.`)
    const latest = this.pipes()[this.pkey(t.id)]?.pr ?? pr
    this.update(t.id, { fixing: false, status: 'running', note: undefined, activity: undefined, pr: { ...latest, checks: 'pending', failing: [], fixes } })
  }

  /** Experimental: a code review of the diff, then GitHub's auto-merge (it merges once required checks pass). */
  private async tryAutoMerge(p: BoardProject, t: RawTicket, root: string, base: string, branch: string, signal: AbortSignal): Promise<void> {
    const pipe = this.pipes()[this.pkey(t.id)]
    if (!pipe?.pr) return
    this.update(t.id, { activity: 'Reviewing the code' })
    const diff = (await gitRun(root, ['diff', `${base}...${branch}`])).slice(0, 60_000)
    const text = await this.ask(pipe.agents.reviewer, CODE_REVIEWER, `Requirements:\n${pipe.requirements.map((r) => `- ${r}`).join('\n')}\n\nDiff:\n${diff}`, null, signal, () => undefined)
    const out = parseJson<{ verdict?: string; notes?: string }>(text)
    if (out?.verdict !== 'approve') {
      await this.note(p, t, this.settingsFor(p.id), `Cloth code review didn't approve, so it won't merge on its own.\n${out?.notes ?? ''}`)
      this.update(t.id, { status: 'needsYou', note: `Code review didn't approve: ${out?.notes ?? 'no notes'}`, activity: undefined })
      return
    }
    try {
      await exec('gh', ['pr', 'merge', String(pipe.pr.number), '--auto', '--squash'], root)
      this.update(t.id, { pr: { ...pipe.pr, merging: true }, activity: undefined })
    } catch (err) {
      this.update(t.id, { status: 'needsYou', note: `GitHub wouldn't turn on auto-merge: ${errorMessage(err)}`, activity: undefined })
    }
  }

  /** Checks and merges for open PRs; a merged PR moves the ticket to the merged state, failed checks go to a fixer. */
  private async checkPrs(p: BoardProject): Promise<void> {
    const s = this.settingsFor(p.id)
    if (!s.repo || !existsSync(s.repo)) return
    for (const [k, pipe] of Object.entries(this.pipes())) {
      // A fix in progress owns the PR until it pushes.
      if (pipe.projectId !== p.id || pipe.stage !== 'pr' || !pipe.pr || pipe.status === 'done' || pipe.fixing) continue
      const id = k.slice(k.indexOf(':') + 1)
      try {
        const v = JSON.parse(await exec('gh', ['pr', 'view', String(pipe.pr.number), '--json', 'state,headRefOid,statusCheckRollup'], s.repo, 30_000)) as { state: string; headRefOid?: string; statusCheckRollup?: RollupCheck[] }
        // Read again: a step may have changed the ticket while GitHub answered.
        const cur = this.pipes()[k]
        if (!cur?.pr || cur.fixing || this.running.has(id)) continue
        const roll = v.statusCheckRollup ?? []
        const failed = failedChecks(roll)
        const pending = roll.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING')
        const checks = !roll.length ? 'none' : failed.length ? 'fail' : pending ? 'pending' : 'pass'
        const pr: NonNullable<TicketPipeline['pr']> = { ...cur.pr, checks, failing: failed.map((c) => c.name) }
        const raw = this.raw.get(p.id)?.find((t) => t.id === id)
        if (v.state === 'MERGED') {
          this.update(id, { pr, status: 'done', note: undefined })
          if (raw) await this.moveTo(p, raw, s, 'merged')
        } else if (v.state === 'CLOSED') {
          this.update(id, { pr, status: 'needsYou', note: 'The pull request was closed without merging.' })
        } else if (checks === 'fail') {
          const fixes = pr.fixes ?? 0
          if (cur.status === 'paused' || cur.status === 'error') this.update(id, { pr })
          else if (fixes < s.checkFixes && v.headRefOid && v.headRefOid !== pr.fixedSha) {
            this.update(id, { pr, fixing: true, status: 'queued', note: undefined })
            this.enqueue(id)
          } else
            this.update(id, { pr, status: 'needsYou', note: s.checkFixes > 0 && fixes >= s.checkFixes ? `Checks still fail after ${s.checkFixes} fix${s.checkFixes === 1 ? '' : 'es'}. Fix checks to have the agent try again, or fix it yourself.` : 'Checks failed on the pull request.' })
        } else if ((checks === 'pass' || checks === 'none') && cur.status === 'running' && !pr.merging && !s.autoMerge) {
          this.update(id, { pr, status: 'needsYou', note: 'Waiting for you to review and merge.' })
        } else this.update(id, { pr })
      } catch (err) {
        this.ctx.log('boards', `PR #${pipe.pr.number}: ${errorMessage(err)}`)
      }
    }
  }

  private changed(): void {
    this.ctx.emit('boards', { type: 'changed' })
  }
}

