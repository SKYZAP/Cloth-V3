import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { BACKGROUND_FIRST_LOOK, BackgroundShells, CwdReportFilter, cwdMarker, findGitBash, gitBashPath, shellCwd, withCwdReport } from '../src/main/agent/shell'
import { buildWorkspaceTools, runAsCall, type ApprovalService } from '../src/main/agent/workspace'
import type { PendingApproval, TerminalEvent } from '../src/shared/types'
import { TerminalService } from '../src/main/panel/terminals'
import type { Ctx } from '../src/main/core/context'

const win = process.platform === 'win32'
const SHELL = win ? 'powershell' : 'bash'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('Git Bash on Windows', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', SystemRoot: 'C:\\Windows' }

  it('finds it where Git for Windows installs it', () => {
    expect(findGitBash({ env, exists: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe', where: () => [] })).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(findGitBash({ env, exists: (p) => p === 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', where: () => [] })).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
  })

  it('finds it next to git.exe on PATH', () => {
    const where = (p: string) => (p === 'git.exe' ? ['D:\\Tools\\Git\\cmd\\git.exe'] : [])
    expect(findGitBash({ env, exists: (p) => p === 'D:\\Tools\\Git\\bin\\bash.exe', where })).toBe('D:\\Tools\\Git\\bin\\bash.exe')
  })

  it("never takes WSL's bash.exe or a Store alias, and is null when there is no Git Bash", () => {
    const where = (p: string) => (p === 'bash.exe' ? ['C:\\Windows\\System32\\bash.exe', 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'] : [])
    expect(findGitBash({ env, exists: () => true, where: (p) => (p === 'git.exe' ? [] : where(p)) }) ?? null).not.toMatch(/System32|WindowsApps/i)
    expect(findGitBash({ env, exists: (p) => /System32|WindowsApps/i.test(p), where })).toBeNull()
    // A bash.exe on PATH that is a real Git Bash (MSYS2, a portable Git) is fine.
    expect(findGitBash({ env, exists: (p) => p === 'E:\\PortableGit\\usr\\bin\\bash.exe', where: (p) => (p === 'bash.exe' ? ['E:\\PortableGit\\usr\\bin\\bash.exe'] : []) })).toBe('E:\\PortableGit\\usr\\bin\\bash.exe')
  })
})

describe('the folder report after a command', () => {
  it('takes the report out of the output, even split across chunks', () => {
    const marker = cwdMarker()
    let out = ''
    const f = new CwdReportFilter(marker, (d) => (out += d.toString()))
    const all = `hello\nworld${marker}/home/me/project/sub\n`
    for (let i = 0; i < all.length; i += 3) f.push(Buffer.from(all.slice(i, i + 3)))
    f.end()
    expect(out).toBe('hello\nworld')
    expect(f.cwd).toBe('/home/me/project/sub')
  })

  it('passes output through untouched when there is no report (the command exited early)', () => {
    const marker = cwdMarker()
    let out = ''
    const f = new CwdReportFilter(marker, (d) => (out += d.toString()))
    f.push(Buffer.from('partial \n\u001e__CL'))
    f.end()
    expect(out).toBe('partial \n\u001e__CL')
    expect(f.cwd).toBeNull()
  })

  it('wraps commands so the exit code is kept, and leaves a PowerShell line ending in a backtick alone', () => {
    const m = cwdMarker()
    expect(withCwdReport('npm test', 'bash', m)).toContain('__cloth_rc=$?')
    expect(withCwdReport('npm test', 'gitbash', m)).toContain('pwd -W')
    expect(withCwdReport('Get-ChildItem `', 'powershell', m)).toBeNull()
    expect(withCwdReport('npm test', 'powershell', m)).toContain('$LASTEXITCODE')
  })
})

/** Approvals that record what was asked and answer with `decision`. */
function approvals(decision: 'allow' | 'deny' = 'deny') {
  const asked: Omit<PendingApproval, 'id' | 'createdAt'>[] = []
  const svc = { request: async (a: Omit<PendingApproval, 'id' | 'createdAt'>) => (asked.push(a), decision) } as unknown as ApprovalService
  return { asked, svc }
}

function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloth-shell-')))
  mkdirSync(join(root, 'sub'))
  mkdirSync(join(root, 'x'))
  writeFileSync(join(root, 'sub', 'marker.txt'), 'in sub')
  return root
}

function tools(root: string, sessionId: string, opts: { approvals?: ApprovalService; background?: BackgroundShells; manual?: boolean } = {}) {
  return buildWorkspaceTools({
    root,
    sessionId,
    access: 'write',
    shell: true,
    approvals: opts.approvals ?? null,
    checkpoints: null,
    autoApprove: () => 'all',
    checkRisk: true,
    asksBeforeRisky: () => !!opts.manual,
    background: opts.background ?? null
  })
}

async function run(list: AgentTool<any>[], name: string, params: Record<string, unknown>): Promise<string> {
  const tool = list.find((t) => t.name === name)
  if (!tool) throw new Error(`no ${name} tool: ${list.map((t) => t.name).join(', ')}`)
  const id = `call_${Math.random().toString(36).slice(2)}`
  try {
    const { result } = await runAsCall(id, name, undefined, () => tool.execute(id, params, undefined, () => undefined))
    return result.content.map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('')
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`
  }
}

describe('the shell keeps its folder between commands', () => {
  const sessions: string[] = []
  afterEach(() => sessions.splice(0).forEach((s) => shellCwd.reset(s)))

  it('starts the next command where the last one ended, inside the workspace', async () => {
    const root = folder()
    const s = `ses_cwd_${Date.now()}`
    sessions.push(s)
    const t = tools(root, s)
    const cd = await run(t, SHELL, { command: 'cd sub' })
    expect(cd).not.toContain('CLOTH_CWD')
    expect(shellCwd.get(s)).toBe('sub')
    const out = await run(t, SHELL, { command: win ? 'Get-Content marker.txt' : 'cat marker.txt' })
    expect(out).toContain('in sub')
    // A new set of tools (the next turn) is still there.
    const again = await run(tools(root, s), SHELL, { command: win ? '(Get-Location).Path' : 'pwd' })
    expect(again.replace(/\\/g, '/')).toMatch(/\/sub\s*$/)
  }, 60_000)

  it('goes back to the root (and says so) when a command leaves the workspace', async () => {
    const root = folder()
    const s = `ses_out_${Date.now()}`
    sessions.push(s)
    const t = tools(root, s)
    await run(t, SHELL, { command: 'cd sub' })
    const out = await run(t, SHELL, { command: 'cd ../..' })
    expect(out).toContain('outside the workspace')
    expect(shellCwd.get(s)).toBeNull()
    const here = await run(t, SHELL, { command: win ? '(Get-Location).Path' : 'pwd' })
    expect(here.trim().replace(/\\/g, '/').toLowerCase()).toContain(root.replace(/\\/g, '/').toLowerCase())
    expect(here.replace(/\\/g, '/')).not.toMatch(/\/sub\s*$/)
  }, 60_000)

  it('keeps the exit code of a failing command', async () => {
    const root = folder()
    const s = `ses_exit_${Date.now()}`
    sessions.push(s)
    const out = await run(tools(root, s), SHELL, { command: win ? 'cmd /c exit 3' : 'exit 3' })
    expect(out).toMatch(/ERROR|exit code|3/i)
  }, 60_000)

  it('checks risk from the folder the command runs in', async () => {
    const root = folder()
    const s = `ses_risk_${Date.now()}`
    sessions.push(s)
    const { asked, svc } = approvals('deny')
    const t = tools(root, s, { approvals: svc, manual: true })
    const del = win ? 'Remove-Item -Recurse -Force ../x' : 'rm -rf ../x'
    // From the root, ../x is outside the workspace: it asks (and is declined).
    expect(await run(t, SHELL, { command: del })).toContain('declined')
    expect(asked).toHaveLength(1)
    // From sub, ../x is the workspace's own x: no question, and it is gone.
    await run(t, SHELL, { command: 'cd sub' })
    await run(t, SHELL, { command: del })
    expect(asked).toHaveLength(1)
    expect(existsSync(join(root, 'x'))).toBe(false)
    expect(asked[0].path).toBe('.')
  }, 60_000)
})

describe('background commands', () => {
  const long = win ? 'while ($true) { Write-Output "tick"; Start-Sleep -Milliseconds 200 }' : 'while true; do echo tick; sleep 0.2; done'

  it('start, report output since the last read, stop, and stop with their chat', async () => {
    const root = folder()
    const events: string[] = []
    const bg = new BackgroundShells((_s, list) => events.push(list.map((c) => c.status).join(',')))
    const s = `ses_bg_${Date.now()}`
    const t = tools(root, s, { background: bg })
    expect(t.map((x) => x.name)).toEqual(expect.arrayContaining([SHELL, 'shell_output', 'shell_stop']))

    const started = await run(t, SHELL, { command: long, run_in_background: true })
    const id = /bg_[0-9a-f]+/.exec(started)?.[0]
    expect(id).toBeTruthy()
    expect(bg.list(s)).toEqual([expect.objectContaining({ id, status: 'running', cwd: '.' })])
    await wait(800)
    const first = await run(t, 'shell_output', { id })
    expect(first).toContain('still running')
    expect(first).toContain('tick')
    // Only lines that match, and only what is new since the last read.
    await wait(400)
    expect(await run(t, 'shell_output', { id, filter: '^nothing$' })).toContain('no new lines match')

    expect(await run(t, 'shell_stop', { id })).toContain(`Stopped ${id}`)
    expect(bg.list(s)[0].status).toBe('stopped')
    expect(await run(t, 'shell_output', { id: 'bg_nope' })).toContain('No background command')

    // Stopping the chat stops what is still running; deleting it forgets the list.
    await run(t, SHELL, { command: long, run_in_background: true })
    expect(bg.list(s).filter((c) => c.status === 'running')).toHaveLength(1)
    await bg.stopSession(s)
    expect(bg.list(s).every((c) => c.status !== 'running')).toBe(true)
    await bg.stopSession(s, true)
    expect(bg.list(s)).toEqual([])
    expect(events.length).toBeGreaterThan(2)
  }, 60_000)

  it('shows each one as a tab in the Terminals panel, which can stop it and keeps its output', async () => {
    const root = folder()
    const events: TerminalEvent[] = []
    const terminals = new TerminalService({ emit: (_c: string, e: TerminalEvent) => events.push(e) } as unknown as Ctx)
    const bg = new BackgroundShells()
    bg.showIn(terminals)
    const s = `ses_tab_${Date.now()}`
    const t = tools(root, s, { background: bg })
    await run(t, SHELL, { command: 'cd sub' })
    const started = await run(t, SHELL, { command: long, run_in_background: true })
    expect(started).toContain('Terminals panel')
    const [tab] = terminals.list(s)
    expect(tab).toMatchObject({ background: true, command: long, cwd: 'sub', running: true })
    expect(events.some((e) => e.type === 'opened' && e.terminal.id === tab.id)).toBe(true)
    await wait(600)
    // Output reaches the tab as terminal lines, after a header naming the command.
    const shown = terminals.buffer(tab.id)
    expect(shown).toContain(`$ ${long}`)
    expect(shown).toContain('tick\r\n')
    // Typing into it does nothing: there is no shell behind it.
    terminals.write(tab.id, 'exit\r')
    // Stop from the tab: the command ends, the agent sees it stopped, and the tab stays with its output.
    terminals.stop(tab.id)
    for (let i = 0; i < 100 && terminals.list(s)[0].running; i++) await wait(50)
    expect(terminals.list(s)[0]).toMatchObject({ running: false })
    expect(bg.list(s)[0].status).toBe('stopped')
    expect(await run(t, 'shell_output', { id: bg.list(s)[0].id })).toContain('was stopped')
    // Closing a running one's tab stops it too.
    await run(t, SHELL, { command: long, run_in_background: true })
    const second = terminals.list(s).find((x) => x.running)!
    terminals.kill(second.id)
    for (let i = 0; i < 100 && bg.list(s).some((c) => c.status === 'running'); i++) await wait(50)
    expect(bg.list(s).every((c) => c.status === 'stopped')).toBe(true)
    expect(terminals.list(s).map((x) => x.id)).toEqual([tab.id])
    shellCwd.reset(s)
  }, 60_000)

  it('says at once when a background command fails straight away', async () => {
    const root = folder()
    const bg = new BackgroundShells()
    const s = `ses_bgfail_${Date.now()}`
    // A shell can take a while to start on a busy machine: the look waits for the command to end, up to this long.
    const was = BACKGROUND_FIRST_LOOK.ms
    BACKGROUND_FIRST_LOOK.ms = 20_000
    try {
      const started = Date.now()
      const out = await run(tools(root, s, { background: bg }), SHELL, { command: 'exit 2', run_in_background: true })
      expect(out).toContain('already ended (failed, exit code 2)')
      // It returned when the command ended, not after the whole window.
      expect(Date.now() - started).toBeLessThan(20_000)
    } finally {
      BACKGROUND_FIRST_LOOK.ms = was
    }
  }, 40_000)

  it('asks before a risky background command like any other', async () => {
    const root = folder()
    const { asked, svc } = approvals('deny')
    const bg = new BackgroundShells()
    const s = `ses_bgrisk_${Date.now()}`
    const out = await run(tools(root, s, { background: bg, approvals: svc, manual: true }), SHELL, { command: 'git push origin main', run_in_background: true })
    expect(out).toContain('declined')
    expect(asked).toHaveLength(1)
    expect(bg.list(s)).toEqual([])
  }, 30_000)

  it('has no background tools without a chat', () => {
    const t = tools(folder(), '', { background: new BackgroundShells() })
    // sessionId '' counts as no chat.
    expect(t.map((x) => x.name)).not.toContain('shell_output')
  })
})

describe.runIf(win && !!gitBashPath())('Git Bash as a second shell', () => {
  it('runs bash beside PowerShell, sharing the folder', async () => {
    const root = folder()
    const s = `ses_gb_${Date.now()}`
    const t = tools(root, s)
    expect(t.map((x) => x.name)).toEqual(expect.arrayContaining(['powershell', 'bash']))
    await run(t, 'bash', { command: 'cd sub' })
    expect(shellCwd.get(s)).toBe('sub')
    expect(await run(t, 'powershell', { command: 'Get-Content marker.txt' })).toContain('in sub')
    expect(await run(t, 'bash', { command: 'cat marker.txt' })).toContain('in sub')
    shellCwd.reset(s)
  }, 60_000)
})
