import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalEvent, TerminalInfo } from '../src/shared/types'
import type { DockerRun } from '../src/main/agent/containers'
import type { Pty, PtySpawn } from '../src/main/panel/terminals'
import { autoStart, clipboardKey, terminalsAfter, withTerminal } from '../src/shared/terminal-tabs'
import { terminalReadTool } from '../src/main/agent/shell'
import { makeServices } from './helpers'

interface Spawned {
  file: string
  args: string[]
  cwd: string
  killed: number
  exit(code: number): void
}

/** Stands in for node-pty: records every shell started, and a kill ends the process the way a real one does. */
function fakePty() {
  const spawned: Spawned[] = []
  const spawn: PtySpawn = (file, args, options) => {
    const exits = new Set<(e: { exitCode: number }) => void>()
    const rec: Spawned = { file, args, cwd: options.cwd ?? '', killed: 0, exit: (exitCode) => exits.forEach((l) => l({ exitCode })) }
    spawned.push(rec)
    const pty: Pty = {
      onData: () => ({ dispose: () => undefined }),
      onExit: (l) => {
        exits.add(l)
        return { dispose: () => exits.delete(l) }
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        rec.killed++
        queueMicrotask(() => rec.exit(1))
      }
    }
    return pty
  }
  return { spawn, spawned }
}

/** A docker CLI that has the container running for whoever asks. */
const docker: DockerRun = async (args) => ({ code: 0, stdout: args[0] === 'version' ? '27.1.1\n' : args[0] === 'inspect' ? 'true\n' : '', stderr: '' })

const folder = (file?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-term-'))
  if (file) writeFileSync(join(dir, file), 'x')
  return dir
}
const terminalEvents = (events: { channel: string; payload: unknown }[]) => events.filter((e) => e.channel === 'terminal').map((e) => e.payload as TerminalEvent)
const size = { cols: 100, rows: 30 }

describe('side panel terminals', () => {
  it('starts each shell in the folder the chat has when it opens, and keeps that folder on the terminal', async () => {
    const pty = fakePty()
    const { services } = makeServices({ pty: pty.spawn })
    const first = folder()
    const second = folder()
    const chat = services.chat.create({ workspace: first })
    const a = await services.panel.openTerminal(chat.id, size)
    expect(pty.spawned.map((s) => s.cwd)).toEqual([first])
    expect(a).toMatchObject({ sessionId: chat.id, cwd: first, container: false, running: true })

    // The chat moves to another folder: the next shell starts there; the open one stays where it was, saying so.
    services.chat.update(chat.id, { workspace: second })
    const b = await services.panel.openTerminal(chat.id, size)
    expect(pty.spawned.map((s) => s.cwd)).toEqual([first, second])
    expect(services.panel.terminals.list(chat.id).map((t) => [t.id, t.cwd])).toEqual([
      [a.id, first],
      [b.id, second]
    ])

    // No folder, or one that is gone: the home folder (and the terminal says so).
    const none = services.chat.create({})
    expect((await services.panel.openTerminal(none.id, size)).cwd).toBe(homedir())
    const gone = services.chat.create({ workspace: join(first, 'missing') })
    expect((await services.panel.openTerminal(gone.id, size)).cwd).toBe(homedir())
  })

  it("lists only the chat's own terminals, starts one per call and closes each once", async () => {
    const pty = fakePty()
    const { services, events } = makeServices({ pty: pty.spawn })
    const one = services.chat.create({ workspace: folder() })
    const two = services.chat.create({ workspace: folder() })
    const a = await services.panel.openTerminal(one.id, size)
    const b = await services.panel.openTerminal(two.id, size)
    expect(pty.spawned).toHaveLength(2)
    expect(terminalEvents(events).filter((e) => e.type === 'opened')).toHaveLength(2)
    expect(services.panel.terminals.list(one.id).map((t) => t.id)).toEqual([a.id])
    expect(services.panel.terminals.list(two.id).map((t) => t.id)).toEqual([b.id])

    services.panel.terminals.kill(a.id)
    services.panel.terminals.kill(a.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(pty.spawned[0].killed).toBe(1)
    expect(terminalEvents(events).filter((e) => e.type === 'closed')).toEqual([{ type: 'closed', id: a.id, sessionId: one.id }])
    // Its process ending afterwards doesn't bring it back.
    expect(services.panel.terminals.list(one.id)).toEqual([])
    expect(services.panel.terminals.list(two.id).map((t) => t.id)).toEqual([b.id])

    // A shell that already exited is closed without killing it again.
    const c = await services.panel.openTerminal(two.id, size)
    pty.spawned[2].exit(0)
    expect(services.panel.terminals.list(two.id).find((t) => t.id === c.id)).toMatchObject({ running: false, exitCode: 0 })
    services.panel.terminals.kill(c.id)
    expect(pty.spawned[2].killed).toBe(0)

    // Deleting a chat closes its terminals only.
    const d = await services.panel.openTerminal(one.id, size)
    services.panel.terminals.killSession(two.id)
    expect(services.panel.terminals.list(two.id)).toEqual([])
    expect(services.panel.terminals.list(one.id).map((t) => t.id)).toEqual([d.id])
  })

  it("runs a container chat's shell in its container, on a copy of the chat's current folder", async () => {
    const pty = fakePty()
    const { services } = makeServices({ pty: pty.spawn, docker })
    const first = folder('first.txt')
    const second = folder('second.txt')
    const chat = services.chat.create({ workspace: first, container: { image: 'node:22', network: true } })
    const t = await services.panel.openTerminal(chat.id, size)
    expect(t).toMatchObject({ container: true, cwd: '/workspace' })
    expect(pty.spawned[0].file).toBe('docker')
    expect(pty.spawned[0].args.slice(0, 4)).toEqual(['exec', '-it', '-w', '/workspace'])
    expect(pty.spawned[0].args).toContain(services.containers.containerName(chat.id))
    const copy = services.containers.copyDir(chat.id)
    expect(existsSync(join(copy, 'first.txt'))).toBe(true)

    // A new folder: the next shell's copy is made from it.
    services.chat.update(chat.id, { workspace: second })
    await services.panel.openTerminal(chat.id, size)
    expect(existsSync(join(copy, 'second.txt'))).toBe(true)
    expect(existsSync(join(copy, 'first.txt'))).toBe(false)
  })
})

const term = (id: string, sessionId = 'ses_a'): TerminalInfo => ({ id, sessionId, title: id, cwd: '/x', container: false, running: true, exitCode: null })

describe('side panel terminal tabs', () => {
  it('starts a shell only the first time the tab shows with no terminals', () => {
    // Not shown yet, or the list still loading: nothing is decided.
    let s = autoStart(false, false, [])
    expect(s).toEqual({ decided: false, start: false })
    s = autoStart(s.decided, true, null)
    expect(s).toEqual({ decided: false, start: false })
    s = autoStart(s.decided, true, [])
    expect(s).toEqual({ decided: true, start: true })
    // The user closes that shell: the tab stays empty.
    expect(autoStart(s.decided, true, [])).toEqual({ decided: true, start: false })
  })

  it('never starts one for a chat that already had terminals, even after closing them all', () => {
    let s = autoStart(false, true, [term('t1')])
    expect(s).toEqual({ decided: true, start: false })
    s = autoStart(s.decided, true, [])
    expect(s.start).toBe(false)
  })

  it("keeps the chat's own terminals, each once", () => {
    const opened = term('t1')
    // The shell this panel opened and the event announcing it: one tab.
    let list = withTerminal([], 'ses_a', opened)
    list = terminalsAfter(list, 'ses_a', { type: 'opened', terminal: opened })
    expect(list).toEqual([opened])
    // Another chat's terminal never shows here.
    expect(terminalsAfter(list, 'ses_a', { type: 'opened', terminal: term('t2', 'ses_b') })).toBe(list)
    expect(withTerminal(list, 'ses_a', term('t2', 'ses_b'))).toBe(list)
    // Before the list loads, events are left to the load; the panel's own shell is kept.
    expect(terminalsAfter(null, 'ses_a', { type: 'opened', terminal: opened })).toBeNull()
    expect(withTerminal(null, 'ses_a', opened)).toEqual([opened])
  })

  it('closes a tab once and marks an ended shell', () => {
    const list = [term('t1'), term('t2')]
    const exited = terminalsAfter(list, 'ses_a', { type: 'exit', id: 't2', code: 3 })
    expect(exited?.[1]).toMatchObject({ running: false, exitCode: 3 })
    const closed = terminalsAfter(exited, 'ses_a', { type: 'closed', id: 't1', sessionId: 'ses_a' })
    expect(closed?.map((t) => t.id)).toEqual(['t2'])
    // A second report of the same close, another chat's close, or output: nothing changes.
    expect(terminalsAfter(closed, 'ses_a', { type: 'closed', id: 't1', sessionId: 'ses_a' })).toBe(closed)
    expect(terminalsAfter(closed, 'ses_a', { type: 'closed', id: 't2', sessionId: 'ses_b' })).toBe(closed)
    expect(terminalsAfter(closed, 'ses_a', { type: 'data', id: 't2', data: 'hi' })).toBe(closed)
  })
})

describe('terminal titles, copying and reading', () => {
  it('numbers terminals with the lowest number not in use, so a lone terminal is always 1', async () => {
    const pty = fakePty()
    const { services } = makeServices({ pty: pty.spawn })
    const chat = services.chat.create({ workspace: folder() })
    const num = (t: TerminalInfo) => Number(/(\d+)$/.exec(t.title)?.[1])
    const a = await services.panel.openTerminal(chat.id, size)
    expect(num(a)).toBe(1)
    services.panel.terminals.kill(a.id)
    const b = await services.panel.openTerminal(chat.id, size)
    expect(num(b)).toBe(1)
    const c = await services.panel.openTerminal(chat.id, size)
    expect(num(c)).toBe(2)
    // Closing 1 while 2 is open: the next is 1 again; numbers of other chats don't count.
    services.panel.terminals.kill(b.id)
    expect(num(await services.panel.openTerminal(chat.id, size))).toBe(1)
    const other = services.chat.create({ workspace: folder() })
    expect(num(await services.panel.openTerminal(other.id, size))).toBe(1)
  })

  it('copies and pastes with the usual keys, and leaves Ctrl+C to the shell when nothing is selected', () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ type: 'keydown', key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })
    // Windows and Linux.
    expect(clipboardKey(key('c', { ctrlKey: true }), true, false)).toBe('copy')
    expect(clipboardKey(key('c', { ctrlKey: true }), false, false)).toBeNull()
    expect(clipboardKey(key('C', { ctrlKey: true, shiftKey: true }), false, false)).toBe('copy')
    expect(clipboardKey(key('v', { ctrlKey: true }), false, false)).toBe('paste')
    expect(clipboardKey(key('V', { ctrlKey: true, shiftKey: true }), false, false)).toBe('paste')
    expect(clipboardKey(key('d', { ctrlKey: true }), true, false)).toBeNull()
    expect(clipboardKey({ ...key('c', { ctrlKey: true }), type: 'keyup' }, true, false)).toBeNull()
    // macOS: Cmd, and Ctrl+C still interrupts.
    expect(clipboardKey(key('c', { metaKey: true }), false, true)).toBe('copy')
    expect(clipboardKey(key('v', { metaKey: true }), false, true)).toBe('paste')
    expect(clipboardKey(key('a', { metaKey: true }), false, true)).toBe('select-all')
    expect(clipboardKey(key('c', { ctrlKey: true }), true, true)).toBeNull()
  })

  it("lets the agent read the chat's terminals as plain text, never typing into them", async () => {
    const terms = [term('term_a'), { ...term('term_b'), background: true, command: 'npm run dev', running: false, exitCode: 1 }]
    const buffers: Record<string, string> = {
      term_a: '\u001b[32mPS C:/x>\u001b[0m npm test\r\nloading 10%\rloading 100%\r\n\u001b]0;title\u0007Error: boom\r\n',
      term_b: 'one\r\ntwo\r\nthree\r\n'
    }
    const tool = terminalReadTool({ list: (s) => terms.filter((t) => t.sessionId === s), buffer: (id) => buffers[id] }, 'ses_a')
    const read = async (args: Record<string, unknown>) => ((await tool.execute('t', args)).content[0] as { text: string }).text
    // Several: it lists them.
    const listed = await read({})
    expect(listed).toContain('term_a')
    expect(listed).toContain('background command `npm run dev` (exited with code 1, in /x)')
    const a = await read({ id: 'term_a' })
    expect(a).toContain('PS C:/x> npm test\nloading 100%\nError: boom')
    expect(a).not.toContain('\u001b')
    expect(a).not.toContain('loading 10%')
    expect(await read({ id: 'term_b', lines: 2 })).toContain('last 2 of 3 lines:\n\ntwo\nthree')
    expect(await read({ id: 'term_x' })).toContain('No terminal term_x')
    // None open, and a chat with just one.
    const none = terminalReadTool({ list: () => [], buffer: () => '' }, 'ses_a')
    expect(((await none.execute('t', {})).content[0] as { text: string }).text).toContain('No terminals are open')
    const one = terminalReadTool({ list: () => [term('term_a')], buffer: () => 'hello\r\n' }, 'ses_a')
    expect(((await one.execute('t', {})).content[0] as { text: string }).text).toContain('hello')
  })
})
