import { useRef, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, Box, ShieldCheck } from 'lucide-react'
import type { AutomationCommands, AutomationWatch, ContainerStatus, McpClientConfig, McpClientStatus } from '@shared/types'
import { api } from '@/lib/api'
import { attempt } from '@/lib/store'
import { Button, Input, Select, Textarea } from '@/components/ui'
import { KIND, type AccessItem } from './Access'

/** The prompt, with @ to mention something it may use (which switches it on). */
export function PromptBox({ value, onChange, items, onMention, onBlur }: { value: string; onChange(v: string): void; items: AccessItem[]; onMention(i: AccessItem): void; onBlur?(): void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const matches = query === null ? [] : items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
  const sync = (el: HTMLTextAreaElement) => {
    const before = el.value.slice(0, el.selectionStart)
    const m = before.match(/(?:^|\s)@([\w .-]{0,30})$/)
    setQuery(m ? m[1] : null)
    setActive(0)
  }
  const pick = (i: AccessItem) => {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const before = value.slice(0, caret).replace(/@([\w .-]{0,30})$/, `@${i.label} `)
    onChange(before + value.slice(caret))
    onMention(i)
    setQuery(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(before.length, before.length)
    })
  }
  return (
    <div className="relative grid gap-1.5">
      <textarea
        ref={ref}
        rows={4}
        aria-label="What it does"
        value={value}
        placeholder="Look at what changed in my project since yesterday and write me a short brief: what moved, what’s blocked, and the three things to do first today…"
        className="min-h-[128px] w-full resize-y rounded-[12px] border border-line bg-panel px-3.5 py-3 text-body leading-relaxed text-fg transition-colors placeholder:text-dim focus:border-crimson-line focus:outline-none focus:ring-2 focus:ring-crimson-soft"
        onChange={(e) => {
          onChange(e.target.value)
          sync(e.target)
        }}
        onClick={(e) => sync(e.currentTarget)}
        onBlur={() => {
          setTimeout(() => setQuery(null), 120)
          onBlur?.()
        }}
        onKeyDown={(e) => {
          if (!matches.length) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((n) => (n + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            pick(matches[active])
          } else if (e.key === 'Escape') setQuery(null)
        }}
      />
      {matches.length > 0 && (
        <ul role="listbox" aria-label="Mention" className="absolute left-2 top-full z-10 mt-1 grid w-[min(360px,100%)] gap-0.5 rounded-[12px] border border-line-strong bg-elev p-1 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.8)]">
          {matches.map((i, n) => (
            <li key={`${i.kind}:${i.id}`} role="option" aria-selected={n === active}>
              <button onMouseDown={(e) => (e.preventDefault(), pick(i))} className={clsx('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-ui', n === active ? 'bg-elev-2' : 'hover:bg-elev-2')}>
                <span aria-hidden="true" className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', KIND[i.kind].tile)}>
                  <i.icon size={13} />
                </span>
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className="text-caption text-dim">{KIND[i.kind].one}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-dim">Type @ to add a tool, server, collection or skill.</p>
    </div>
  )
}

const EVERY = [5, 15, 30, 60, 180, 720, 1440]
export const everyLabel = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? 'hour' : m < 1440 ? `${m / 60} hours` : 'day')

export function watchSentence(w: AutomationWatch, server?: string): string {
  if (w.kind === 'files') return 'Runs when a file in its folder changes'
  const every = `checking every ${everyLabel(w.everyMinutes)}`
  if (w.kind === 'url') return `Runs when the page at ${w.url || '…'} changes, ${every}`
  return `Runs when ${server ?? 'the server'}’s ${w.tool || 'tool'} answers differently, ${every}`
}

/** A fresh watch of this kind (an automation watches at most one thing). */
export function newWatch(kind: AutomationWatch['kind'], configs: McpClientConfig[], every = 15): AutomationWatch {
  return kind === 'files' ? { kind: 'files' } : kind === 'url' ? { kind: 'url', url: '', everyMinutes: every } : { kind: 'mcp', serverId: configs[0]?.id ?? '', tool: '', args: {}, everyMinutes: every }
}

/** How a watch is set up: files in its folder, a web page, or an MCP tool's answer (the kind is picked by the "Also when" chips). */
export function WatchPicker({ value, onChange, folder, configs, status }: { value: AutomationWatch; onChange(w: AutomationWatch): void; folder: string | null; configs: McpClientConfig[]; status: McpClientStatus[] }) {
  const [argsText, setArgsText] = useState(() => (value.kind === 'mcp' && Object.keys(value.args).length ? JSON.stringify(value.args, null, 2) : ''))
  const [argsError, setArgsError] = useState<string | null>(null)
  const server = value.kind === 'mcp' ? status.find((s) => s.id === value.serverId) : undefined
  return (
    <div className="grid gap-3 rounded-[12px] border border-line bg-panel p-3.5">
      {value.kind === 'files' && (
        <p className={clsx('text-ui', folder ? 'text-muted' : 'text-warn')}>{folder ? `Runs a few seconds after files in ${folder.split(/[\\/]/).filter(Boolean).pop()} change. It’s told which files.` : 'Choose its folder under “What it can use” first.'}</p>
      )}
      {value.kind === 'url' && (
        <label className="grid gap-1 text-ui text-muted">
          Page address
          <Input value={value.url} onChange={(e) => onChange({ ...value, url: e.target.value })} placeholder="https://example.com/pricing…" spellCheck={false} autoComplete="off" className="font-mono" />
        </label>
      )}
      {value.kind === 'mcp' && (
        <div className="grid gap-2.5">
          {!configs.length ? (
            <p className="text-ui text-warn">Add an MCP server on the MCP page first.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Server" value={value.serverId} onChange={(e) => onChange({ ...value, serverId: e.target.value, tool: '' })} className="w-48">
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Select aria-label="Tool" value={value.tool} onChange={(e) => onChange({ ...value, tool: e.target.value })} className="min-w-48 flex-1">
                <option value="">{server?.state === 'ready' ? 'Pick a tool…' : 'Start the server to list its tools…'}</option>
                {(server?.tools ?? []).map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
                {value.tool && !server?.tools.some((t) => t.name === value.tool) && <option value={value.tool}>{value.tool}</option>}
              </Select>
              {server?.state !== 'ready' && value.serverId && (
                <Button size="sm" onClick={() => void attempt(() => api.mcp.startClient(value.serverId))}>
                  Start it
                </Button>
              )}
            </div>
          )}
          <label className="grid gap-1 text-ui text-muted">
            What to ask it (optional, JSON)
            <Textarea
              rows={2}
              className="font-mono text-caption"
              spellCheck={false}
              value={argsText}
              placeholder='{ "repo": "owner/name", "state": "open" }…'
              onChange={(e) => {
                setArgsText(e.target.value)
                try {
                  const v = e.target.value.trim() ? JSON.parse(e.target.value) : {}
                  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Give an object, like { "repo": "owner/name" }')
                  setArgsError(null)
                  onChange({ ...value, args: v })
                } catch (err) {
                  setArgsError(err instanceof Error ? err.message : 'Not valid JSON')
                }
              }}
            />
            {argsError && <span className="text-caption text-danger-hi">{argsError}</span>}
          </label>
        </div>
      )}
      {value.kind !== 'files' && (
        <label className="flex flex-wrap items-center gap-2 text-ui text-muted">
          Check every
          <Select aria-label="How often to check" value={String(value.everyMinutes)} onChange={(e) => onChange({ ...value, everyMinutes: Number(e.target.value) })} className="w-32">
            {EVERY.map((m) => (
              <option key={m} value={m}>
                {everyLabel(m)}
              </option>
            ))}
          </Select>
        </label>
      )}
    </div>
  )
}

/** Whether the agent may run commands: not at all, in a container on a copy of its folder, or only listed commands. */
export function CommandsPicker({ value, onChange, folder, docker }: { value: AutomationCommands | null; onChange(c: AutomationCommands | null): void; folder: boolean; docker: ContainerStatus | null }) {
  const [allowText, setAllowText] = useState(() => (value?.mode === 'allowlist' ? value.allow.join('\n') : ''))
  const mode = value?.mode ?? 'off'
  // Its empty folder only exists inside the container: commands always run there.
  if (value?.mode === 'container' && value.empty)
    return (
      <div className="grid gap-2.5 rounded-[12px] border border-line bg-panel p-3.5">
        <p className="text-ui text-muted">Commands run in the container with its empty folder. To change this, choose another option under Folder.</p>
        <label className="flex flex-wrap items-center gap-2 text-ui text-muted">
          Image
          <Input value={value.image} onChange={(e) => onChange({ ...value, image: e.target.value })} spellCheck={false} autoComplete="off" className="w-44 font-mono" />
          <span className="text-dim">The Linux system it runs in, such as node:22 or python:3.12.</span>
        </label>
        <label className="flex min-h-8 cursor-pointer items-center gap-2 text-ui">
          <input type="checkbox" className="accent-crimson" checked={value.network} onChange={(e) => onChange({ ...value, network: e.target.checked })} />
          Can reach the internet (to install packages)
        </label>
      </div>
    )
  const options: { v: 'off' | 'container' | 'allowlist'; label: string; sub: string; icon?: typeof Box }[] = [
    { v: 'off', label: 'No', sub: 'It can’t run commands.' },
    { v: 'container', label: 'In a container', sub: 'On a copy of its folder. You apply its changes after.', icon: Box },
    { v: 'allowlist', label: 'Only these commands', sub: 'On this computer, nothing else allowed.', icon: ShieldCheck }
  ]
  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label="Running commands" className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
        {options.map((o) => (
          <button
            key={o.v}
            role="radio"
            aria-checked={mode === o.v}
            onClick={() => onChange(o.v === 'off' ? null : o.v === 'container' ? { mode: 'container', image: 'node:22', network: true } : { mode: 'allowlist', allow: allowText.split('\n').map((x) => x.trim()).filter(Boolean) })}
            className={clsx('grid content-start gap-0.5 rounded-[11px] border p-3 text-left', mode === o.v ? 'border-crimson-line bg-elev-2' : 'border-line hover:border-line-strong')}
          >
            <span className="flex items-center gap-1.5 text-ui font-semibold">
              {o.icon && <o.icon size={14} aria-hidden="true" />}
              {o.label}
            </span>
            <span className="text-caption text-dim">{o.sub}</span>
          </button>
        ))}
      </div>
      {value && !folder && (
        <p className="flex items-center gap-2 text-caption text-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          Commands run in its folder. Choose one under Folder.
        </p>
      )}
      {value?.mode === 'container' && (
        <div className="grid gap-2.5 rounded-[12px] border border-line bg-panel p-3.5">
          {docker && !docker.available && <p className="text-ui text-warn">{docker.error ?? 'Docker isn’t available.'} Runs will fail until it is.</p>}
          <label className="flex flex-wrap items-center gap-2 text-ui text-muted">
            Image
            <Input value={value.image} onChange={(e) => onChange({ ...value, image: e.target.value })} spellCheck={false} autoComplete="off" className="w-44 font-mono" />
            <span className="text-dim">The Linux system it runs in, such as node:22 or python:3.12.</span>
          </label>
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-ui">
            <input type="checkbox" className="accent-crimson" checked={value.network} onChange={(e) => onChange({ ...value, network: e.target.checked })} />
            Can reach the internet (to install packages)
          </label>
        </div>
      )}
      {value?.mode === 'allowlist' && (
        <label className="grid gap-1 text-ui text-muted">
          Commands it may run, one per line
          <Textarea
            rows={3}
            className="font-mono text-caption"
            spellCheck={false}
            value={allowText}
            placeholder={'git log\nnpm test…'}
            onChange={(e) => {
              setAllowText(e.target.value)
              onChange({ mode: 'allowlist', allow: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })
            }}
          />
          <span className="text-caption text-dim">Each line is how an allowed command starts: “git log” allows “git log --oneline” too. Anything else, or two commands chained together, is refused and the agent is told why.</span>
        </label>
      )}
    </div>
  )
}
