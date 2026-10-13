import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import {
  Books,
  CaretRight,
  ChatCircleDots,
  Cpu,
  DeviceMobile,
  FolderOpen,
  GlobeHemisphereWest,
  Info,
  MagnifyingGlass,
  Palette,
  PlugsConnected,
  Plus,
  Robot,
  Trash,
  X,
  type Icon
} from '@phosphor-icons/react'
import { DEFAULT_TIER_INSTRUCTIONS, type AgentTier, type AppInfo, type Settings, type SubagentSettings, type ThinkingLevel } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { isMobile, useSideBySide } from '@/lib/platform'
import { Button, Card, IconButton, Input, ListPane, Select, Switch, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Logo } from '@/components/Logo'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { WebSearchSettings } from './WebSearchSettings'
import { PhoneSettings } from './PhoneSettings'
import { EFFORT_OPTIONS, normalizeEffort, normalizeEffortOrNull } from '@shared/effort'

type SectionId = 'models' | 'chat' | 'subagents' | 'web' | 'knowledge' | 'design' | 'phone' | 'mcp' | 'about'

interface SectionDef {
  id: SectionId
  title: string
  icon: Icon
  blurb: string
  /** Extra words the search matches besides the title and blurb. */
  keywords: string
  desktopOnly?: boolean
}

const SECTIONS: SectionDef[] = [
  { id: 'models', title: 'Models', icon: Cpu, blurb: 'Default chat, embedding and image models', keywords: 'default model embedding image llm provider' },
  { id: 'chat', title: 'Chat', icon: ChatCircleDots, blurb: 'Summarising long conversations and naming chats', keywords: 'compact summarise summarize context window title name rename ai titles' },
  { id: 'subagents', title: 'Subagents', icon: Robot, blurb: 'Delegation with the task tool', keywords: 'task delegate scout worker parallel turns agent' },
  { id: 'web', title: 'Web search', icon: GlobeHemisphereWest, blurb: 'Search engine and page fetching', keywords: 'searxng obscura web_fetch internet results' },
  { id: 'knowledge', title: 'Knowledge', icon: Books, blurb: 'How documents are split for search', keywords: 'chunk chunking overlap rag index' },
  { id: 'design', title: 'Design systems', icon: Palette, blurb: 'Palettes, type and shape that projects follow', keywords: 'design system palette colours colors fonts theme tokens tailwind shadcn DESIGN.md' },
  { id: 'phone', title: 'Phone', icon: DeviceMobile, blurb: 'Use Cloth from the Android app', keywords: 'mobile android pair qr remote tailscale wifi', desktopOnly: true },
  { id: 'mcp', title: 'MCP server', icon: PlugsConnected, blurb: 'Expose skills and knowledge to other tools', keywords: 'mcp port server claude cursor' },
  { id: 'about', title: 'Data & about', icon: Info, blurb: 'Where Cloth keeps its data, and version', keywords: 'data folder version database about' }
]

const LAST_SECTION = 'cloth.settingsSection'

export function SettingsPage() {
  const settings = useApp((s) => s.settings)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SectionId>(() => {
    try {
      return (localStorage.getItem(LAST_SECTION) as SectionId) || 'models'
    } catch {
      return 'models'
    }
  })
  const [open, setOpen] = useState(false)
  const side = useSideBySide()

  const sections = useMemo(() => SECTIONS.filter((s) => !(s.desktopOnly && isMobile)), [])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? sections.filter((s) => `${s.title} ${s.blurb} ${s.keywords}`.toLowerCase().includes(q)) : sections
  }, [sections, query])
  // Searching jumps to the first matching section (desktop shows it straight away).
  useEffect(() => {
    if (shown.length && !shown.some((s) => s.id === active)) setActive(shown[0].id)
  }, [shown, active])
  const pick = (id: SectionId) => {
    setActive(id)
    setOpen(true)
    try {
      localStorage.setItem(LAST_SECTION, id)
    } catch {
      /* storage unavailable */
    }
  }

  if (!settings) return null
  const current = sections.find((s) => s.id === active) ?? sections[0]

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        width={248}
        header={
          <div className="space-y-2">
            <div className="text-[13px] font-semibold">Settings</div>
            <div className="relative">
              <MagnifyingGlass size={13} className="absolute left-2.5 top-2.5 text-dim" />
              <Input className="pl-7 pr-7" placeholder="Search settings" value={query} onChange={(e) => setQuery(e.target.value)} />
              {query && (
                <button onClick={() => setQuery('')} className="absolute right-2 top-2 text-dim hover:text-fg" aria-label="Clear search">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        }
      >
        {shown.map((s) => {
          const on = s.id === current.id && side
          return (
            <button
              key={s.id}
              onClick={() => pick(s.id)}
              className={clsx(
                'relative mx-0.5 my-0.5 flex w-[calc(100%-4px)] items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors mobile:min-h-[56px] mobile:gap-3',
                on ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev hover:text-fg mobile:text-fg'
              )}
            >
              {on && <motion.span layoutId="settings-nav" transition={{ type: 'spring', stiffness: 500, damping: 40 }} className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-crimson" />}
              <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', on ? 'bg-crimson-soft text-crimson-hi' : 'bg-elev text-dim')}>
                <s.icon size={15} weight={on ? 'fill' : 'regular'} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium mobile:text-[14px]">{s.title}</span>
                <span className="block truncate text-[11px] text-dim mobile:text-[12px]">{s.blurb}</span>
              </span>
              {!side && <CaretRight size={14} className="text-dim" />}
            </button>
          )
        })}
        {!shown.length && <div className="p-4 text-center text-[12px] text-dim">Nothing matches “{query}”.</div>}
      </ListPane>

      <SplitDetail>
        <div className="h-full overflow-y-auto">
          <div className="mx-auto max-w-[760px] px-6 pb-10 pt-6 mobile:px-4 mobile:pt-3">
            <div className="mb-5 flex items-start gap-2">
              <SplitBack className="mt-0.5" />
              <div>
                <h1 className="text-[18px] font-semibold tracking-tight">{current.title}</h1>
                <div className="text-[12.5px] text-dim">{current.blurb}</div>
              </div>
            </div>
            <SectionBody id={current.id} settings={settings} />
          </div>
        </div>
      </SplitDetail>
    </SplitRoot>
  )
}

function SectionBody({ id, settings }: { id: SectionId; settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  switch (id) {
    case 'models':
      return (
        <Group>
          <Row label="Chat" hint="Default for new chats, flows and skill tests.">
            <ModelPicker className="w-72 mobile:w-full" value={settings.defaultModel} onChange={(m) => void update({ defaultModel: m })} allowNone noneLabel="None" />
          </Row>
          <Row label="Embeddings" hint="Adds vector search. None means keyword search only.">
            <ModelPicker className="w-72 mobile:w-full" kind="embedding" value={settings.embeddingModel} onChange={(m) => void update({ embeddingModel: m })} allowNone noneLabel="None (BM25 only)" />
          </Row>
          <Row label="Images" hint="Used by generate_image.">
            <ModelPicker className="w-72 mobile:w-full" kind="image" value={settings.imageModel} onChange={(m) => void update({ imageModel: m })} allowNone noneLabel="First image model available" />
          </Row>
        </Group>
      )
    case 'chat':
      return (
        <Group>
          <Row label="Summarise long conversations" hint="Summarises older turns near the context limit.">
            <Switch checked={settings.autoCompact} onChange={(autoCompact) => void update({ autoCompact })} />
          </Row>
          <Row label="Name chats with AI" hint="Titles you type are kept.">
            <Switch checked={settings.aiTitles} onChange={(aiTitles) => void update({ aiTitles })} />
          </Row>
          {settings.aiTitles && (
            <Row label="Title model" hint="Defaults to the chat's model.">
              <ModelPicker className="w-72 mobile:w-full" value={settings.titleModel} onChange={(titleModel) => void update({ titleModel })} allowNone noneLabel="Same as the chat" />
            </Row>
          )}
        </Group>
      )
    case 'subagents':
      return (
        <>
          <SubagentSection value={settings.subagents} />
          <TierSection tiers={settings.agentTiers} />
        </>
      )
    case 'web':
      return <WebSearchSettings />
    case 'knowledge':
      return (
        <Group title="Chunking" note="Applies to newly indexed documents.">
          <Row label="Chunk size" hint="Characters per chunk.">
            <NumberInput value={settings.chunkSize} min={300} max={8000} step={100} suffix="chars" onCommit={(chunkSize) => void update({ chunkSize })} />
          </Row>
          <Row label="Overlap" hint="Characters shared between neighbouring chunks.">
            <NumberInput value={settings.chunkOverlap} min={0} max={2000} step={50} suffix="chars" onCommit={(chunkOverlap) => void update({ chunkOverlap })} />
          </Row>
        </Group>
      )
    case 'design':
      return (
        <Group>
          <div className="flex items-center gap-3 p-4 text-[12.5px] text-muted">
            <span className="flex-1">Palettes, type and shape that projects follow; written into a project as DESIGN.md and theme files.</span>
            <Button size="sm" onClick={() => useApp.getState().openDesign(null)}>
              Open design systems
            </Button>
          </div>
        </Group>
      )
    case 'phone':
      return (
        <>
          <PhoneSettings />
        </>
      )
    case 'mcp':
      return (
        <Group>
          <Row label="Port">
            <NumberInput value={settings.mcpPort} min={1024} max={65535} onCommit={(mcpPort) => void update({ mcpPort })} />
          </Row>
        </Group>
      )
    case 'about':
      return <AboutSection />
  }
}

function SubagentSection({ value }: { value: SubagentSettings }) {
  const update = useApp((s) => s.updateSettings)
  const set = (patch: Partial<SubagentSettings>) => void update({ subagents: { ...value, ...patch } })
  const [instructions, setInstructions] = useState(value.instructions)
  useEffect(() => setInstructions(value.instructions), [value.instructions])
  return (
    <>
      <Group title="Defaults">
        <Row label="On for new chats" hint="Existing chats keep their own setting.">
          <Switch checked={value.enabledByDefault} onChange={(enabledByDefault) => set({ enabledByDefault })} />
        </Row>
        <Row label="Model" hint="Defaults to the chat's model.">
          <ModelPicker className="w-72 mobile:w-full" value={value.model} onChange={(model) => set({ model })} allowNone noneLabel="Same as the chat" />
        </Row>
        <Row label="Thinking" hint="On models that support it.">
          <select
            value={value.thinking === 'inherit' ? 'inherit' : normalizeEffort(value.thinking)}
            onChange={(e) => set({ thinking: e.target.value as SubagentSettings['thinking'] })}
            className="h-8 w-44 rounded-md border border-line bg-panel px-2 text-[12.5px] text-fg outline-none focus:border-crimson-line mobile:w-full"
          >
            <option value="inherit">Same as the chat</option>
            {EFFORT_OPTIONS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group title="Limits">
        <Row label="Steps per subagent" hint="Turns before it must report back.">
          <NumberInput value={value.maxTurns} min={1} max={100} onCommit={(maxTurns) => set({ maxTurns })} />
        </Row>
        <Row label="Running at once" hint="Across all chats; extra jobs queue.">
          <NumberInput value={value.maxParallel} min={1} max={16} onCommit={(maxParallel) => set({ maxParallel })} />
        </Row>
      </Group>
      <Group title="Permissions">
        <Row label="Allow workers" hint="Off: subagents are read-only.">
          <Switch checked={value.allowWorkers} onChange={(allowWorkers) => set({ allowWorkers })} />
        </Row>
      </Group>
      <Group title="Instructions">
        <div className="grid gap-2 p-4">
          <Textarea
            rows={4}
            value={instructions}
            aria-label="Instructions for plain jobs"
            placeholder="Rules every plain job follows (on top of its tier's)…"
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => instructions !== value.instructions && set({ instructions })}
          />
          <span className="text-[11.5px] text-dim">Added to every job handed out without a saved agent, read-only or editing.</span>
        </div>
        <div className="flex items-center gap-3 border-t border-line p-4 text-[12.5px] text-muted">
          <span className="flex-1">Saved agents, with their own instructions, model and effort, are on the Agents page.</span>
          <Button size="sm" onClick={() => useApp.getState().setPage('agents')}>
            Open Agents
          </Button>
        </div>
      </Group>
    </>
  )
}

/** The tiers (model + effort) agents can run at, in order. */
function TierSection({ tiers }: { tiers: AgentTier[] }) {
  const update = useApp((s) => s.updateSettings)
  const save = (next: AgentTier[]) => void update({ agentTiers: next })
  const patch = (id: string, p: Partial<AgentTier>) => save(tiers.map((t) => (t.id === id ? { ...t, ...p } : t)))
  const add = () => save([...tiers, { id: `tier_${Math.random().toString(36).slice(2, 10)}`, name: 'New tier', model: null, thinking: 'medium', purpose: '', instructions: '' }])
  const remove = async (t: AgentTier) => {
    if (tiers.length <= 1) return
    if (!(await confirmAction('Agents set to it fall back to the subagent defaults.', { title: `Remove ${t.name}?`, confirmLabel: 'Remove', danger: true }))) return
    save(tiers.filter((x) => x.id !== t.id))
  }
  return (
    <Group title="Tiers" note="Agents can run at a tier. Cloth picks the cheapest one that should get each job right.">
      {tiers.map((t) => (
        <TierRow key={t.id} tier={t} canRemove={tiers.length > 1} onChange={(p) => patch(t.id, p)} onRemove={() => void remove(t)} />
      ))}
      <div className="px-4 py-3">
        <Button size="sm" icon={<Plus size={13} />} onClick={add}>
          Add tier
        </Button>
      </div>
    </Group>
  )
}

function TierRow({ tier, canRemove, onChange, onRemove }: { tier: AgentTier; canRemove: boolean; onChange(p: Partial<AgentTier>): void; onRemove(): void }) {
  const [name, setName] = useState(tier.name)
  const [purpose, setPurpose] = useState(tier.purpose)
  useEffect(() => setName(tier.name), [tier.name])
  const [instructions, setInstructions] = useState(tier.instructions)
  useEffect(() => setPurpose(tier.purpose), [tier.purpose])
  useEffect(() => setInstructions(tier.instructions), [tier.instructions])
  const preset = DEFAULT_TIER_INSTRUCTIONS[tier.id]
  return (
    <div className="grid gap-2.5 px-4 py-3.5">
      <div className="flex items-center gap-2 mobile:flex-wrap">
        <Input
          className="w-40 mobile:w-full"
          value={name}
          aria-label="Tier name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => (name.trim() && name !== tier.name ? onChange({ name: name.trim() }) : setName(tier.name))}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <ModelPicker className="min-w-0 flex-1 mobile:w-full" value={tier.model} onChange={(model) => onChange({ model })} allowNone noneLabel="Chat's model" />
        <Select className="w-32 mobile:w-full" aria-label="Effort" value={normalizeEffortOrNull(tier.thinking) ?? 'chat'} onChange={(e) => onChange({ thinking: e.target.value === 'chat' ? null : (e.target.value as ThinkingLevel) })}>
          <option value="chat">Chat's</option>
          {EFFORT_OPTIONS.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </Select>
        <IconButton aria-label={`Remove ${tier.name}`} title={canRemove ? 'Remove tier' : 'At least one tier must remain'} disabled={!canRemove} onClick={onRemove}>
          <Trash size={14} />
        </IconButton>
      </div>
      <Textarea rows={2} value={purpose} aria-label="Purpose" placeholder="Meant for…" onChange={(e) => setPurpose(e.target.value)} onBlur={() => purpose !== tier.purpose && onChange({ purpose })} />
      <label htmlFor={`tier-instructions-${tier.id}`} className="px-0.5 text-[12px] font-medium text-dim">
        Instructions
      </label>
      <Textarea
        id={`tier-instructions-${tier.id}`}
        rows={5}
        value={instructions}
        aria-label="Instructions"
        placeholder="Rules every job at this tier follows…"
        onChange={(e) => setInstructions(e.target.value)}
        onBlur={() => instructions !== tier.instructions && onChange({ instructions })}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-dim">Added to the agent's instructions for every job run at this tier.</span>
        {preset !== undefined && tier.instructions !== preset && (
          <button type="button" className="shrink-0 text-[11.5px] text-dim hover:text-fg" onClick={() => onChange({ instructions: preset })}>
            Reset to default
          </button>
        )}
      </div>
    </div>
  )
}

function AboutSection() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void api.app.info().then(setInfo)
  }, [])
  if (!info) return null
  return (
    <>
      <Group title="Data">
        <Row label="Data folder" hint="API keys are encrypted with the OS keychain." stacked>
          <div className="flex items-center gap-2">
            <span className="selectable min-w-0 flex-1 truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[12px] text-muted">{info.dataDir}</span>
            {!isMobile && (
              <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void api.app.openPath(info.dataDir)}>
                Open
              </Button>
            )}
          </div>
        </Row>
      </Group>
      <Card className="flex items-center gap-3 p-4">
        <Logo size={32} />
        <div>
          <div className="text-[13.5px] font-semibold">Cloth {info.version}</div>
          <div className="text-[11.5px] text-dim">
            Electron {info.electron} · Node {info.node} · {info.platform} · agent runtime: pi-agent-core
          </div>
        </div>
      </Card>
    </>
  )
}

/** A titled card of setting rows. */
function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <div className="mb-2 px-1 text-[12px] font-medium text-dim">{title}</div>}
      <div className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-panel">{children}</div>
      {note && <div className="mt-1.5 px-1 text-[11.5px] text-dim">{note}</div>}
    </section>
  )
}

/** One setting: what it does on the left, its control on the right (or below when `stacked`). */
function Row({ label, hint, children, stacked }: { label: string; hint?: ReactNode; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={clsx('gap-x-6 gap-y-2.5 px-4 py-3.5', stacked ? 'space-y-2.5' : 'flex items-center mobile:flex-col mobile:items-stretch')}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-dim">{hint}</div>}
      </div>
      <div className={clsx(!stacked && 'shrink-0')}>{children}</div>
    </div>
  )
}

/** Number field that saves a clamped value on blur or Enter. */
function NumberInput({ value, min, max, step = 1, suffix, onCommit }: { value: number; min: number; max: number; step?: number; suffix?: string; onCommit(n: number): void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Math.round(Math.max(min, Math.min(max, Number(text))))
    if (!Number.isFinite(n)) return setText(String(value))
    setText(String(n))
    if (n !== value) onCommit(n)
  }
  return (
    <div className="flex items-center gap-2">
      <Input type="number" className="w-28" min={min} max={max} step={step} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      {suffix && <span className="text-[11.5px] text-dim">{suffix}</span>}
    </div>
  )
}
