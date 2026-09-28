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
import { Type } from 'typebox'
import { astRewrite, astSearch, resolveLanguage, supportedLanguages } from './ast'
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
}

export const WORKSPACE_TOOL_NAMES = ['read', 'ls', 'find', 'write', 'edit', 'bash', 'powershell', 'ast_grep', 'ast_edit', 'lsp']

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
    t('ast_grep', 'AST search', 'Structural code search with ast-grep patterns ($VAR, $$ARGS). TS/JS/TSX/HTML/CSS, Python, Go, Rust, Java.', 'Chats with a workspace folder', obj({ pattern: 'string', language: 'string', path: 'string' }, ['pattern'])),
    t('ast_edit', 'AST rewrite', 'Rewrite every match of an ast-grep pattern, reusing captured $VARS. One approval (combined diff) for all files; undoable.', 'Chats with a workspace in read & write mode', obj({ pattern: 'string', rewrite: 'string', language: 'string', path: 'string' }, ['pattern', 'rewrite'])),
    t('lsp', 'Code intelligence', 'Language-server diagnostics, definition, references, hover, symbols and rename for TypeScript/JavaScript (TypeScript 7 native server) and Python (Pyright). Also reports type errors right after each edit.', 'Chats with a workspace and code intelligence on', obj({ action: 'string', path: 'string', symbol: 'string', line: 'number', query: 'string', newName: 'string' }, ['action'])),
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
    const added = planned.reduce((n, p) => n + p.added, 0)
    const removed = planned.reduce((n, p) => n + p.removed, 0)
    await ask({ kind, path: planned.length === 1 ? planned[0].rel : `${planned.length} files`, diff: planned.map((p) => p.diff).join('\n'), added, removed })
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
          const errors = (await server.diagnostics(p.abs, 12_000)).filter((d) => d.severity === 1)
          state.notes.push(errors.length ? `Type errors after this change — ${formatDiagnostics(p.rel, errors, { errorsOnly: true, max: 8 })}` : `✓ ${p.rel}: no type errors`)
        } catch {
          /* no server / too slow: skip the check rather than fail the edit */
        }
      }
    }
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

/** Run each call with its id in async context, and attach the files it changed to the result. */
function withCallState<T extends AgentTool<any>>(tool: T): T {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const started = performance.now()
      const { result: raw, changes, notes } = await runAsCall(id, tool.name, signal, () => tool.execute(id, params, signal, onUpdate))
      const res = notes.length ? { ...raw, content: [...raw.content, { type: 'text' as const, text: `\n${notes.join('\n')}` }] } : raw
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
