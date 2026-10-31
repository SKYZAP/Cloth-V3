import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { AlertTriangle, ArrowLeft, BookOpen, ChevronDown, ChevronUp, Code2, FileText, Globe, Link2, ListChecks, MessageSquareText, Play, Plug, Plus, Search, ShieldAlert, Sparkles, SquareTerminal, Trash2, Wrench, X } from 'lucide-react'
import { mcpToolName, type BuiltinToolInfo, type CustomTool, type CustomToolInput, type CustomToolKind, type McpClientStatus, type ModelRef, type ToolParam, type ToolParamType, type ToolRunResult, type ToolUsage } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Inspector, refocus } from '@/components/Inspector'
import { duration, timeAgo } from '@/lib/format'
import { Button, Field, IconButton, Input, Select, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Editor } from '@/components/Editor'

type Icon = typeof Globe

const KINDS: Record<CustomToolKind, { label: string; icon: Icon; blurb: string }> = {
  http: { label: 'Web request', icon: Link2, blurb: 'Calls a web address (an API) and returns what it sends back.' },
  javascript: { label: 'JavaScript', icon: Code2, blurb: 'Runs a short script, for anything a request can’t do on its own.' },
  command: { label: 'Command', icon: SquareTerminal, blurb: 'Runs a program on this computer, like git or ImageMagick.' },
  prompt: { label: 'AI prompt', icon: MessageSquareText, blurb: 'Asks a model to do a small job and returns its answer.' }
}

/** What the kind's settings step is called. */
const SETUP_TITLE: Record<CustomToolKind, string> = { http: 'Where does it call?', javascript: 'The script', command: 'Which program, with what?', prompt: 'What to ask the model' }

/** Settings each kind starts with. */
const STARTER: Record<CustomToolKind, Record<string, unknown>> = {
  http: { method: 'GET', url: '', headers: '{\n  "accept": "application/json"\n}', body: '', timeoutMs: 15000 },
  javascript: { code: 'return args', timeoutMs: 5000 },
  command: { command: '', args: '', cwd: '', timeoutMs: 15000 },
  prompt: { model: null, system: '', prompt: '' }
}

const PARAM_TYPES: { value: ToolParamType; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes or no' },
  { value: 'json', label: 'List or object' }
]

const GROUPS: { id: BuiltinToolInfo['group']; label: string; icon: Icon }[] = [
  { id: 'workspace', label: 'Files and code', icon: FileText },
  { id: 'web', label: 'Web', icon: Globe },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'planning', label: 'Planning', icon: ListChecks },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'tools', label: 'Making tools', icon: Wrench }
]

type Source = 'builtin' | 'mine' | 'mcp'
type Show = 'all' | Source

interface Item {
  key: string
  source: Source
  /** The name the agent calls it by. */
  name: string
  label: string
  description: string
  icon: Icon
  kindLabel: string
  builtin?: BuiltinToolInfo
  custom?: CustomTool
  server?: string
  /** An external tool: its server's id, its own name, and its input schema. */
  serverId?: string
  rawName?: string
  schema?: Record<string, unknown>
}

const SOURCE_TILE: Record<Source, string> = {
  builtin: 'bg-elev-2 text-muted',
  mine: 'bg-crimson-soft text-crimson-hi',
  mcp: 'bg-info/15 text-info'
}

const humanize = (name: string) => {
  const s = name.replace(/[_-]+/g, ' ').trim()
  return s ? s[0].toUpperCase() + s.slice(1) : name
}

/** A tool made by a model that waits for the user's OK (or one switched off before tools stopped having a switch). */
const waiting = (t: CustomTool) => !t.enabled

/**
 * What Cloth and its agents can do: every tool in one searchable list (built in, made by you, from MCP
 * servers), its details and a quick test beside it, and a step-by-step screen for making your own.
 * Which agent or automation may use a tool is chosen on those pages, not here.
 */
export function ToolsPage() {
  const [builtins, setBuiltins] = useState<BuiltinToolInfo[]>([])
  const [custom, setCustom] = useState<CustomTool[]>([])
  const [usage, setUsage] = useState<Record<string, ToolUsage>>({})
  const [usedBy, setUsedBy] = useState<Record<string, string[]>>({})
  const [agentNames, setAgentNames] = useState<string[]>([])
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const [selKey, setSelKey] = useState<string | null>(null)
  const [making, setMaking] = useState<{ id: string | null } | null>(null)
  const [filter, setFilter] = useState('')
  const [show, setShow] = useState<Show>(() => (localStorage.getItem('cloth.tools.show') as Show | null) ?? 'all')
  const settings = useApp((s) => s.settings)
  const setPage = useApp((s) => s.setPage)

  const load = async () => {
    const [b, c, u, m, by] = await Promise.all([api.tools.builtins(), api.tools.list(), api.tools.usage().catch(() => ({})), api.mcp.clients().catch(() => []), api.tools.usedBy().catch(() => ({}))])
    setBuiltins(b)
    setCustom(c)
    setUsage(u)
    setServers(m)
    setUsedBy(by)
  }
  useEffect(() => {
    void load()
    void api.agents.list().then((a) => setAgentNames(a.map((x) => x.name)), () => undefined)
  }, [])
  // Tools made by a model (chat or MCP) appear without a reload.
  useEvent('tools', () => void load())
  useEvent('agents', () => void api.tools.usedBy().then(setUsedBy, () => undefined))
  useEvent('mcpClients', () => void api.mcp.clients().then(setServers, () => undefined))
  useEffect(() => {
    try {
      localStorage.setItem('cloth.tools.show', show)
    } catch {
      /* storage unavailable */
    }
  }, [show])

  const configs = settings?.mcpClients ?? []
  const items = useMemo(() => {
    const out: Item[] = []
    for (const b of builtins) {
      const g = GROUPS.find((x) => x.id === b.group)
      out.push({ key: `b:${b.name}`, source: 'builtin', name: b.name, label: b.label, description: b.description, icon: g?.icon ?? Wrench, kindLabel: 'Built in', builtin: b })
    }
    for (const t of custom) out.push({ key: `c:${t.id}`, source: 'mine', name: t.name, label: humanize(t.name), description: t.description, icon: KINDS[t.kind].icon, kindLabel: KINDS[t.kind].label, custom: t })
    for (const c of configs) {
      const st = servers.find((s) => s.id === c.id)
      for (const t of st?.state === 'ready' ? st.tools : [])
        out.push({ key: `m:${c.id}:${t.name}`, source: 'mcp', name: mcpToolName(c.name, t.name), label: humanize(t.name), description: t.description || `A tool from the ${c.name} server.`, icon: Plug, kindLabel: `From ${c.name}`, server: c.name, serverId: c.id, rawName: t.name, schema: t.inputSchema })
    }
    return out
  }, [builtins, custom, configs, servers])

  const q = filter.trim().toLowerCase()
  const matches = (i: Item) => (show === 'all' || i.source === show) && (!q || `${i.name} ${i.label} ${i.description}`.toLowerCase().includes(q))
  const shown = items.filter(matches)
  const count = (s: Show) => items.filter((i) => s === 'all' || i.source === s).length
  const sections: { id: string; title: string; items: Item[]; note?: ReactNode }[] = [
    ...GROUPS.map((g) => ({ id: g.id, title: g.label, items: shown.filter((i) => i.builtin?.group === g.id), note: undefined })),
    { id: 'mine', title: 'Made by you', items: shown.filter((i) => i.source === 'mine'), note: undefined },
    ...configs.map((c) => {
      const st = servers.find((s) => s.id === c.id)
      const list = shown.filter((i) => i.source === 'mcp' && i.key.startsWith(`m:${c.id}:`))
      const offline = st?.state !== 'ready' && (show === 'all' || show === 'mcp') && (!q || c.name.toLowerCase().includes(q))
      return {
        id: `mcp-${c.id}`,
        title: `From ${c.name}`,
        items: list,
        note: offline ? (
          <button onClick={() => setPage('mcp')} className="w-full rounded-[11px] px-3 py-2.5 text-left text-[12.5px] text-dim hover:bg-elev hover:text-muted">
            {c.enabled ? (st?.state === 'error' ? `${c.name} couldn’t start. Check it on the MCP page.` : `Its tools are listed once ${c.name} is running.`) : `${c.name} is turned off. Turn it on on the MCP page to see its tools.`}
          </button>
        ) : undefined
      }
    })
  ].filter((s) => s.items.length || s.note)

  const sel = items.find((i) => i.key === selKey) ?? null
  const close = () => {
    const key = selKey
    setSelKey(null)
    refocus(key)
  }
  // The tools on screen, in the order they're shown: previous and next step through these.
  const order = sections.flatMap((s) => s.items)
  const step = (d: 1 | -1) => {
    if (!order.length) return
    const at = order.findIndex((i) => i.key === selKey)
    const next = order[at < 0 ? (d > 0 ? 0 : order.length - 1) : (at + d + order.length) % order.length]
    setSelKey(next.key)
    requestAnimationFrame(() => document.querySelector(`[data-focus-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (making || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.matches('input, textarea, select') || el.isContentEditable)) return
      // A modal opened from the drawer handles its own keys.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      // Not while the drawer is open: the search box is behind it.
      if (e.key === '/' && !sel) {
        e.preventDefault()
        document.getElementById('tools-search')?.focus()
      } else if (sel && (e.key === 'ArrowDown' || e.key === 'j')) {
        e.preventDefault()
        step(1)
      } else if (sel && (e.key === 'ArrowUp' || e.key === 'k')) {
        e.preventDefault()
        step(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (making)
    return (
      <ToolMaker
        key={making.id ?? 'new'}
        tool={making.id ? (custom.find((t) => t.id === making.id) ?? null) : null}
        taken={[...custom.filter((t) => t.id !== making.id).map((t) => t.name), ...builtins.map((b) => b.name)]}
        onBack={() => setMaking(null)}
        onSaved={(t) => {
          setMaking(null)
          setSelKey(`c:${t.id}`)
          void load()
        }}
        onDeleted={() => {
          setMaking(null)
          setSelKey(null)
          void load()
        }}
      />
    )

  const details = sel && (
    <ToolDetails
      key={sel.key}
      item={sel}
      usage={usage[sel.name]}
      usedBy={usedBy[sel.name] ?? []}
      agentNames={agentNames}
      onEdit={sel.custom ? () => setMaking({ id: sel.custom!.id }) : undefined}
      onChanged={() => void load()}
      onClose={close}
      onPrev={() => step(-1)}
      onNext={() => step(1)}
    />
  )

  const FILTERS: { value: Show; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'builtin', label: 'Built in' },
    { value: 'mine', label: 'Made by you' },
    { value: 'mcp', label: 'From MCP' }
  ]

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="grid gap-4 px-8 py-6 mobile:px-3 mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <h1 className="text-[18px] font-semibold tracking-tight">Tools</h1>
            </div>
            <div className="relative w-[260px] mobile:w-full">
              <Search size={13} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
              <Input id="tools-search" className="pl-7" placeholder="Search tools…" aria-label="Search tools" spellCheck={false} autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setMaking({ id: null })}>
              New tool
            </Button>
          </div>

          <div className="sticky top-0 z-[5] flex items-center gap-3 border-b border-line bg-bg py-2">
            <div role="tablist" aria-label="Show" className="flex flex-wrap gap-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  role="tab"
                  aria-selected={show === f.value}
                  onClick={() => setShow(f.value)}
                  className={clsx('flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px]', show === f.value ? 'bg-elev-2 font-medium text-fg' : 'text-muted hover:bg-elev hover:text-fg')}
                >
                  {f.label}
                  <span className="text-[11px] tabular-nums text-dim">{count(f.value)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid min-w-0 gap-6">
            {sections.map((s) => (
              <section key={s.id} aria-label={s.title}>
                <h2 className="mb-3 border-b border-line pb-2 text-[12px] font-semibold text-fg/90">
                  {s.title}
                  <span className="ml-2 text-[11.5px] font-normal tabular-nums text-dim">{s.items.length}</span>
                </h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
                  {s.items.map((i) => (
                    <ToolCard key={i.key} item={i} usage={usage[i.name]} selected={selKey === i.key} onOpen={() => setSelKey(i.key)} />
                  ))}
                  {s.note && <div className="col-span-full">{s.note}</div>}
                </div>
              </section>
            ))}
            {!shown.length && builtins.length > 0 && (
              <div className="grid justify-items-center gap-2 rounded-[14px] border border-dashed border-line-strong px-4 py-7 text-center">
                <div className="text-[13.5px] font-semibold">{q ? `No tool matches “${filter.trim()}”` : 'Nothing here yet'}</div>
                <div className="text-[12.5px] text-dim">Make one: describe what it should do and Cloth drafts it.</div>
                <Button size="sm" icon={<Plus size={12} />} onClick={() => setMaking({ id: null })}>
                  New tool
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      <Inspector open={!!sel} label={sel?.label ?? 'Tool'} onClose={close} width={440}>
        <div className="min-h-0 flex-1 overflow-y-auto">{details}</div>
      </Inspector>
    </div>
  )
}

function ToolCard({ item: i, usage, selected, onOpen }: { item: Item; usage?: ToolUsage; selected: boolean; onOpen(): void }) {
  const pending = i.custom && waiting(i.custom)
  const daily = usage?.daily ?? []
  const peak = Math.max(1, ...daily)
  return (
    <button
      data-focus-key={i.key}
      onClick={onOpen}
      aria-pressed={selected}
      className={clsx(
        'group flex flex-col overflow-hidden rounded-[12px] border text-left transition-colors focus-visible:ring-2 focus-visible:ring-crimson-line',
        selected ? 'border-crimson-line bg-elev ring-1 ring-crimson-line' : 'border-line bg-panel hover:border-line-strong'
      )}
    >
      <span className="flex gap-3 p-3.5">
        <span aria-hidden="true" className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]', SOURCE_TILE[i.source])}>
          <i.icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[13.5px] font-semibold">{i.label}</span>
            <span className="truncate font-mono text-[11px] text-dim" translate="no">
              {i.source === 'mcp' ? i.name.replace(/^mcp__/, '').replace('__', ' / ') : i.name}
            </span>
          </span>
          <span className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-muted">{i.description}</span>
        </span>
      </span>
      <span className="mt-auto flex items-center gap-2 border-t border-line px-3.5 py-2 text-[11.5px] text-dim">
        <span className="min-w-0 truncate">{i.source === 'builtin' ? 'Built in' : i.source === 'mcp' ? i.server : i.kindLabel}</span>
        {pending ? (
          <span className="ml-auto shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">Needs your OK</span>
        ) : usage ? (
          <>
            <span className="ml-auto shrink-0 tabular-nums">
              {usage.calls} use{usage.calls === 1 ? '' : 's'} this month
            </span>
            {daily.length > 0 && (
              <span aria-hidden="true" className="inline-flex h-3 shrink-0 items-end gap-px">
                {daily.map((n, d) => (
                  <i key={d} style={{ height: `${Math.max(1, (n / peak) * 12)}px` }} className={clsx('w-[2px] rounded-[1px]', selected ? 'bg-dim' : 'bg-line-strong group-hover:bg-dim')} />
                ))}
              </span>
            )}
          </>
        ) : (
          <span className="ml-auto shrink-0">Not used yet</span>
        )}
      </span>
    </button>
  )
}

type SchemaProps = { properties?: Record<string, { type?: string; description?: string; anyOf?: { const?: string }[]; items?: { type?: string } }>; required?: string[] }

function ToolDetails({
  item: i,
  usage,
  usedBy,
  agentNames,
  onEdit,
  onChanged,
  onClose,
  onPrev,
  onNext
}: {
  item: Item
  usage?: ToolUsage
  usedBy: string[]
  agentNames: string[]
  onEdit?: () => void
  onChanged(): void
  onClose(): void
  onPrev(): void
  onNext(): void
}) {
  const t = i.custom
  const aiSchema = i.builtin?.schema ?? i.schema
  const params: Field[] = t ? t.params : fieldsOf(aiSchema as SchemaProps | undefined)
  const daily = usage?.daily ?? []
  const peak = Math.max(1, ...daily)
  // Every agent having it reads better as one phrase than as a list of all of them.
  const everyAgent = agentNames.length > 1 && agentNames.every((n) => usedBy.includes(n))
  const users = everyAgent ? ['Every agent', ...usedBy.filter((n) => !agentNames.includes(n))] : usedBy
  const origin = t && t.createdBy !== 'user' ? (t.createdBy === 'chat' ? 'in a chat' : 'for an app connected over MCP') : null
  const runsCode = t && (t.kind === 'command' || t.kind === 'javascript')
  return (
    <div className="grid gap-5 px-5 py-5">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className={clsx('flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[11px]', SOURCE_TILE[i.source])}>
          <i.icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-semibold">{i.label}</h2>
          <div className="truncate font-mono text-[11.5px] text-dim" translate="no">
            {i.name}
          </div>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <IconButton aria-label="Previous tool" title="Previous tool (↑ or K)" onClick={onPrev}>
            <ChevronUp size={15} />
          </IconButton>
          <IconButton aria-label="Next tool" title="Next tool (↓ or J)" onClick={onNext}>
            <ChevronDown size={15} />
          </IconButton>
          <IconButton aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-fg/90">{i.description}</p>

      {t && waiting(t) && (
        <div className="grid gap-2.5 rounded-[11px] border border-warn/35 bg-warn/5 p-3">
          <div className="flex gap-2 text-[12.5px] leading-relaxed">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            <span>
              {origin ? `Cloth made this tool ${origin}. ` : 'This tool is switched off. '}
              {runsCode ? 'It runs code on your computer, so it waits for your OK before any agent can use it.' : 'Agents can use it once you allow it.'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                if (await attempt(() => api.tools.setEnabled(t.id, true), 'Tool allowed')) onChanged()
              }}
            >
              Allow this tool
            </Button>
            {onEdit && (
              <Button size="sm" onClick={onEdit}>
                Review settings
              </Button>
            )}
          </div>
        </div>
      )}

      {onEdit && <Button onClick={onEdit}>Edit tool</Button>}

      <section aria-labelledby="tool-usage" className="grid gap-2 border-t border-line pt-4">
        <h3 id="tool-usage" className="text-[12.5px] font-semibold">
          Usage
        </h3>
        {usage ? (
          <div>
            <div className="grid grid-cols-3 rounded-[10px] border border-line">
              {[
                [String(usage.calls), 'uses in 30 days'],
                [usage.lastAt ? timeAgo(usage.lastAt) : '—', 'last used'],
                [String(usage.errors), 'failed']
              ].map(([value, label], n) => (
                <div key={label} className={clsx('min-w-0 px-3 py-2.5', n > 0 && 'border-l border-line')}>
                  <div className="truncate text-[15px] font-semibold tabular-nums">{value}</div>
                  <div className="text-[11.5px] text-dim">{label}</div>
                </div>
              ))}
            </div>
            {daily.length > 0 && (
              <>
                <div role="img" aria-label="Uses per day over the last 14 days" className="mt-2.5 flex h-9 items-end gap-[2px]">
                  {daily.map((n, d) => (
                    <i key={d} style={{ height: `${(n / peak) * 100}%` }} className="min-h-[2px] flex-1 rounded-t-[2px] bg-crimson-line" />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-dim">
                  <span>14 days ago</span>
                  <span>today</span>
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-[12px] text-dim">Not used in the last 30 days.</p>
        )}
      </section>

      <section aria-labelledby="tool-inputs" className="grid gap-2">
        <h3 id="tool-inputs" className="text-[12.5px] font-semibold">
          Inputs
        </h3>
        {params.length ? (
          <div className="rounded-[10px] border border-line">
            {params.map((p, n) => (
              <div key={p.name} className={clsx('grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 px-3 py-2.5', n > 0 && 'border-t border-line')}>
                <span className="min-w-0 break-words font-mono text-[12px]" translate="no">
                  {p.name}
                  {p.required && (
                    <span className="text-crimson-hi" title="Required">
                      {' *'}
                    </span>
                  )}
                </span>
                <span className="text-right text-[11.5px] text-dim">{PARAM_TYPES.find((x) => x.value === p.type)?.label ?? p.type}</span>
                {p.description && <p className="col-span-full text-[12px] text-muted">{p.description}</p>}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-dim">Nothing; it runs as it is.</p>
        )}
      </section>

      <section aria-labelledby="usedby" className="grid gap-2">
        <h3 id="usedby" className="text-[12.5px] font-semibold">
          Used by
        </h3>
        {users.length ? (
          <div className="flex flex-wrap gap-1.5">
            {users.map((u) => (
              <span key={u} className="rounded-md border border-line px-2 py-0.5 text-[12px]">
                {u}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[13px] leading-relaxed">No agent or automation has it yet.</p>
        )}
      </section>

      {aiSchema && (
        <details>
          <summary className="cursor-default text-[12px] text-dim hover:text-muted">What the AI sees</summary>
          <pre className="selectable mt-2 overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-[11.5px] text-muted">{JSON.stringify(aiSchema, null, 2)}</pre>
        </details>
      )}

      <div className="flex items-center border-t border-line pt-3 text-[11.5px] text-dim">
        <span className="min-w-0 truncate">Provided by {i.source === 'builtin' ? 'Cloth' : i.source === 'mine' ? 'you' : i.server}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span aria-hidden="true" className={clsx('h-1.5 w-1.5 rounded-full', t && waiting(t) ? 'bg-warn' : 'bg-ok')} />
          {t && waiting(t) ? 'Waiting for your OK' : 'Available to agents'}
        </span>
      </div>
    </div>
  )
}

type Field = Pick<ToolParam, 'name' | 'type' | 'required' | 'description'>

/** A JSON schema's properties as plain inputs: text, number, yes or no, or JSON for lists and objects. */
function fieldsOf(schema: SchemaProps | undefined): Field[] {
  return Object.entries(schema?.properties ?? {}).map(([name, p]) => ({
    name,
    description: p.description ?? '',
    required: !!schema?.required?.includes(name),
    type: p.type === 'number' || p.type === 'integer' ? 'number' : p.type === 'boolean' ? 'boolean' : p.type === 'array' || p.type === 'object' ? 'json' : 'string'
  }))
}

/** Fill in a tool's inputs and run it, without the JSON. File tools also get a folder to look in. */
function TryIt({ fields, run: runTool, folder: needsFolder, title = 'Try it' }: { fields: Field[]; run(args: Record<string, unknown>, folder: string | null): Promise<ToolRunResult>; folder?: boolean; title?: string }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ToolRunResult | null>(null)
  const [running, setRunning] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  const run = async () => {
    const args: Record<string, unknown> = {}
    for (const p of fields) {
      const v = values[p.name] ?? ''
      if (!v.trim()) continue
      if (p.type === 'number') args[p.name] = Number(v)
      else if (p.type === 'boolean') args[p.name] = v === 'true'
      else if (p.type === 'json') {
        try {
          args[p.name] = JSON.parse(v)
        } catch {
          setResult({ ok: false, output: '', error: `${p.name} isn’t valid JSON. Check the brackets and quotes.`, durationMs: 0 })
          return
        }
      } else args[p.name] = v
    }
    setRunning(true)
    setResult(await runTool(args, folder))
    setRunning(false)
  }
  return (
    <section aria-label={title} className="grid gap-2.5 border-t border-line pt-4">
      <h3 className="text-[12px] font-medium text-muted">{title}</h3>
      {needsFolder && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          Look in
          <Button
            size="sm"
            onClick={async () => {
              const [dir] = await api.app.pickPaths({ directory: true, title: 'Folder to try it in' })
              if (dir) setFolder(dir)
            }}
          >
            {folder ? folder.split(/[\\/]/).filter(Boolean).pop() : 'Choose a folder'}
          </Button>
          <span className="text-dim">It only reads; nothing is changed.</span>
        </div>
      )}
      {fields.map((p) => (
        <label key={p.name} className="grid gap-1">
          <span className="font-mono text-[11.5px] text-muted" translate="no">
            {p.name}
            {!p.required && <span className="font-sans text-dim"> (optional)</span>}
          </span>
          {p.type === 'boolean' ? (
            <Select value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}>
              <option value="">Leave out</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          ) : (
            <Input className="font-mono" spellCheck={false} autoComplete="off" placeholder={p.description ? `${p.description}…` : undefined} value={values[p.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
          )}
        </label>
      ))}
      <Button size="sm" className="justify-self-start" icon={<Play size={11} fill="currentColor" />} loading={running} onClick={() => void run()}>
        Run tool
      </Button>
      {result && (
        <div className="grid gap-1.5" aria-live="polite">
          <div className="flex items-center gap-2 text-[12px]">
            <span className={clsx('h-2 w-2 rounded-full', result.ok ? 'bg-ok' : 'bg-crimson')} aria-hidden="true" />
            <span className={result.ok ? 'text-ok' : 'text-danger-hi'}>{result.ok ? 'Worked' : 'Failed'}</span>
            <span className="text-dim">in {duration(result.durationMs)}</span>
          </div>
          <pre className={clsx('selectable max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-[11.5px]', result.ok ? 'text-fg' : 'text-danger-hi')}>{result.ok ? result.output : result.error}</pre>
        </div>
      )}
    </section>
  )
}

const blankTool = (taken: string[]): CustomToolInput => {
  let name = 'new_tool'
  for (let i = 2; taken.includes(name); i++) name = `new_tool_${i}`
  return { name, description: '', kind: 'http', params: [], config: { ...STARTER.http }, enabled: true }
}

/** Making or changing a tool, as numbered steps, with a test beside it. */
function ToolMaker({ tool, taken, onBack, onSaved, onDeleted }: { tool: CustomTool | null; taken: string[]; onBack(): void; onSaved(t: CustomTool): void; onDeleted(): void }) {
  const initial = useMemo<CustomToolInput>(() => (tool ? { name: tool.name, description: tool.description, kind: tool.kind, params: tool.params, config: tool.config, enabled: tool.enabled } : blankTool(taken)), [tool]) // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<CustomToolInput>(initial)
  const [saving, setSaving] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const set = (patch: Partial<CustomToolInput>) => setDraft((d) => ({ ...d, ...patch }))
  const setConfig = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }))
  const runsCode = draft.kind === 'command' || draft.kind === 'javascript'
  const nameOk = /^[a-z][a-z0-9_]{1,63}$/.test(draft.name)

  const save = async () => {
    setSaving(true)
    // Saving here is the user's OK: what they made or reviewed is allowed.
    const input = { ...draft, enabled: true }
    const t = await attempt(() => (tool ? api.tools.update(tool.id, input) : api.tools.create(input)), tool ? 'Tool saved' : 'Tool made')
    setSaving(false)
    if (t) onSaved(t)
  }
  const back = async () => {
    if (dirty && !(await confirmAction('Your changes to this tool will be lost.', { title: 'Leave without saving?', confirmLabel: 'Leave' }))) return
    onBack()
  }
  const draftIt = async () => {
    setDrafting(true)
    const d = await attempt(() => api.tools.draft(draft.description))
    setDrafting(false)
    if (d) setDraft({ ...d, description: d.description || draft.description, enabled: true })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-5 py-5 mobile:w-[calc(100%-24px)]">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => void back()} className="flex h-9 items-center gap-1.5 rounded-lg px-1.5 text-[13px] text-muted hover:text-fg">
            <ArrowLeft size={15} aria-hidden="true" />
            Tools
          </button>
          <span className="text-line-strong" aria-hidden="true">
            /
          </span>
          <label className="min-w-[200px] flex-1">
            <span className="sr-only">Tool name, as the AI calls it</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_') })} spellCheck={false} autoComplete="off" className="w-full bg-transparent py-1 font-mono text-[18px] font-semibold outline-none" />
          </label>
          {tool && (
            <IconButton
              title="Delete tool"
              aria-label="Delete tool"
              onClick={async () => {
                if (!(await confirmAction(`Agents and automations that use “${tool.name}” will no longer be able to call it.`, { title: 'Delete tool?', confirmLabel: 'Delete', danger: true }))) return
                if (await attempt(() => api.tools.remove(tool.id).then(() => true))) onDeleted()
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          )}
          <Button variant="primary" loading={saving} disabled={!nameOk} onClick={() => void save()}>
            Save tool
          </Button>
        </div>
        {!nameOk && <p className="-mt-3 text-[12px] text-warn">Name it in lowercase with underscores, like weather_for_city.</p>}

        {tool && waiting(tool) && (
          <div className="flex items-start gap-2.5 rounded-[11px] border border-warn/35 bg-warn/5 p-3 text-[12.5px]">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            <span>A model made this tool. Read its settings and try it on the right; saving it allows agents to use it.</span>
          </div>
        )}

        <div className="grid items-start gap-6 min-[1000px]:grid-cols-[minmax(0,1fr)_380px]">
          <ol className="grid min-w-0">
            <Step n={1} title="What should it do?">
              <Textarea rows={3} aria-label="What the tool does" value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Get today’s weather for a city: temperature, rain chance and wind. Use it when I ask about the weather…" className="text-[13.5px]" />
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" icon={<Sparkles size={13} />} loading={drafting} disabled={!draft.description.trim()} onClick={() => void draftIt()}>
                  Draft the rest for me
                </Button>
                <span className="text-[12px] text-dim">The AI reads this to decide when to use it.</span>
              </div>
            </Step>

            <Step n={2} title="How does it work?">
              <div role="radiogroup" aria-label="How it works" className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
                {(Object.keys(KINDS) as CustomToolKind[]).map((k) => {
                  const K = KINDS[k]
                  const on = draft.kind === k
                  return (
                    <button
                      key={k}
                      role="radio"
                      aria-checked={on}
                      onClick={() => !on && setDraft((d) => ({ ...d, kind: k, config: { ...STARTER[k] } }))}
                      className={clsx('flex min-h-[78px] gap-3 rounded-[12px] border p-3 text-left', on ? 'border-crimson-line bg-crimson-soft' : 'border-line hover:border-line-strong')}
                    >
                      <span aria-hidden="true" className={clsx('flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]', on ? 'bg-crimson text-white' : 'bg-elev-2 text-muted')}>
                        <K.icon size={16} />
                      </span>
                      <span className="grid content-start gap-0.5">
                        <span className="text-[13px] font-semibold">{K.label}</span>
                        <span className="text-[12px] text-dim">{K.blurb}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
              {runsCode && (
                <p className="flex items-center gap-2 text-[12px] text-warn">
                  <AlertTriangle size={14} aria-hidden="true" />
                  This runs on your computer. Only add code you trust.
                </p>
              )}
            </Step>

            <Step n={3} title="What does it need?">
              <ParamsEditor params={draft.params} onChange={(params) => set({ params })} />
            </Step>

            <Step n={4} title={SETUP_TITLE[draft.kind]} last>
              <KindConfig kind={draft.kind} config={draft.config} setConfig={setConfig} params={draft.params} />
            </Step>
          </ol>

          <aside aria-label="Test" className="grid gap-3 min-[1000px]:sticky min-[1000px]:top-4">
            <div className="rounded-[16px] border border-line bg-panel px-4 pb-4">
              <TryIt key={draft.params.map((p) => p.name).join()} fields={draft.params} run={(args) => api.tools.test({ kind: draft.kind, config: draft.config, params: draft.params }, args)} title="Test it" />
            </div>
            <details className="rounded-[16px] border border-line bg-panel px-4 py-3">
              <summary className="cursor-default text-[12.5px] font-medium">What the AI sees</summary>
              <pre className="selectable mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] text-muted">
                {[draft.name, draft.description || '(no description yet)', '', ...draft.params.map((p) => `${p.name}  ${PARAM_TYPES.find((x) => x.value === p.type)?.label.toLowerCase()}  ${p.required ? 'needed' : 'optional'}  ${p.description}`)].join('\n')}
              </pre>
            </details>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Step({ n, title, hint, last, children }: { n: number; title: string; hint?: string; last?: boolean; children: ReactNode }) {
  return (
    <li className={clsx('relative grid gap-3 pl-12', last ? 'pb-2' : 'pb-8')}>
      {!last && <span aria-hidden="true" className="absolute bottom-1 left-[13px] top-9 w-0.5 bg-elev-2" />}
      <span aria-hidden="true" className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-elev text-[12.5px] font-semibold">
        {n}
      </span>
      <div className="flex min-h-7 flex-wrap items-baseline gap-x-3">
        <h2 className="text-[15px] font-semibold leading-7">{title}</h2>
        {hint && <span className="text-[12px] text-dim">{hint}</span>}
      </div>
      {children}
    </li>
  )
}

function ParamsEditor({ params, onChange }: { params: ToolParam[]; onChange(p: ToolParam[]): void }) {
  const update = (i: number, patch: Partial<ToolParam>) => onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="grid gap-2">
      {params.length > 0 && (
        <div className="grid grid-cols-[minmax(110px,1fr)_minmax(110px,0.8fr)_minmax(160px,2fr)_auto_auto] items-center gap-2 mobile:grid-cols-1">
          <span className="text-[11.5px] text-dim mobile:hidden">Name</span>
          <span className="text-[11.5px] text-dim mobile:hidden">Kind</span>
          <span className="text-[11.5px] text-dim mobile:hidden">Tell the AI what to put here</span>
          <span className="text-[11.5px] text-dim mobile:hidden">Needed</span>
          <span className="mobile:hidden" />
          {params.map((p, i) => (
            <Fragment key={i}>
              <Input aria-label={`Input ${i + 1} name`} className="font-mono" spellCheck={false} autoComplete="off" value={p.name} onChange={(e) => update(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]+/g, '_') })} />
              <Select aria-label={`Input ${i + 1} kind`} value={p.type} onChange={(e) => update(i, { type: e.target.value as ToolParamType })}>
                {PARAM_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Input aria-label={`Input ${i + 1}: what to put here`} placeholder="e.g. City name, like Lisbon…" value={p.description} onChange={(e) => update(i, { description: e.target.value })} />
              <input aria-label={`Input ${i + 1} is needed`} type="checkbox" className="h-4 w-4 justify-self-center accent-[#dc2645]" checked={p.required} onChange={(e) => update(i, { required: e.target.checked })} />
              <IconButton aria-label={`Remove input ${i + 1}`} title="Remove" onClick={() => onChange(params.filter((_, j) => j !== i))}>
                <Trash2 size={12} />
              </IconButton>
            </Fragment>
          ))}
        </div>
      )}
      {!params.length && <p className="text-[12.5px] text-dim">Nothing yet. The tool runs with no inputs.</p>}
      <Button size="sm" className="justify-self-start" icon={<Plus size={12} />} onClick={() => onChange([...params, { name: `input${params.length + 1}`, type: 'string', description: '', required: true }])}>
        Add an input
      </Button>
    </div>
  )
}

function KindConfig({ kind, config, setConfig, params }: { kind: CustomToolKind; config: Record<string, any>; setConfig(p: Record<string, unknown>): void; params: ToolParam[] }) {
  const str = (k: string) => String(config[k] ?? '')
  // Buttons that insert an input's {{placeholder}} at the end of a field.
  const inserts = (field: string) =>
    params.length > 0 && (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11.5px] text-dim">Insert an input:</span>
        {params.map((p) => (
          <button key={p.name} onClick={() => setConfig({ [field]: `${str(field)}{{${p.name}}}` })} className="h-7 rounded-full border border-dashed border-line-strong px-2.5 font-mono text-[11.5px] text-muted hover:border-solid hover:text-fg">
            {p.name}
          </button>
        ))}
      </div>
    )
  switch (kind) {
    case 'http':
      return (
        <div className="grid gap-3">
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <Select aria-label="Method" value={str('method') || 'GET'} onChange={(e) => setConfig({ method: e.target.value })}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
            <Input aria-label="Web address" className="font-mono text-[12px]" spellCheck={false} autoComplete="off" value={str('url')} onChange={(e) => setConfig({ url: e.target.value })} placeholder="https://api.example.com/items/{{id}}…" />
          </div>
          {inserts('url')}
          <details>
            <summary className="cursor-default text-[12.5px] text-muted hover:text-fg">Headers{config.method && config.method !== 'GET' ? ' and body' : ''}</summary>
            <div className="mt-2 grid gap-3">
              <Field label="Headers (JSON)">
                <Textarea rows={3} className="font-mono text-[11.5px]" spellCheck={false} value={str('headers')} onChange={(e) => setConfig({ headers: e.target.value })} />
              </Field>
              {config.method && config.method !== 'GET' && (
                <Field label="Body" hint="Leave empty to send every input as JSON.">
                  <Textarea rows={4} className="font-mono text-[11.5px]" spellCheck={false} value={str('body')} onChange={(e) => setConfig({ body: e.target.value })} />
                </Field>
              )}
              <TimeoutField value={config.timeoutMs} onChange={(timeoutMs) => setConfig({ timeoutMs })} />
            </div>
          </details>
        </div>
      )
    case 'javascript':
      return (
        <div className="grid gap-2">
          <p className="text-[12px] text-dim">
            Inputs are in <span className="font-mono text-muted">args</span>. You can use fetch, and <span className="font-mono text-muted">workspace</span> to read and write files in the run’s folder; require("pptxgenjs") and require("docx") make PowerPoint and Word files. Return the result.
          </p>
          <div className="h-64 overflow-hidden rounded-lg border border-line bg-bg">
            <Editor value={str('code')} onChange={(code) => setConfig({ code })} lang="javascript" />
          </div>
          <TimeoutField value={config.timeoutMs} onChange={(timeoutMs) => setConfig({ timeoutMs })} />
        </div>
      )
    case 'command':
      return (
        <div className="grid gap-3">
          <Field label="Program" hint="A name on PATH (git, node, python) or a full path.">
            <div className="flex gap-2">
              <Input className="font-mono" spellCheck={false} autoComplete="off" value={str('command')} onChange={(e) => setConfig({ command: e.target.value })} />
              <Button
                onClick={async () => {
                  const [f] = await api.app.pickPaths({ title: 'Choose a program' })
                  if (f) setConfig({ command: f })
                }}
              >
                Browse
              </Button>
            </div>
          </Field>
          <Field label="Arguments, one per line" hint="No shell: each line is one argument.">
            <Textarea rows={5} className="font-mono text-[11.5px]" spellCheck={false} value={str('args')} onChange={(e) => setConfig({ args: e.target.value })} />
          </Field>
          {inserts('args')}
          <details>
            <summary className="cursor-default text-[12.5px] text-muted hover:text-fg">Folder and time limit</summary>
            <div className="mt-2 grid gap-3">
              <Field label="Run it in this folder (optional)">
                <Input className="font-mono" spellCheck={false} value={str('cwd')} onChange={(e) => setConfig({ cwd: e.target.value })} />
              </Field>
              <TimeoutField value={config.timeoutMs} onChange={(timeoutMs) => setConfig({ timeoutMs })} />
            </div>
          </details>
        </div>
      )
    case 'prompt':
      return (
        <div className="grid gap-3">
          <Field label="Prompt">
            <Textarea rows={5} className="text-[13px]" value={str('prompt')} onChange={(e) => setConfig({ prompt: e.target.value })} placeholder="Give a one-line weather summary for {{city}}…" />
          </Field>
          {inserts('prompt')}
          <Field label="Model">
            <ModelPicker value={(config.model as ModelRef) ?? null} onChange={(model) => setConfig({ model })} allowNone noneLabel="Default model" />
          </Field>
          <details>
            <summary className="cursor-default text-[12.5px] text-muted hover:text-fg">Instructions for the model (optional)</summary>
            <Textarea rows={2} className="mt-2" aria-label="Instructions for the model" value={str('system')} onChange={(e) => setConfig({ system: e.target.value })} />
          </details>
        </div>
      )
  }
}

function TimeoutField({ value, onChange }: { value: unknown; onChange(v: number): void }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-muted">
      Give up after
      <Input type="number" className="w-24" value={Math.round((Number(value) || 30000) / 1000)} onChange={(e) => onChange(Math.max(1, Number(e.target.value)) * 1000)} />
      seconds
    </label>
  )
}
