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
  PlugsConnected,
  Robot,
  X,
  type Icon
} from '@phosphor-icons/react'
import type { AppInfo, Settings, SubagentSettings, ThinkingLevel } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { Button, Card, Input, ListPane, Switch, Textarea } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Logo } from '@/components/Logo'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { WebSearchSettings } from './WebSearchSettings'
import { PhoneSettings } from './PhoneSettings'

type SectionId = 'models' | 'chat' | 'subagents' | 'web' | 'knowledge' | 'phone' | 'mcp' | 'about'

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
  { id: 'chat', title: 'Chat', icon: ChatCircleDots, blurb: 'Summarising long conversations', keywords: 'compact summarise summarize context window' },
  { id: 'subagents', title: 'Subagents', icon: Robot, blurb: 'Delegation with the task tool', keywords: 'task delegate scout worker parallel turns agent' },
  { id: 'web', title: 'Web search', icon: GlobeHemisphereWest, blurb: 'Search engine and page fetching', keywords: 'searxng obscura web_fetch internet results' },
  { id: 'knowledge', title: 'Knowledge', icon: Books, blurb: 'How documents are split for search', keywords: 'chunk chunking overlap rag index' },
  { id: 'phone', title: 'Phone', icon: DeviceMobile, blurb: 'Use Cloth from the Android app', keywords: 'mobile android pair qr remote tailscale wifi', desktopOnly: true },
  { id: 'mcp', title: 'MCP server', icon: PlugsConnected, blurb: 'Expose skills and knowledge to other tools', keywords: 'mcp port server claude cursor' },
  { id: 'about', title: 'Data & about', icon: Info, blurb: 'Where Cloth keeps its data, and version', keywords: 'data folder version database about' }
]

const THINKING: (ThinkingLevel | 'inherit')[] = ['inherit', 'off', 'minimal', 'low', 'medium', 'high']
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
          const on = s.id === current.id && !isMobile
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
              {isMobile && <CaretRight size={14} className="text-dim" />}
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
          <Row label="Chat" hint="Used by new chats, flows and skill tests unless they pick a model.">
            <ModelPicker className="w-72 mobile:w-full" value={settings.defaultModel} onChange={(m) => void update({ defaultModel: m })} allowNone noneLabel="None" />
          </Row>
          <Row label="Embeddings" hint="Adds vector search to knowledge. Without one, search is keyword-only (BM25).">
            <ModelPicker className="w-72 mobile:w-full" kind="embedding" value={settings.embeddingModel} onChange={(m) => void update({ embeddingModel: m })} allowNone noneLabel="None (BM25 only)" />
          </Row>
          <Row label="Images" hint="Used by generate_image in chat. Mark models as Image on the Models page.">
            <ModelPicker className="w-72 mobile:w-full" kind="image" value={settings.imageModel} onChange={(m) => void update({ imageModel: m })} allowNone noneLabel="First image model available" />
          </Row>
        </Group>
      )
    case 'chat':
      return (
        <Group>
          <Row label="Summarise long conversations" hint="Near the model's context window, older turns are summarised into a checkpoint before the next message. The originals stay visible. You can also summarise any time from the context meter.">
            <Switch checked={settings.autoCompact} onChange={(autoCompact) => void update({ autoCompact })} />
          </Row>
        </Group>
      )
    case 'subagents':
      return <SubagentSection value={settings.subagents} />
    case 'web':
      return <WebSearchSettings />
    case 'knowledge':
      return (
        <Group title="Chunking" note="Applies to newly indexed documents. Re-index a document to re-chunk it.">
          <Row label="Chunk size" hint="Characters per chunk. Larger chunks keep more context; smaller ones match more precisely.">
            <NumberInput value={settings.chunkSize} min={300} max={8000} step={100} suffix="chars" onCommit={(chunkSize) => void update({ chunkSize })} />
          </Row>
          <Row label="Overlap" hint="Characters repeated between neighbouring chunks so sentences aren't cut off.">
            <NumberInput value={settings.chunkOverlap} min={0} max={2000} step={50} suffix="chars" onCommit={(chunkOverlap) => void update({ chunkOverlap })} />
          </Row>
        </Group>
      )
    case 'phone':
      return (
        <>
          <Note>Your PC does all the work — models, files and keys stay here. Phones connect over your home Wi-Fi, or from anywhere through Tailscale, end-to-end encrypted with a key shared only through the QR code.</Note>
          <PhoneSettings />
        </>
      )
    case 'mcp':
      return (
        <Group note="Status, tools and client setup snippets are on the MCP page.">
          <Row label="Port" hint="The server restarts when the port changes.">
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
      <Note>
        With subagents on, the chat agent can hand a self-contained job to a helper with a fresh context using the <code className="font-mono text-muted">task</code> tool — e.g. exploring a codebase or researching in parallel. Turn them on or off per chat in its context sheet.
      </Note>
      <Group title="Defaults">
        <Row label="On for new chats" hint="Existing chats keep their own setting.">
          <Switch checked={value.enabledByDefault} onChange={(enabledByDefault) => set({ enabledByDefault })} />
        </Row>
        <Row label="Model" hint="A faster or cheaper model for delegated jobs. By default subagents use the chat's model.">
          <ModelPicker className="w-72 mobile:w-full" value={value.model} onChange={(model) => set({ model })} allowNone noneLabel="Same as the chat" />
        </Row>
        <Row label="Thinking" hint="Reasoning effort for subagents on models that support it.">
          <select
            value={value.thinking}
            onChange={(e) => set({ thinking: e.target.value as SubagentSettings['thinking'] })}
            className="h-8 w-44 rounded-md border border-line bg-panel px-2 text-[12.5px] text-fg outline-none focus:border-crimson-line mobile:w-full"
          >
            {THINKING.map((t) => (
              <option key={t} value={t}>
                {t === 'inherit' ? 'Same as the chat' : t[0].toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group title="Limits">
        <Row label="Steps per subagent" hint="Agent turns a subagent may take before it has to report back.">
          <NumberInput value={value.maxTurns} min={1} max={100} onCommit={(maxTurns) => set({ maxTurns })} />
        </Row>
        <Row label="Running at once" hint="Across all chats. Extra jobs wait in a queue and show as Queued.">
          <NumberInput value={value.maxParallel} min={1} max={16} onCommit={(maxParallel) => set({ maxParallel })} />
        </Row>
      </Group>
      <Group title="Permissions">
        <Row label="Allow workers" hint="Workers can edit files in the chat's workspace (only when the chat allows writing, and still through its approvals). Off: every subagent is a read-only scout.">
          <Switch checked={value.allowWorkers} onChange={(allowWorkers) => set({ allowWorkers })} />
        </Row>
      </Group>
      <Group title="Instructions" note="Added to every subagent's system prompt — e.g. a report format or conventions to follow.">
        <div className="p-4">
          <Textarea
            rows={4}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => instructions !== value.instructions && set({ instructions })}
            placeholder="e.g. Cite files as path:line. Keep reports under 200 words."
            className="w-full"
          />
          <div className="mt-1 text-[11px] text-dim">Saved when you click away.</div>
        </div>
      </Group>
    </>
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
        <Row label="Data folder" hint="cloth.db (providers, knowledge, chats, workflows), skills/ and skills-trash/. API keys are encrypted with the OS keychain." stacked>
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
      {title && <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-dim">{title}</div>}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">{children}</div>
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

function Note({ children }: { children: ReactNode }) {
  return <div className="mb-5 rounded-xl border border-line bg-elev/60 px-4 py-3 text-[12.5px] leading-relaxed text-muted">{children}</div>
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
