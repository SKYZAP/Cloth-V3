import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { IPty, IWindowsPtyForkOptions } from '@lydell/node-pty'
import type { ContainerSettings, TerminalInfo } from '@shared/types'
import { newId, type Ctx } from '../core/context'
import type { ContainerService } from '../agent/containers'

/** Kept per terminal so a panel that opens later can replay what it missed. */
const SCROLLBACK = 256 * 1024

/** What the service uses of a pseudo-terminal. */
export type Pty = Pick<IPty, 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>

/** Starts a process in a pseudo-terminal (tests pass a stand-in). */
export type PtySpawn = (file: string, args: string[], options: IWindowsPtyForkOptions) => Pty | Promise<Pty>

// Loaded on first use: a native module, and most sessions never open a terminal.
const nodePty: PtySpawn = async (file, args, options) => (await import('@lydell/node-pty')).spawn(file, args, options)

interface Term {
  info: TerminalInfo
  /** Its number in the chat's tab titles (shells only). */
  n?: number
  /** null for a background command's tab: output only, no shell to type into. */
  pty: Pty | null
  buffer: string
  /** Stops a background command (its tab's Stop, or closing the tab). */
  stop?: () => void
}

/** Where a background command's output goes: its tab in the chat's Terminals panel. */
export interface TerminalSink {
  data(text: string): void
  exit(code: number | null): void
}

export interface TerminalTarget {
  sessionId: string
  /** The chat's folder (null: none chosen). */
  folder: string | null
  container: ContainerSettings | null
}

let shellCache: { file: string; args: string[] } | null = null

/** The user's shell: PowerShell 7 if installed (else Windows PowerShell), $SHELL elsewhere. */
function hostShell(): { file: string; args: string[] } {
  if (shellCache) return shellCache
  if (process.platform === 'win32') {
    let pwsh = false
    try {
      execFileSync('where', ['pwsh.exe'], { stdio: 'ignore', windowsHide: true })
      pwsh = true
    } catch {
      pwsh = false
    }
    shellCache = { file: pwsh ? 'pwsh.exe' : 'powershell.exe', args: ['-NoLogo'] }
  } else {
    const sh = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash'
    shellCache = { file: sh, args: ['-l'] }
  }
  return shellCache
}

/** Interactive shells for the chat side panel: in the chat's folder, or inside its container. */
export class TerminalService {
  private terms = new Map<string, Term>()

  constructor(
    private ctx: Ctx,
    private containers?: ContainerService,
    private spawn: PtySpawn = nodePty
  ) {}

  list(sessionId: string): TerminalInfo[] {
    return [...this.terms.values()].filter((t) => t.info.sessionId === sessionId).map((t) => t.info)
  }

  async create(target: TerminalTarget, size: { cols: number; rows: number }): Promise<TerminalInfo> {
    // The lowest number no open terminal of the chat has: closing terminal 1 and opening another gives terminal 1 again.
    const used = new Set([...this.terms.values()].filter((t) => t.info.sessionId === target.sessionId && t.n).map((t) => t.n))
    let n = 1
    while (used.has(n)) n++
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Cloth' } as Record<string, string>
    const cols = Math.max(20, Math.min(500, Math.floor(size.cols) || 80))
    const rows = Math.max(5, Math.min(200, Math.floor(size.rows) || 24))
    let file: string
    let args: string[]
    let cwd: string
    let title: string
    if (target.container) {
      if (!this.containers) throw new Error('Containers are not available')
      await this.containers.prepare(target.sessionId, target.folder)
      await this.containers.ensureRunning(target.sessionId, target.container)
      file = 'docker'
      args = ['exec', '-it', '-w', '/workspace', '-e', 'TERM=xterm-256color', this.containers.containerName(target.sessionId), 'sh', '-c', 'command -v bash >/dev/null && exec bash || exec sh']
      cwd = homedir()
      title = `container ${n}`
    } else {
      const shell = hostShell()
      file = shell.file
      args = shell.args
      cwd = target.folder && existsSync(target.folder) ? target.folder : homedir()
      title = `${basename(shell.file).replace(/\.exe$/i, '')} ${n}`
    }
    const proc = await this.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env, useConpty: true })
    const info: TerminalInfo = { id: newId('term_'), sessionId: target.sessionId, title, cwd: target.container ? '/workspace' : cwd, container: !!target.container, running: true, exitCode: null }
    const term: Term = { info, pty: proc, buffer: '', n }
    this.terms.set(info.id, term)
    proc.onData((data) => {
      term.buffer = (term.buffer + data).slice(-SCROLLBACK)
      this.ctx.emit('terminal', { type: 'data', id: info.id, data })
      if (info.container) this.containers?.keepAlive(info.sessionId)
    })
    proc.onExit(({ exitCode }) => {
      info.running = false
      info.exitCode = exitCode
      this.ctx.emit('terminal', { type: 'exit', id: info.id, code: exitCode })
    })
    this.ctx.emit('terminal', { type: 'opened', terminal: info })
    return info
  }

  /**
   * A command the agent runs in the background, as a tab in the chat's Terminals panel: its output streams in,
   * Stop ends it and closing the tab ends it too. A finished one stays until closed, so its output can be read.
   */
  attach(input: { sessionId: string; command: string; cwd: string; container: boolean; stop(): void }): TerminalSink {
    const first = input.command.split('\n')[0].trim()
    const title = first.length > 28 ? `${first.slice(0, 27)}…` : first
    const info: TerminalInfo = { id: newId('term_'), sessionId: input.sessionId, title, cwd: input.cwd, container: input.container, running: true, exitCode: null, background: true, command: input.command }
    const term: Term = { info, pty: null, buffer: '', stop: input.stop }
    this.terms.set(info.id, term)
    // Plain output, not a terminal's: line feeds need a carriage return to start the next line.
    const push = (text: string) => {
      const data = text.replace(/\r?\n/g, '\r\n')
      term.buffer = (term.buffer + data).slice(-SCROLLBACK)
      if (this.terms.has(info.id)) this.ctx.emit('terminal', { type: 'data', id: info.id, data })
    }
    this.ctx.emit('terminal', { type: 'opened', terminal: info })
    push(`\x1b[90mRunning in the background${input.cwd && input.cwd !== '.' ? ` in ${input.cwd}` : ''}:\x1b[0m\n\x1b[1m$ ${input.command}\x1b[0m\n`)
    return {
      data: push,
      exit: (code) => {
        if (!info.running) return
        info.running = false
        info.exitCode = code
        if (this.terms.has(info.id)) this.ctx.emit('terminal', { type: 'exit', id: info.id, code })
      }
    }
  }

  /** Stop a background command's process; its tab stays with the output. */
  stop(id: string): void {
    const t = this.terms.get(id)
    if (t?.info.running) t.stop?.()
  }

  /** What the terminal printed so far (to replay into a newly shown view). */
  buffer(id: string): string {
    return this.terms.get(id)?.buffer ?? ''
  }

  write(id: string, data: string): void {
    const t = this.terms.get(id)
    if (t?.info.running) t.pty?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id)
    if (!t?.info.running || !t.pty) return
    try {
      t.pty.resize(Math.max(20, Math.min(500, Math.floor(cols))), Math.max(5, Math.min(200, Math.floor(rows))))
    } catch {
      /* the process exited between the check and the resize */
    }
  }

  kill(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    this.terms.delete(id)
    if (t.info.running) {
      try {
        if (t.pty) t.pty.kill()
        else t.stop?.()
      } catch {
        /* already gone */
      }
    }
    this.ctx.emit('terminal', { type: 'closed', id, sessionId: t.info.sessionId })
  }

  /** The chat was deleted. */
  killSession(sessionId: string): void {
    for (const t of this.list(sessionId)) this.kill(t.id)
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }
}
