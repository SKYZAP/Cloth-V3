import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { glob, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import type { ApprovalDecision, AutoApprove, BuiltinToolInfo, ChatEvent, FileAccess, FileChange, PendingApproval } from '@shared/types'
import { newId } from '../core/context'

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

/** Holds writes / edits / commands until the user answers in the chat. */
export class ApprovalService {
  private pending = new Map<string, { approval: PendingApproval; done: (d: ApprovalDecision) => void }>()

  constructor(private emit: (e: ChatEvent) => void) {}

  request(input: Omit<PendingApproval, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<ApprovalDecision> {
    const approval: PendingApproval = { ...input, id: newId('apr_'), createdAt: Date.now() }
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

  /** Deny everything still waiting for a chat (stop / delete). */
  cancel(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.approval.sessionId === sessionId) p.done('deny')
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
}

export const WORKSPACE_TOOL_NAMES = ['read', 'ls', 'find', 'write', 'edit', 'bash', 'powershell']

export function describeWorkspaceTools(): BuiltinToolInfo[] {
  const shell = process.platform === 'win32' ? 'powershell' : 'bash'
  const t = (name: string, label: string, description: string, availability: string, schema: Record<string, unknown>): BuiltinToolInfo => ({ name, label, description, group: 'workspace', availability, schema })
  const obj = (props: Record<string, string>, required: string[]) => ({
    type: 'object',
    required,
    properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }]))
  })
  return [
    t('read', 'Read file', 'Read a text or image file from the workspace, with offset/limit for large files.', 'Chats with a workspace folder', obj({ path: 'string', offset: 'number', limit: 'number' }, ['path'])),
    t('ls', 'List directory', 'List a directory in the workspace.', 'Chats with a workspace folder', obj({ path: 'string', limit: 'number' }, [])),
    t('find', 'Find files', 'Find files by glob pattern (e.g. **/*.ts) in the workspace.', 'Chats with a workspace folder', obj({ pattern: 'string', path: 'string', limit: 'number' }, ['pattern'])),
    t('write', 'Write file', 'Create or overwrite a file. Asks for approval (with a diff) unless edits are auto-approved; undoable.', 'Chats with a workspace in read & write mode', obj({ path: 'string', content: 'string' }, ['path', 'content'])),
    t('edit', 'Edit file', 'Replace exact text in a file (one or more edits). Asks for approval (with a diff) unless edits are auto-approved; undoable.', 'Chats with a workspace in read & write mode', obj({ path: 'string', edits: 'array' }, ['path', 'edits'])),
    t(shell, 'Run command', `Run a ${shell === 'bash' ? 'bash' : 'PowerShell'} command in the workspace. Always asks for approval unless everything is auto-approved.`, 'Chats with a workspace and shell commands on', obj({ command: 'string', timeout: 'number' }, ['command']))
  ]
}

/** pi's coding tools, confined to the workspace, with approvals and checkpoints on every change. */
export function buildWorkspaceTools(o: WorkspaceOptions): AgentTool<any>[] {
  const inside = (p: string) => confine(o.root, p)
  const ask = async (input: Omit<PendingApproval, 'id' | 'createdAt' | 'sessionId' | 'toolCallId'>): Promise<void> => {
    const policy = o.autoApprove()
    const auto = policy === 'all' || (policy === 'edits' && input.kind !== 'command')
    if (auto) return
    if (!o.approvals || !o.sessionId) throw new Error('This action needs approval, and there is no one to ask in this context')
    const state = call.getStore()
    const decision = await o.approvals.request({ ...input, sessionId: o.sessionId, toolCallId: state?.toolCallId ?? null }, state?.signal)
    if (decision === 'deny') {
      throw new Error(
        input.kind === 'command'
          ? `The user declined to run this command. Do not retry it; ask the user how to proceed.`
          : `The user declined this change to ${input.path}. Do not retry the same change; ask the user what they want instead.`
      )
    }
    if (decision === 'always') o.onAlways?.(input.kind === 'command' ? 'all' : 'edits')
  }

  const writeChecked = async (abs: string, content: string) => {
    const rel = relative(await realpath(o.root), abs).split(sep).join('/')
    const before = existsSync(abs) ? await readFile(abs, 'utf8') : null
    if (before === content) return
    const { diff, added, removed } = makeDiff(rel, before, content)
    const state = call.getStore()
    await ask({ kind: state?.toolName === 'edit' ? 'edit' : 'write', path: rel, diff, added, removed })
    if (o.checkpoints && o.sessionId && state) await o.checkpoints.record(o.sessionId, state.toolCallId, { abs, before, after: content })
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
    state?.changes.push({ path: rel, kind: before === null ? 'create' : 'modify', diff, added, removed })
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
    })
  ]

  if (o.access === 'write') {
    tools.push(
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

  if (o.shell) {
    const local: BashOperations = process.platform === 'win32' ? createLocalPowerShellOperations() : createLocalBashOperations()
    const operations: BashOperations = {
      exec: async (command, cwd, options) => {
        const dir = await inside(cwd)
        await ask({ kind: 'command', command, path: relative(await realpath(o.root), dir).split(sep).join('/') || '.' })
        return local.exec(command, dir, options)
      }
    }
    tools.push(process.platform === 'win32' ? createPowerShellTool(o.root, { operations }) : createBashTool(o.root, { operations }))
  }

  return tools.map(withCallState)
}

/** Run each call with its id in async context, and attach the files it changed to the result. */
function withCallState<T extends AgentTool<any>>(tool: T): T {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const state: CallState = { toolCallId: id, toolName: tool.name, signal, changes: [] }
      const started = performance.now()
      const res = await call.run(state, () => tool.execute(id, params, signal, onUpdate))
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
