/*
 * Boards: tickets from one connected tracker (Plane or Jira) moved through Cloth's agent stages.
 * A planner writes requirements from the title and goal, a reviewer checks them against the goal,
 * and an implementer builds the ticket in its own worktree and opens a pull request.
 */

export type TrackerKind = 'plane' | 'jira'

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

/** What the user enters to connect. The token is write-only: it never comes back to the renderer. */
export interface TrackerConnectInput {
  kind: TrackerKind
  /** Plane: the instance (https://plane.example.com). Jira: the site (https://team.atlassian.net). */
  baseUrl: string
  /** Plane only: the workspace slug from its URLs. */
  workspace?: string
  /** Jira only: the account's email. */
  email?: string
  token: string
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
  /** The local git checkout the implementer works from. Building needs one. */
  repo: string | null
  /** stage → tracker state id. */
  stateMap: Record<MappedStage, string | null>
  /** Experimental: merge a PR on its own once checks pass and the code review approves. */
  autoMerge: boolean
  agents: BoardAgents
  /** Commands the implementer may run without asking (prefixes). */
  commands: string[]
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
  pr?: { number: number; url: string; checks: 'pending' | 'pass' | 'fail' | 'none'; merging: boolean }
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
  url: string
  /** Plain text of the description (the goal for tickets made outside Cloth). */
  description: string
  pipeline: TicketPipeline | null
}

export interface BoardOverview {
  connection: TrackerConnection | null
  projects: BoardProject[]
  projectId: string | null
  states: TrackerState[]
  settings: BoardProjectSettings | null
  tickets: BoardTicket[]
  syncedAt: number | null
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
