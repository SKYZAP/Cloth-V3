import { commandAllowed } from '@shared/types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { glob, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { structuredPatch } from 'diff'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  createEditTool,
  createFindTool,
  createLocalBashOperations,
  createLocalPowerShellOperations,
  createLsTool,
  createPowerShellTool,
  createBashTool,
  createReadTool,
  createWriteTool,
  type BashOperations
} from '@earendil-works/pi-coding-agent'
import type { ApprovalDecision, AutoApprove, BuiltinToolInfo, ChatEvent, FileAccess, FileChange, PendingApproval, PendingQuestion } from '@shared/types'
import { newId } from '../core/context'
import { Type } from 'typebox'
import { astRewrite, astSearch, resolveLanguage, supportedLanguages } from './ast'
import { commandRisk, commandRiskResolved, pathRiskResolved } from './risk'
import { BACKGROUND_FIRST_LOOK, CwdReportFilter, cwdMarker, gitBashPath, shellCwd, withCwdReport, type BackgroundShells, type ShellKind } from './shell'
import { DOCS_ONLY_REFUSAL, isDocPath } from './workflow'
import { fileURLToPath } from 'node:url'
import {
  applyEdits,
  describeLocations,
  findPosition,
  formatDiagnostics,
  hoverText,
  locations,
  lspLanguage,
  outline,
  workspaceEditFiles,
  type DocumentSymbol,
  type LspManager,
  type WorkspaceEdit
} from './lsp'
import { ruleNotes } from './rules'
import { git, repoRoot } from '../panel/git'

const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', '__pycache__']
const MAX_DIFF_LINES = 600

// ─── Path confinement ─────────────────────────────────────────────────────────

/**
 * Resolve `p` against the workspace and make sure it stays inside it — including through
 * symlinks (the nearest existing ancestor is resolved with realpath). Returns the absolute path.
 */
export async function confine(root: string, p: string): Promise<string> {
  const rootReal = await realpath(root)
  const abs = isAbsolute(p) ? resolve(p) : resolve(rootReal, p)
  let probe = abs
  const rest: string[] = []
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    rest.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    probe = parent
  }
  const real = join(existsSync(probe) ? await realpath(probe) : probe, ...rest)
  const inside = (a: string, b: string) => {
    const rel = relative(b, a)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  if (!inside(real, rootReal) && !inside(abs, rootReal)) throw new Error(`"${p}" is outside the workspace (${root}). Only files inside the workspace can be accessed.`)
  if (!inside(real, rootReal)) throw new Error(`"${p}" resolves through a link to a location outside the workspace.`)
  return real
}

// ─── Approvals ───────────────────────────────────────────────────────────────

/** Holds writes / edits / commands, and questions from `ask_user`, until the user answers in the chat. */
export class ApprovalService {
  private pending = new Map<string, { approval: PendingApproval; done: (d: ApprovalDecision) => void }>()
  private questions = new Map<string, { question: PendingQuestion; done: (answer: string | null, cancelled?: boolean) => void }>()

  /** Called when a chat starts waiting for the user (computer use hands the screen back). */
  onWait?: (sessionId: string) => void

  constructor(private emit: (e: ChatEvent) => void) {}

  request(input: Omit<PendingApproval, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<ApprovalDecision> {
    const approval: PendingApproval = { ...input, id: newId('apr_'), createdAt: Date.now() }
    this.onWait?.(input.sessionId)
    return new Promise((resolvePromise) => {
      const done = (d: ApprovalDecision) => {
        if (!this.pending.delete(approval.id)) return
        signal?.removeEventListener('abort', onAbort)
        this.emit({ sessionId: approval.sessionId, type: 'approval-done', id: approval.id })
        resolvePromise(d)
      }
      const onAbort = () => done('deny')
      if (signal?.aborted) return resolvePromise('deny')
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(approval.id, { approval, done })
      this.emit({ sessionId: approval.sessionId, type: 'approval', approval })
    })
  }

  resolve(id: string, decision: ApprovalDecision): void {
    const p = this.pending.get(id)
    if (!p) throw new Error('This request is no longer waiting for an answer')
    p.done(decision)
  }

  list(sessionId: string): PendingApproval[] {
    return [...this.pending.values()].filter((p) => p.approval.sessionId === sessionId).map((p) => p.approval)
  }

  /** Ask the user a question. Resolves with the answer, or null when they skip it; rejects when the chat is stopped. */
  ask(input: Omit<PendingQuestion, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<string | null> {
    const question: PendingQuestion = { ...input, id: newId('ask_'), createdAt: Date.now() }
    this.onWait?.(input.sessionId)
    return new Promise((resolvePromise, reject) => {
      const done = (answer: string | null, cancelled = false) => {
        if (!this.questions.delete(question.id)) return
        signal?.removeEventListener('abort', onAbort)
        this.emit({ sessionId: question.sessionId, type: 'question-done', id: question.id })
        if (cancelled) reject(new Error('The chat was stopped before the user answered'))
        else resolvePromise(answer)
      }
      const onAbort = () => done(null, true)
      if (signal?.aborted) return reject(new Error('Cancelled'))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.questions.set(question.id, { question, done })
      this.emit({ sessionId: question.sessionId, type: 'question', question })
    })
  }

  answer(id: string, answer: string | null): void {
    const q = this.questions.get(id)
    if (!q) throw new Error('This question is no longer waiting for an answer')
    q.done(answer?.trim() ? answer.trim() : null)
  }

  listQuestions(sessionId: string): PendingQuestion[] {
    return [...this.questions.values()].filter((q) => q.question.sessionId === sessionId).map((q) => q.question)
  }

  /** Deny everything still waiting for a chat (stop / delete). */
  cancel(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.approval.sessionId === sessionId) p.done('deny')
    for (const q of [...this.questions.values()]) if (q.question.sessionId === sessionId) q.done(null, true)
  }
}

// ─── Checkpoints ─────────────────────────────────────────────────────────────

interface CheckpointEntry {
  abs: string
  before: string | null
  after: string
}

/** File contents before each change, so a tool call's changes can be undone. */
export class CheckpointStore {
  constructor(private dir: string) {}

  private file(sessionId: string, toolCallId: string): string {
    return join(this.dir, safe(sessionId), `${safe(toolCallId)}.json`)
  }

  async record(sessionId: string, toolCallId: string, entry: CheckpointEntry): Promise<void> {
    const f = this.file(sessionId, toolCallId)
    const list = await this.read(f)
    // Keep the oldest "before" for a path changed twice in one call.
    const prev = list.find((e) => e.abs === entry.abs)
    if (prev) prev.after = entry.after
    else list.push(entry)
    await mkdir(dirname(f), { recursive: true })
    await writeFile(f, JSON.stringify(list))
  }

  /** Restore the files a tool call changed. Refuses if a file was changed again since. */
  async undo(sessionId: string, toolCallId: string, force = false): Promise<string[]> {
    const f = this.file(sessionId, toolCallId)
    const list = await this.read(f)
    if (!list.length) throw new Error('Nothing to undo for this step')
    if (!force) {
      for (const e of list) {
        const now = existsSync(e.abs) ? await readFile(e.abs, 'utf8') : null
        if (now !== e.after) throw new Error(`${e.abs} has changed since this edit — undoing would overwrite newer changes`)
      }
    }
    for (const e of [...list].reverse()) {
      if (e.before === null) await rm(e.abs, { force: true })
      else {
        await mkdir(dirname(e.abs), { recursive: true })
        await writeFile(e.abs, e.before)
      }
    }
    await rm(f, { force: true })
    return list.map((e) => e.abs)
  }

  async removeSession(sessionId: string): Promise<void> {
    await rm(join(this.dir, safe(sessionId)), { recursive: true, force: true })
  }

  private async read(f: string): Promise<CheckpointEntry[]> {
    try {
      return JSON.parse(await readFile(f, 'utf8')) as CheckpointEntry[]
    } catch {
      return []
    }
  }
}

function safe(s: string): string {
  return s.replace(/[^\w.-]/g, '_')
}

// ─── Diffs ───────────────────────────────────────────────────────────────────

export function makeDiff(path: string, before: string | null, after: string): { diff: string; added: number; removed: number } {
  const lf = (s: string) => s.replace(/\r\n/g, '\n')
  const patch = structuredPatch(before === null ? '/dev/null' : `a/${path}`, `b/${path}`, lf(before ?? ''), lf(after), '', '', { context: 3 })
  let added = 0
  let removed = 0
  const lines: string[] = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`]
  for (const h of patch.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
      lines.push(l)
    }
  }
  const diff = lines.length > MAX_DIFF_LINES ? [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more diff lines`].join('\n') : lines.join('\n')
  return { diff, added, removed }
}

// ─── Tools ───────────────────────────────────────────────────────────────────

interface CallState {
  toolCallId: string
  toolName: string
  signal?: AbortSignal
  changes: FileChange[]
  /** Checkpoint key: the outermost tool call (a subagent's edits belong to its `task` call). */
  checkpointId: string
  parent?: CallState
  /** Extra lines appended to the tool result (e.g. type errors after an edit). */
  notes: string[]
}

const call = new AsyncLocalStorage<CallState>()

export interface WorkspaceOptions {
  root: string
  sessionId: string | null
  access: FileAccess
  shell: boolean
  approvals: ApprovalService | null
  checkpoints: CheckpointStore | null
  /** Live policy — the user can switch to auto-approve mid-run. */
  autoApprove(): AutoApprove
  /** The user picked "always" on an approval card. */
  onAlways?(scope: 'edits' | 'all'): void
  /** Language servers for the `lsp` tool and post-edit type checking; null = off. */
  lsp?: LspManager | null
  /** Global coding rules folder; changed files are also checked against the folder's own sgconfig.yml rules (rules.ts). */
  rulesDir?: string | null
  /** Commands that run without asking; any other command is refused (unattended automations). */
  commandAllow?: string[] | null
  /** Commands a chat runs with run_in_background (null: no background commands, e.g. unattended runs). */
  background?: BackgroundShells | null
  /** Run commands somewhere else (a Linux container) with bash; cwd is relative to the workspace root. */
  shellExec?: (command: string, cwd: string, options: Parameters<BashOperations['exec']>[2]) => Promise<{ exitCode: number | null }>
  /**
   * Look for risky actions (risk.ts): they ask even when everything else is approved up front (unless
   * `asksBeforeRisky` says no), and are refused when nobody is there to ask. Never in a container, whose changes are reviewed instead.
   */
  checkRisk?: boolean
  /** Live: risky actions still ask (permissions.ts asksBeforeRisky); false in a chat set to Auto. Default true. */
  asksBeforeRisky?(): boolean
  /** Live: the chat is in Plan mode, so changes and commands are refused even if the tools are there. */
  readOnly?(): boolean
  /** Live: a Spec → Ship chat before Build may only write the glossary and docs/, and run no commands. */
  docsOnly?(): boolean
}

/** What an unattended run is told when a risky action would need a person. */
export const NEEDS_PERSON = 'This needs approval and nobody is here to give it; report it instead.'
export const PLAN_REFUSAL = 'This chat is in Plan mode, which is read-only: describe the change in your plan (present_plan) instead of making it.'

/** An allowlisted command that is risky runs only when the allowlist entry it matched is itself risky ("git push", not "git"). */
function allowCovers(command: string, allow: string[], shell: 'bash' | 'powershell', root: string): boolean {
  const c = command.trim().replace(/\s+/g, ' ')
  return allow.some((a) => {
    const p = a.trim().replace(/\s+/g, ' ')
    return !!p && (c === p || c.startsWith(`${p} `)) && !!commandRisk(p, { root, shell })
  })
}

export const WORKSPACE_TOOL_NAMES = ['read', 'ls', 'find', 'write', 'edit', 'bash', 'powershell', 'shell_output', 'shell_stop', 'terminal_read', 'ast_grep', 'ast_edit', 'git_diff', 'lsp']

const MAX_GIT_DIFF_CHARS = 60_000
/** A ref or range the model may pass to git: no leading dash (it would read as an option), no spaces or shell-ish characters. */
const SAFE_REF = /^(?!-)[\w./~^@{}:+-]+$/

/**
 * What changed in the repository holding `root`, for a reader: the commits in a range, a per-file summary,
 * the patch (capped), and new untracked files. Never runs external diff or textconv drivers or fsmonitor hooks.
 */
export async function gitChanges(root: string, opts: { base?: string; staged?: boolean; path?: string; statOnly?: boolean } = {}): Promise<string> {
  const top = await repoRoot(root)
  if (!top) return 'This workspace is not in a git repository (or git is not installed), so there is no diff. Review the files you were pointed at instead.'
  const base = opts.base?.trim() || undefined
  if (base && !SAFE_REF.test(base)) throw new Error(`"${base}" is not a branch, tag, commit or range git_diff accepts`)
  const run = async (args: string[]) => {
    const r = await git(top, ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args])
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`)
    return r.stdout
  }
  const scope = opts.path ? ['--', relative(top, opts.path).split(sep).join('/') || '.'] : []
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...(opts.staged ? ['--cached'] : []), ...(base ? [base] : opts.staged ? [] : ['HEAD'])]
  const hasHead = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code === 0
  // A repository with no commits yet has no HEAD to compare with: everything is new.
  if (!hasHead && !base && !opts.staged) diffArgs.splice(diffArgs.indexOf('HEAD'), 1, '--cached')
  const parts: string[] = []
  if (base && /\.\.\.?/.test(base)) {
    const log = (await run(['log', '--oneline', '--no-decorate', '-n', '30', base.includes('...') ? base.replace('...', '..') : base])).trim()
    if (log) parts.push(`Commits in ${base}:\n${log}`)
  }
  const stat = (await run([...diffArgs, '--stat=120', ...scope])).trim()
  const untracked = opts.staged || (base && /\.\./.test(base)) ? [] : (await run(['ls-files', '--others', '--exclude-standard', ...scope])).split('\n').map((f) => f.trim()).filter(Boolean)
  if (!stat && !untracked.length) return `${parts.length ? parts.join('\n\n') + '\n\n' : ''}No changes${base ? ` against ${base}` : opts.staged ? ' staged' : ''}${opts.path ? ' in that path' : ''}.`
  if (stat) parts.push(`Changed files (against ${base ?? (opts.staged ? 'HEAD, staged only' : 'HEAD')}):\n${stat}`)
  if (untracked.length) parts.push(`New untracked files (not in the diff; read them in full):\n${untracked.slice(0, 200).join('\n')}${untracked.length > 200 ? `\n… and ${untracked.length - 200} more` : ''}`)
  if (!opts.statOnly && stat) {
    let patch = await run([...diffArgs, ...scope])
    if (patch.length > MAX_GIT_DIFF_CHARS) {
      patch = `${patch.slice(0, MAX_GIT_DIFF_CHARS)}\n… diff cut off at ${MAX_GIT_DIFF_CHARS} characters. Call git_diff again with path set to each remaining file, or read the files.`
    }
    parts.push(patch.trimEnd())
  }
  return parts.join('\n\n')
}

export function describeWorkspaceTools(): BuiltinToolInfo[] {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash'
  const t = (name: string, label: string, description: string, availability: string, schema: Record<string, unknown>): BuiltinToolInfo => ({ name, label, description, group: 'workspace', availability, where: { chats: true, subagents: true, flows: true, apps: false }, schema })
  const obj = (props: Record<string, string>, required: string[]) => ({
    type: 'object',
    required,
    properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }]))
  })
  return [
    t('read', 'Read file', 'Read a text or image file from the workspace, with offset/limit for large files.', 'Chats with a workspace folder', obj({ path: 'string', offset: 'number', limit: 'number' }, ['path'])),
    t('ls', 'List directory', 'List a directory in the workspace.', 'Chats with a workspace folder', obj({ path: 'string', limit: 'number' }, [])),
    t('find', 'Find files', 'Find files by glob pattern (e.g. **/*.ts) in the workspace.', 'Chats with a workspace folder', obj({ pattern: 'string', path: 'string', limit: 'number' }, ['pattern'])),
    t('ast_grep', 'AST search', 'Structural code search with ast-grep patterns ($VAR, $$ARGS). TS/JS/TSX/HTML/CSS, Python, Go, Rust, Java.', 'Chats with a workspace folder', obj({ pattern: 'string', language: 'string', path: 'string' }, ['pattern'])),
    t('git_diff', 'Git diff', 'Read-only: the uncommitted changes, or the changes against a branch, commit or range, as a unified diff with a per-file summary and the new untracked files.', 'Chats with a workspace folder in a git repository', obj({ base: 'string', staged: 'boolean', path: 'string', statOnly: 'boolean' }, [])),
    t('ast_edit', 'AST rewrite', 'Rewrite every match of an ast-grep pattern, reusing captured $VARS. One approval (combined diff) for all files; undoable.', 'Chats with a workspace in read & write mode', obj({ pattern: 'string', rewrite: 'string', language: 'string', path: 'string' }, ['pattern', 'rewrite'])),
    t('lsp', 'Code intelligence', 'Language-server diagnostics, definition, references, hover, symbols and rename for TypeScript/JavaScript (TypeScript 7 native server) and Python (Pyright). Also reports type errors right after each edit.', 'Chats with a workspace and code intelligence on', obj({ action: 'string', path: 'string', symbol: 'string', line: 'number', query: 'string', newName: 'string' }, ['action'])),
    t('write', 'Write file', 'Create or overwrite a file. Asks for approval (with a diff) unless edits are auto-approved; undoable.', 'Chats with a workspace in read & write mode', obj({ path: 'string', content: 'string' }, ['path', 'content'])),
    t('edit', 'Edit file', 'Replace exact text in a file (one or more edits). Asks for approval (with a diff) unless edits are auto-approved; undoable.', 'Chats with a workspace in read & write mode', obj({ path: 'string', edits: 'array' }, ['path', 'edits'])),
    t(shell, 'Run command', `Run a ${shell === 'bash' ? 'bash' : 'PowerShell'} command in the workspace. \`cd\` carries over to the next command while it stays in the workspace, and run_in_background keeps servers and watchers running. In Manual mode, risky commands ask first.`, 'Chats with a workspace and shell commands on', obj({ command: 'string', timeout: 'number', run_in_background: 'boolean' }, ['command'])),
    ...(shell === 'powershell' && gitBashPath()
      ? [t('bash', 'Run bash command', 'Run a command in Git Bash, in the workspace. Same rules as PowerShell: the folder carries over, run_in_background is there, and in Manual mode risky commands ask first.', 'Chats with a workspace and shell commands on (Git Bash installed)', obj({ command: 'string', timeout: 'number', run_in_background: 'boolean' }, ['command']))]
      : []),
    t('shell_output', 'Background output', 'Read new output from a command started with run_in_background, and whether it is still running. A filter (regular expression) keeps only matching lines.', 'Chats with shell commands on', obj({ id: 'string', filter: 'string' }, ['id'])),
    t('shell_stop', 'Stop background command', 'Stop a command started with run_in_background, and everything it started.', 'Chats with shell commands on', obj({ id: 'string' }, ['id'])),
    t('terminal_read', 'Read terminal', "Read what a terminal in the chat's Terminal panel shows: the user's own shells and background commands' tabs. It never types into them.", 'Chats', obj({ id: 'string', lines: 'number' }, []))
  ]
}

/** pi's coding tools, confined to the workspace, with approvals and checkpoints on every change. */
export function buildWorkspaceTools(o: WorkspaceOptions): AgentTool<any>[] {
  const inside = (p: string) => confine(o.root, p)
  const commandShell: 'bash' | 'powershell' = o.shellExec || process.platform !== 'win32' ? 'bash' : 'powershell'
  /** Why a command needs a person's look (risk.ts), or null; never in a container. */
  const commandRiskOf = async (command: string, cwd: string, shell: 'bash' | 'powershell' = commandShell): Promise<string | null> =>
    o.checkRisk && !o.shellExec ? commandRiskResolved(command, { root: await realpath(o.root), cwd, shell, home: homedir() }) : null
  /**
   * Ask before a change or command unless the policy approves it up front. A risky one (`risk`)
   * asks even then; with nobody to ask, it is refused with a note for the model.
   */
  const ask = async (input: Omit<PendingApproval, 'id' | 'createdAt' | 'sessionId' | 'toolCallId'>, risk: string | null = null): Promise<void> => {
    if (o.readOnly?.()) throw new Error(PLAN_REFUSAL)
    if (o.docsOnly?.() && input.kind === 'command') throw new Error(DOCS_ONLY_REFUSAL)
    if (input.kind === 'command' && o.commandAllow?.length) {
      if (!commandAllowed(input.command ?? '', o.commandAllow)) {
        throw new Error(`This automation may only run these commands, one at a time: ${o.commandAllow.join(', ')}. Use one of them, or do without.`)
      }
      if (!risk || allowCovers(input.command ?? '', o.commandAllow, commandShell, o.root)) return
      throw new Error(`${risk}. ${NEEDS_PERSON}`)
    }
    // A chat in Auto takes risky actions without asking too.
    if (risk && o.asksBeforeRisky && !o.asksBeforeRisky()) risk = null
    const policy = o.autoApprove()
    const auto = policy === 'all' || (policy === 'edits' && input.kind !== 'command')
    if (auto && !risk) return
    if (!o.approvals || !o.sessionId) throw new Error(risk ? `${risk}. ${NEEDS_PERSON}` : 'This action needs approval, and there is no one to ask in this context')
    const state = call.getStore()
    const decision = await o.approvals.request({ ...input, ...(risk ? { risk } : {}), sessionId: o.sessionId, toolCallId: state?.toolCallId ?? null }, state?.signal)
    if (decision === 'deny') {
      throw new Error(
        input.kind === 'command'
          ? `The user declined to run this command. Do not retry it; ask the user how to proceed.`
          : `The user declined this change to ${input.path}. Do not retry the same change; ask the user what they want instead.`
      )
    }
    // "Always" ("Switch to Auto" on a risky action) allows this one and stops asking from now on.
    if (decision === 'always') o.onAlways?.(input.kind === 'command' ? 'all' : 'edits')
  }

  /** Apply one or more file changes behind a single approval, checkpointing each file. */
  const commit = async (files: { abs: string; before: string | null; after: string }[], kind: 'write' | 'edit') => {
    const rootReal = await realpath(o.root)
    const planned = files
      .filter((f) => f.before !== f.after)
      .map((f) => {
        const rel = relative(rootReal, f.abs).split(sep).join('/')
        return { ...f, rel, ...makeDiff(rel, f.before, f.after) }
      })
    if (!planned.length) return []
    if (o.docsOnly?.() && !planned.every((p) => isDocPath(p.rel))) throw new Error(DOCS_ONLY_REFUSAL)
    const added = planned.reduce((n, p) => n + p.added, 0)
    const removed = planned.reduce((n, p) => n + p.removed, 0)
    // Paths are already confined to the folder; this also catches one that a link leads out of.
    let risk: string | null = null
    if (o.checkRisk && !o.shellExec) for (const p of planned) risk ??= await pathRiskResolved(rootReal, p.abs, 'write')
    await ask({ kind, path: planned.length === 1 ? planned[0].rel : `${planned.length} files`, diff: planned.map((p) => p.diff).join('\n'), added, removed }, risk)
    const state = call.getStore()
    const changes: FileChange[] = []
    for (const p of planned) {
      if (o.checkpoints && o.sessionId && state) await o.checkpoints.record(o.sessionId, state.checkpointId, { abs: p.abs, before: p.before, after: p.after })
      await mkdir(dirname(p.abs), { recursive: true })
      await writeFile(p.abs, p.after)
      const change: FileChange = { path: p.rel, kind: p.before === null ? 'create' : 'modify', diff: p.diff, added: p.added, removed: p.removed }
      for (let s: CallState | undefined = state; s; s = s.parent) s.changes.push(change)
      changes.push(change)
    }
    // Tell the agent right away if the change broke the types, so it can fix it in the same turn.
    if (o.lsp && state) {
      for (const p of planned.filter((x) => lspLanguage(x.abs)).slice(0, 5)) {
        try {
          const server = await o.lsp.server(rootReal, p.abs)
          if (!server.ready) {
            // jdtls is still importing the project (can take minutes): don't hold the edit up for it.
            state.notes.push(`${p.rel}: type check skipped, the Java language server is still importing the project`)
            continue
          }
          const errors = (await server.diagnostics(p.abs, 12_000)).filter((d) => d.severity === 1)
          state.notes.push(errors.length ? `Type errors after this change — ${formatDiagnostics(p.rel, errors, { errorsOnly: true, max: 8 })}` : `✓ ${p.rel}: no type errors`)
        } catch {
          /* no server / too slow: skip the check rather than fail the edit */
        }
      }
    }
    // And whether it breaks the user's coding rules.
    if (state) state.notes.push(...(await ruleNotes(rootReal, o.rulesDir ?? null, planned).catch(() => [])))
    return changes
  }

  const writeChecked = async (abs: string, content: string) => {
    const before = existsSync(abs) ? await readFile(abs, 'utf8') : null
    await commit([{ abs, before, after: content }], call.getStore()?.toolName === 'edit' ? 'edit' : 'write')
  }

  const langs = () => supportedLanguages().join(', ')
  const astGrep: AgentTool<any> = {
    name: 'ast_grep',
    label: 'AST search',
    description: `Structural code search with ast-grep: the pattern is code, with $NAME matching any single node and $$ARGS matching a list (e.g. "console.log($$ARGS)", "useEffect($FN, [])", "def $F($$P): $$B"). Finds code by shape regardless of formatting — better than grep for calls, definitions and usages. Languages: ${langs()} (inferred from file extensions; set language to restrict).`,
    parameters: Type.Object({
      pattern: Type.String({ description: 'Code pattern with $VARS' }),
      language: Type.Optional(Type.String()),
      path: Type.Optional(Type.String({ description: 'File or directory (default: workspace root)' })),
      maxResults: Type.Optional(Type.Number())
    }),
    async execute(_id, params, signal) {
      const p = params as { pattern: string; language?: string; path?: string; maxResults?: number }
      const { matches, files } = await astSearch(await realpath(o.root), await inside(p.path || '.'), { pattern: p.pattern, lang: resolveLanguage(p.language), max: p.maxResults ?? 60, signal })
      const text = matches.length
        ? matches.map((m) => `${m.file}:${m.line}: ${m.text.length > 300 ? m.text.slice(0, 300) + '…' : m.text}`).join('\n\n')
        : `No matches in ${files} file${files === 1 ? '' : 's'}.`
      return { content: [{ type: 'text', text }], details: { matches: matches.length, files } }
    }
  }
  const astEdit: AgentTool<any> = {
    name: 'ast_edit',
    label: 'AST rewrite',
    description: `Structural rewrite with ast-grep across a file or directory: every match of pattern is replaced by rewrite, where $NAME / $$ARGS in rewrite insert what the pattern captured (e.g. pattern "console.log($$A)" → rewrite "logger.debug($$A)"). Use for renames and mechanical refactors across many places; use edit for one-off changes. Run ast_grep first to check what matches. All changed files are shown to the user as one diff for approval. Languages: ${langs()}.`,
    parameters: Type.Object({
      pattern: Type.String(),
      rewrite: Type.String(),
      language: Type.Optional(Type.String()),
      path: Type.Optional(Type.String({ description: 'File or directory (default: workspace root)' }))
    }),
    async execute(_id, params, signal) {
      const p = params as { pattern: string; rewrite: string; language?: string; path?: string }
      const found = await astRewrite(await inside(p.path || '.'), { pattern: p.pattern, rewrite: p.rewrite, lang: resolveLanguage(p.language), signal })
      if (!found.length) return { content: [{ type: 'text', text: 'No matches — nothing changed.' }], details: {} }
      const changes = await commit(found, 'edit')
      const total = found.reduce((n, f) => n + f.count, 0)
      return { content: [{ type: 'text', text: `Rewrote ${total} match${total === 1 ? '' : 'es'} in ${changes.length} file${changes.length === 1 ? '' : 's'}: ${changes.map((c) => c.path).join(', ')}` }], details: {} }
    }
  }

  const lspTool: AgentTool<any> = {
    name: 'lsp',
    label: 'Code intelligence',
    description:
      'Language-server code intelligence for TypeScript/JavaScript and Python. actions: "diagnostics" (type errors and warnings in path), "definition", "references" and "hover" (for symbol — give its 1-based line when you know it), "symbols" (outline of path, or search the project for query), "rename" (rename symbol to newName everywhere it is used; read & write chats only, shown as one diff for approval). Point at symbols by name and line, never by column.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('diagnostics'), Type.Literal('definition'), Type.Literal('references'), Type.Literal('hover'), Type.Literal('symbols'), Type.Literal('rename')]),
      path: Type.Optional(Type.String({ description: 'File the symbol is in (relative to the workspace)' })),
      symbol: Type.Optional(Type.String()),
      line: Type.Optional(Type.Number({ description: '1-based line of the symbol' })),
      query: Type.Optional(Type.String({ description: 'For symbols: project-wide symbol search' })),
      newName: Type.Optional(Type.String({ description: 'For rename' }))
    }),
    async execute(_id, params) {
      const p = params as { action: string; path?: string; symbol?: string; line?: number; query?: string; newName?: string }
      if (!o.lsp) throw new Error('Code intelligence is off for this chat')
      const rootReal = await realpath(o.root)
      const text = (t: string) => ({ content: [{ type: 'text' as const, text: t || '(nothing found)' }], details: {} })
      if (p.action === 'symbols' && p.query && !p.path) {
        const server = await o.lsp.server(rootReal, join(rootReal, 'index.ts'))
        const found = (await server.request<DocumentSymbol[] | null>('workspace/symbol', { query: p.query })) ?? []
        return text(await describeLocations(rootReal, found.filter((s) => s.location).map((s) => s.location!), 40))
      }
      if (!p.path) throw new Error('path is required')
      const abs = await inside(p.path)
      const rel = relative(rootReal, abs).split(sep).join('/')
      const server = await o.lsp.server(rootReal, abs)
      if (p.action === 'diagnostics') return text(formatDiagnostics(rel, await server.diagnostics(abs)))
      const uri = await server.sync(abs)
      if (p.action === 'symbols') {
        if (p.query) {
          const found = (await server.request<DocumentSymbol[] | null>('workspace/symbol', { query: p.query })) ?? []
          return text(await describeLocations(rootReal, found.filter((s) => s.location).map((s) => s.location!), 40))
        }
        const syms = (await server.request<DocumentSymbol[] | null>('textDocument/documentSymbol', { textDocument: { uri } })) ?? []
        return text(outline(syms).join('\n'))
      }
      const position = findPosition(await readFile(abs, 'utf8'), p.symbol, p.line)
      const at = { textDocument: { uri }, position }
      switch (p.action) {
        case 'definition':
          return text(await describeLocations(rootReal, locations(await server.request('textDocument/definition', at))))
        case 'references':
          return text(await describeLocations(rootReal, locations(await server.request('textDocument/references', { ...at, context: { includeDeclaration: true } })), 60))
        case 'hover':
          return text(hoverText(await server.request('textDocument/hover', at)))
        case 'rename': {
          if (o.access !== 'write') throw new Error('Renaming changes files — this chat is read-only')
          if (!p.newName) throw new Error('newName is required')
          const edit = await server.request<WorkspaceEdit | null>('textDocument/rename', { ...at, newName: p.newName })
          const files = []
          for (const f of workspaceEditFiles(edit)) {
            const target = await inside(fileURLToPath(f.uri))
            const before = await readFile(target, 'utf8')
            files.push({ abs: target, before, after: applyEdits(before, f.edits) })
          }
          if (!files.length) return text(`Nothing to rename at ${rel}:${position.line + 1}`)
          const changes = await commit(files, 'edit')
          return text(`Renamed ${p.symbol ?? 'symbol'} → ${p.newName} in ${changes.length} file${changes.length === 1 ? '' : 's'}: ${changes.map((c) => c.path).join(', ')}`)
        }
        default:
          throw new Error(`Unknown action "${p.action}"`)
      }
    }
  }

  const gitDiffTool: AgentTool<any> = {
    name: 'git_diff',
    label: 'Git diff',
    description:
      'Read-only: show what changed in the workspace\'s git repository, as a unified diff with a per-file summary. With no arguments: every uncommitted change (staged and not) against HEAD, plus the list of new untracked files (read those with `read`). base: compare the working tree with a branch, tag or commit instead ("main", "HEAD~3", "abc123"), or give a range ("main...HEAD", "abc123..def456"); the commits in it are listed too. staged: only what is staged. path: limit to a file or folder. statOnly: just the summary, for a large change you will read file by file.',
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: 'Ref or range to compare against (default: HEAD)' })),
      staged: Type.Optional(Type.Boolean({ description: 'Only staged changes' })),
      path: Type.Optional(Type.String({ description: 'File or folder to limit the diff to' })),
      statOnly: Type.Optional(Type.Boolean({ description: 'Only the per-file summary' }))
    }),
    async execute(_id, params) {
      const p = params as { base?: string; staged?: boolean; path?: string; statOnly?: boolean }
      const rootReal = await realpath(o.root)
      const out = await gitChanges(rootReal, { base: p.base, staged: p.staged, path: p.path ? await inside(p.path) : undefined, statOnly: p.statOnly })
      return { content: [{ type: 'text', text: out }], details: {} }
    }
  }

  const readOps = {
    readFile: async (p: string) => readFile(await inside(p)),
    access: async (p: string) => void (await stat(await inside(p)))
  }
  const tools: AgentTool<any>[] = [
    createReadTool(o.root, { operations: readOps }),
    createLsTool(o.root, {
      operations: {
        exists: async (p) => existsSync(await inside(p)),
        stat: async (p) => stat(await inside(p)),
        readdir: async (p) => readdir(await inside(p))
      }
    }),
    createFindTool(o.root, {
      operations: {
        exists: async (p) => existsSync(await inside(p)),
        glob: async (pattern, cwd, opts) => {
          const base = await inside(cwd)
          const out: string[] = []
          const skip = new Set([...IGNORED_DIRS, ...opts.ignore.map((i) => i.replace(/^\*\*\/|\/\*\*$/g, ''))])
          for await (const f of glob(pattern, { cwd: base, exclude: (name: string) => skip.has(name.split(/[\\/]/).pop() ?? name) })) {
            out.push(String(f).split(sep).join('/'))
            if (out.length >= opts.limit) break
          }
          return out
        }
      }
    }),
    astGrep,
    gitDiffTool,
    ...(o.lsp ? [lspTool] : [])
  ]

  if (o.access === 'write') {
    tools.push(
      astEdit,
      createWriteTool(o.root, {
        operations: {
          writeFile: async (p, content) => writeChecked(await inside(p), content),
          mkdir: async (p) => void (await inside(p))
        }
      }),
      createEditTool(o.root, {
        operations: {
          readFile: async (p) => readFile(await inside(p)),
          writeFile: async (p, content) => writeChecked(await inside(p), content),
          access: async (p) => void (await stat(await inside(p)))
        }
      })
    )
  }

  if (o.shell) tools.push(...shellTools(o, inside, ask, commandRiskOf))

  return tools.map(withCallState)
}

type Ask = (input: Omit<PendingApproval, 'id' | 'createdAt' | 'sessionId' | 'toolCallId'>, risk?: string | null) => Promise<void>

interface Shell {
  /** The tool's name. */
  name: 'bash' | 'powershell'
  kind: ShellKind
  /** How risk.ts reads its commands. */
  risk: 'bash' | 'powershell'
  /** Runs a command (cwd relative to the workspace root, '' for the root). */
  run(command: string, rel: string, options: ExecOptions): Promise<{ exitCode: number | null }>
}

/**
 * The shell tools: bash (Linux, macOS, a container, and Git Bash on Windows) and PowerShell (Windows), each with a
 * folder that carries over between commands and run_in_background, plus shell_output / shell_stop for those.
 */
function shellTools(o: WorkspaceOptions, inside: (p: string) => Promise<string>, ask: Ask, riskOf: (command: string, cwd: string, shell: 'bash' | 'powershell') => Promise<string | null>): AgentTool<any>[] {
  const shells: Shell[] = []
  if (o.shellExec) {
    const run = o.shellExec
    shells.push({ name: 'bash', kind: 'container', risk: 'bash', run: (command, rel, options) => run(command, rel, options) })
  } else if (process.platform === 'win32') {
    const ps = createLocalPowerShellOperations()
    shells.push({ name: 'powershell', kind: 'powershell', risk: 'powershell', run: async (command, rel, options) => ps.exec(command, join(await realpath(o.root), rel), options) })
    const gitBash = gitBashPath()
    if (gitBash) {
      const bash = createLocalBashOperations({ shellPath: gitBash })
      shells.push({ name: 'bash', kind: 'gitbash', risk: 'bash', run: async (command, rel, options) => bash.exec(command, join(await realpath(o.root), rel), options) })
    }
  } else {
    const bash = createLocalBashOperations()
    shells.push({ name: 'bash', kind: 'bash', risk: 'bash', run: async (command, rel, options) => bash.exec(command, join(await realpath(o.root), rel), options) })
  }

  // The folder the next command starts in, relative to the root ('' = the root). Kept per chat; a run without a chat keeps its own.
  let ownCwd = ''
  const getRel = () => (o.sessionId ? (shellCwd.get(o.sessionId) ?? '') : ownCwd)
  const setRel = (rel: string) => {
    if (!o.sessionId) ownCwd = rel
    else if (rel) shellCwd.set(o.sessionId, rel)
    else shellCwd.reset(o.sessionId)
  }
  /** Where the next command starts: where the last one ended, while that is still a folder inside the workspace. */
  const start = async (): Promise<{ dir: string; rel: string }> => {
    const rootReal = await realpath(o.root)
    const rel = getRel()
    if (rel) {
      try {
        const dir = await inside(rel)
        if ((await stat(dir)).isDirectory()) return { dir, rel: relative(rootReal, dir).split(sep).join('/') }
      } catch {
        /* gone, or outside now: back to the root */
      }
      setRel('')
    }
    return { dir: rootReal, rel: '' }
  }
  /** Keep the folder a command ended in, or go back to the root (with a note) when it left the workspace. */
  const keep = async (reported: string | null, shell: Shell, out: (data: Buffer) => void): Promise<void> => {
    if (!reported) return
    let rel: string | null
    if (shell.kind === 'container') {
      const r = posix.relative('/workspace', reported)
      rel = r.startsWith('..') || posix.isAbsolute(r) ? null : r
    } else {
      const rootReal = await realpath(o.root)
      const abs = resolve(reported)
      const real = await realpath(abs).catch(() => abs)
      const r = relative(rootReal, real)
      rel = r.startsWith('..') || isAbsolute(r) ? null : r.split(sep).join('/')
    }
    if (rel === null) {
      setRel('')
      out(Buffer.from(`\n[The command ended in ${reported}, outside the workspace, so the next command starts in the workspace root again.]\n`))
      return
    }
    setRel(rel)
  }

  const background = o.background && o.sessionId ? { bg: o.background, sessionId: o.sessionId } : null
  const NOTE =
    '\n\nThe working folder carries over: after `cd sub`, the next command runs in sub, as long as it stays inside the workspace (leaving it sends the next command back to the root).' +
    (background
      ? ' Set run_in_background to true for dev servers, watchers and anything else that keeps running: it returns at once with an id, the command keeps running while you work, and you read its new output with shell_output and stop it with shell_stop. Never use nohup, & or Start-Process for that.'
      : '')

  const tools: AgentTool<any>[] = []
  for (const sh of shells) {
    const operations: BashOperations = {
      exec: async (command, _cwd, options) => {
        const { dir, rel } = await start()
        await ask({ kind: 'command', command, path: rel || '.' }, await riskOf(command, dir, sh.risk))
        const marker = cwdMarker()
        const wrapped = withCwdReport(command, sh.kind, marker)
        const filter = new CwdReportFilter(marker, options.onData)
        try {
          return await withDefaultTimeout(sh.risk, { ...options, onData: filter.push }, (opts) => sh.run(wrapped ?? command, rel, opts))
        } finally {
          filter.end()
          await keep(filter.cwd, sh, options.onData)
        }
      }
    }
    const base: AgentTool<any> =
      sh.name === 'powershell' ? createPowerShellTool(o.root, { operations }) : createBashTool(o.root, { operations })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (base.parameters as unknown as { properties: Record<string, any> }).properties
    tools.push({
      ...base,
      description: `${base.description}${sh.kind === 'gitbash' ? '\n\nThis is Git Bash on Windows: Unix tools (grep, sed, find) and paths like /c/Users/…; Windows programs (npm, git, dotnet) run as usual.' : ''}${NOTE}`,
      parameters: background
        ? Type.Object({ ...props, run_in_background: Type.Optional(Type.Boolean({ description: 'Run it in the background and return at once with an id (for servers, watchers and other commands that keep running)' })) })
        : base.parameters,
      async execute(id, params, signal, onUpdate) {
        const { run_in_background: inBackground, ...rest } = (params ?? {}) as { run_in_background?: boolean; command?: string; timeout?: number }
        if (!inBackground || !background) return base.execute(id, rest, signal, onUpdate)
        const command = String(rest.command ?? '').trim()
        if (!command) throw new Error('Give the command to run')
        const { dir, rel } = await start()
        await ask({ kind: 'command', command, path: rel || '.' }, await riskOf(command, dir, sh.risk))
        const info = background.bg.start({ sessionId: background.sessionId, command, cwd: rel || '.', shell: sh.name, container: sh.kind === 'container', run: (onData, sig) => sh.run(command, rel, { onData, signal: sig }) })
        // A moment for it to fail straight away (a typo, a port in use) before the agent moves on; returns as soon as it ends.
        await background.bg.settled(background.sessionId, info.id, BACKGROUND_FIRST_LOOK.ms)
        const first = background.bg.read(background.sessionId, info.id)
        const state = first.info.status === 'running' ? `It is running as ${info.id}.` : `It already ended (${first.info.status}${first.info.exitCode !== null ? `, exit code ${first.info.exitCode}` : ''}).`
        const text = `Started in the background in ${rel || 'the workspace root'}. ${state} Read new output with shell_output (id ${info.id}); stop it with shell_stop. The user sees it as a tab in the chat's Terminals panel and can stop it there.${first.text.trim() ? `\n\nOutput so far:\n${capOutput(first.text)}` : ''}`
        return { content: [{ type: 'text', text }], details: { background: info.id } }
      }
    })
  }

  if (background) {
    const { bg, sessionId } = background
    tools.push({
      name: 'shell_output',
      label: 'Background output',
      description: 'Read the new output of a command started with run_in_background (since the last read), and whether it is still running. Pass filter, a regular expression, to keep only matching lines (e.g. "error|warn").',
      parameters: Type.Object({ id: Type.String({ description: 'The id run_in_background returned (bg_…)' }), filter: Type.Optional(Type.String({ description: 'Only lines matching this regular expression' })) }),
      async execute(_id, params) {
        const p = params as { id: string; filter?: string }
        const r = bg.read(sessionId, p.id, p.filter)
        const status =
          r.info.status === 'running' ? `${r.info.id} is still running.` : `${r.info.id} ${r.info.status === 'stopped' ? 'was stopped' : 'ended'}${r.info.exitCode !== null ? ` with exit code ${r.info.exitCode}` : ''}.`
        const dropped = r.skipped ? `\n[${r.skipped} characters of older output were dropped before this read.]` : ''
        return { content: [{ type: 'text', text: `${status}${dropped}\n\n${r.text.trim() ? capOutput(r.text) : p.filter ? '(no new lines match the filter)' : '(no new output)'}` }], details: {} }
      }
    })
    tools.push({
      name: 'shell_stop',
      label: 'Stop background command',
      description: 'Stop a command started with run_in_background, and everything it started.',
      parameters: Type.Object({ id: Type.String({ description: 'The id run_in_background returned (bg_…)' }) }),
      async execute(_id, params) {
        const was = bg.list(sessionId).find((c) => c.id === (params as { id: string }).id.trim())?.status
        const info = await bg.stop(sessionId, (params as { id: string }).id)
        return { content: [{ type: 'text', text: was === 'running' ? `Stopped ${info.id}.` : `${info.id} had already ended (${info.status}).` }], details: {} }
      }
    })
  }
  return tools
}

/** Seconds a shell command may run when the model gives no timeout. */
export const DEFAULT_COMMAND_TIMEOUT = 300

type ExecOptions = Parameters<BashOperations['exec']>[2]

/** Run with the default timeout unless one was given; on timeout, add a note on what to do instead to the command's output. */
async function withDefaultTimeout(shell: 'bash' | 'powershell', options: ExecOptions, exec: (o: ExecOptions) => Promise<{ exitCode: number | null }>): Promise<{ exitCode: number | null }> {
  const timeout = options.timeout ?? DEFAULT_COMMAND_TIMEOUT
  try {
    return await exec({ ...options, timeout })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('timeout:')) {
      const took = timeout % 60 === 0 ? `${timeout / 60} minute${timeout === 60 ? '' : 's'}` : `${timeout} seconds`
      options.onData(
        Buffer.from(
          `\n[The command was stopped after ${took}. Start servers, watchers and other long-running processes with run_in_background: true, then read their output with shell_output and check they respond. For a long build, pass a larger timeout.]\n`
        )
      )
    }
    throw e
  }
}

/**
 * Run `fn` as a tool call: file changes made inside it (including by nested calls, e.g. a
 * subagent's edits) are collected and checkpointed under this call's id.
 */
export async function runAsCall<T>(toolCallId: string, toolName: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<{ result: T; changes: FileChange[]; notes: string[] }> {
  const parent = call.getStore()
  const state: CallState = { toolCallId, toolName, signal, changes: [], checkpointId: parent?.checkpointId ?? toolCallId, parent, notes: [] }
  const result = await call.run(state, fn)
  return { result, changes: state.changes, notes: state.notes }
}

/** Above this many characters a command's output keeps only its start and end: test runs and builds can print tens of
 * thousands, and every later request in the turn carries them. */
export const MAX_COMMAND_OUTPUT = 8000

/** A command's output with the middle cut when it is long (the start shows the command's setup, the end its result). */
export function capOutput(text: string, max = MAX_COMMAND_OUTPUT): string {
  if (text.length <= max) return text
  const lines = text.split('\n')
  const head: string[] = []
  let used = 0
  for (const l of lines.slice(0, 20)) {
    if (used + l.length > max * 0.2) break
    head.push(l)
    used += l.length + 1
  }
  const tail: string[] = []
  for (let i = lines.length - 1; i >= head.length; i--) {
    const l = lines[i].length > max / 2 ? `${lines[i].slice(0, max / 2)}…` : lines[i]
    if (used + l.length > max) break
    tail.unshift(l)
    used += l.length + 1
  }
  const cut = lines.length - head.length - tail.length
  return [...head, `[… ${cut} line${cut === 1 ? '' : 's'} cut to save context. Re-run with a filter (only failures, Select-String, grep, tail) to see more …]`, ...tail].join('\n')
}

/** Run each call with its id in async context, and attach the files it changed to the result. */
function withCallState<T extends AgentTool<any>>(tool: T): T {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const started = performance.now()
      const { result: raw, changes, notes } = await runAsCall(id, tool.name, signal, () => tool.execute(id, params, signal, onUpdate))
      const shown = tool.name === 'bash' || tool.name === 'powershell' ? { ...raw, content: raw.content.map((c) => (c.type === 'text' ? { ...c, text: capOutput(c.text) } : c)) } : raw
      const res = notes.length ? { ...shown, content: [...shown.content, { type: 'text' as const, text: `\n${notes.join('\n')}` }] } : shown
      const state = { changes }
      const details = (res.details && typeof res.details === 'object' ? res.details : {}) as Record<string, unknown>
      return {
        ...res,
        details: {
          ...details,
          durationMs: Math.round(performance.now() - started),
          ...(state.changes.length ? { changes: state.changes } : {})
        }
      }
    }
  }
}
