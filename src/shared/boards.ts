/*
 * Boards: tickets from one connected tracker (Plane or Jira) or a Cloth board kept on this PC, moved through
 * Cloth's agent stages. A planner writes requirements from the title and goal, a reviewer checks them against
 * the goal, and an implementer builds the ticket in its own worktree. What happens to its changes (left
 * uncommitted, committed to a local branch, or pushed as a pull request) is a project setting.
 */

/** `cloth`: an offline board whose projects and tickets live in Cloth's own storage. */
export type TrackerKind = 'plane' | 'jira' | 'cloth'

export const TRACKER_NAMES: Record<TrackerKind, string> = { plane: 'Plane', jira: 'Jira', cloth: 'Cloth' }

/**
 * What the implementer's finished work becomes. `none`: changes stay uncommitted in the ticket's worktree until
 * you apply them; `commit`: committed to a local branch, nothing pushed; `pr`: committed, pushed and opened as a PR.
 */
export type GitMode = 'none' | 'commit' | 'pr'

/** The agent stages, in order. `merged` is the last mapping row; merged tickets leave the board. */
export const STAGES = ['new', 'req', 'rev', 'build', 'pr'] as const
export type Stage = (typeof STAGES)[number]
export type MappedStage = Stage | 'merged'
export const MAPPED_STAGES: MappedStage[] = [...STAGES, 'merged']

export const STAGE_LABELS: Record<MappedStage, string> = {
  new: 'New',
  req: 'Requirements',
  rev: 'Review',
  build: 'Building',
  pr: 'PR open',
  merged: 'Merged'
}

/** The goal inside a description Cloth wrote, or the whole description for one written by a person. */
export function goalOf(description: string): string {
  const m = /##\s*Goal\s*\n([\s\S]*?)(\n##\s|\nWritten by Cloth agents\.|$)/.exec(description)
  return (m ? m[1] : description).trim()
}

/** A stage's name on this project's board: the last column is "Ready" when nothing opens a pull request. */
export function stageLabel(stage: MappedStage, s: Pick<BoardProjectSettings, 'git'> | null | undefined): string {
  if (s && s.git !== 'pr') {
    if (stage === 'pr') return 'Ready'
    if (stage === 'merged') return 'Done'
  }
  return STAGE_LABELS[stage]
}

/** What the user enters to connect. The token is write-only: it never comes back to the renderer. */
export interface TrackerConnectInput {
  kind: TrackerKind
  /** Plane: the instance (https://plane.example.com). Jira: the site (https://team.atlassian.net). Not used by a Cloth board. */
  baseUrl?: string
  /** Plane only: the workspace slug from its URLs. */
  workspace?: string
  /** Jira only: the account's email. */
  email?: string
  /** Not used by a Cloth board. */
  token?: string
}

export interface TrackerConnection {
  kind: TrackerKind
  baseUrl: string
  workspace?: string
  email?: string
  /** Shown in the menu: "plane.example.com · 3 projects". */
  label: string
}

export interface BoardProject {
  id: string
  /** Ticket key prefix: CL (Plane identifier) or CLOTH (Jira key). */
  key: string
  name: string
}

export interface TrackerState {
  id: string
  name: string
  /** backlog | unstarted | started | completed | cancelled (Plane groups; Jira categories are mapped onto them). */
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
  /** Not one of the tracker's default states. */
  custom: boolean
}

export interface BoardAgents {
  /** Saved agent ids; null = Cloth's built-in instructions for that step. */
  planner: string | null
  reviewer: string | null
  implementer: string | null
}

export interface BoardProjectSettings {
  /** The code folder the implementer works from: in a git worktree when it's a git repository, else in a copy. Building needs one. */
  repo: string | null
  /** stage → tracker state id. */
  stateMap: Record<MappedStage, string | null>
  /** Allow PR creation and commits: what the implementer's work becomes (default `none`, nothing committed). */
  git: GitMode
  /**
   * Allow ticket sync and updates: Cloth writes back to Plane or Jira (creates tickets, moves them between the
   * mapped states, writes requirements, posts reviews). Off by default: the tracker is only read and progress
   * stays in Cloth. A Cloth board always updates its own tickets.
   */
  trackerUpdates: boolean
  /** Stop after the reviewer approves the requirements, so you check them before any code is written. */
  approveRequirements: boolean
  /** Times the reviewer may send requirements back before the ticket waits for you (1–5). */
  reviewRounds: number
  /** Fixes an agent pushes on its own for a PR's failing checks before it hands the PR to you (0–5). */
  checkFixes: number
  /** Experimental: merge a PR on its own once checks pass and the code review approves. Needs `git: 'pr'`. */
  autoMerge: boolean
  agents: BoardAgents
  /** Commands the implementer may run without asking (prefixes). */
  commands: string[]
}

/** Where the work of a ticket built without a pull request is. */
export interface LocalResult {
  /** `copy`: built in a copy of a code folder that isn't a git repository. */
  mode: 'none' | 'commit' | 'copy'
  /** The branch the worktree started from ('' for a copy). */
  base: string
  /** `none` and `copy`: the worktree or copy holding the uncommitted changes. */
  dir?: string
  /** `commit`: the local branch with the commit. */
  branch?: string
  /** Changes were applied to the code folder. */
  applied?: boolean
}

export interface TicketComment {
  at: number
  text: string
}

export type TicketPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

/** Where the agents are with a ticket. */
export type PipelineStatus = 'queued' | 'running' | 'paused' | 'needsYou' | 'error' | 'done'

export interface TicketPipeline {
  stage: Stage
  status: PipelineStatus
  /** One line on what's happening now ("Writing criteria", "Running tests"). */
  activity?: string
  /** Why it stopped (needsYou, error, paused). */
  note?: string
  goal: string
  requirements: string[]
  outOfScope: string[]
  /** The latest review: approved, or sent back with notes. */
  review?: { verdict: 'approve' | 'revise'; notes: string }
  sendBacks: number
  agents: BoardAgents
  branch?: string
  /** Files the implementer changed. */
  files?: number
  pr?: {
    number: number
    url: string
    checks: 'pending' | 'pass' | 'fail' | 'none'
    merging: boolean
    /** Names of the checks that failed on the PR's latest commit. */
    failing?: string[]
    /** How many times an agent has pushed a fix for failing checks. */
    fixes?: number
    /** The commit the last fix started from, so the same failure isn't fixed twice. */
    fixedSha?: string
  }
  /** An agent is fixing (or is queued to fix) the PR's failing checks. */
  fixing?: boolean
  /** What the planner found out (each with its source) and what it had to assume. */
  research?: { notes: string[]; assumptions: string[] }
  /** The change as a conventional commit: `feat`, `fix`, `test` … and an imperative summary. */
  commit?: { type: string; subject: string }
  /** The implementer's account of the build, for the pull request. */
  built?: { summary: string; testing: string[] }
  /** Root causes found by earlier check fixes, so a later fix doesn't repeat one. */
  fixLog?: { rootCause: string; fix: string }[]
  /** Built without a pull request: where the changes are. */
  local?: LocalResult
  updatedAt: number
}

export interface BoardTicket {
  id: string
  /** CL-42 */
  key: string
  title: string
  priority: TicketPriority
  stateId: string
  stateName: string
  /** The column it shows in: the pipeline's stage, or the one its tracker state maps to. */
  stage: Stage
  /** Empty on a Cloth board: there is nowhere else to open it. */
  url: string
  /** Plain text of the description (the goal for tickets made outside Cloth). */
  description: string
  pipeline: TicketPipeline | null
  /** A Cloth board's comments (reviews, hand-offs), oldest first. Other trackers keep theirs. */
  comments?: TicketComment[]
}

/** A chat project linked to a tracker project: its board. */
export interface BoardLink {
  kind: TrackerKind
  /** The tracker project's id. */
  projectId: string
  name: string
}

export interface BoardOverview {
  connection: TrackerConnection | null
  projects: BoardProject[]
  projectId: string | null
  states: TrackerState[]
  settings: BoardProjectSettings | null
  /** Whether the project's code folder is in a git repository (null: no folder). Commits and PRs need one. */
  repoGit: boolean | null
  tickets: BoardTicket[]
  syncedAt: number | null
  /** The chat project linked to the board on show: chats opened from its tickets go there. */
  chatProjectId: string | null
  /** The last sync failed: why. */
  error?: string
}

export interface NewTicketInput {
  title: string
  goal: string
  /** Hand to agents right away. */
  auto: boolean
  agents?: Partial<BoardAgents>
}

export type BoardEvent = { type: 'changed' }
