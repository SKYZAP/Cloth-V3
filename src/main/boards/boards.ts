import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  STAGES,
  type BoardAgents,
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
import { agentScope, type AgentRuntime } from '../agent/chat'
import type { ToolScope } from '../agent/tools'
import { git, repoRoot } from '../panel/git'
import { defaultStateMap, makeTracker, type RawTicket, type Tracker, type TrackerConfig } from './trackers'

/*
 * Boards keeps one tracker connection, the chosen project, each project's settings, and a pipeline record
 * per ticket handed to agents. The tracker stays the source of truth for tickets; Cloth moves them between
 * the mapped states as its agents work, writes requirements into the description, and comments reviews.
 */

const K_CONN = 'boards.connection'
const K_PROJECT = 'boards.project'
const K_SETTINGS = 'boards.settings'
const K_PIPES = 'boards.pipelines'
const SYNC_MS = 60_000
const MAX_RUNNING = 2
const MAX_SEND_BACKS = 2
const DEFAULT_COMMANDS = ['npm test', 'npm run', 'npx tsc', 'npx vitest', 'pnpm test', 'pnpm run', 'yarn test', 'node']

interface StoredConn extends Omit<TrackerConfig, 'token'> {
  token: string
}
type StoredPipe = TicketPipeline & { projectId: string; key: string; title: string }

export interface BoardDeps {
  runtime: AgentRuntime
  agents: AgentService
  settings: SettingsService
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

/** The goal inside a description Cloth wrote, or the whole description for one written by a person. */
export function goalOf(description: string): string {
  const m = /##\s*Goal\s*\n([\s\S]*?)(\n##\s|\nWritten by Cloth agents\.|$)/.exec(description)
  return (m ? m[1] : description).trim()
}

const PLANNER = `You write requirements for a software ticket. Read the code in the workspace where it helps you be concrete.
Write acceptance criteria someone can check, each one sentence, only what the goal asks for. Note what is out of scope.
Reply with only a JSON object: {"requirements": ["..."], "outOfScope": ["..."]}.`

const REVIEWER = `You review requirements written for a software ticket. Check each one against the goal: approve when they cover the goal
and add nothing it doesn't ask for; otherwise send them back and say exactly which ones to change and why.
Reply with only a JSON object: {"verdict": "approve" | "revise", "notes": "..."}.`

const CODE_REVIEWER = `You review a pull request's diff against the ticket's requirements. Approve when the change meets them and has no
obvious bugs; otherwise say what is wrong. Reply with only a JSON object: {"verdict": "approve" | "revise", "notes": "..."}.`

const IMPLEMENTER = `You implement a software ticket in this workspace, a git worktree on its own branch. Meet every requirement,
stay inside them, follow the code's existing conventions, and run the project's tests or type checks when you can.
Don't commit or push: Cloth does that when you finish. End with a short summary of what you changed.`

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
    if (c) this.tracker = makeTracker(this.config(c))
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

  private config(c: StoredConn): TrackerConfig {
    return { ...c, token: this.ctx.secrets.decrypt(Buffer.from(c.token, 'base64')) }
  }

  private connection(): TrackerConnection | null {
    const c = this.storedConn()
    if (!c) return null
    let host = c.baseUrl
    try {
      host = new URL(c.baseUrl).host
    } catch {
      /* keep the raw value */
    }
    return { kind: c.kind, baseUrl: c.baseUrl, workspace: c.workspace, email: c.email, label: `${host} · ${this.projects.length} project${this.projects.length === 1 ? '' : 's'}` }
  }

  async connect(input: TrackerConnectInput): Promise<BoardOverview> {
    const baseUrl = input.baseUrl.trim()
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Enter the full address, starting with https://')
    if (!input.token.trim()) throw new Error('Enter the API token')
    if (input.kind === 'plane' && !input.workspace?.trim()) throw new Error('Enter the workspace slug (the part after the address in Plane links)')
    if (input.kind === 'jira' && !input.email?.trim()) throw new Error('Enter the email of the Jira account the token belongs to')
    const config: TrackerConfig = { kind: input.kind, baseUrl, workspace: input.workspace?.trim(), email: input.email?.trim(), token: input.token.trim() }
    const tracker = makeTracker(config)
    const projects = await tracker.projects()
    // One tracker at a time: whatever was running on the old one stops.
    for (const a of this.running.values()) a.abort()
    this.running.clear()
    this.queue = []
    this.ctx.kv.set(K_CONN, { ...config, token: Buffer.from(this.ctx.secrets.encrypt(config.token)).toString('base64') } satisfies StoredConn)
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
    const saved = all[this.skey(projectId)]
    const defaults = defaultStateMap(this.states.get(projectId) ?? []) as BoardProjectSettings['stateMap']
    return {
      repo: saved?.repo ?? null,
      stateMap: { ...defaults, ...Object.fromEntries(Object.entries(saved?.stateMap ?? {}).filter(([, v]) => v)) } as BoardProjectSettings['stateMap'],
      autoMerge: saved?.autoMerge ?? false,
      agents: saved?.agents ?? { planner: null, reviewer: null, implementer: null },
      commands: saved?.commands ?? DEFAULT_COMMANDS
    }
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
    all[this.skey(projectId)] = next
    this.ctx.kv.set(K_SETTINGS, all)
    this.changed()
    return this.overview()
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

  /** Changes made in the tracker come back: a ticket moved to the Requirements state starts again there; one moved to the merged state is done. */
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
      } else if (t.stateId === s.stateMap.req && STAGES.indexOf(pipe.stage) > STAGES.indexOf('req') && pipe.stage !== 'pr') {
        Object.assign(pipe, { stage: 'req', status: 'queued', note: undefined, review: undefined, sendBacks: 0, updatedAt: Date.now() })
        changed = true
        this.enqueue(t.id)
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
    if (p && settings)
      for (const t of this.raw.get(p.id) ?? []) {
        const pipe = pipes[this.pkey(t.id)] ?? null
        const state = states.find((s) => s.id === t.stateId)
        if (pipe?.status === 'done') continue
        if (!pipe && (state?.group === 'completed' || state?.group === 'cancelled' || t.stateId === settings.stateMap.merged)) continue
        // Without agents, the column comes from the tracker state (the first stage mapped to it).
        const mapped = STAGES.find((st) => settings.stateMap[st] === t.stateId)
        const stage: Stage = pipe?.stage ?? mapped ?? (state?.group === 'started' ? 'build' : 'new')
        tickets.push({ id: t.id, key: t.key, title: t.title, priority: t.priority, stateId: t.stateId, stateName: state?.name ?? '', stage, url: t.url, description: t.description, pipeline: pipe ? this.publicPipe(pipe) : null })
      }
    return { connection: conn, projects: this.projects, projectId: p?.id ?? null, states, settings, tickets, syncedAt: this.syncedAt, error: this.syncError }
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
    if (pipe.stage === 'pr') {
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
      if (pipe.stage === 'pr' || pipe.stage === 'new') return
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
    if (!target || t.stateId === target || !this.tracker) return
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
    await this.tracker!.setDescription(p, t, describe(pipe.goal, requirements, outOfScope))
    t.description = describe(pipe.goal, requirements, outOfScope)
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
    await this.tracker!.comment(p, t, verdict === 'approve' ? `Cloth review: the requirements match the goal. Approved.${notes ? `\n${notes}` : ''}` : `Cloth review: sent back to the planner.\n${notes}`).catch((err) => this.ctx.log('boards', errorMessage(err)))
    if (verdict === 'approve') {
      this.update(t.id, { review: { verdict, notes }, stage: 'build', activity: undefined })
      return true
    }
    const sendBacks = pipe.sendBacks + 1
    if (sendBacks >= MAX_SEND_BACKS) {
      this.update(t.id, { review: { verdict, notes }, sendBacks, stage: 'req', status: 'needsYou', note: 'Review sent the requirements back twice. Edit the goal in the tracker, or resume for one more round.', activity: undefined })
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
    const branch = pipe.branch ?? `boards/${t.key.toLowerCase()}`
    const dir = join(this.ctx.dataDir, 'boards', 'worktrees', t.key.toLowerCase())
    this.update(t.id, { branch, activity: 'Setting up the worktree' })
    if (!existsSync(dir)) {
      await mkdir(join(this.ctx.dataDir, 'boards', 'worktrees'), { recursive: true })
      const exists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
      await gitRun(root, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base])
    }
    const workspace = join(dir, relative(root, s.repo))
    const { model, system, saved } = this.model(pipe.agents.implementer)
    // The implementer edits files in its worktree and runs only the project's allowed commands.
    let scope: ToolScope = { collectionIds: [], skillsEnabled: true, webEnabled: false, customTools: false, workspace, fileAccess: 'write', shell: true, commandAllow: s.commands, permissions: () => 'manual', autoApprove: () => 'edits', codeIntel: false }
    if (saved) scope = { ...agentScope(saved, scope), fileAccess: 'write', shell: true, commandAllow: s.commands, autoApprove: () => 'edits', codeIntel: false }
    this.update(t.id, { activity: 'Starting' })
    await this.deps.runtime.run({
      model,
      prompt: `Ticket ${t.key}: ${t.title}\n\nGoal: ${pipe.goal}\n\nRequirements:\n${pipe.requirements.map((r) => `- ${r}`).join('\n')}\n\nOut of scope:\n${pipe.outOfScope.map((r) => `- ${r}`).join('\n') || '(none)'}`,
      systemPrompt: [system, IMPLEMENTER].filter(Boolean).join('\n\n'),
      scope,
      thinking: saved?.thinking ?? undefined,
      maxTurns: 80,
      signal,
      onEvent: (_turn, progress) => this.update(t.id, { files: progress.files.length, ...(progress.current ? { activity: progress.current.summary || progress.current.tool } : {}) })
    })
    if (signal.aborted) return
    this.update(t.id, { activity: 'Committing' })
    await gitRun(dir, ['add', '-A'])
    const changed = (await gitRun(dir, ['status', '--porcelain'])).trim()
    if (!changed && !(await gitRun(dir, ['log', `${base}..HEAD`, '--oneline'])).trim()) throw new Error('The implementer finished without changing anything. Resume to try again.')
    if (changed) await gitRun(dir, ['commit', '-m', `${t.key}: ${t.title}`])
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
    await this.tracker!.comment(p, t, `Cloth opened a pull request: ${url}`).catch(() => undefined)
    this.update(t.id, { stage: 'pr', status: 'running', pr: { number, url, checks: 'pending', merging: false }, activity: undefined })
    await this.moveTo(p, t, s, 'pr')
    await git(root, ['worktree', 'remove', '--force', dir]).catch(() => undefined)
    if (s.autoMerge) await this.tryAutoMerge(p, t, root, base, branch, signal)
    this.update(t.id, { status: s.autoMerge ? 'running' : 'needsYou', note: s.autoMerge ? undefined : 'Waiting for you to review and merge.' })
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
      await this.tracker!.comment(p, t, `Cloth code review didn't approve, so it won't merge on its own.\n${out?.notes ?? ''}`).catch(() => undefined)
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

  /** Checks and merges for open PRs; a merged PR moves the ticket to the merged state. */
  private async checkPrs(p: BoardProject): Promise<void> {
    const s = this.settingsFor(p.id)
    if (!s.repo || !existsSync(s.repo)) return
    const pipes = this.pipes()
    for (const [k, pipe] of Object.entries(pipes)) {
      if (pipe.projectId !== p.id || pipe.stage !== 'pr' || !pipe.pr || pipe.status === 'done') continue
      try {
        const v = JSON.parse(await exec('gh', ['pr', 'view', String(pipe.pr.number), '--json', 'state,statusCheckRollup'], s.repo, 30_000)) as { state: string; statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[] }
        const roll = v.statusCheckRollup ?? []
        const failed = roll.some((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(String(c.conclusion ?? c.state)))
        const pending = roll.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING')
        pipe.pr.checks = !roll.length ? 'none' : failed ? 'fail' : pending ? 'pending' : 'pass'
        const raw = this.raw.get(p.id)?.find((t) => t.id === k.slice(k.indexOf(':') + 1))
        if (v.state === 'MERGED') {
          pipe.status = 'done'
          if (raw) await this.moveTo(p, raw, s, 'merged')
        } else if (v.state === 'CLOSED') {
          pipe.status = 'needsYou'
          pipe.note = 'The pull request was closed without merging.'
        } else if (pipe.pr.checks === 'fail') {
          pipe.status = 'needsYou'
          pipe.note = 'Checks failed on the pull request.'
        }
      } catch (err) {
        this.ctx.log('boards', `PR #${pipe.pr.number}: ${errorMessage(err)}`)
      }
    }
    this.ctx.kv.set(K_PIPES, pipes)
  }

  private changed(): void {
    this.ctx.emit('boards', { type: 'changed' })
  }
}

