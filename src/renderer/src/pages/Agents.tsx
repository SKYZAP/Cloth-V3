import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowCounterClockwise, CaretRight, ChatCircleDots, Copy, MagnifyingGlass, Plus, Robot, Sparkle, Trash } from '@phosphor-icons/react'
import { AGENT_TEMPLATES, type Agent, type AgentInput, type AgentSetup, type ChatSetup, type McpClientStatus, type ModelRef, type ThinkingLevel } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Empty, Input, ListItem, ListPane, Modal, PageHeader, Spinner, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { SplitDetail, SplitRoot } from '@/components/SplitView'
import { Segmented } from './chat/StatusLine'
import { KnowledgeView, ServersView, SkillsView, ToolsView, k, useCapabilities } from './chat/Setup'

/** Two letters for an agent's tile. */
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?'

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem('cloth.agent'))
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)

  const load = async () => {
    const list = await api.agents.list()
    setAgents(list)
    setLoaded(true)
    setActiveId((cur) => (cur && list.some((a) => a.id === cur) ? cur : (list[0]?.id ?? null)))
  }
  useEffect(() => {
    void load()
  }, [])
  useEvent('agents', () => void load())
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem('cloth.agent', activeId)
    } catch {
      /* storage unavailable */
    }
  }, [activeId])

  const q = filter.trim().toLowerCase()
  const shown = agents.filter((a) => !q || a.name.toLowerCase().includes(q) || a.purpose.toLowerCase().includes(q))
  const active = agents.find((a) => a.id === activeId) ?? null
  const pick = (id: string) => (setActiveId(id), setOpen(true))

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        header={
          <div className="flex gap-2">
            <div className="relative flex-1">
              <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" />
              <Input className="pl-7" placeholder="Filter agents" aria-label="Filter agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <button onClick={() => setCreating(true)} title="New agent" aria-label="New agent" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-crimson text-white hover:bg-crimson-hi">
              <Plus size={16} weight="bold" />
            </button>
          </div>
        }
      >
        {shown.map((a) => (
          <ListItem key={a.id} active={a.id === activeId} onClick={() => pick(a.id)}>
            <Tile name={a.name} builtin={!!a.builtin} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="min-w-0 truncate text-[12.5px] font-medium text-fg">{a.name}</span>
                {a.builtin && <span className="shrink-0 text-[10.5px] text-dim">built in</span>}
              </div>
              <div className="truncate text-[11.5px] text-dim">{a.purpose || 'No purpose yet'}</div>
            </div>
          </ListItem>
        ))}
        {loaded && !shown.length && <div className="p-4 text-center text-[12px] text-dim">{agents.length ? 'No agent matches.' : 'No agents yet'}</div>}
      </ListPane>
      <SplitDetail>
        {active ? (
          <AgentEditor key={active.id} agent={active} onSaved={(a) => setAgents((list) => list.map((x) => (x.id === a.id ? a : x)))} onRemoved={() => void load()} onDuplicated={(a) => (void load(), pick(a.id))} />
        ) : (
          <Empty icon={<Robot size={22} />} title="Agents you define once and use anywhere" action={<Button variant="primary" onClick={() => setCreating(true)}>New agent</Button>}>
            An agent is a saved setup with a purpose: its instructions, model and what it may use. Pick one as a chat's agent, or let other agents hand it work by name.
          </Empty>
        )}
      </SplitDetail>
      <NewAgentDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(a) => {
          setCreating(false)
          void load().then(() => pick(a.id))
        }}
      />
    </SplitRoot>
  )
}

function Tile({ name, builtin, size = 'sm' }: { name: string; builtin?: boolean; size?: 'sm' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex shrink-0 items-center justify-center font-semibold tracking-tight',
        size === 'lg' ? 'h-10 w-10 rounded-[10px] text-[14px]' : 'h-8 w-8 rounded-[8px] text-[11.5px]',
        builtin ? 'bg-elev-2 text-muted' : 'bg-crimson-soft text-crimson-hi'
      )}
    >
      {initials(name)}
    </span>
  )
}

const EFFORT: { value: ThinkingLevel | 'chat'; label: string }[] = [
  { value: 'chat', label: "Chat's" },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

function AgentEditor({ agent, onSaved, onRemoved, onDuplicated }: { agent: Agent; onSaved(a: Agent): void; onRemoved(): void; onDuplicated(a: Agent): void }) {
  const [name, setName] = useState(agent.name)
  const [purpose, setPurpose] = useState(agent.purpose)
  const [instructions, setInstructions] = useState(agent.instructions)
  const [setup, setSetup] = useState<ChatSetup | null>(null)
  const [servers, setServers] = useState<McpClientStatus[]>([])
  const setPage = useApp((s) => s.setPage)
  useEffect(() => setName(agent.name), [agent.name])
  useEffect(() => setPurpose(agent.purpose), [agent.purpose])
  useEffect(() => setInstructions(agent.instructions), [agent.instructions])

  const loadSetup = () => {
    void api.agents.setup(agent.id).then(setSetup, () => undefined)
    void api.mcp.clients().then(setServers, () => undefined)
  }
  useEffect(loadSetup, [agent.id, agent.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  useEvent('mcpClients', loadSetup)

  const save = async (patch: AgentInput) => {
    const a = await attempt(() => api.agents.update(agent.id, patch))
    if (a) onSaved(a)
  }
  const update = (p: Partial<AgentSetup>) => save(p)
  const m = useCapabilities(agent, update, setup)

  const useInChat = async () => {
    const s = await attempt(async () => {
      const chat = await api.chat.create({})
      return api.chat.useAgent(chat.id, agent.id)
    })
    if (!s) return
    try {
      localStorage.setItem('cloth.chat', s.id)
    } catch {
      /* storage unavailable */
    }
    setPage('chat')
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Tile name={agent.name} builtin={!!agent.builtin} />
            {agent.name}
          </span>
        }
        subtitle={agent.builtin ? 'Built in: the main agent hands it work as a subagent' : undefined}
        actions={
          <>
            {agent.asChat && (
              <Button size="sm" icon={<ChatCircleDots size={14} />} onClick={() => void useInChat()}>
                New chat with it
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={async () => {
              const a = await attempt(() => api.agents.duplicate(agent.id))
              if (a) onDuplicated(a)
            }}>
              Duplicate
            </Button>
            {!agent.builtin && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash size={14} />}
                aria-label="Delete agent"
                onClick={async () => {
                  if (!(await confirmAction(`Chats set up from ${agent.name} keep their setup.`, { title: `Delete ${agent.name}?`, confirmLabel: 'Delete', danger: true }))) return
                  if (await attempt(() => api.agents.remove(agent.id).then(() => true))) onRemoved()
                }}
              />
            )}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-[min(760px,calc(100%-40px))] grid-cols-[minmax(0,1fr)] gap-6 py-6">
          {!agent.builtin && (
            <Section title="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== agent.name && void save({ name })} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} aria-label="Name" />
            </Section>
          )}
          <Section title="Purpose" hint="How other agents decide to hand work to it, and what you see when picking it.">
            <Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} onBlur={() => purpose !== agent.purpose && void save({ purpose })} aria-label="Purpose" placeholder="e.g. Reviews and fixes interfaces against the project's design system." />
          </Section>
          <Section title="Model">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 mobile:grid-cols-1">
              <ModelPicker value={agent.model} onChange={(model) => void save({ model })} allowNone noneLabel="The chat's model" />
              <div className="w-[300px] mobile:w-full">
                <Segmented size="sm" label="Reasoning effort" value={agent.thinking ?? 'chat'} onChange={(v) => void save({ thinking: v === 'chat' ? null : v })} options={EFFORT} />
              </div>
            </div>
          </Section>
          <InstructionsEditor agent={agent} value={instructions} onChange={setInstructions} onSave={(text) => void save({ instructions: text })} />

          <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold">What it can use</h3>
              <span className="font-mono text-[11px] tabular-nums text-dim">{setup ? `about ${k(m.total)} tokens per request` : '…'}</span>
            </div>
            <Collapsible title="Skills" meta={`${m.skillsOn.length} · +${k(m.parts.skills)}`} defaultOpen>
              <SkillsView target={agent} update={update} m={m} />
            </Collapsible>
            <Collapsible title="External servers" meta={m.configs.length ? `${m.external.filter((t) => m.isOn(t.name)).length} tools · +${k(m.parts.servers)}` : 'none set up'}>
              <ServersView target={agent} update={update} m={m} status={servers} />
            </Collapsible>
            <Collapsible title="Built-in tools" meta={`${m.builtin.filter((t) => m.isOn(t.name)).length} · +${k(m.parts.builtin)}`}>
              <ToolsView
                target={agent}
                update={update}
                m={m}
                access={
                  agent.builtin ? (
                    <span className="text-[11px] text-dim">{agent.builtin === 'scout' ? 'Read-only: a scout never changes files.' : 'Can edit files when the chat it works for can.'}</span>
                  ) : (
                    <div className="grid gap-1.5">
                      <Segmented
                        size="sm"
                        label="Folder access"
                        value={agent.fileAccess === 'write' ? (agent.shell ? 'shell' : 'edit') : 'read'}
                        onChange={(v) => void save({ fileAccess: v === 'read' ? 'read' : 'write', shell: v === 'shell' })}
                        options={[
                          { value: 'read', label: 'Read' },
                          { value: 'edit', label: 'Edit' },
                          { value: 'shell', label: 'Edit + shell' }
                        ]}
                      />
                      <span className="text-[11px] text-dim">The most it may do in a chat's folder; a chat with less access keeps its own.</span>
                    </div>
                  )
                }
              />
            </Collapsible>
            <Collapsible title="Knowledge" meta={`${m.selected.length} · +${k(m.parts.knowledge)}`}>
              <KnowledgeView target={agent} update={update} total={m.parts.knowledge} />
            </Collapsible>
          </div>

          <Section title="Works as">
            <div className="flex flex-wrap gap-4">
              <Check label="Chat agent" sub="Pick it in a chat's Setup tab" on={agent.asChat} disabled={!!agent.builtin} onChange={(asChat) => void save({ asChat })} />
              <Check label="Subagent" sub="Other agents can hand it work by name" on={agent.asSubagent} disabled={!!agent.builtin} onChange={(asSubagent) => void save({ asSubagent })} />
            </div>
          </Section>
          {!agent.builtin && (
            <Section title="Approvals" hint="Used when a chat is set up from this agent.">
              <Segmented
                label="Approvals"
                value={agent.autoApprove}
                onChange={(autoApprove) => void save({ autoApprove })}
                options={[
                  { value: 'none', label: 'Ask first' },
                  { value: 'edits', label: 'Allow edits' },
                  { value: 'all', label: 'Allow all' }
                ]}
              />
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="text-[12px] font-medium text-muted">{title}</div>
      {children}
      {hint && <div className="text-[11px] text-dim">{hint}</div>}
    </div>
  )
}

function Collapsible({ title, meta, defaultOpen, children }: { title: string; meta: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="min-w-0 rounded-[12px] border border-line bg-panel">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <CaretRight size={11} className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 text-[12.5px] font-medium">{title}</span>
        <span className="font-mono text-[11px] tabular-nums text-dim">{meta}</span>
      </button>
      {open && <div className="border-t border-line p-2">{children}</div>}
    </div>
  )
}

function Check({ label, sub, on, disabled, onChange }: { label: string; sub: string; on: boolean; disabled?: boolean; onChange(v: boolean): void }) {
  return (
    <label className={clsx('flex items-start gap-2', disabled ? 'opacity-50' : 'cursor-pointer')}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-crimson" />
      <span>
        <span className="block text-[12.5px] text-fg">{label}</span>
        <span className="block text-[11px] text-dim">{sub}</span>
      </span>
    </label>
  )
}

/** The agent's instructions, with a way to have AI apply a change to them. */
function InstructionsEditor({ agent, value, onChange, onSave }: { agent: Agent; value: string; onChange(v: string): void; onSave(v: string): void }) {
  const settings = useApp((s) => s.settings)
  const [asking, setAsking] = useState(false)
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [previous, setPrevious] = useState<string | null>(null)
  const model = agent.model ?? settings?.defaultModel ?? null
  const rewrite = async () => {
    setBusy(true)
    const next = await attempt(() => api.agents.rewrite(value, request, model))
    setBusy(false)
    if (next === undefined || next === null) return
    setPrevious(value)
    onChange(next)
    onSave(next)
    setAsking(false)
    setRequest('')
  }
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12px] font-medium text-muted">Instructions</span>
        {previous !== null && (
          <Button size="sm" variant="ghost" icon={<ArrowCounterClockwise size={13} />} onClick={() => (onChange(previous), onSave(previous), setPrevious(null))}>
            Undo rewrite
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<Sparkle size={13} />} onClick={() => setAsking(!asking)} aria-expanded={asking}>
          Rewrite with AI
        </Button>
      </div>
      {asking && (
        <div className="flex gap-2 rounded-[10px] border border-line bg-panel p-2">
          <Input
            autoFocus
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && request.trim() && !busy && void rewrite()}
            placeholder="What should change? e.g. be stricter about mobile layouts"
            aria-label="What should change"
          />
          <Button variant="primary" loading={busy} disabled={!request.trim() || !model} onClick={() => void rewrite()}>
            Rewrite
          </Button>
        </div>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => value !== agent.instructions && onSave(value)}
        rows={10}
        aria-label="Instructions"
        placeholder="What it should do first, how to work, what to check before finishing, and what never to do."
      />
      <div className="text-[11px] text-dim">Added to Cloth's system prompt wherever the agent works. Saved when you click away.</div>
    </div>
  )
}

/** Describe → check the drafted name and purpose → Generate writes the agent and opens it. */
function NewAgentDialog({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(a: Agent): void }) {
  const settings = useApp((s) => s.settings)
  const [description, setDescription] = useState('')
  const [model, setModel] = useState<ModelRef | null>(null)
  const [draft, setDraft] = useState<{ name: string; purpose: string } | null>(null)
  const [busy, setBusy] = useState<'draft' | 'generate' | null>(null)
  useEffect(() => {
    if (open) {
      setDescription('')
      setDraft(null)
      setModel(settings?.defaultModel ?? null)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const step = useMemo(() => (draft ? 2 : 1), [draft])

  const makeDraft = async () => {
    setBusy('draft')
    const d = await attempt(() => api.agents.draft(description, model))
    setBusy(null)
    if (d) setDraft(d)
  }
  const generate = async () => {
    if (!draft) return
    setBusy('generate')
    const a = await attempt(() => api.agents.generate({ description, name: draft.name, purpose: draft.purpose, model }))
    setBusy(null)
    if (a) onCreated(a)
  }
  const fromTemplate = async (template: string | undefined) => {
    const a = await attempt(() => api.agents.create(template ? { template } : {}))
    if (a) onCreated(a)
  }

  return (
    <Modal open={open} onClose={onClose} title="New agent" width={860}>
      <ol className="mb-4 flex items-center gap-2 text-[11.5px] text-dim" aria-label="Steps">
        {['Describe', 'Check the draft', 'Edit'].map((s, i) => (
          <li key={s} className={clsx('flex items-center gap-2', i + 1 === step && 'text-fg')} aria-current={i + 1 === step ? 'step' : undefined}>
            {i > 0 && <CaretRight size={10} aria-hidden="true" />}
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-5 mobile:grid-cols-1">
        <div className="grid content-start gap-3">
          <label htmlFor="agent-description" className="text-[12px] font-medium text-muted">
            What should this agent do?
          </label>
          <Textarea
            id="agent-description"
            autoFocus
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Check my web pages for design problems against the project's design system and fix them. It should look at the page in a real browser on phone and desktop, in both themes, before saying it's done."
          />
          <div className="grid gap-1">
            <span className="text-[11.5px] text-dim">Write with</span>
            <ModelPicker value={model} onChange={(m) => setModel(m)} />
          </div>
          <div className="flex justify-end">
            <Button variant={draft ? 'secondary' : 'primary'} icon={<Sparkle size={13} />} loading={busy === 'draft'} disabled={!description.trim() || !model || !!busy} onClick={() => void makeDraft()}>
              {draft ? 'Draft again' : 'Draft agent'}
            </Button>
          </div>
          <div className="grid gap-1.5 border-t border-line pt-3">
            <span className="text-[11.5px] text-dim">Or start from</span>
            <div className="flex flex-wrap gap-1.5">
              {AGENT_TEMPLATES.map((t) => (
                <button key={t.id} onClick={() => void fromTemplate(t.id)} title={t.summary} className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:border-line-strong hover:text-fg">
                  {t.name}
                </button>
              ))}
              <button onClick={() => void fromTemplate(undefined)} className="rounded-lg px-2.5 py-1 text-[12px] text-dim hover:text-fg">
                Blank agent
              </button>
            </div>
          </div>
        </div>
        <div className={clsx('grid content-start gap-3 rounded-[12px] border p-3.5', draft ? 'border-line-strong bg-elev' : 'border-dashed border-line')}>
          <div className="text-[12px] font-medium text-muted">Draft</div>
          {busy === 'draft' ? (
            <div className="flex items-center gap-2 py-6 text-[12px] text-dim">
              <Spinner /> Drafting a name and purpose…
            </div>
          ) : draft ? (
            <>
              <label className="grid gap-1">
                <span className="text-[11.5px] text-dim">Name</span>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="grid gap-1">
                <span className="text-[11.5px] text-dim">Purpose</span>
                <Textarea rows={4} value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} />
              </label>
              <div className="flex justify-end">
                <Button variant="primary" icon={<Sparkle size={13} weight="fill" />} loading={busy === 'generate'} disabled={!draft.name.trim() || !!busy} onClick={() => void generate()}>
                  Generate
                </Button>
              </div>
              <p className="text-[11px] text-dim">Generate writes its instructions and opens it, where you choose what it can use.</p>
            </>
          ) : (
            <p className="py-6 text-[12px] text-dim">Describe the agent and draft it: you'll check its name and purpose here before it's written.</p>
          )}
        </div>
      </div>
    </Modal>
  )
}
