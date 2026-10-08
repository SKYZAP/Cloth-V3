import { Fragment, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Search, Code2, Globe, Link2, MessageSquareText, Play, Plus, Save, ShieldAlert, SquareTerminal, Trash2, X } from 'lucide-react'
import type { BuiltinToolInfo, CustomTool, CustomToolInput, CustomToolKind, McpClientStatus, ModelRef, ToolOrigin, ToolParam, ToolParamType, ToolRunResult, ToolUsage, ToolWhere } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Inspector, InspectorHead, refocus } from '@/components/Inspector'
import { duration, timeAgo } from '@/lib/format'
import { Badge, Button, Field, IconButton, Input, Modal, PageHeader, Segmented, Select, Switch, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Editor } from '@/components/Editor'

const KINDS: Record<CustomToolKind, { label: string; icon: typeof Globe; blurb: string }> = {
  http: { label: 'HTTP request', icon: Link2, blurb: 'Call a REST API. URL, headers and body are templates over the parameters.' },
  javascript: { label: 'JavaScript', icon: Code2, blurb: 'Async function body with args, fetch, workspace and require("pptxgenjs" | "docx") in scope. Return a value.' },
  command: { label: 'Command', icon: SquareTerminal, blurb: 'Run an executable (no shell). One templated argument per line.' },
  prompt: { label: 'Prompt', icon: MessageSquareText, blurb: 'Call a model with a templated prompt — a reusable sub-task.' }
}

const ORIGIN: Record<Exclude<ToolOrigin, 'user'>, string> = { chat: 'a chat', mcp: 'an MCP client' }

const TEMPLATES: Record<CustomToolKind, CustomToolInput> = {
  http: {
    name: 'github_repo',
    description: 'Look up a public GitHub repository: description, stars, open issues and default branch.',
    kind: 'http',
    params: [
      { name: 'owner', type: 'string', description: 'Repository owner, e.g. vercel', required: true },
      { name: 'repo', type: 'string', description: 'Repository name, e.g. next.js', required: true }
    ],
    config: { method: 'GET', url: 'https://api.github.com/repos/{{owner}}/{{repo}}', headers: '{\n  "accept": "application/vnd.github+json"\n}', body: '', timeoutMs: 15000 }
  },
  javascript: {
    name: 'date_math',
    description: 'Add or subtract days from a date and return the ISO date and weekday.',
    kind: 'javascript',
    params: [
      { name: 'date', type: 'string', description: 'Start date (ISO); defaults to today', required: false },
      { name: 'days', type: 'number', description: 'Days to add (negative to subtract)', required: true }
    ],
    config: {
      code: "const d = args.date ? new Date(args.date) : new Date()\nd.setDate(d.getDate() + args.days)\nreturn {\n  date: d.toISOString().slice(0, 10),\n  weekday: d.toLocaleDateString('en-US', { weekday: 'long' })\n}",
      timeoutMs: 5000
    }
  },
  command: {
    name: 'git_recent_commits',
    description: 'List the most recent commits of a local git repository.',
    kind: 'command',
    params: [
      { name: 'repo', type: 'string', description: 'Absolute path of the repository', required: true },
      { name: 'count', type: 'number', description: 'How many commits', required: false }
    ],
    config: { command: 'git', args: '-C\n{{repo}}\nlog\n--oneline\n-n\n{{count}}', cwd: '', timeoutMs: 15000 }
  },
  prompt: {
    name: 'explain_error',
    description: 'Explain a compiler or runtime error message and suggest the most likely fix.',
    kind: 'prompt',
    params: [{ name: 'error', type: 'string', description: 'The full error message / stack trace', required: true }],
    config: { model: null, system: 'You are a senior engineer. Be brief and concrete.', prompt: 'Explain this error and give the most likely fix:\n\n{{error}}' }
  }
}

type Selection = { kind: 'builtin'; name: string } | { kind: 'custom'; id: string } | null
type Place = 'all' | keyof ToolWhere

const PLACES: { value: Place; label: string; title: string }[] = [
  { value: 'all', label: 'Everywhere', title: 'Every tool' },
  { value: 'chats', label: 'Chats', title: 'What a chat can call' },
  { value: 'subagents', label: 'Subagents', title: 'What a subagent can call' },
  { value: 'flows', label: 'Flows', title: "What a flow's Agent step can call" },
  { value: 'apps', label: 'Apps over MCP', title: 'What apps connected to Cloth can call' }
]
const PLACE_KEYS: (keyof ToolWhere)[] = ['chats', 'subagents', 'flows', 'apps']
const PLACE_NAME: Record<keyof ToolWhere, string> = { chats: 'chats', subagents: 'subagents', flows: 'flows', apps: 'apps over MCP' }

const GROUPS: { id: BuiltinToolInfo['group']; label: string }[] = [
  { id: 'workspace', label: 'Files and code' },
  { id: 'web', label: 'Web' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'planning', label: 'Planning' },
  { id: 'skills', label: 'Skills' },
  { id: 'tools', label: 'Making tools' }
]

/** Custom tools work wherever custom tools are on: chats, their subagents and flow Agent steps. */
const CUSTOM_WHERE: ToolWhere = { chats: true, subagents: true, flows: true, apps: false }

/** Why a tool isn't available somewhere, in a sentence. */
function whyNot(name: string, place: keyof ToolWhere): string {
  if (place === 'apps') return "Cloth's MCP server doesn't share it"
  if (place === 'subagents') {
    if (name === 'task') return "Subagents can't start subagents of their own"
    if (name === 'todo_write' || name === 'ask_user') return 'Only the chat itself plans with you and asks you questions'
    return 'Only chats add to Cloth’s knowledge, skills and tools'
  }
  if (name === 'lsp') return 'Flow steps run without code intelligence'
  if (name === 'powershell' || name === 'bash') return "Flow steps can't run commands"
  if (name === 'task') return "Flow steps can't start subagents"
  if (name === 'todo_write' || name === 'ask_user') return 'Nobody is watching a flow run to plan with or ask'
  return 'Only chats add to Cloth’s knowledge, skills and tools'
}

const whereLabel = (w: ToolWhere) => {
  const yes = PLACE_KEYS.filter((k) => w[k]).map((k) => PLACE_NAME[k])
  const no = PLACE_KEYS.filter((k) => !w[k]).map((k) => PLACE_NAME[k])
  return `Works in ${yes.join(', ') || 'nothing'}${no.length ? `; not in ${no.join(', ')}` : ''}`
}

/**
 * What agents can do and where: tools grouped by purpose, four squares per tool for chats, subagents,
 * flows and apps over MCP, calls this month, and details beside the map.
 */
export function ToolsPage() {
  const [builtins, setBuiltins] = useState<BuiltinToolInfo[]>([])
  const [custom, setCustom] = useState<CustomTool[]>([])
  const [usage, setUsage] = useState<Record<string, ToolUsage>>({})
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const [sel, setSel] = useState<Selection>(null)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')
  const [place, setPlace] = useState<Place>(() => (localStorage.getItem('cloth.tools.place') as Place | null) ?? 'all')
  const settings = useApp((s) => s.settings)
  const setPage = useApp((s) => s.setPage)

  const load = async (select?: Selection) => {
    const [b, c, u, m] = await Promise.all([api.tools.builtins(), api.tools.list(), api.tools.usage().catch(() => ({})), api.mcp.clients().catch(() => [])])
    setBuiltins(b)
    setCustom(c)
    setUsage(u)
    setServers(m)
    if (select !== undefined) setSel(select)
  }
  useEffect(() => {
    void load()
  }, [])
  // Tools made by a model (chat or MCP) appear without a reload.
  useEvent('tools', () => void load())
  useEvent('mcpClients', () => void api.mcp.clients().then(setServers, () => undefined))
  useEffect(() => {
    try {
      localStorage.setItem('cloth.tools.place', place)
    } catch {
      /* storage unavailable */
    }
  }, [place])

  const q = filter.trim().toLowerCase()
  const match = (s: string) => !q || s.toLowerCase().includes(q)
  const fits = (w: ToolWhere) => place === 'all' || w[place]
  const selectedBuiltin = sel?.kind === 'builtin' ? builtins.find((b) => b.name === sel.name) : undefined
  const selectedCustom = sel?.kind === 'custom' ? custom.find((c) => c.id === sel.id) : undefined
  const selKey = sel?.kind === 'builtin' ? sel.name : sel?.kind === 'custom' ? sel.id : null
  const close = () => {
    const key = selKey
    setSel(null)
    refocus(key)
  }
  const configs = settings?.mcpClients ?? []
  const ownOn = custom.filter((c) => c.enabled).length
  const summary = [
    `${builtins.length} built in`,
    configs.length ? `${configs.length} external server${configs.length === 1 ? '' : 's'}` : null,
    custom.length ? `${custom.length} of your own${ownOn < custom.length ? ` (${ownOn} on)` : ''}` : 'none of your own yet'
  ]
    .filter(Boolean)
    .join(', ')

  // Within a group, the tools doing the work come first.
  const groups = GROUPS.map((g) => ({
    ...g,
    tools: builtins.filter((b) => b.group === g.id && match(b.name + b.label + b.description) && fits(b.where)).sort((a, b) => (usage[b.name]?.calls ?? 0) - (usage[a.name]?.calls ?? 0))
  })).filter((g) => g.tools.length)
  const own = custom.filter((t) => match(t.name + t.description) && fits(CUSTOM_WHERE))
  const showServers = (place === 'all' || place === 'chats' || place === 'subagents') && configs.some((c) => match(c.name))

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-5 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <h1 className="text-[18px] font-semibold tracking-tight">Tools</h1>
              <p className="mt-0.5 text-[12.5px] text-dim">{builtins.length ? summary : '…'}</p>
            </div>
            <div role="radiogroup" aria-label="Show tools that work in">
              <Segmented value={place} onChange={setPlace} items={PLACES} />
            </div>
            <div className="relative w-[200px] mobile:w-full">
              <Search size={13} className="absolute left-2.5 top-2.5 text-dim" aria-hidden="true" />
              <Input className="pl-7" placeholder="Filter tools" aria-label="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
              New tool
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-dim">
            <span className="flex items-center gap-1.5">
              <Square on /> works
            </span>
            <span className="flex items-center gap-1.5">
              <Square /> doesn't
            </span>
            <span>Columns: C chats, S subagents, F flows, A apps over MCP</span>
            <span className="flex-1" />
            <span>Calls in the last 30 days</span>
          </div>

          <div className="columns-[300px] gap-x-6 [&>section]:mb-6 [&>section]:break-inside-avoid">
            {groups.map((g) => (
              <Group key={g.id} label={g.label} count={g.tools.length}>
                {g.tools.map((t) => (
                  <ToolRow key={t.name} name={t.name} hint={t.label} where={t.where} calls={usage[t.name]?.calls ?? 0} selected={selKey === t.name} focusKey={t.name} onOpen={() => setSel({ kind: 'builtin', name: t.name })} />
                ))}
              </Group>
            ))}

            {(own.length > 0 || (!q && place !== 'apps')) && (
              <Group label="Your tools" count={own.length}>
                {own.map((t) => (
                  <ToolRow
                    key={t.id}
                    name={t.name}
                    hint={KINDS[t.kind].label}
                    status={t.enabled ? undefined : t.createdBy !== 'user' ? 'needs review' : 'off'}
                    where={CUSTOM_WHERE}
                    calls={usage[t.name]?.calls ?? 0}
                    selected={selKey === t.id}
                    focusKey={t.id}
                    onOpen={() => setSel({ kind: 'custom', id: t.id })}
                  />
                ))}
                {!custom.length && (
                  <div className="grid gap-2 px-0.5 py-2.5 text-[12.5px] text-muted">
                    Turn a script, an HTTP call or a prompt into a tool every chat can use.
                    <span>
                      <Button size="sm" onClick={() => setCreating(true)}>
                        Make a tool
                      </Button>
                    </span>
                  </div>
                )}
              </Group>
            )}

            {showServers && (
              <Group label="From external servers" count={configs.length} columns={false}>
                {configs
                  .filter((c) => match(c.name))
                  .map((c) => {
                    const st = servers.find((s) => s.id === c.id)
                    const n = st?.state === 'ready' ? st.tools.length : null
                    return (
                      <button key={c.id} onClick={() => setPage('mcp')} className="flex w-full items-center gap-2 border-b border-line px-0.5 py-1.5 text-left text-[12.5px] last:border-b-0 hover:bg-elev">
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" translate="no">
                          {c.name}
                        </span>
                        <span className="shrink-0 text-[12px] text-dim">{n !== null ? `${n} tools` : c.enabled ? 'tools listed once running' : 'turned off'}</span>
                        <span className="shrink-0 text-[12px] text-dim">{c.defaultOn ? 'on in new chats' : 'per chat'}</span>
                      </button>
                    )
                  })}
                <p className="pt-1.5 text-[12px] text-dim">Set up on the MCP page; each chat chooses which servers it uses.</p>
              </Group>
            )}
          </div>
          {!groups.length && !own.length && !showServers && builtins.length > 0 && <p className="text-[12.5px] text-dim">No tool matches “{filter}”{place !== 'all' ? ` in ${PLACE_NAME[place]}` : ''}.</p>}
        </div>
      </div>

      <Inspector open={!!(selectedBuiltin || selectedCustom)} label={selectedBuiltin?.name ?? selectedCustom?.name ?? 'Tool'} onClose={close} width={selectedCustom ? 900 : 640}>
        {selectedBuiltin && <BuiltinView tool={selectedBuiltin} usage={usage[selectedBuiltin.name]} onClose={close} />}
        {selectedCustom && (
          <CustomToolEditor
            key={selectedCustom.id + selectedCustom.updatedAt}
            tool={selectedCustom}
            onClose={close}
            onSaved={(t) => void load({ kind: 'custom', id: t.id })}
            onDeleted={() => void load(null)}
          />
        )}
      </Inspector>
      <NewToolModal existing={custom.map((c) => c.name)} open={creating} onClose={() => setCreating(false)} onCreated={(t) => void load({ kind: 'custom', id: t.id })} />
    </div>
  )
}

function Square({ on }: { on?: boolean }) {
  return <span aria-hidden="true" className={clsx('inline-block h-[11px] w-[11px] rounded-[3px] border-[1.5px]', on ? 'border-ok bg-ok' : 'border-line-strong')} />
}

function Group({ label, count, columns = true, children }: { label: string; count: number; columns?: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={label} className="min-w-0">
      <h2 className="flex items-center gap-2 border-b border-line-strong pb-1.5 text-[13px] font-semibold">
        {label} <span className="text-[12px] font-normal text-dim">{count}</span>
        <span className="flex-1" />
        {columns && (
          <span aria-hidden="true" className="grid grid-cols-[repeat(4,11px)] gap-1 text-center text-[11px] font-medium text-dim">
            <span>C</span>
            <span>S</span>
            <span>F</span>
            <span>A</span>
          </span>
        )}
        {columns && <span className="w-9" aria-hidden="true" />}
      </h2>
      <div>{children}</div>
    </section>
  )
}

function ToolRow({ name, hint, status, where, calls, selected, focusKey, onOpen }: { name: string; hint: string; status?: string; where: ToolWhere; calls: number; selected: boolean; focusKey: string; onOpen(): void }) {
  return (
    <button
      data-focus-key={focusKey}
      onClick={onOpen}
      aria-haspopup="dialog"
      title={hint}
      className={clsx('flex w-full items-center gap-2 border-b border-line px-0.5 py-1.5 text-left last:border-b-0 hover:bg-elev focus-visible:ring-2 focus-visible:ring-crimson-line', selected && 'bg-crimson-soft shadow-[inset_2px_0_0_var(--color-crimson)]')}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]" translate="no">
        {name}
        {status && <span className="ml-2 font-sans text-[11.5px] text-warn">{status}</span>}
      </span>
      <span role="img" aria-label={whereLabel(where)} className="grid shrink-0 grid-cols-[repeat(4,11px)] gap-1">
        {PLACE_KEYS.map((k) => (
          <Square key={k} on={where[k]} />
        ))}
      </span>
      <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-dim">{calls || '–'}</span>
    </button>
  )
}

function uniqueName(base: string, taken: string[]): string {
  let name = base
  for (let i = 2; taken.includes(name); i++) name = `${base}_${i}`
  return name
}

function NewToolModal({ open, onClose, onCreated, existing }: { open: boolean; onClose(): void; onCreated(t: CustomTool): void; existing: string[] }) {
  const [kind, setKind] = useState<CustomToolKind>('http')
  const [blank, setBlank] = useState(false)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New tool"
      width={620}
      footer={
        <>
          <Switch checked={!blank} onChange={(v) => setBlank(!v)} label="Start from the example" />
          <div className="flex-1" />
          <Button
            variant="primary"
            onClick={async () => {
              const tpl = TEMPLATES[kind]
              const input: CustomToolInput = blank
                ? { name: uniqueName(`new_${kind}_tool`, existing), description: 'Describe what this tool does and when to use it.', kind, params: [], config: { ...tpl.config, ...(kind === 'javascript' ? { code: 'return args' } : {}) }, enabled: false }
                : { ...tpl, name: uniqueName(tpl.name, existing) }
              const t = await attempt(() => api.tools.create(input))
              if (t) {
                onCreated(t)
                onClose()
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(KINDS) as CustomToolKind[]).map((k) => {
          const K = KINDS[k]
          return (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={clsx('flex gap-2.5 rounded-lg border p-3 text-left', kind === k ? 'border-crimson-line bg-crimson-soft' : 'border-line hover:border-line-strong')}
            >
              <K.icon size={16} className="mt-0.5 shrink-0 text-crimson-hi" />
              <div>
                <div className="text-[12.5px] font-semibold">{K.label}</div>
                <div className="text-[11px] text-dim">{K.blurb}</div>
                {!blank && <div className="mt-1 font-mono text-[10.5px] text-muted">example: {TEMPLATES[k].name}</div>}
              </div>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

function BuiltinView({ tool, usage, onClose }: { tool: BuiltinToolInfo; usage?: ToolUsage; onClose(): void }) {
  const schema = tool.schema as { properties?: Record<string, { type?: string; description?: string; anyOf?: { const?: string }[]; items?: { type?: string } }>; required?: string[] }
  const props = Object.entries(schema.properties ?? {})
  const max = Math.max(1, ...(usage?.daily ?? [0]))
  const busiest = usage ? usage.daily.indexOf(Math.max(...usage.daily)) : -1
  const day = (i: number) => new Date(Date.now() - (13 - i) * 86_400_000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const fortnight = usage?.daily.reduce((a, b) => a + b, 0) ?? 0
  return (
    <>
      <InspectorHead title={<span className="font-mono" translate="no">{tool.name}</span>} sub={`${tool.label}, built in`} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="grid gap-6">
          <p className="text-[13px] leading-relaxed">{tool.description}</p>

          <section className="grid gap-2">
            <h3 className="text-[12px] font-medium text-muted">Where it works</h3>
            <div className="grid gap-1.5">
              {PLACE_KEYS.map((k) => (
                <div key={k} className="grid grid-cols-[18px_120px_minmax(0,1fr)] items-start gap-2 text-[12.5px]">
                  <span className={tool.where[k] ? 'text-ok' : 'text-dim'} aria-hidden="true">
                    {tool.where[k] ? '✓' : '✗'}
                  </span>
                  <span className={tool.where[k] ? '' : 'text-dim'}>
                    <span className="sr-only">{tool.where[k] ? 'Works in ' : 'Not in '}</span>
                    {PLACE_NAME[k][0].toUpperCase() + PLACE_NAME[k].slice(1)}
                  </span>
                  <span className="text-[12px] text-dim">{tool.where[k] ? (k === 'chats' ? tool.availability : k === 'apps' ? "Shared by Cloth's MCP server" : k === 'subagents' ? 'When the chat that starts them has it' : 'In Agent steps that have it on') : whyNot(tool.name, k)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-2">
            <h3 className="text-[12px] font-medium text-muted">Parameters</h3>
            {props.length ? (
              <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
                {props.map(([name, p]) => (
                  <Fragment key={name}>
                    <span className="font-mono text-crimson-hi" translate="no">
                      {name}
                      {!schema.required?.includes(name) && <span className="text-dim">?</span>}
                    </span>
                    <span className="font-mono text-[11.5px] text-muted">
                      {p.type ?? (p.anyOf ? p.anyOf.map((a) => JSON.stringify(a.const)).join(' | ') : 'any')}
                      {p.items?.type ? `<${p.items.type}>` : ''}
                    </span>
                    <span className="text-muted">{p.description ?? ''}</span>
                  </Fragment>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-dim">No parameters.</p>
            )}
          </section>

          <section className="grid gap-2">
            <h3 className="text-[12px] font-medium text-muted">Use</h3>
            {usage ? (
              <>
                <p className="text-[12.5px]">
                  {usage.calls} call{usage.calls === 1 ? '' : 's'} in the last 30 days{usage.errors ? `, ${usage.errors} failed` : ''}. Last used {timeAgo(usage.lastAt)}.
                  {fortnight > 0 && busiest >= 0 && ` Busiest recent day: ${day(busiest)} (${usage.daily[busiest]}).`}
                </p>
                <div role="img" aria-label={`Calls per day over the last 14 days: ${usage.daily.join(', ')}`} className="flex h-10 items-end gap-[3px]">
                  {usage.daily.map((n, i) => (
                    <span key={i} title={`${day(i)}: ${n}`} className={clsx('flex-1 rounded-t-[2px]', i === 13 ? 'bg-ok' : 'bg-ok/45')} style={{ height: `${n ? Math.max(8, (n / max) * 100) : 3}%` }} />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-dim">Not used in the last 30 days.</p>
            )}
          </section>

          <details>
            <summary className="cursor-default text-[12px] text-dim hover:text-muted">JSON schema sent to the model</summary>
            <pre className="selectable mt-2 overflow-x-auto rounded-lg border border-line bg-panel p-3 font-mono text-[11.5px] text-muted">{JSON.stringify(tool.schema, null, 2)}</pre>
          </details>
        </div>
      </div>
    </>
  )
}

function CustomToolEditor({ tool, onClose, onSaved, onDeleted }: { tool: CustomTool; onClose(): void; onSaved(t: CustomTool): void; onDeleted(): void }) {
  const [draft, setDraft] = useState<CustomToolInput>({ name: tool.name, description: tool.description, kind: tool.kind, params: tool.params, config: tool.config, enabled: tool.enabled })
  const [saving, setSaving] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify({ name: tool.name, description: tool.description, kind: tool.kind, params: tool.params, config: tool.config, enabled: tool.enabled })
  const set = (patch: Partial<CustomToolInput>) => setDraft((d) => ({ ...d, ...patch }))
  const setConfig = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }))
  const K = KINDS[draft.kind]

  const save = async () => {
    setSaving(true)
    const t = await attempt(() => api.tools.update(tool.id, draft), 'Tool saved')
    setSaving(false)
    if (t) onSaved(t)
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
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <K.icon size={15} className="text-crimson-hi" />
            <span className="font-mono">{tool.name}</span>
            <Badge>{K.label}</Badge>
          </span>
        }
        subtitle={`${tool.createdBy !== 'user' ? `Made by AI in ${ORIGIN[tool.createdBy]} · ` : ''}Updated ${timeAgo(tool.updatedAt)}`}
        actions={
          <>
            <Switch
              checked={tool.enabled}
              onChange={async (v) => {
                const t = await attempt(() => api.tools.setEnabled(tool.id, v))
                if (t) onSaved(t)
              }}
              label="Enabled"
            />
            <IconButton
              title="Delete tool"
              onClick={async () => {
                if (!(await confirmAction(`Chats and flows that use “${tool.name}” will no longer be able to call it.`, { title: 'Delete tool?', confirmLabel: 'Delete', danger: true }))) return
                await attempt(() => api.tools.remove(tool.id))
                onDeleted()
              }}
            >
              <Trash2 size={14} />
            </IconButton>
            <Button variant="primary" icon={<Save size={13} />} disabled={!dirty} loading={saving} onClick={() => void save()}>
              Save
            </Button>
            <IconButton title="Close (Esc)" aria-label="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          </>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="min-h-0 space-y-4 overflow-y-auto border-r border-line p-5">
          {tool.createdBy !== 'user' && !tool.enabled && (
            <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/5 p-3 text-[12px]">
              <ShieldAlert size={15} className="mt-px shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-fg">Review before enabling</div>
                <div className="mt-0.5 text-muted">
                  A model made this tool in {ORIGIN[tool.createdBy]}. {draft.kind === 'command' || draft.kind === 'javascript' ? 'It runs code on this computer, so read' : 'Read'} its settings below and try it in the test panel, then enable it.
                </div>
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  const t = await attempt(() => api.tools.setEnabled(tool.id, true), 'Tool enabled')
                  if (t) onSaved(t)
                }}
              >
                Enable tool
              </Button>
            </div>
          )}
          <div className="grid grid-cols-[220px_1fr] gap-3">
            <Field label="Name" hint="snake_case — how the model calls it">
              <Input className="font-mono" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Description" hint="The model decides when to call the tool from this text.">
              <Textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
          </div>
          <ParamsEditor params={draft.params} onChange={(params) => set({ params })} />
          <div>
            <div className="mb-2 text-[12.5px] font-semibold">{K.label} settings</div>
            <KindConfig kind={draft.kind} config={draft.config} setConfig={setConfig} params={draft.params} />
          </div>
        </div>
        <TestPanel draft={draft} />
      </div>
    </div>
  )
}

function ParamsEditor({ params, onChange }: { params: ToolParam[]; onChange(p: ToolParam[]): void }) {
  const update = (i: number, patch: Partial<ToolParam>) => onChange(params.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12.5px] font-semibold">Parameters</div>
        <Button size="sm" icon={<Plus size={12} />} onClick={() => onChange([...params, { name: `param${params.length + 1}`, type: 'string', description: '', required: true }])}>
          Parameter
        </Button>
      </div>
      {!params.length && <div className="text-[12px] text-dim">No parameters — the tool is called with no arguments.</div>}
      <div className="space-y-1.5">
        {params.map((p, i) => (
          <div key={i} className="grid grid-cols-[140px_100px_1fr_auto_auto] items-center gap-2">
            <Input className="font-mono" value={p.name} onChange={(e) => update(i, { name: e.target.value })} />
            <Select value={p.type} onChange={(e) => update(i, { type: e.target.value as ToolParamType })}>
              {['string', 'number', 'boolean', 'json'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
            <Input placeholder="Description for the model" value={p.description} onChange={(e) => update(i, { description: e.target.value })} />
            <label className="flex items-center gap-1 text-[11.5px] text-muted">
              <input type="checkbox" className="accent-[#dc2645]" checked={p.required} onChange={(e) => update(i, { required: e.target.checked })} />
              required
            </label>
            <IconButton onClick={() => onChange(params.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  )
}

function KindConfig({ kind, config, setConfig, params }: { kind: CustomToolKind; config: Record<string, any>; setConfig(p: Record<string, unknown>): void; params: ToolParam[] }) {
  const refs = params.map((p) => `{{${p.name}}}`).join(' ')
  const hint = refs ? `Available: ${refs}` : 'Add parameters to reference them as {{name}}'
  const str = (k: string) => String(config[k] ?? '')
  switch (kind) {
    case 'http':
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <Select value={str('method') || 'GET'} onChange={(e) => setConfig({ method: e.target.value })}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
            <Input className="font-mono text-[12px]" value={str('url')} onChange={(e) => setConfig({ url: e.target.value })} placeholder="https://api.example.com/items/{{id}}" />
          </div>
          <div className="text-[11px] text-dim">{hint}</div>
          <Field label="Headers (JSON template)">
            <Textarea rows={3} className="font-mono text-[11.5px]" value={str('headers')} onChange={(e) => setConfig({ headers: e.target.value })} />
          </Field>
          {config.method && config.method !== 'GET' && (
            <Field label="Body (template)" hint="Empty = send all arguments as JSON">
              <Textarea rows={4} className="font-mono text-[11.5px]" value={str('body')} onChange={(e) => setConfig({ body: e.target.value })} />
            </Field>
          )}
          <TimeoutField value={config.timeoutMs} onChange={(timeoutMs) => setConfig({ timeoutMs })} />
        </div>
      )
    case 'javascript':
      return (
        <div className="space-y-2">
          <div className="space-y-1 text-[11px] text-dim">
            <div>Async function body. In scope: args, fetch, URL, console, JSON, Math, Date, Buffer. Return a string or any JSON value.</div>
            <div>
              <span className="font-mono text-muted">workspace</span>: write(path, data), read, readBytes, list, exists — files in the flow's workspace (the test run uses a scratch folder).{' '}
              <span className="font-mono text-muted">require</span>: pptxgenjs (PowerPoint), docx (Word).
            </div>
          </div>
          <div className="h-64 overflow-hidden rounded-md border border-line bg-bg">
            <Editor value={str('code')} onChange={(code) => setConfig({ code })} lang="javascript" />
          </div>
          <TimeoutField value={config.timeoutMs} onChange={(timeoutMs) => setConfig({ timeoutMs })} />
          <div className="text-[11px] text-dim">Runs in a separate V8 context inside Cloth — convenient, but not a security sandbox. Only add code you trust.</div>
        </div>
      )
    case 'command':
      return (
        <div className="space-y-3">
          <Field label="Executable" hint="Name on PATH (git, node, python) or an absolute path">
            <div className="flex gap-2">
              <Input className="font-mono" value={str('command')} onChange={(e) => setConfig({ command: e.target.value })} />
              <Button
                onClick={async () => {
                  const [f] = await api.app.pickPaths({ title: 'Choose executable' })
                  if (f) setConfig({ command: f })
                }}
              >
                Browse
              </Button>
            </div>
          </Field>
          <Field label="Arguments — one per line" hint={`${hint}. Each line becomes exactly one argument; no shell is involved.`}>
            <Textarea rows={6} className="font-mono text-[11.5px]" value={str('args')} onChange={(e) => setConfig({ args: e.target.value })} />
          </Field>
          <Field label="Working directory (optional, template)">
            <Input className="font-mono" value={str('cwd')} onChange={(e) => setConfig({ cwd: e.target.value })} />
          </Field>
          <TimeoutField value={config.timeoutMs} onChange={(timeoutMs) => setConfig({ timeoutMs })} />
        </div>
      )
    case 'prompt':
      return (
        <div className="space-y-3">
          <Field label="Model">
            <ModelPicker value={(config.model as ModelRef) ?? null} onChange={(model) => setConfig({ model })} allowNone noneLabel="Default model" />
          </Field>
          <Field label="System prompt (template)">
            <Textarea rows={2} value={str('system')} onChange={(e) => setConfig({ system: e.target.value })} />
          </Field>
          <Field label="Prompt (template)" hint={hint}>
            <Textarea rows={6} className="font-mono text-[11.5px]" value={str('prompt')} onChange={(e) => setConfig({ prompt: e.target.value })} />
          </Field>
        </div>
      )
  }
}

function TimeoutField({ value, onChange }: { value: unknown; onChange(v: number): void }) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-muted">
      Timeout
      <Input type="number" className="w-24" value={Number(value) || 30000} onChange={(e) => onChange(Number(e.target.value))} />
      ms
    </label>
  )
}

function TestPanel({ draft }: { draft: CustomToolInput }) {
  const sample = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(draft.params.map((p) => [p.name, p.type === 'number' ? 1 : p.type === 'boolean' ? true : p.type === 'json' ? {} : ''])),
        null,
        2
      ),
    [draft.params]
  )
  const [args, setArgs] = useState(sample)
  const [result, setResult] = useState<ToolRunResult | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    let parsed: Record<string, unknown>
    try {
      parsed = args.trim() ? JSON.parse(args) : {}
    } catch (err) {
      setResult({ ok: false, output: '', error: `Arguments are not valid JSON: ${err instanceof Error ? err.message : err}`, durationMs: 0 })
      return
    }
    setRunning(true)
    setResult(await api.tools.test({ kind: draft.kind, config: draft.config, params: draft.params }, parsed))
    setRunning(false)
  }

  return (
    <div className="flex min-h-0 flex-col bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <div className="text-[12.5px] font-semibold">Test</div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setArgs(sample)}>
            Reset args
          </Button>
          <Button size="sm" variant="primary" icon={<Play size={11} fill="currentColor" />} loading={running} onClick={() => void run()}>
            Run
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="text-[11px] text-dim">Runs the current (unsaved) definition with these arguments.</div>
        <div className="h-40 shrink-0 overflow-hidden rounded-md border border-line bg-bg">
          <Editor value={args} onChange={setArgs} lang="json" />
        </div>
        {result && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-1.5 flex items-center gap-2 text-[11.5px]">
              <Badge tone={result.ok ? 'ok' : 'crimson'}>{result.ok ? 'ok' : 'error'}</Badge>
              <span className="font-mono text-dim">{duration(result.durationMs)}</span>
            </div>
            <pre className={clsx('selectable min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-3 font-mono text-[11.5px]', result.ok ? 'text-fg' : 'text-crimson-hi')}>
              {result.ok ? result.output : result.error}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
