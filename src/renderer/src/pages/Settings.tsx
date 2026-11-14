import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import {
  ArrowClockwise,
  Books,
  CaretRight,
  ChatCircleDots,
  Code,
  Cpu,
  DeviceMobile,
  DownloadSimple,
  FolderOpen,
  GlobeHemisphereWest,
  Info,
  MagnifyingGlass,
  Package,
  Palette,
  PlugsConnected,
  Plus,
  Robot,
  Trash,
  X,
  type Icon
} from '@phosphor-icons/react'
import { DEFAULT_TIER_INSTRUCTIONS, type AgentTier, type AppInfo, type Settings, type UpdateStatus, type SubagentSettings, type ThinkingLevel } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { useApp } from '@/lib/store'
import { isMobile, useSideBySide } from '@/lib/platform'
import { Button, Card, IconButton, Input, ListPane, Select, Switch, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Logo } from '@/components/Logo'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { WebSearchSettings } from './WebSearchSettings'
import { PhoneSettings } from './PhoneSettings'
import { DependencySettings } from './DependencySettings'
import { DEFAULT_SETTINGS } from '@shared/settings-defaults'
import { EFFORT_OPTIONS, normalizeEffort, normalizeEffortOrNull } from '@shared/effort'
import { ACCESS_LEVELS, maxDelegatedAccess, type AgentAccess } from '@shared/access'

type SectionId = 'models' | 'chat' | 'coding' | 'subagents' | 'web' | 'knowledge' | 'design' | 'phone' | 'mcp' | 'deps' | 'about'

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
  { id: 'models', title: 'Models', icon: Cpu, blurb: 'Which model does each job. Add or edit providers on the Models page.', keywords: 'default model embedding image llm provider' },
  { id: 'chat', title: 'Chat', icon: ChatCircleDots, blurb: 'How chats are named, and how long ones stay within the model’s limit.', keywords: 'compact summarise summarize context window title name rename ai titles' },
  { id: 'coding', title: 'Coding rules', icon: Code, blurb: 'Rules every agent follows when it writes code.', keywords: 'style conventions lint ast-grep sgconfig agents.md claude.md preferences' },
  { id: 'subagents', title: 'Subagents', icon: Robot, blurb: 'Helpers a chat can hand parts of a task to, what they may do, and the reasoning levels they run at.', keywords: 'task delegate reader writer operator access reasoning tier parallel turns agent' },
  { id: 'web', title: 'Web search', icon: GlobeHemisphereWest, blurb: 'Where chats look things up when web search is on.', keywords: 'searxng obscura web_fetch internet results' },
  { id: 'knowledge', title: 'Knowledge', icon: Books, blurb: 'How documents are split before they’re indexed. Changes apply to documents added afterwards.', keywords: 'chunk chunking overlap rag index' },
  { id: 'design', title: 'Design systems', icon: Palette, blurb: 'Palettes, type and shape that projects follow.', keywords: 'design system palette colours colors fonts theme tokens tailwind shadcn DESIGN.md' },
  { id: 'phone', title: 'Phone', icon: DeviceMobile, blurb: 'Chat with Cloth from the Android app.', keywords: 'mobile android pair qr remote tailscale wifi', desktopOnly: true },
  { id: 'mcp', title: 'MCP server', icon: PlugsConnected, blurb: 'Lets other apps, like your editor, use Cloth’s skills and knowledge.', keywords: 'mcp port server claude cursor' },
  { id: 'deps', title: 'Dependencies', icon: Package, blurb: 'Programs Cloth ships with, the ones it uses from this PC, and what each one is for.', keywords: 'git github gh docker node python bash powershell obscura searxng openspec installed programs tools requirements', desktopOnly: true },
  { id: 'about', title: 'Data & about', icon: Info, blurb: 'Where Cloth keeps its data, and which version you have.', keywords: 'data folder version database about update updates github release' }
]

const LAST_SECTION = 'cloth.settingsSection'

/** Opens Settings on one section (the toast for a found update uses it). */
export function openSettingsSection(id: SectionId): void {
  try {
    localStorage.setItem(LAST_SECTION, id)
  } catch {
    // Without storage Settings opens on its first section.
  }
  useApp.getState().setPage('settings')
}

export function SettingsPage() {
  const side = useSideBySide()
  const settings = useApp((s) => s.settings)
  if (!settings) return null
  return side ? <SettingsDocument settings={settings} /> : <SettingsSplit settings={settings} />
}

const savedSection = (): SectionId => {
  try {
    return (localStorage.getItem(LAST_SECTION) as SectionId) || 'models'
  } catch {
    return 'models'
  }
}
const saveSection = (id: SectionId) => {
  try {
    localStorage.setItem(LAST_SECTION, id)
  } catch {
    /* storage unavailable */
  }
}
const matches = (s: SectionDef, q: string) => !q || `${s.title} ${s.blurb} ${s.keywords}`.toLowerCase().includes(q)

/** Settings changed from their defaults: a blue outline, wash and Reset on the row, a count in the index. */
interface Tracked {
  section: SectionId
  changed(s: Settings): boolean
  reset(s: Settings): Partial<Settings>
}
const D = DEFAULT_SETTINGS
const top = <K extends keyof Settings>(key: K, section: SectionId): [string, Tracked] => [
  key,
  { section, changed: (s) => s[key] !== D[key], reset: () => ({ [key]: D[key] }) as Partial<Settings> }
]
const sub = <K extends keyof SubagentSettings>(key: K): [string, Tracked] => [
  `subagents.${key}`,
  { section: 'subagents', changed: (s) => s.subagents[key] !== D.subagents[key], reset: (s) => ({ subagents: { ...s.subagents, [key]: D.subagents[key] } }) }
]
const TRACKED = new Map<string, Tracked>([
  top('autoCompact', 'chat'),
  top('aiTitles', 'chat'),
  top('chunkSize', 'knowledge'),
  top('chunkOverlap', 'knowledge'),
  top('mcpPort', 'mcp'),
  sub('enabledByDefault'),
  sub('thinking'),
  sub('maxTurns'),
  sub('maxParallel'),
  sub('maxAccess')
])
const changedKeys = (s: Settings) => [...TRACKED].filter(([, t]) => t.changed(s)).map(([k]) => k)

/** Desktop: every section on one scrolling page, with an index that follows the scroll. */
function SettingsDocument({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SectionId>(savedSection)
  const scroller = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const q = query.trim().toLowerCase()
  const sections = useMemo(() => SECTIONS.filter((s) => !(s.desktopOnly && isMobile)), [])
  const shown = sections.filter((s) => matches(s, q))
  const changed = changedKeys(settings)
  const countIn = (id: SectionId) => changed.filter((k) => TRACKED.get(k)!.section === id).length

  const jump = (id: SectionId, behavior?: ScrollBehavior) => {
    setActive(id)
    saveSection(id)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: behavior ?? (reduce ? 'auto' : 'smooth'), block: 'start' })
  }
  // Open where the user left off (or where openSettingsSection pointed).
  useEffect(() => {
    const id = savedSection()
    if (id !== 'models') requestAnimationFrame(() => jump(id, 'auto'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Ctrl+F finds a setting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const onScroll = () => {
    const box = scroller.current
    if (!box) return
    const line = box.getBoundingClientRect().top + 56
    let current = shown[0]?.id
    for (const s of shown) {
      const el = document.getElementById(`settings-${s.id}`)
      if (el && el.getBoundingClientRect().top <= line) current = s.id
    }
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) current = shown.at(-1)?.id ?? current
    if (current && current !== active) {
      setActive(current)
      saveSection(current)
    }
  }
  const resetAll = async () => {
    const n = changed.length
    if (!(await confirmAction(`${n} ${n === 1 ? 'setting goes' : 'settings go'} back to the default. Models, instructions and reasoning levels stay as they are.`, { title: 'Reset changed settings?', confirmLabel: 'Reset' }))) return
    let patch: Partial<Settings> = {}
    for (const k of changed) patch = { ...patch, ...TRACKED.get(k)!.reset({ ...settings, ...patch }) }
    void update(patch)
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-[240px] shrink-0 flex-col gap-4 border-r border-line/60 px-3 pb-4 pt-6">
        <h1 className="px-2 text-title font-semibold tracking-tight">Settings</h1>
        <div className="relative">
          <MagnifyingGlass size={14} className="pointer-events-none absolute left-2.5 top-[9px] text-dim" />
          <Input ref={search} className="pl-8 pr-14" placeholder="Find a setting" aria-label="Find a setting" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQuery('')} />
          {query ? (
            <button onClick={() => setQuery('')} className="absolute right-2 top-[9px] text-dim hover:text-fg" aria-label="Clear search">
              <X size={14} />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 top-[7px] rounded border border-line px-1.5 font-mono text-micro text-dim">Ctrl F</kbd>
          )}
        </div>
        <nav aria-label="Settings sections" className="-mx-0.5 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
          {sections.map((s) => {
            const hit = matches(s, q)
            const on = hit && s.id === active
            const n = countIn(s.id)
            return (
              <button
                key={s.id}
                onClick={() => jump(s.id)}
                disabled={!hit}
                aria-current={on ? 'true' : undefined}
                className={clsx(
                  'flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-ui font-medium transition-colors',
                  on ? 'bg-elev text-fg' : 'text-dim hover:bg-elev hover:text-fg',
                  !hit && 'pointer-events-none opacity-35'
                )}
              >
                <s.icon size={16} weight={on ? 'fill' : 'regular'} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {n > 0 && (
                  <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-elev-2 px-1.5 text-micro font-semibold text-muted" title={`${n} changed from the default`}>
                    {n}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
        {changed.length > 0 && (
          <div className="flex items-center justify-between border-t border-line/60 px-2 pt-3 text-caption text-dim">
            <span>
              {changed.length} {changed.length === 1 ? 'setting' : 'settings'} changed
            </span>
            <button className="rounded px-1.5 py-0.5 hover:bg-elev hover:text-fg" onClick={() => void resetAll()}>
              Reset all
            </button>
          </div>
        )}
      </aside>

      <div ref={scroller} onScroll={onScroll} className="min-w-0 flex-1 overflow-y-auto">
        <div className="px-12 pb-[40vh] pt-7">
          {shown.map((s) => (
            <section key={s.id} id={`settings-${s.id}`} aria-labelledby={`settings-${s.id}-title`} className="scroll-mt-4 pb-6 pt-3">
              <h2 id={`settings-${s.id}-title`} className="text-section font-semibold">
                {s.title}
              </h2>
              <p className="mb-4 mt-0.5 max-w-[60ch] text-ui text-dim">{s.blurb}</p>
              <SectionBody id={s.id} settings={settings} />
            </section>
          ))}
          {!shown.length && (
            <p className="py-10 text-ui text-dim">
              Nothing matches <span className="text-fg">“{query}”</span>. Try a word like “model”, “port” or “summarise”.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** Phone: a list of sections, each opening on its own screen. */
function SettingsSplit({ settings }: { settings: Settings }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SectionId>(savedSection)
  const [open, setOpen] = useState(false)
  const side = useSideBySide()

  const sections = useMemo(() => SECTIONS.filter((s) => !(s.desktopOnly && isMobile)), [])
  const shown = useMemo(() => sections.filter((s) => matches(s, query.trim().toLowerCase())), [sections, query])
  // Searching jumps to the first matching section.
  useEffect(() => {
    if (shown.length && !shown.some((s) => s.id === active)) setActive(shown[0].id)
  }, [shown, active])
  const pick = (id: SectionId) => {
    setActive(id)
    setOpen(true)
    saveSection(id)
  }

  const current = sections.find((s) => s.id === active) ?? sections[0]

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        width={248}
        header={
          <div className="space-y-2">
            <div className="text-ui font-semibold">Settings</div>
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
              <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', on ? 'bg-elev-2 text-fg' : 'bg-elev text-dim')}>
                <s.icon size={15} weight={on ? 'fill' : 'regular'} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium mobile:text-body">{s.title}</span>
              </span>
              {!side && <CaretRight size={14} className="text-dim" />}
            </button>
          )
        })}
        {!shown.length && <div className="p-4 text-center text-caption text-dim">Nothing matches “{query}”.</div>}
      </ListPane>

      <SplitDetail>
        <div className="h-full overflow-y-auto">
          <div className="px-6 pb-10 pt-6 mobile:px-4 mobile:pt-3">
            <div className="mb-5 flex items-start gap-2">
              <SplitBack className="mt-0.5" />
              <div>
                <h1 className="text-title font-semibold tracking-tight">{current.title}</h1>
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
          <Row label="Chat">
            <ModelPicker className="w-72 mobile:w-full" value={settings.defaultModel} onChange={(m) => void update({ defaultModel: m })} allowNone noneLabel="None" />
          </Row>
          <Row label="Embeddings">
            <ModelPicker className="w-72 mobile:w-full" kind="embedding" value={settings.embeddingModel} onChange={(m) => void update({ embeddingModel: m })} allowNone noneLabel="None (BM25 only)" />
          </Row>
          <Row label="Images">
            <ModelPicker className="w-72 mobile:w-full" kind="image" value={settings.imageModel} onChange={(m) => void update({ imageModel: m })} allowNone noneLabel="First image model available" />
          </Row>
        </Group>
      )
    case 'chat':
      return (
        <Group>
          <Row label="Summarise long conversations" track="autoCompact" hint="When a chat nears the model's limit, older turns are replaced by a summary.">
            <Switch checked={settings.autoCompact} onChange={(autoCompact) => void update({ autoCompact })} />
          </Row>
          <Row label="Name chats with AI" track="aiTitles" hint="Give each chat a short title after the first answer.">
            <Switch checked={settings.aiTitles} onChange={(aiTitles) => void update({ aiTitles })} />
          </Row>
          {settings.aiTitles && (
            <Row label="Title model">
              <ModelPicker className="w-72 mobile:w-full" value={settings.titleModel} onChange={(titleModel) => void update({ titleModel })} allowNone noneLabel="Same as the chat" />
            </Row>
          )}
        </Group>
      )
    case 'coding':
      return <CodingRulesSection value={settings.codingRules} />
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
        <Group>
          <Row label="Chunk size" track="chunkSize" hint="Smaller chunks give sharper matches with less context around them.">
            <NumberInput value={settings.chunkSize} min={300} max={8000} step={100} suffix="chars" onCommit={(chunkSize) => void update({ chunkSize })} />
          </Row>
          <Row label="Overlap" track="chunkOverlap" hint="Text repeated between neighbouring chunks so sentences aren’t cut in half.">
            <NumberInput value={settings.chunkOverlap} min={0} max={2000} step={50} suffix="chars" onCommit={(chunkOverlap) => void update({ chunkOverlap })} />
          </Row>
        </Group>
      )
    case 'design':
      return (
        <Group>
          <div className="flex items-center gap-3 p-4 text-ui text-muted">
            <span className="flex-1">Design systems</span>
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
          <Row label="Port" track="mcpPort" hint="Change it if another app already uses this port.">
            <NumberInput value={settings.mcpPort} min={1024} max={65535} onCommit={(mcpPort) => void update({ mcpPort })} />
          </Row>
        </Group>
      )
    case 'deps':
      return <DependencySettings />
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
        <Row label="On for new chats" track="subagents.enabledByDefault">
          <Switch checked={value.enabledByDefault} onChange={(enabledByDefault) => set({ enabledByDefault })} />
        </Row>
        <Row label="Model">
          <ModelPicker className="w-72 mobile:w-full" value={value.model} onChange={(model) => set({ model })} allowNone noneLabel="Same as the chat" />
        </Row>
        <Row label="Checks" hint="The model verifiers run on, such as Spec → Ship's review checks. Another model family than the one that builds catches more.">
          <ModelPicker className="w-72 mobile:w-full" value={value.reviewModel ?? null} onChange={(reviewModel) => set({ reviewModel })} allowNone noneLabel="Same as other subagents" />
        </Row>
        <Row label="Thinking" track="subagents.thinking">
          <select
            value={value.thinking === 'inherit' ? 'inherit' : normalizeEffort(value.thinking)}
            onChange={(e) => set({ thinking: e.target.value as SubagentSettings['thinking'] })}
            className="h-8 w-44 rounded-md border border-line bg-panel px-2 text-ui text-fg outline-none focus:border-crimson-line mobile:w-full"
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
        <Row label="Steps per subagent" track="subagents.maxTurns" hint="A subagent stops and reports back after this many steps.">
          <NumberInput value={value.maxTurns} min={1} max={100} onCommit={(maxTurns) => set({ maxTurns })} />
        </Row>
        <Row label="Running at once" track="subagents.maxParallel" hint="More run sooner but share your model’s rate limit.">
          <NumberInput value={value.maxParallel} min={1} max={16} onCommit={(maxParallel) => set({ maxParallel })} />
        </Row>
      </Group>
      <Group title="Permissions">
        <Row label="Delegated jobs may" track="subagents.maxAccess" hint="The most a subagent may do. The chat’s own access still caps it: in Plan mode every subagent is a Reader.">
          <select
            aria-label="Delegated jobs may"
            value={maxDelegatedAccess(value)}
            onChange={(e) => {
              const maxAccess = e.target.value as AgentAccess
              set({ maxAccess, allowWorkers: maxAccess !== 'reader' })
            }}
            className="h-8 rounded-lg border border-line bg-bg px-2 text-ui text-fg outline-none focus:border-line-strong"
          >
            {ACCESS_LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}: {l.sub.charAt(0).toLowerCase() + l.sub.slice(1)}
              </option>
            ))}
          </select>
        </Row>
      </Group>
      <Group title="Instructions">
        <div className="grid gap-2 p-4">
          <Textarea
            rows={4}
            value={instructions}
            aria-label="Instructions for plain jobs"
            placeholder="Rules every plain job follows (on top of its reasoning level's)…"
            onChange={(e) => setInstructions(e.target.value)}
            onBlur={() => instructions !== value.instructions && set({ instructions })}
          />
        </div>
        <div className="flex items-center gap-3 border-t border-line p-4 text-ui text-muted">
          <span className="flex-1">Saved agents</span>
          <Button size="sm" onClick={() => useApp.getState().setPage('agents')}>
            Open Agents
          </Button>
        </div>
      </Group>
    </>
  )
}

/** Rules for all code agents write: instructions in their prompt, and the global ast-grep rules folder checked after each edit. */
function CodingRulesSection({ value }: { value: string }) {
  const update = useApp((s) => s.updateSettings)
  const [rules, setRules] = useState(value)
  const [rulesDir, setRulesDir] = useState<string | null>(null)
  useEffect(() => setRules(value), [value])
  useEffect(() => {
    void api.app.info().then((info) => setRulesDir(info.rulesDir))
  }, [])
  return (
    <>
      <Group title="Instructions" note="Added to every chat and agent that works in a folder. A folder's AGENTS.md (or CLAUDE.md) comes after them and wins where they disagree.">
        <div className="grid gap-2 p-4">
          <Textarea
            rows={10}
            value={rules}
            aria-label="Coding rules"
            placeholder={'How you want code written, e.g.\n- Use early returns instead of nested if/else.\n- Name things after what they mean, not how they work.'}
            onChange={(e) => setRules(e.target.value)}
            onBlur={() => rules !== value && void update({ codingRules: rules })}
          />
        </div>
      </Group>
      <Group title="Rule checks" note="Agents see what these rules find right after each change, and fix it in the same turn.">
        <Row label="Rule files" hint="ast-grep rules (.yml) in this folder are checked in every folder. A folder's own sgconfig.yml rules are checked too." stacked>
          <div className="flex items-center gap-2">
            <span className="selectable min-w-0 flex-1 truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-caption text-muted">{rulesDir ?? '…'}</span>
            {!isMobile && rulesDir && (
              <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void api.app.openPath(rulesDir)}>
                Open
              </Button>
            )}
          </div>
        </Row>
      </Group>
    </>
  )
}

/** The tiers (model + effort) agents can run at, in order. */
function TierSection({ tiers }: { tiers: AgentTier[] }) {
  const update = useApp((s) => s.updateSettings)
  const save = (next: AgentTier[]) => void update({ agentTiers: next })
  const patch = (id: string, p: Partial<AgentTier>) => save(tiers.map((t) => (t.id === id ? { ...t, ...p } : t)))
  const add = () => save([...tiers, { id: `tier_${Math.random().toString(36).slice(2, 10)}`, name: 'New level', model: null, thinking: 'medium', purpose: '', instructions: '' }])
  const remove = async (t: AgentTier) => {
    if (tiers.length <= 1) return
    if (!(await confirmAction('Agents set to it fall back to the subagent defaults.', { title: `Remove ${t.name}?`, confirmLabel: 'Remove', danger: true }))) return
    save(tiers.filter((x) => x.id !== t.id))
  }
  return (
    <Group title="Reasoning levels">
      {tiers.map((t) => (
        <TierRow key={t.id} tier={t} canRemove={tiers.length > 1} onChange={(p) => patch(t.id, p)} onRemove={() => void remove(t)} />
      ))}
      <div className="px-4 py-3">
        <Button size="sm" icon={<Plus size={13} />} onClick={add}>
          Add level
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
          aria-label="Reasoning level name"
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
      <label htmlFor={`tier-instructions-${tier.id}`} className="px-0.5 text-caption font-medium text-dim">
        Instructions
      </label>
      <Textarea
        id={`tier-instructions-${tier.id}`}
        rows={5}
        value={instructions}
        aria-label="Instructions"
        placeholder="Rules every job at this level follows…"
        onChange={(e) => setInstructions(e.target.value)}
        onBlur={() => instructions !== tier.instructions && onChange({ instructions })}
      />
      <div className="flex items-center justify-between gap-3">
        {preset !== undefined && tier.instructions !== preset && (
          <button type="button" className="shrink-0 text-caption text-dim hover:text-fg" onClick={() => onChange({ instructions: preset })}>
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
            <span className="selectable min-w-0 flex-1 truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-caption text-muted">{info.dataDir}</span>
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
          <div className="text-body font-semibold">Cloth {info.version}</div>
          <div className="text-caption text-dim">
            Electron {info.electron} · Node {info.node} · {info.platform} · agent runtime: pi-agent-core
          </div>
        </div>
      </Card>
      {!isMobile && <UpdatesGroup />}
    </>
  )
}

const UPDATE_REPO = 'SKYZAP/Cloth-V3'
const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`

/** Check for updates from the private GitHub releases, download when asked, restart into the new version. */
function UpdatesGroup() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  const [token, setToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  useEffect(() => {
    void api.updates.status().then(setSt)
  }, [])
  useEvent('updates', setSt)
  if (!st) return null

  const saveToken = async () => {
    setSaving(true)
    setTokenError(null)
    try {
      setSt(await api.updates.setToken(token))
      setToken('')
      setEditing(false)
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  const forget = async () => {
    if (!(await confirmAction('Cloth stops checking for updates until a token is added again.', { title: 'Forget the GitHub token?', confirmLabel: 'Forget' }))) return
    setSt(await api.updates.setToken(''))
  }

  const pct = st.progress && st.progress.total ? Math.round((st.progress.transferred / st.progress.total) * 100) : 0
  const summary = !st.supported
    ? 'This build can’t update itself. Installed Windows and Linux builds can.'
    : !st.hasToken
      ? 'Add a GitHub token below to check for updates.'
      : st.state === 'checking'
        ? 'Checking GitHub…'
        : st.state === 'none'
          ? `Cloth ${st.current} is the newest version.`
          : st.state === 'available'
            ? `Cloth ${st.version} is available${st.size ? ` (${mb(st.size)})` : ''}.`
            : st.state === 'downloading'
              ? `Downloading Cloth ${st.version}… ${pct}%`
              : st.state === 'ready'
                ? `Cloth ${st.version} is downloaded. Restart to install it.`
                : st.checkedAt
                  ? `Last checked ${new Date(st.checkedAt).toLocaleString()}.`
                  : 'Not checked yet.'

  return (
    <div className="mt-6">
      <Group title="Updates" note={`Releases come from the private repository ${UPDATE_REPO}. Cloth checks once a day at launch; downloads start only when you ask.`}>
        <Row
          label={`Cloth ${st.current}`}
          hint={
            <>
              <span aria-live="polite">{summary}</span>
              {st.error && <span className="mt-1 block text-danger-hi">{st.error}</span>}
              {st.state === 'downloading' && (
                <span className="mt-2 block h-1 w-full max-w-[320px] overflow-hidden rounded-full bg-line-strong" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
                  <span className="block h-full rounded-full bg-info transition-[width]" style={{ width: `${pct}%` }} />
                </span>
              )}
            </>
          }
        >
          {st.supported && st.hasToken && (
            <div className="flex gap-2">
              {st.state === 'available' && (
                <Button variant="primary" icon={<DownloadSimple size={13} />} onClick={() => void api.updates.download().then(setSt)}>
                  Download {st.version}
                </Button>
              )}
              {st.state === 'ready' ? (
                <Button variant="primary" icon={<ArrowClockwise size={13} />} onClick={() => void api.updates.install()}>
                  Restart to update
                </Button>
              ) : (
                st.state !== 'downloading' && (
                  <Button loading={st.state === 'checking'} onClick={() => void api.updates.check().then(setSt)}>
                    Check for updates
                  </Button>
                )
              )}
            </div>
          )}
        </Row>
        {st.supported && (
          <Row
            label="GitHub token"
            stacked={!st.hasToken || editing}
            hint={
              st.hasToken && !editing
                ? 'Saved, encrypted with the OS keychain.'
                : `A fine-grained token with read-only access to Contents on ${UPDATE_REPO}. It stays encrypted on this PC.`
            }
          >
            {st.hasToken && !editing ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setEditing(true)}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void forget()}>
                  Forget
                </Button>
              </div>
            ) : (
              <form
                className="grid gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (token.trim()) void saveToken()
                }}
              >
                <div className="flex gap-2">
                  <Input
                    type="password"
                    className="min-w-0 flex-1 font-mono"
                    aria-label="GitHub token"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="github_pat_…"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value)
                      setTokenError(null)
                    }}
                  />
                  <Button type="submit" variant="primary" loading={saving} disabled={!token.trim()}>
                    Save token
                  </Button>
                  {editing && (
                    <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  )}
                </div>
                {tokenError && <div className="text-caption text-danger-hi">{tokenError}</div>}
              </form>
            )}
          </Row>
        )}
      </Group>
    </div>
  )
}

/** A titled card of setting rows. */
function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      {title && <div className="mb-2 px-1 text-caption font-medium text-dim">{title}</div>}
      <div className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-panel p-1">{children}</div>
      {note && <div className="mt-1.5 px-1 text-caption text-dim">{note}</div>}
    </section>
  )
}

/** One setting: what it does on the left, its control on the right (or below when `stacked`). */
function Row({ label, hint, children, stacked, track }: { label: string; hint?: ReactNode; children: ReactNode; stacked?: boolean; /** A TRACKED key: marks the row when it differs from the default. */ track?: string }) {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const t = track ? TRACKED.get(track) : undefined
  const changed = !!(t && settings && t.changed(settings))
  return (
    <div className={clsx('relative gap-x-6 gap-y-2.5 rounded-[7px] px-3 py-3.5', changed && 'bg-info/[0.07]', stacked ? 'space-y-2.5' : 'flex items-center mobile:flex-col mobile:items-stretch')}>
      {/* The ring sits above the dividers on either side, so a changed row reads as one outlined block. */}
      {changed && <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 -inset-y-px z-[1] rounded-[7px] ring-1 ring-inset ring-info/45" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-ui font-medium">
          {label}
          {changed && (
            <button type="button" className="rounded px-1.5 text-caption font-normal text-info hover:bg-info/15" onClick={() => void update(t!.reset(settings!))} aria-label={`Reset ${label} to the default`} title="Changed from the default">
              Reset
            </button>
          )}
        </div>
        {hint && <div className="mt-0.5 text-caption leading-snug text-dim">{hint}</div>}
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
      {suffix && <span className="text-caption text-dim">{suffix}</span>}
    </div>
  )
}
