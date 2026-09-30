import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Bot, BookOpen, ListChecks, Code2, FolderSearch, Globe, Link2, Lock, MessageSquareText, Play, Plus, Save, ShieldAlert, Sparkles, SquareTerminal, Trash2, Wrench } from 'lucide-react'
import type { BuiltinToolInfo, CustomTool, CustomToolInput, CustomToolKind, ModelRef, ToolOrigin, ToolParam, ToolParamType, ToolRunResult } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { duration, timeAgo } from '@/lib/format'
import { Badge, Button, Card, Dot, Empty, Field, IconButton, Input, ListItem, ListPane, Modal, PageHeader, Select, Switch, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Editor } from '@/components/Editor'
import { SplitDetail, SplitRoot } from '@/components/SplitView'

const KINDS: Record<CustomToolKind, { label: string; icon: typeof Globe; blurb: string }> = {
  http: { label: 'HTTP request', icon: Link2, blurb: 'Call a REST API. URL, headers and body are templates over the parameters.' },
  javascript: { label: 'JavaScript', icon: Code2, blurb: 'Async function body with args, fetch and console in scope. Return a value.' },
  command: { label: 'Command', icon: SquareTerminal, blurb: 'Run an executable (no shell). One templated argument per line.' },
  prompt: { label: 'Prompt', icon: MessageSquareText, blurb: 'Call a model with a templated prompt — a reusable sub-task.' }
}

const GROUP_ICON: Record<BuiltinToolInfo['group'], typeof Globe> = { knowledge: BookOpen, web: Globe, skills: Sparkles, workspace: FolderSearch, planning: ListChecks, tools: Wrench }

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

export function ToolsPage() {
  const [builtins, setBuiltins] = useState<BuiltinToolInfo[]>([])
  const [custom, setCustom] = useState<CustomTool[]>([])
  const [sel, setSel] = useState<Selection>(null)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')

  const load = async (select?: Selection) => {
    const [b, c] = await Promise.all([api.tools.builtins(), api.tools.list()])
    setBuiltins(b)
    setCustom(c)
    if (select) {
      setSel(select)
      setOpen(true)
    }
    else setSel((cur) => cur ?? (c[0] ? { kind: 'custom', id: c[0].id } : b[0] ? { kind: 'builtin', name: b[0].name } : null))
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Tools made by a model (chat or MCP) appear without a reload.
  useEvent('tools', () => void load())

  const match = (s: string) => !filter || s.toLowerCase().includes(filter.toLowerCase())
  const selectedBuiltin = sel?.kind === 'builtin' ? builtins.find((b) => b.name === sel.name) : undefined
  const selectedCustom = sel?.kind === 'custom' ? custom.find((c) => c.id === sel.id) : undefined

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        header={
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">Tools</div>
                <div className="text-[11px] text-dim">
                  {builtins.length} built-in · {custom.filter((c) => c.enabled).length}/{custom.length} custom enabled
                </div>
              </div>
              <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
                New
              </Button>
            </div>
            <Input placeholder="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        }
      >
        <SectionLabel>Custom</SectionLabel>
        {custom
          .filter((t) => match(t.name + t.description))
          .map((t) => {
            const Icon = KINDS[t.kind].icon
            return (
              <ListItem key={t.id} active={sel?.kind === 'custom' && sel.id === t.id} onClick={() => (setSel({ kind: 'custom', id: t.id }), setOpen(true))}>
                <Icon size={14} className="shrink-0 text-dim" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px]">{t.name}</div>
                  <div className="truncate text-[11px] text-dim">
                    {KINDS[t.kind].label}
                    {t.createdBy !== 'user' && ` · made by AI${t.enabled ? '' : ', needs review'}`}
                  </div>
                </div>
                {t.createdBy !== 'user' && <Bot size={12} className="shrink-0 text-dim" aria-label="Made by AI" />}
                <Dot tone={t.enabled ? 'ok' : t.createdBy !== 'user' ? 'warn' : 'dim'} />
              </ListItem>
            )
          })}
        {!custom.length && <div className="px-2.5 pb-2 text-[11.5px] text-dim">No custom tools yet.</div>}
        <SectionLabel>Built-in</SectionLabel>
        {builtins
          .filter((b) => match(b.name + b.description))
          .map((b) => {
            const Icon = GROUP_ICON[b.group]
            return (
              <ListItem key={b.name} active={sel?.kind === 'builtin' && sel.name === b.name} onClick={() => (setSel({ kind: 'builtin', name: b.name }), setOpen(true))}>
                <Icon size={14} className="shrink-0 text-dim" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px]">{b.name}</div>
                  <div className="truncate text-[11px] text-dim">{b.label}</div>
                </div>
                <Lock size={11} className="shrink-0 text-dim" />
              </ListItem>
            )
          })}
      </ListPane>
      <SplitDetail>
        {selectedBuiltin ? (
          <BuiltinView tool={selectedBuiltin} />
        ) : selectedCustom ? (
          <CustomToolEditor key={selectedCustom.id + selectedCustom.updatedAt} tool={selectedCustom} onSaved={(t) => void load({ kind: 'custom', id: t.id })} onDeleted={() => (setOpen(false), void load(null))} />
        ) : (
          <Empty icon={<Wrench size={20} />} title="Extend the agent with tools" action={<Button variant="primary" onClick={() => setCreating(true)}>Create a tool</Button>}>
            Custom tools become callable by the chat agent and by workflow agent nodes. Built-in tools are listed for reference.
          </Empty>
        )}
      </SplitDetail>
      <NewToolModal existing={custom.map((c) => c.name)} open={creating} onClose={() => setCreating(false)} onCreated={(t) => void load({ kind: 'custom', id: t.id })} />
    </SplitRoot>
  )
}

function uniqueName(base: string, taken: string[]): string {
  let name = base
  for (let i = 2; taken.includes(name); i++) name = `${base}_${i}`
  return name
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-dim first:pt-1">{children}</div>
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

function BuiltinView({ tool }: { tool: BuiltinToolInfo }) {
  const schema = tool.schema as { properties?: Record<string, { type?: string; description?: string; anyOf?: { const?: string }[]; items?: { type?: string } }>; required?: string[] }
  const props = Object.entries(schema.properties ?? {})
  const Icon = GROUP_ICON[tool.group]
  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{tool.name}</span>
            <Badge tone="dim">
              <Lock size={9} /> built-in · read-only
            </Badge>
          </span>
        }
        subtitle={tool.label}
      />
      <div className="mx-auto max-w-3xl space-y-4 p-5">
        <Card className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Icon size={14} className="text-crimson-hi" />
            <span className="capitalize">{tool.group}</span>
            <span className="text-dim">·</span>
            <span>{tool.availability}</span>
          </div>
          <div className="text-[13px] leading-relaxed">{tool.description}</div>
        </Card>
        <Card>
          <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">Parameters</div>
          {props.length ? (
            <table className="w-full text-[12px]">
              <tbody>
                {props.map(([name, p]) => (
                  <tr key={name} className="border-t border-line first:border-0">
                    <td className="w-40 px-4 py-2 align-top font-mono text-crimson-hi">
                      {name}
                      {!schema.required?.includes(name) && <span className="text-dim">?</span>}
                    </td>
                    <td className="w-32 py-2 align-top font-mono text-[11px] text-muted">{p.type ?? (p.anyOf ? p.anyOf.map((a) => JSON.stringify(a.const)).join(' | ') : 'any')}{p.items?.type ? `<${p.items.type}>` : ''}</td>
                    <td className="py-2 pr-4 align-top text-muted">{p.description ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-4 py-3 text-[12px] text-dim">No parameters.</div>
          )}
        </Card>
        <details>
          <summary className="cursor-default text-[12px] text-dim hover:text-muted">JSON schema sent to the model</summary>
          <pre className="selectable mt-2 overflow-x-auto rounded-lg border border-line bg-panel p-3 font-mono text-[11px] text-muted">{JSON.stringify(tool.schema, null, 2)}</pre>
        </details>
      </div>
    </div>
  )
}

function CustomToolEditor({ tool, onSaved, onDeleted }: { tool: CustomTool; onSaved(t: CustomTool): void; onDeleted(): void }) {
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
          <div className="text-[11px] text-dim">Async function body. In scope: args, fetch, URL, console, JSON, Math, Date. Return a string or any JSON value.</div>
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
