import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Lightning, Plus, Stop, TerminalWindow, X } from '@phosphor-icons/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '@shared/types'
import { autoStart, clipboardKey, terminalsAfter, withTerminal } from '@shared/terminal-tabs'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { Button } from '@/components/ui'
import { isMobile } from '@/lib/platform'

const mac = /Mac|iPhone|iPad/.test(navigator.platform)

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

function theme() {
  return {
    background: css('--color-panel', '#141518'),
    foreground: css('--color-fg', '#f1f1f4'),
    cursor: css('--color-crimson-hi', '#e54056'),
    cursorAccent: css('--color-panel', '#141518'),
    selectionBackground: 'rgba(220, 38, 69, 0.35)',
    black: '#26262b',
    brightBlack: '#6c6c76',
    red: '#ef5d73',
    brightRed: '#ff7a8e',
    green: '#5ccb89',
    brightGreen: '#5fd497',
    yellow: '#e0a43a',
    brightYellow: '#f2c066',
    blue: '#6cb2ec',
    brightBlue: '#8fb5ff',
    magenta: '#c9a3f5',
    brightMagenta: '#d8a8ff',
    cyan: '#4fc1c9',
    brightCyan: '#7ddde3',
    white: '#c9c9d1',
    brightWhite: '#ffffff'
  }
}

/** One live shell. The xterm stays mounted while hidden so nothing is lost when switching tabs. */
function TerminalView({ info, active }: { info: TerminalInfo; active: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  // Output that arrives before the replayed scrollback is already part of it.
  const replayed = useRef(false)

  useEffect(() => {
    const t = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      // A background command's tab only shows output: nothing to type into.
      cursorBlink: !info.background,
      disableStdin: !!info.background,
      cursorInactiveStyle: info.background ? 'none' : 'outline',
      scrollback: 5000,
      allowProposedApi: false,
      theme: theme()
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    term.current = t
    fit.current = f
    const input = t.onData((d) => {
      if (!info.background) void api.panel.writeTerminal(info.id, d)
    })
    t.attachCustomKeyEventHandler((e) => {
      const action = clipboardKey(e, t.hasSelection(), mac)
      if (!action) return true
      e.preventDefault()
      if (action === 'copy') {
        const text = t.getSelection()
        if (text) void navigator.clipboard.writeText(text).catch(() => undefined)
        t.clearSelection()
      } else if (action === 'paste') {
        if (!info.background) void navigator.clipboard.readText().then((text) => text && t.paste(text), () => undefined)
      } else t.selectAll()
      return false
    })
    const resize = t.onResize(({ cols, rows }) => void api.panel.resizeTerminal(info.id, cols, rows))
    // A view torn down before its scrollback arrives (StrictMode remounts) leaves the replay to the next one.
    let live = true
    void api.panel.terminalBuffer(info.id).then((buf) => {
      if (!live) return
      t.write(buf)
      replayed.current = true
    })
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) {
        try {
          f.fit()
        } catch {
          /* not laid out yet */
        }
      }
    })
    ro.observe(host.current!)
    return () => {
      live = false
      replayed.current = false
      ro.disconnect()
      input.dispose()
      resize.dispose()
      t.dispose()
    }
  }, [info.id])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        /* hidden */
      }
      if (!info.background) term.current?.focus()
    })
  }, [active])

  useEvent('terminal', (e) => {
    if (e.type === 'data' && e.id === info.id && replayed.current) term.current?.write(e.data)
    if (e.type === 'exit' && e.id === info.id)
      term.current?.write(`\r\n\x1b[90m[${info.background && e.code === null ? 'stopped' : `process exited${e.code !== null ? ` with code ${e.code}` : ''}`}]\x1b[0m\r\n`)
  })

  return <div ref={host} className={clsx('absolute inset-0 px-2 pt-1.5', !active && 'invisible')} />
}

export function Terminals({ sessionId, visible, hasFolder, container, onPickFolder }: { sessionId: string; visible: boolean; hasFolder: boolean; container: boolean; onPickFolder(): void }) {
  // Without a folder the tab waits to be asked: a shell would open in the home folder.
  const homeOnly = !hasFolder && !container
  const [list, setList] = useState<TerminalInfo[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    let live = true
    setList(null)
    void api.panel.terminals(sessionId).then((ts) => {
      if (!live) return
      setList(ts)
      setActive(ts.at(-1)?.id ?? null)
    })
    return () => {
      live = false
    }
  }, [sessionId])

  useEvent('terminal', (e) => {
    if (e.type !== 'data') setList((cur) => terminalsAfter(cur, sessionId, e))
  })

  // One shell per click, however the clicks and the first-show start overlap.
  const pending = useRef(false)
  const open = async () => {
    if (pending.current) return
    pending.current = true
    setOpening(true)
    const t = await attempt(() => api.panel.openTerminal(sessionId, { cols: 100, rows: 30 }))
    pending.current = false
    setOpening(false)
    if (t) {
      setList((cur) => withTerminal(cur, sessionId, t))
      setActive(t.id)
    }
  }
  // The first time the tab is shown with a folder, start a shell if the chat has none (closing the last one doesn't start another).
  const decided = useRef(false)
  useEffect(() => {
    const next = autoStart(decided.current, visible && !homeOnly, list)
    decided.current = next.decided
    if (next.start) void open()
  }, [visible, list, homeOnly])
  useEffect(() => {
    if (list && active && !list.some((t) => t.id === active)) setActive(list.at(-1)?.id ?? null)
  }, [list, active])

  const close = (id: string) => void api.panel.closeTerminal(id)
  const stop = (id: string) => void attempt(() => api.panel.stopTerminal(id))
  // A background command the agent starts comes to the front, so it's easy to find.
  useEvent('terminal', (e) => {
    if (e.type === 'opened' && e.terminal.sessionId === sessionId && e.terminal.background) setActive(e.terminal.id)
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1.5">
        {list?.map((t) => (
          <div
            key={t.id}
            onClick={() => setActive(t.id)}
            title={t.background ? `Started by the agent in the background${t.cwd && t.cwd !== '.' ? `, in ${t.cwd}` : ''}:\n${t.command}` : t.cwd}
            className={clsx('group/tab flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1 text-caption', t.id === active ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev')}
          >
            {t.background ? <Lightning size={13} weight="fill" className={t.running ? 'text-ok' : 'text-dim'} aria-label="Background command" /> : <TerminalWindow size={13} className={t.running ? 'text-ok' : 'text-dim'} />}
            <span className={clsx(t.background && 'max-w-[180px] truncate font-mono')}>{t.title}</span>
            {t.background && t.running && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  stop(t.id)
                }}
                className="flex h-5 items-center gap-0.5 rounded px-1 text-micro text-dim hover:bg-elev hover:text-danger-hi"
                aria-label={`Stop ${t.title}`}
                title="Stop this command (its output stays here)"
              >
                <Stop size={9} weight="fill" />
                Stop
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                close(t.id)
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-dim opacity-0 hover:bg-elev hover:text-fg group-hover/tab:opacity-100 mobile:opacity-100"
              aria-label={`Close ${t.title}`}
              title={t.background && t.running ? 'Stop it and close the tab' : undefined}
            >
              <X size={10} weight="bold" />
            </button>
          </div>
        ))}
        <button onClick={() => void open()} disabled={opening} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim hover:bg-elev hover:text-fg disabled:opacity-50" aria-label="New terminal" title={container ? 'New shell in the container' : 'New terminal'}>
          <Plus size={13} />
        </button>
        {opening && <span className="pl-1 text-caption text-dim">{container ? 'Starting the container…' : 'Starting…'}</span>}
      </div>
      <div className="relative min-h-0 flex-1 bg-panel">
        {list?.map((t) => <TerminalView key={t.id} info={t} active={visible && t.id === active} />)}
        {list && !list.length && !opening && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            {homeOnly ? (
              <div className="space-y-3">
                <div className="text-ui text-dim">No folder yet. A terminal opens in your home folder.</div>
                <div className="flex flex-col items-center gap-2">
                  <Button size="sm" icon={<Plus size={13} />} onClick={() => void open()}>
                    Open a terminal
                  </Button>
                  {!isMobile && (
                    <button onClick={onPickFolder} className="text-caption text-muted underline-offset-2 hover:text-fg hover:underline">
                      Choose a folder
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="text-ui text-dim">No terminals open.</div>
                <Button size="sm" icon={<Plus size={13} />} onClick={() => void open()}>
                  New terminal
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
