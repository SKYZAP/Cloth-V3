// The shell tool's extras, Claude Code style: bash on Windows through Git Bash, a working folder that carries
// over from one command to the next, and commands that run in the background while the chat goes on.

import { accessSync, constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { win32 } from 'node:path'
import type { BackgroundCommand, TerminalInfo } from '@shared/types'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

// ─── Git Bash ─────────────────────────────────────────────────────────────────

const canRun = (p: string): boolean => {
  try {
    accessSync(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** `where` on Windows: every match, first first. */
function whereAll(program: string): string[] {
  try {
    const r = spawnSync('where', [program], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    return r.status === 0 && r.stdout ? r.stdout.trim().split(/\r?\n/).filter(Boolean) : []
  } catch {
    return []
  }
}

/** The WSL launcher (System32 / Sysnative bash.exe) and Store aliases are not Git Bash: they run another OS. */
function isNotGitBash(p: string, env: NodeJS.ProcessEnv): boolean {
  const n = win32.normalize(p).toLowerCase()
  const root = (env.SystemRoot ?? env.windir ?? 'C:\\Windows').toLowerCase()
  return n.startsWith(win32.join(root, 'system32').toLowerCase()) || n.startsWith(win32.join(root, 'sysnative').toLowerCase()) || n.includes('\\windowsapps\\')
}

export interface GitBashProbe {
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
  where?: (program: string) => string[]
}

/**
 * Git for Windows' bash: its usual install folders (machine-wide and per user), then next to a git.exe on PATH,
 * then a bash.exe on PATH that isn't WSL's launcher. Null when there is none (PowerShell is the only shell then).
 */
export function findGitBash(probe: GitBashProbe = {}): string | null {
  const env = probe.env ?? process.env
  const exists = probe.exists ?? canRun
  const where = probe.where ?? whereAll
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')].filter((x): x is string => !!x)
  for (const root of roots) {
    const p = win32.join(root, 'Git', 'bin', 'bash.exe')
    if (exists(p)) return p
  }
  // git.exe lives in <Git>\cmd or <Git>\bin (or mingw64\bin); bash is in <Git>\bin.
  for (const git of where('git.exe')) {
    let dir = win32.dirname(git)
    for (let i = 0; i < 3; i++) {
      const p = win32.join(dir, 'bin', 'bash.exe')
      if (exists(p) && !isNotGitBash(p, env)) return p
      dir = win32.dirname(dir)
    }
  }
  for (const p of where('bash.exe')) if (!isNotGitBash(p, env) && exists(p)) return p
  return null
}

let gitBash: string | null | undefined
/** Git Bash on this PC (Windows only), looked up once. */
export function gitBashPath(): string | null {
  if (process.platform !== 'win32') return null
  if (gitBash === undefined) gitBash = findGitBash()
  return gitBash
}

// ─── The working folder that carries over ─────────────────────────────────────

export type ShellKind = 'bash' | 'gitbash' | 'powershell' | 'container'

/** A marker printed after the command with the folder it ended in; the tool takes it out of the output. */
export function cwdMarker(): string {
  return `\n\u001e__CLOTH_CWD_${randomBytes(4).toString('hex')}__`
}

/**
 * The command with a tail that prints `marker` + the folder it ended in and keeps its exit code. Null when the
 * command can't be wrapped safely (a PowerShell line ending in a backtick continues into whatever follows).
 */
export function withCwdReport(command: string, kind: ShellKind, marker: string): string | null {
  const m = marker.replace(/\n/g, '')
  if (kind === 'powershell') {
    if (command.trimEnd().endsWith('`')) return null
    // `;` on its own keeps an unfinished last statement an error. $? and the native exit code are kept, as -Command would.
    return (
      `${command}\n;\n$__clothOk = $?; $__clothCode = $LASTEXITCODE\n` +
      `try { [Console]::Out.Write("\`n${m}" + (Get-Location).ProviderPath + "\`n") } catch {}\n` +
      `if ($__clothOk) { exit 0 }\nif (($__clothCode -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\n` +
      `if ($__clothCode) { exit $__clothCode }\nexit 1`
    )
  }
  // Git Bash prints /c/Users/…: `pwd -W` gives the Windows path.
  const pwd = kind === 'gitbash' ? 'pwd -W' : 'pwd -P'
  return `${command}\n__cloth_rc=$?; printf '\\n%s%s\\n' '${m}' "$(${pwd} 2>/dev/null || pwd)"; exit $__cloth_rc`
}

/**
 * Passes a command's output through without the folder report, and keeps the folder it named. Text that might be
 * the start of the marker is held back until the next chunk shows it isn't.
 */
export class CwdReportFilter {
  private held = ''
  cwd: string | null = null
  private done = false
  constructor(
    private marker: string,
    private out: (data: Buffer) => void
  ) {}

  push = (data: Buffer): void => {
    if (this.done) {
      // After the marker: the folder line, then nothing (the shell exits).
      this.held += data.toString('utf8')
      this.takeCwd()
      return
    }
    const text = this.held + data.toString('utf8')
    const at = text.indexOf(this.marker)
    if (at >= 0) {
      if (at > 0) this.out(Buffer.from(text.slice(0, at)))
      this.done = true
      this.held = text.slice(at + this.marker.length)
      this.takeCwd()
      return
    }
    // Hold back the longest tail that could still become the marker.
    let keep = 0
    for (let n = Math.min(this.marker.length - 1, text.length); n > 0; n--) {
      if (this.marker.startsWith(text.slice(text.length - n))) {
        keep = n
        break
      }
    }
    if (text.length > keep) this.out(Buffer.from(text.slice(0, text.length - keep)))
    this.held = text.slice(text.length - keep)
  }

  private takeCwd(): void {
    const nl = this.held.indexOf('\n')
    if (nl < 0) return
    this.cwd = this.held.slice(0, nl).replace(/\r$/, '').trim() || null
    this.held = this.held.slice(nl + 1)
  }

  /** The command ended: anything still held that wasn't the marker is output after all. */
  end(): void {
    if (!this.done && this.held) this.out(Buffer.from(this.held))
    else if (this.done && this.cwd === null) this.cwd = this.held.replace(/\r?\n$/, '').trim() || null
    this.held = ''
  }
}

/** Each chat's shell folder, as an absolute path on this PC (or inside the chat's copy, for a container). */
const kept = new Map<string, string>()

export const shellCwd = {
  get: (sessionId: string): string | null => kept.get(sessionId) ?? null,
  set: (sessionId: string, dir: string): void => void kept.set(sessionId, dir),
  reset: (sessionId: string): void => void kept.delete(sessionId)
}

// ─── Background commands ──────────────────────────────────────────────────────

/** Most text kept per background command; older output is dropped first. */
export const BACKGROUND_KEEP = 1_000_000
/** Background commands a chat may run at once. */
export const BACKGROUND_MAX = 8
/**
 * How long starting a background command waits to see whether it fails straight away (it returns sooner when the
 * command ends). Tests on a slow machine raise it.
 */
export const BACKGROUND_FIRST_LOOK = { ms: 1500 }
/** Finished background commands a chat keeps listed. */
const FINISHED_KEEP = 10

interface Proc {
  info: BackgroundCommand
  text: string
  /** Characters dropped from the start of `text` so far, and where the last read stopped (in the same count). */
  dropped: number
  readTo: number
  abort: AbortController
  done: Promise<void>
  /** Its tab in the Terminals panel. */
  tab?: { data(text: string): void; exit(code: number | null): void } | null
}

/** Where a background command's output shows for the person: a tab in the chat's Terminals panel (panel/terminals.ts). */
export interface BackgroundTerminals {
  attach(input: { sessionId: string; command: string; cwd: string; container: boolean; stop(): void }): { data(text: string): void; exit(code: number | null): void }
}

export interface BackgroundStart {
  sessionId: string
  command: string
  /** It runs in the chat's Linux container. */
  container?: boolean
  /** The folder it runs in, as shown (relative to the chat's folder). */
  cwd: string
  shell: string
  /** Runs the command until it ends or the signal aborts it; output goes to onData. */
  run(onData: (data: Buffer) => void, signal: AbortSignal): Promise<{ exitCode: number | null }>
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n')

/** Commands that keep running after the tool call returns: dev servers, watchers, long builds. */
export class BackgroundShells {
  private procs = new Map<string, Proc>()

  private terminals: BackgroundTerminals | null = null

  /** emit: the chat's list changed. */
  constructor(private emit: (sessionId: string, list: BackgroundCommand[]) => void = () => undefined) {}

  /** Show each new background command as a tab in its chat's Terminals panel. */
  showIn(terminals: BackgroundTerminals): void {
    this.terminals = terminals
  }

  list(sessionId: string): BackgroundCommand[] {
    return [...this.procs.values()].filter((p) => p.info.sessionId === sessionId).map((p) => ({ ...p.info }))
  }

  start(input: BackgroundStart): BackgroundCommand {
    const running = this.list(input.sessionId).filter((c) => c.status === 'running').length
    if (running >= BACKGROUND_MAX) throw new Error(`This chat already has ${running} commands running in the background. Stop one (shell_stop) before starting another.`)
    const id = `bg_${randomBytes(4).toString('hex')}`
    const abort = new AbortController()
    const p: Proc = {
      info: { id, sessionId: input.sessionId, command: input.command, cwd: input.cwd, shell: input.shell, status: 'running', exitCode: null, startedAt: Date.now(), endedAt: null },
      text: '',
      dropped: 0,
      readTo: 0,
      abort,
      done: Promise.resolve()
    }
    this.procs.set(id, p)
    const tab = this.terminals?.attach({ sessionId: input.sessionId, command: input.command, cwd: input.cwd, container: !!input.container, stop: () => void this.stop(input.sessionId, id) }) ?? null
    p.tab = tab
    const onData = (data: Buffer) => {
      const text = data.toString('utf8')
      tab?.data(text)
      p.text += strip(text)
      if (p.text.length > BACKGROUND_KEEP) {
        const cut = p.text.length - BACKGROUND_KEEP
        p.text = p.text.slice(cut)
        p.dropped += cut
      }
    }
    p.done = input
      .run(onData, abort.signal)
      .then(
        (r) => this.finish(p, abort.signal.aborted ? 'stopped' : r.exitCode === 0 ? 'exited' : 'failed', r.exitCode),
        (err) => {
          if (!abort.signal.aborted) onData(Buffer.from(`\n[${err instanceof Error ? err.message : String(err)}]\n`))
          this.finish(p, abort.signal.aborted ? 'stopped' : 'failed', null)
        }
      )
    this.changed(input.sessionId)
    return { ...p.info }
  }

  private finish(p: Proc, status: BackgroundCommand['status'], exitCode: number | null): void {
    if (p.info.status !== 'running') return
    p.info = { ...p.info, status, exitCode, endedAt: Date.now() }
    p.tab?.exit(exitCode)
    // Keep only the last few finished ones listed.
    const finished = [...this.procs.values()].filter((x) => x.info.sessionId === p.info.sessionId && x.info.status !== 'running').sort((a, b) => (b.info.endedAt ?? 0) - (a.info.endedAt ?? 0))
    for (const old of finished.slice(FINISHED_KEEP)) this.procs.delete(old.info.id)
    this.changed(p.info.sessionId)
  }

  private find(sessionId: string, id: string): Proc {
    const p = this.procs.get(id.trim())
    if (!p || p.info.sessionId !== sessionId) throw new Error(`No background command ${id} in this chat. Running: ${this.list(sessionId).filter((c) => c.status === 'running').map((c) => c.id).join(', ') || 'none'}.`)
    return p
  }

  /** Output since the last read (lines matching `filter` only, when given), and how the command is doing. */
  read(sessionId: string, id: string, filter?: string): { info: BackgroundCommand; text: string; skipped: number } {
    const p = this.find(sessionId, id)
    const from = Math.max(p.readTo, p.dropped)
    const skipped = from - p.readTo
    let text = p.text.slice(from - p.dropped)
    p.readTo = p.dropped + p.text.length
    if (filter) {
      let re: RegExp
      try {
        re = new RegExp(filter, 'i')
      } catch {
        throw new Error(`The filter isn't a valid regular expression: ${filter}`)
      }
      text = text
        .split('\n')
        .filter((l) => re.test(l))
        .join('\n')
    }
    return { info: { ...p.info }, text, skipped }
  }

  /** Resolves when the command ends, or after `ms` if it is still running then. */
  async settled(sessionId: string, id: string, ms: number): Promise<void> {
    const p = this.find(sessionId, id)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([p.done, new Promise((r) => (timer = setTimeout(r, ms)))])
    clearTimeout(timer)
  }

  /** Stop a command and everything it started; resolves once it has ended. */
  async stop(sessionId: string, id: string): Promise<BackgroundCommand> {
    const p = this.find(sessionId, id)
    if (p.info.status === 'running') {
      p.abort.abort()
      await Promise.race([p.done, new Promise((r) => setTimeout(r, 5000))])
    }
    return { ...p.info }
  }

  /** The chat was stopped or deleted: its commands stop. */
  async stopSession(sessionId: string, forget = false): Promise<void> {
    const mine = [...this.procs.values()].filter((p) => p.info.sessionId === sessionId)
    for (const p of mine) if (p.info.status === 'running') p.abort.abort()
    await Promise.race([Promise.all(mine.map((p) => p.done)), new Promise((r) => setTimeout(r, 5000))])
    if (forget) for (const p of mine) this.procs.delete(p.info.id)
    if (mine.length) this.changed(sessionId)
  }

  /** Cloth is quitting. */
  async stopAll(): Promise<void> {
    const ids = new Set([...this.procs.values()].map((p) => p.info.sessionId))
    await Promise.all([...ids].map((s) => this.stopSession(s)))
  }

  private changed(sessionId: string): void {
    this.emit(sessionId, this.list(sessionId))
  }
}

// ─── Reading the chat's terminals ─────────────────────────────────────────────

/** The chat's terminals, as the Terminal panel has them (panel/terminals.ts). */
export interface ChatTerminals {
  list(sessionId: string): TerminalInfo[]
  buffer(id: string): string
}

/** Terminal output as plain text: colours and cursor codes out, and a line redrawn with \r shows its last version. */
export function terminalText(raw: string): string {
  const noCodes = raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  return noCodes
    .split('\n')
    .map((line) => {
      const l = line.replace(/\r$/, '')
      const at = l.lastIndexOf('\r')
      return at >= 0 ? l.slice(at + 1) : l
    })
    .join('\n')
}

const DEFAULT_LINES = 200
const MAX_LINES = 2000

/** `terminal_read`: what the user's terminals in this chat show (their shells, and background commands' tabs). */
export function terminalReadTool(terminals: ChatTerminals, sessionId: string): AgentTool<any> {
  const describe = (t: TerminalInfo) => `${t.id}: ${t.background ? `background command \`${t.command?.split('\n')[0] ?? t.title}\`` : `${t.title}`} (${t.running ? 'running' : `exited${t.exitCode !== null ? ` with code ${t.exitCode}` : ''}`}${t.cwd ? `, in ${t.cwd}` : ''})`
  return {
    name: 'terminal_read',
    label: 'Read terminal',
    description:
      "Read what a terminal in this chat's Terminal panel shows: the user's own shells (for example an error they want you to see, or a server they started) and the tabs of commands you ran in the background. Without an id it reads the only terminal, or lists them when there are several. It only reads: nothing is typed into the terminal.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'The terminal to read (term_…), from the list this tool gives without an id' })),
      lines: Type.Optional(Type.Number({ description: `How many of the last lines to read (default ${DEFAULT_LINES}, at most ${MAX_LINES})` }))
    }),
    async execute(_id, params) {
      const p = (params ?? {}) as { id?: string; lines?: number }
      const list = terminals.list(sessionId)
      const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }], details: {} })
      if (!list.length) return text('No terminals are open in this chat. The user opens one from the Terminal panel (Ctrl+`).')
      const id = p.id?.trim()
      if (!id && list.length > 1) return text(`This chat has ${list.length} terminals; read one by its id:\n${list.map((t) => `- ${describe(t)}`).join('\n')}`)
      const t = id ? list.find((x) => x.id === id) : list[0]
      if (!t) return text(`No terminal ${id} in this chat. Open ones:\n${list.map((x) => `- ${describe(x)}`).join('\n')}`)
      const n = Math.max(1, Math.min(MAX_LINES, Math.round(p.lines ?? DEFAULT_LINES)))
      const lines = terminalText(terminals.buffer(t.id)).replace(/\s+$/, '').split('\n')
      const shown = lines.slice(-n)
      const head = `${describe(t)}${lines.length > shown.length ? `, last ${shown.length} of ${lines.length} lines` : ''}:`
      return text(`${head}\n\n${shown.join('\n') || '(nothing printed yet)'}`)
    }
  }
}
