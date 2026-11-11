import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, BookOpen, Check, ChevronDown, Code2, FileText, Globe, Link2, MessageSquareText, Minus, Monitor, Plug, Plus, Search, Sparkles, SquareTerminal, X } from 'lucide-react'
import type { Automation, BuiltinToolInfo, Collection, CustomTool, McpClientStatus, Skill } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Input } from '@/components/ui'

export type Kind = 'tools' | 'mcp' | 'knowledge' | 'skills'
type Icon = typeof Globe

export interface AccessItem {
  kind: Kind
  /** Tool name, server id, collection id or skill name. */
  id: string
  label: string
  desc: string
  meta: string
  warn?: string
  icon: Icon
  /** An external server's tools, for picking some of them. */
  serverTools?: string[]
  /** Runs code on this computer (your JavaScript and command tools). */
  runsCode?: boolean
}

export const KIND: Record<Kind, { label: string; one: string; tile: string; dot: string; on: string }> = {
  tools: { label: 'Tools', one: 'Tool', tile: 'bg-crimson-soft text-crimson-hi', dot: 'bg-crimson', on: 'border-transparent bg-crimson-soft text-crimson-hi' },
  mcp: { label: 'MCP servers', one: 'MCP server', tile: 'bg-info/15 text-info', dot: 'bg-info', on: 'border-transparent bg-info/15 text-info' },
  knowledge: { label: 'Knowledge', one: 'Knowledge', tile: 'bg-ok/15 text-ok', dot: 'bg-ok', on: 'border-transparent bg-ok/15 text-ok' },
  skills: { label: 'Skills', one: 'Skill', tile: 'bg-skill-soft text-skill', dot: 'bg-skill-dot', on: 'border-transparent bg-skill-soft text-skill' }
}
export const KINDS: Kind[] = ['tools', 'mcp', 'knowledge', 'skills']

export const READS = ['read', 'ls', 'find', 'grep', 'ast_grep']
export const WRITES = ['write', 'edit', 'ast_edit']
export const WEB = ['web_search', 'web_fetch']

const CUSTOM_ICON: Record<CustomTool['kind'], Icon> = { http: Link2, javascript: Code2, command: SquareTerminal, prompt: MessageSquareText }

const PRESETS: { label: string; does: string; pick(items: AccessItem[]): Picked }[] = [
  {
    label: 'Read-only',
    does: 'reads files, searches the web and all your Knowledge',
    pick: (items) => ({ ...none(), tools: [...READS, ...WEB].filter((n) => items.some((i) => i.kind === 'tools' && i.id === n)), collectionIds: items.filter((i) => i.kind === 'knowledge').map((i) => i.id) })
  },
  {
    label: 'Research',
    does: 'searches the web and all your Knowledge',
    pick: (items) => ({ ...none(), tools: WEB.filter((n) => items.some((i) => i.id === n)), collectionIds: items.filter((i) => i.kind === 'knowledge').map((i) => i.id) })
  },
  {
    label: 'Hands-on',
    does: 'reads and changes files in its folder and searches the web',
    pick: (items) => ({ ...none(), tools: [...READS, ...WRITES, ...WEB].filter((n) => items.some((i) => i.kind === 'tools' && i.id === n)) })
  }
]

export interface Picked {
  tools: string[]
  servers: Automation['servers']
  collectionIds: string[]
  skills: string[]
}
export const none = (): Picked => ({ tools: [], servers: [], collectionIds: [], skills: [] })

export const isOnIn = (p: Picked, i: AccessItem) =>
  i.kind === 'tools' ? p.tools.includes(i.id) : i.kind === 'mcp' ? p.servers.some((s) => s.id === i.id) : i.kind === 'knowledge' ? p.collectionIds.includes(i.id) : p.skills.includes(i.id)

export function toggleIn(p: Picked, i: AccessItem, on: boolean): Picked {
  const flip = (arr: string[]) => (on ? [...new Set([...arr, i.id])] : arr.filter((x) => x !== i.id))
  if (i.kind === 'tools') return { ...p, tools: flip(p.tools) }
  if (i.kind === 'knowledge') return { ...p, collectionIds: flip(p.collectionIds) }
  if (i.kind === 'skills') return { ...p, skills: flip(p.skills) }
  return { ...p, servers: on ? (p.servers.some((s) => s.id === i.id) ? p.servers : [...p.servers, { id: i.id, tools: null }]) : p.servers.filter((s) => s.id !== i.id) }
}

/** Everything an automation's agent could be given: file and web tools, your tools, MCP servers, collections and skills. */
export function useAccessItems(): { items: AccessItem[]; collections: Collection[]; status: McpClientStatus[] } {
  const [builtins, setBuiltins] = useState<BuiltinToolInfo[]>([])
  const [custom, setCustom] = useState<CustomTool[]>([])
  const [status, setStatus] = useState<McpClientStatus[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const settings = useApp((s) => s.settings)
  useEffect(() => {
    void Promise.all([api.tools.builtins(), api.tools.list(), api.mcp.clients().catch(() => []), api.rag.collections().catch(() => []), api.skills.list().catch(() => [])]).then(([b, c, m, k, sk]) => {
      setBuiltins(b)
      setCustom(c)
      setStatus(m)
      setCollections(k)
      setSkills(sk)
    })
  }, [])
  useEvent('mcpClients', () => void api.mcp.clients().then(setStatus, () => undefined))
  useEvent('tools', () => void api.tools.list().then(setCustom, () => undefined))
  const configs = settings?.mcpClients ?? []
  const items = useMemo(() => {
    const out: AccessItem[] = []
    for (const b of builtins) {
      // Only what an automation's agent can actually call: files and the web.
      if (!b.where.flows || (b.group !== 'workspace' && b.group !== 'web')) continue
      out.push({ kind: 'tools', id: b.name, label: b.label, desc: b.description.split(/(?<=\.)\s/)[0], meta: 'Built in', warn: WRITES.includes(b.name) ? 'Can change files in its folder' : undefined, icon: b.group === 'web' ? Globe : FileText })
    }
    // Computer use (Windows and macOS): screenshots, mouse and keyboard, on a model that sees images.
    if (window.cloth.platform === 'win32' || window.cloth.platform === 'darwin')
      out.push({ kind: 'tools', id: 'computer', label: 'Computer', desc: 'Sees your screen and uses the mouse and keyboard.', meta: 'Built in · needs a model that sees images', warn: 'Controls this computer while it runs', icon: Monitor })
    for (const t of custom) {
      const runsCode = t.kind === 'command' || t.kind === 'javascript'
      out.push({
        kind: 'tools',
        id: t.name,
        label: t.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
        desc: t.description,
        meta: t.enabled ? 'Made by you' : 'Waiting for your OK on the Tools page',
        warn: runsCode ? 'Runs on your computer' : undefined,
        icon: CUSTOM_ICON[t.kind],
        runsCode
      })
    }
    for (const c of configs) {
      const st = status.find((x) => x.id === c.id)
      const tools = st?.state === 'ready' ? st.tools.map((t) => t.name) : undefined
      out.push({ kind: 'mcp', id: c.id, label: c.name, desc: `Tools from the ${c.name} server.`, meta: tools ? `${tools.length} tools` : c.enabled ? 'Starts when it runs' : 'Turned off on the MCP page', icon: Plug, serverTools: tools })
    }
    for (const k of collections) out.push({ kind: 'knowledge', id: k.id, label: k.name, desc: k.description || 'A Knowledge collection.', meta: `${k.docCount} document${k.docCount === 1 ? '' : 's'}`, icon: BookOpen })
    for (const sk of skills) out.push({ kind: 'skills', id: sk.name, label: sk.name, desc: sk.description, meta: 'Skill', icon: Sparkles })
    return out
  }, [builtins, custom, configs, status, collections, skills])
  return { items, collections, status }
}

/**
 * What an automation (or an automation's step in the flow editor) may use: a line of plain abilities
 * ("It can read your files"), what's allowed so far grouped by kind, and a searchable list to add more.
 * External servers can be narrowed to some of their tools.
 */
export function AccessPicker({ items, value, onChange, folder, commands, title = 'What it may use' }: { items: AccessItem[]; value: Picked; onChange(p: Picked): void; folder?: boolean; commands?: boolean; title?: string }) {
  const picked = value
  const setPicked = (p: Picked | ((p: Picked) => Picked)) => onChange(typeof p === 'function' ? p(value) : p)
  const [preset, setPreset] = useState<string | null>(null)
  const isOn = (i: AccessItem) => isOnIn(value, i)
  const toggle = (i: AccessItem, on = !isOn(i)) => {
    setPreset(null)
    onChange(toggleIn(value, i, on))
  }
  const runsCode = items.some((i) => i.runsCode && value.tools.includes(i.id))
  const [kind, setKind] = useState<'all' | Kind>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const has = (n: string[]) => n.some((x) => picked.tools.includes(x))
  const abilities: { label: string; on: boolean; risky?: boolean }[] = [
    { label: 'Read your files', on: has(READS) },
    { label: 'Search the internet', on: has(WEB) },
    { label: 'Use other apps', on: picked.servers.length > 0 },
    { label: 'Look things up in Knowledge', on: picked.collectionIds.length > 0 },
    { label: 'Change files', on: has(WRITES), risky: true },
    { label: 'Run commands', on: runsCode || !!commands, risky: true }
  ]
  const allowed = items.filter(isOn)
  const query = q.trim().toLowerCase()
  const visible = items.filter((i) => (kind === 'all' || i.kind === kind) && (!query || `${i.label} ${i.desc}`.toLowerCase().includes(query)))
  const pre = PRESETS.find((p) => p.label === preset)

  const serverPick = (id: string) => picked.servers.find((s) => s.id === id)
  const setServerTools = (id: string, tools: string[] | null) => setPicked((p) => ({ ...p, servers: p.servers.map((s) => (s.id === id ? { ...s, tools } : s)) }))

  return (
    <section aria-label={title} className="grid gap-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="flex-1 text-body font-semibold">{title}</h2>
        <span className="text-caption text-dim">Start from</span>
        <div role="group" aria-label="Start from a preset" className="inline-flex rounded-[10px] border border-line bg-panel p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              aria-pressed={preset === p.label}
              onClick={() => {
                setPicked(p.pick(items))
                setPreset(p.label)
              }}
              className={clsx('h-[30px] rounded-lg px-3 text-ui', preset === p.label ? 'bg-elev-2 font-medium text-fg' : 'text-muted hover:text-fg')}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {pre && (
        <p className="-mt-1.5 text-caption text-dim" aria-live="polite">
          {pre.label}: {pre.does}. Change anything below.
        </p>
      )}

      <div role="list" aria-label="What this lets it do" className="flex flex-wrap items-center gap-1.5 rounded-[14px] border border-line bg-panel p-2.5">
        <span className="px-1.5 text-caption text-muted">It can</span>
        {abilities.map((ab) => (
          <span
            key={ab.label}
            role="listitem"
            className={clsx(
              'inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-ui transition-colors motion-reduce:transition-none',
              ab.on ? (ab.risky ? 'border-warn/45 bg-warn/10 text-warn' : 'border-ok/40 bg-ok/10 text-ok') : 'border-line text-dim'
            )}
          >
            {ab.on ? <Check size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
            {ab.label}
            <span className="sr-only">{ab.on ? ': yes' : ': no'}</span>
          </span>
        ))}
      </div>
      {has([...READS, ...WRITES]) && folder === false && (
        <p className="-mt-1 flex items-center gap-2 text-caption text-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          File tools need a folder to work in.
        </p>
      )}

      <div className="flex flex-wrap overflow-hidden rounded-[16px] border border-line bg-panel">
        <div className="grid min-w-0 flex-[1_1_270px] content-start gap-3 border-r border-line bg-bg/40 p-3.5 mobile:border-b mobile:border-r-0">
          <div className="flex items-baseline gap-2">
            <h3 className="text-ui font-semibold">Allowed</h3>
            <span className="text-caption tabular-nums text-dim">{allowed.length}</span>
          </div>
          {!allowed.length && <p className="py-4 text-ui text-dim">Nothing yet. It can only read the prompt and write an answer. Add things from the list.</p>}
          {KINDS.map((k) => {
            const group = allowed.filter((i) => i.kind === k)
            if (!group.length) return null
            return (
              <div key={k} className="grid gap-0.5">
                <div className="flex items-center gap-1.5 px-1 pb-0.5 text-caption text-dim">
                  <span aria-hidden="true" className={clsx('h-[7px] w-[7px] rounded-full', KIND[k].dot)} />
                  {KIND[k].label}
                </div>
                {group.map((i) => {
                  const sp = i.kind === 'mcp' ? serverPick(i.id) : undefined
                  const all = i.serverTools ?? []
                  const chosen = sp?.tools ?? all
                  const isOpen = !!open[i.id]
                  return (
                    <div key={`${i.kind}:${i.id}`} className="grid">
                      <div className="flex min-h-10 items-center gap-2 rounded-[9px] py-0.5 pl-1.5 pr-1 hover:bg-elev">
                        <span aria-hidden="true" className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', KIND[i.kind].tile)}>
                          <i.icon size={14} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-ui font-medium">{i.label}</span>
                        {i.kind === 'mcp' && all.length > 0 && (
                          <button aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [i.id]: !isOpen }))} className="flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-line-strong px-2 text-caption text-info">
                            {sp?.tools === null || chosen.length === all.length ? 'All tools' : `${chosen.length} of ${all.length} tools`}
                            <ChevronDown size={11} aria-hidden="true" className={clsx('transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} />
                          </button>
                        )}
                        <button aria-label={`Remove ${i.label}`} title="Remove" onClick={() => toggle(i, false)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg">
                          <X size={12} />
                        </button>
                      </div>
                      {isOpen && (
                        <div className="mb-1.5 ml-10 grid gap-0.5 border-l-2 border-info/35 py-1 pl-2.5">
                          {all.map((t) => (
                            <label key={t} className="flex min-h-[30px] cursor-pointer items-center gap-2 text-ui">
                              <input
                                type="checkbox"
                                className="h-[15px] w-[15px] accent-info"
                                checked={sp?.tools === null || chosen.includes(t)}
                                onChange={(e) => {
                                  const cur = sp?.tools ?? all
                                  const next = e.target.checked ? [...new Set([...cur, t])] : cur.filter((x) => x !== t)
                                  setServerTools(i.id, next.length === all.length ? null : next)
                                }}
                              />
                              <span className="truncate font-mono text-caption" translate="no">
                                {t}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div className="grid min-w-0 flex-[999_1_340px] content-start gap-2.5 p-3.5">
          <h3 className="text-ui font-semibold">Add more</h3>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
            <Input className="pl-8" aria-label="Search tools, servers, Knowledge and skills" placeholder="Search tools, servers, Knowledge and skills…" spellCheck={false} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div role="tablist" aria-label="Kind" className="flex flex-wrap gap-1">
            {(['all', ...KINDS] as ('all' | Kind)[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
                className={clsx('flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-ui', kind === k ? 'border-line-strong bg-elev-2 font-medium text-fg' : 'border-transparent text-muted hover:bg-elev hover:text-fg')}
              >
                <span aria-hidden="true" className={clsx('h-[7px] w-[7px] rounded-full', k === 'all' ? 'bg-muted' : KIND[k].dot)} />
                {k === 'all' ? 'Everything' : KIND[k].label}
                <span className="text-caption tabular-nums text-dim">{items.filter((i) => k === 'all' || i.kind === k).length}</span>
              </button>
            ))}
          </div>
          <div className="-mx-1 grid max-h-[340px] gap-0.5 overflow-y-auto px-1">
            {visible.map((i) => {
              const on = isOn(i)
              return (
                <div key={`${i.kind}:${i.id}`} className="flex min-h-14 items-center gap-3 rounded-[11px] py-1.5 pl-2 pr-1.5 hover:bg-elev/60">
                  <span aria-hidden="true" className={clsx('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]', KIND[i.kind].tile)}>
                    <i.icon size={16} />
                  </span>
                  <span className="grid min-w-0 flex-1 gap-px">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-body font-semibold">{i.label}</span>
                      <span className="text-caption text-dim">{kind === 'all' ? `${KIND[i.kind].one}, ${i.meta.charAt(0).toLowerCase()}${i.meta.slice(1)}` : i.meta}</span>
                    </span>
                    <span className="line-clamp-2 text-caption text-dim">
                      {i.desc}
                      {i.warn && <span className="text-warn"> {i.warn}.</span>}
                    </span>
                  </span>
                  <button
                    aria-pressed={on}
                    aria-label={`${on ? 'Remove' : 'Add'} ${i.label}`}
                    onClick={() => toggle(i)}
                    className={clsx('flex h-8 min-w-[84px] shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-ui transition-colors motion-reduce:transition-none', on ? KIND[i.kind].on : 'border-line-strong bg-elev hover:border-muted/40')}
                  >
                    {on ? <Check size={12} aria-hidden="true" /> : <Plus size={12} aria-hidden="true" />}
                    {on ? 'Added' : 'Add'}
                  </button>
                </div>
              )
            })}
            {!visible.length && (
              <p className="px-1 py-4 text-ui text-dim">
                {query ? `Nothing matches “${q.trim()}”.` : 'Nothing of this kind yet.'} Make tools on the Tools page and add servers on the MCP page.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}


