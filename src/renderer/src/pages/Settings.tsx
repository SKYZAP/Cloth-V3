import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { motion } from 'motion/react'
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  ArrowCounterClockwise,
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
  ShieldCheck,
  Swatches as SwatchesIcon,
  Trash,
  Warning,
  Translate,
  X,
  type Icon
} from '@phosphor-icons/react'
import type { SwatchServerStatus } from '@shared/swatches'
import { DEFAULT_TIER_INSTRUCTIONS, type AgentTier, type AppInfo, type CertificateInfo, type NetworkCheck, type Settings, type UpdateStatus, type SubagentSettings, type ThinkingLevel } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { useApp } from '@/lib/store'
import { isMobile, useSideBySide } from '@/lib/platform'
import { Button, Card, IconButton, Input, ListPane, Select, Spinner, Switch, Textarea, chooseAction, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { NetworkFix, NetworkPill, networkSummary } from '@/components/NetworkTrust'
import { Logo } from '@/components/Logo'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { WebSearchSettings } from './WebSearchSettings'
import { PhoneSettings } from './PhoneSettings'
import { DependencySettings } from './DependencySettings'
import { LanguageServerStatus, useLanguageServers } from '@/components/LanguageServers'
import { LANGUAGES, type LanguageId } from '@shared/onboarding'
import { FORMAT_TOOLS, type CodeChecks, type FormatToolId, type FormatToolStatus } from '@shared/formatters'
import { attempt } from '@/lib/store'
import { DEFAULT_SETTINGS } from '@shared/settings-defaults'
import { activeTheme, allThemes, clampStrength, DEFAULT_CHAT_THEME, NO_THEME, STRENGTH_RANGE } from '@shared/chat-themes'
import { EFFORT_OPTIONS, normalizeEffort, normalizeEffortOrNull } from '@shared/effort'
import { ACCESS_LEVELS, maxDelegatedAccess, type AgentAccess } from '@shared/access'

type SectionId = 'models' | 'chat' | 'coding' | 'languages' | 'subagents' | 'web' | 'network' | 'knowledge' | 'design' | 'phone' | 'swatches' | 'mcp' | 'deps' | 'about'

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
  { id: 'chat', title: 'Chat', icon: ChatCircleDots, blurb: 'How chats are named, how long ones stay within the model’s limit, the background behind them, and how agents tidy the code they write.', keywords: 'format formatter lint linter prettier eslint biome ruff black gofmt golangci rustfmt clippy clang-format google-java-format compact summarise summarize context window title name rename ai titles background theme shader animation flow waves strength' },
  { id: 'coding', title: 'Coding rules', icon: Code, blurb: 'Rules every agent follows when it writes code.', keywords: 'style conventions lint ast-grep sgconfig agents.md claude.md preferences' },
  { id: 'languages', title: 'Languages', icon: Translate, blurb: 'The languages you work in, and the language servers that give agents go to definition, references and type errors.', keywords: 'lsp language server code intelligence gopls rust-analyzer clangd jdtls pyright typescript go rust c++ java install', desktopOnly: true },
  { id: 'subagents', title: 'Subagents', icon: Robot, blurb: 'Helpers a chat can hand parts of a task to, what they may do, and the reasoning levels they run at.', keywords: 'task delegate reader writer operator access reasoning tier parallel turns agent' },
  { id: 'web', title: 'Web search', icon: GlobeHemisphereWest, blurb: 'Where chats look things up when web search is on.', keywords: 'searxng obscura web_fetch internet results' },
  { id: 'network', title: 'Network', icon: ShieldCheck, blurb: 'How Cloth reaches sites over HTTPS, and certificates it trusts on networks that inspect it.', keywords: 'certificate cert ca pem crt ssl tls https proxy corporate company antivirus norton zscaler trust store mcp web search' },
  { id: 'knowledge', title: 'Knowledge', icon: Books, blurb: 'How documents are split before they’re indexed. Changes apply to documents added afterwards.', keywords: 'chunk chunking overlap rag index' },
  { id: 'design', title: 'Design systems', icon: Palette, blurb: 'Palettes, type and shape that projects follow.', keywords: 'design system palette colours colors fonts theme tokens tailwind shadcn DESIGN.md' },
  { id: 'phone', title: 'Phone', icon: DeviceMobile, blurb: 'Chat with Cloth from the Android app.', keywords: 'mobile android pair qr remote tailscale wifi', desktopOnly: true },
  { id: 'swatches', title: 'Swatches', icon: SwatchesIcon, blurb: 'Where the pages chats publish are served, and who can open them.', keywords: 'swatch swatches port server network share link lan wifi page', desktopOnly: true },
  { id: 'mcp', title: 'MCP server', icon: PlugsConnected, blurb: 'Lets other apps, like your editor, use Cloth’s skills and knowledge.', keywords: 'mcp port server claude cursor' },
  { id: 'deps', title: 'Dependencies', icon: Package, blurb: 'Programs Cloth ships with, the ones it uses from this PC, and what each one is for.', keywords: 'git github gh docker node python bash powershell obscura searxng openspec installed programs tools requirements', desktopOnly: true },
  { id: 'about', title: 'Data & about', icon: Info, blurb: 'Where Cloth keeps its data, and which version you have.', keywords: 'data folder version database about update updates github release setup onboarding first run welcome languages import' }
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
  top('chatTheme', 'chat'),
  top('chatThemeStrength', 'chat'),
  top('chunkSize', 'knowledge'),
  top('chunkOverlap', 'knowledge'),
  top('swatchPort', 'swatches'),
  top('swatchNetwork', 'swatches'),
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
        <>
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
          <BackgroundRows settings={settings} />
        </Group>
        <FormattingSection settings={settings} />
        </>
      )
    case 'coding':
      return <CodingRulesSection value={settings.codingRules} />
    case 'languages':
      return <LanguagesSection languages={settings.languages ?? []} />
    case 'subagents':
      return (
        <>
          <SubagentSection value={settings.subagents} />
          <TierSection tiers={settings.agentTiers} />
        </>
      )
    case 'web':
      return <WebSearchSettings />
    case 'network':
      return <NetworkSection settings={settings} />
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
    case 'swatches':
      return <SwatchSettings settings={settings} />
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

/** The swatch server: whether it's running (and why not), sharing with the network, and its port. */
function SwatchSettings({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const [status, setStatus] = useState<SwatchServerStatus | null>(null)
  useEffect(() => {
    void api.swatches.status().then(setStatus, () => undefined)
  }, [])
  useEvent('swatches', (e) => e.type === 'status' && setStatus(e.status))
  return (
    <Group
      note={
        status?.error ? (
          <span className="text-danger-hi">{status.error.replace(/ Pick another in Settings › Swatches\.$/, ' Pick another port above.')}</span>
        ) : status?.running ? (
          <span>
            Running on port <span className="font-mono tabular-nums text-muted">{status.port}</span>
            {status.network ? ', open to devices on your network.' : ', on this computer only.'}
          </span>
        ) : status ? (
          'Not running.'
        ) : undefined
      }
    >
      <Row label="Share on your network" track="swatchNetwork" hint="Phones and computers on the same network can open swatch links. Each link has its own key, so only people you send one to can open it.">
        <Switch checked={settings.swatchNetwork} onChange={(swatchNetwork) => void update({ swatchNetwork })} />
      </Row>
      <Row label="Port" track="swatchPort" hint="Change it if another app, or another copy of Cloth, already uses this port. Links made before stop working on the old port.">
        <NumberInput value={settings.swatchPort} min={1024} max={65535} onCommit={(swatchPort) => void update({ swatchPort })} />
      </Row>
    </Group>
  )
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

const WHEN_HINTS: Record<CodeChecks['when'], string> = {
  agent: 'Agents are told the folder’s formatter and linter commands, and run them on the files they changed before they finish.',
  cloth: 'Cloth runs them itself right after each write or edit, and shows the agent what’s left, so formatting doesn’t depend on the agent remembering.',
  off: 'Nothing runs. Agents may still run a folder’s lint script when a task asks for it.'
}

const FORMAT_GROUPS: { name: string; langs: LanguageId[] }[] = [
  { name: 'TypeScript and JavaScript', langs: ['typescript', 'javascript'] },
  { name: 'Python', langs: ['python'] },
  { name: 'Go', langs: ['go'] },
  { name: 'Rust', langs: ['rust'] },
  { name: 'C and C++', langs: ['cpp'] },
  { name: 'Java', langs: ['java'] }
]

/** Formatting and linting: when they run, and each tool with where it stands (Cloth installs some itself). */
function FormattingSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const checks = settings.codeChecks
  const set = (p: Partial<CodeChecks>) => void update({ codeChecks: { ...checks, ...p } })
  const [tools, setTools] = useState<FormatToolStatus[] | null>(null)
  const [busy, setBusy] = useState<Partial<Record<FormatToolId, { text: string; fraction: number | null }>>>({})
  useEffect(() => {
    let live = true
    void api.onboarding.formatters().then(
      (t) => live && setTools(t),
      () => live && setTools([])
    )
    return () => {
      live = false
    }
  }, [])
  useEvent('formatters', (e) => setBusy((b) => (b[e.id] ? { ...b, [e.id]: { text: e.text, fraction: e.fraction } } : b)))
  const run = async (id: FormatToolId, fn: () => Promise<FormatToolStatus[]>, done: string) => {
    setBusy((b) => ({ ...b, [id]: { text: 'Starting', fraction: null } }))
    const next = await attempt(fn, done)
    setBusy(({ [id]: _gone, ...rest }) => rest)
    if (next) setTools(next)
  }
  const off = checks.when === 'off'
  const chosen = settings.languages ?? []
  // Before any language is picked (no setup yet), every tool shows.
  const shown = (langs: LanguageId[]) => !chosen.length || langs.some((l) => chosen.includes(l))
  return (
    <>
      <Group title="Formatting and linting" note="Only the files a change touched are checked, so a folder is never reformatted as a whole.">
        <Row label="When code changes" hint={WHEN_HINTS[checks.when]}>
          <Select className="w-72 mobile:w-full" aria-label="When code changes" value={checks.when} onChange={(e) => set({ when: e.target.value as CodeChecks['when'] })}>
            <option value="agent">The agent runs them before it finishes</option>
            <option value="cloth">Cloth runs them after every change</option>
            <option value="off">Off</option>
          </Select>
        </Row>
        <div className={clsx(off && 'opacity-50')}>
          <Row label="Fix what they can" hint="Formatters rewrite the changed files and linters apply their safe fixes. Off, they only report, and the agent fixes what they find.">
            <Switch checked={checks.fix} disabled={off} onChange={(fix) => set({ fix })} ariaLabel="Fix what they can" />
          </Row>
        </div>
        <div className={clsx(off && 'opacity-50')}>
          <Row label="Folders with no setup of their own" hint="A folder’s own config and copy of a tool always come first. This decides what happens in a folder that has neither.">
            <Select className="w-72 mobile:w-full" aria-label="Folders with no setup of their own" disabled={off} value={checks.noSetup} onChange={(e) => set({ noSetup: e.target.value as CodeChecks['noSetup'] })}>
              <option value="skip">Leave them as they are</option>
              <option value="defaults">Use Cloth’s copies with their defaults</option>
            </Select>
          </Row>
        </div>
      </Group>
      <Group title="Formatters and linters" note="Shown for the languages switched on under Languages. Tools Cloth installs go in its data folder and are used only where a folder doesn’t have its own copy.">
        {FORMAT_GROUPS.filter((g) => shown(g.langs)).map((g) => (
          <div key={g.name}>
            <div className="px-3 pb-1 pt-2.5 text-caption font-semibold text-muted">{g.name}</div>
            {FORMAT_TOOLS.filter((t) => t.languages.some((l) => g.langs.includes(l))).map((t) => {
              const use = !checks.off.includes(t.id)
              return (
                <div key={t.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3 py-2.5 mobile:grid-cols-[auto_minmax(0,1fr)]">
                  <Switch checked={use} onChange={(v) => set({ off: v ? checks.off.filter((x) => x !== t.id) : [...checks.off, t.id] })} ariaLabel={`Agents use ${t.name}`} />
                  <div className={clsx('min-w-0', !use && 'opacity-60')}>
                    <div className="flex flex-wrap items-center gap-2 text-ui font-medium">
                      {t.name}
                      <span className="rounded bg-elev-2 px-1.5 text-micro font-medium text-muted">{t.kind}</span>
                    </div>
                    <div className="text-caption leading-snug text-dim">{t.hint}</div>
                  </div>
                  <div className="mobile:col-start-2">
                    <FormatToolState
                      info={tools?.find((x) => x.id === t.id)}
                      name={t.name}
                      progress={busy[t.id]}
                      onInstall={() => void run(t.id, () => api.onboarding.installFormatter(t.id), `${t.name} installed`)}
                      onRemove={() => void run(t.id, () => api.onboarding.removeFormatter(t.id), `Removed Cloth’s copy of ${t.name}`)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </Group>
    </>
  )
}

/** One formatter or linter: where it stands, and Install / Update / Remove when Cloth handles it. */
function FormatToolState({ info, name, progress, onInstall, onRemove }: { info: FormatToolStatus | undefined; name: string; progress?: { text: string; fraction: number | null }; onInstall(): void; onRemove(): void }) {
  if (!info) return <span className="text-caption text-dim">Checking…</span>
  if (progress)
    return (
      <span className="flex min-w-0 items-center justify-end gap-2 text-caption text-muted" role="status">
        <Spinner size={12} />
        <span className="truncate">
          {progress.text}
          {progress.fraction !== null && progress.fraction < 1 ? ` · ${Math.round(progress.fraction * 100)}%` : ''}
        </span>
      </span>
    )
  const link = (to: string, text: string) => (
    <button type="button" onClick={() => void api.app.openExternal(to)} className="inline-flex items-center gap-1 text-caption text-warn hover:underline">
      <Warning size={12} />
      {text}
      <ArrowSquareOut size={10} />
    </button>
  )
  const ok = (text: string) => (
    <span className="inline-flex min-w-0 items-center gap-1 text-caption text-ok">
      <CheckCircle size={13} weight="fill" className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  )
  const needs = info.needs ? link(info.needs.url, `Needs ${info.needs.name}`) : null
  const wrap = (children: ReactNode) => <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 mobile:justify-start">{children}</span>
  switch (info.status) {
    case 'bundled':
      return ok('Included with Cloth')
    case 'project':
      return <span className="text-caption text-dim">Uses each folder’s own copy</span>
    case 'toolchain':
      return needs
    case 'installed':
      return wrap(
        <>
          {ok(info.version ? `${name} ${info.version} installed` : `${name} installed`)}
          {needs}
          <Button size="sm" variant="ghost" onClick={onInstall}>
            Update
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        </>
      )
    case 'found':
      return wrap(
        <>
          {ok(`${info.program} found on this PC`)}
          {needs}
        </>
      )
    default:
      return wrap(
        <>
          {info.installable ? (
            <Button size="sm" variant="outline" icon={<DownloadSimple size={13} />} onClick={onInstall}>
              Install {name}
            </Button>
          ) : (
            info.url && (
              <button type="button" onClick={() => void api.app.openExternal(info.url!)} className="inline-flex items-center gap-1 text-caption text-warn hover:underline">
                How to install {name} <ArrowSquareOut size={10} />
              </button>
            )
          )}
          {needs}
        </>
      )
  }
}

/** Rules for all code agents write: instructions in their prompt, and the global ast-grep rules folder checked after each edit. */
/** The languages the user works in (they gate PATH servers and shape setup's library), and each one's language server. */
function LanguagesSection({ languages }: { languages: LanguageId[] }) {
  const update = useApp((s) => s.updateSettings)
  const ls = useLanguageServers(LANGUAGES.map((l) => l.id))
  const on = new Set(languages)
  return (
    <Group title="Languages" note="Code intelligence runs only for the languages switched on here. TypeScript, JavaScript and Python servers ship with Cloth; the others install into Cloth’s data folder, or come from this PC when already installed.">
      {LANGUAGES.map((l) => (
        <div key={l.id} className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-2 first:border-t-0">
          <Switch checked={on.has(l.id)} onChange={(v) => void update({ languages: v ? [...languages, l.id] : languages.filter((x) => x !== l.id) })} ariaLabel={`I work in ${l.name}`} />
          <span className="w-24 shrink-0 text-ui">{l.name}</span>
          <div className={clsx('min-w-0 flex-1', !on.has(l.id) && 'opacity-60')}>
            <LanguageServerStatus info={ls.servers?.find((s) => s.id === l.id)} progress={ls.busy[l.id]} onInstall={() => void ls.install(l.id)} onRemove={() => void ls.remove(l.id)} />
          </div>
        </div>
      ))}
    </Group>
  )
}

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
      {!isMobile && (
        <Group title="Setup">
          <Row label="First-run setup" hint="Model, main working folder, languages, tools check, importing from other coding tools and the ways to work.">
            <Button size="sm" onClick={() => useApp.getState().openOnboarding('model')}>
              Run setup again
            </Button>
          </Row>
        </Group>
      )}
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
      {!isMobile && <ResetGroup />}
    </>
  )
}

/** The chat background: which theme, how strongly it shows, and the themes you or the agent made. */
function BackgroundRows({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const themes = allThemes(settings.chatThemes)
  const active = settings.chatTheme === NO_THEME ? NO_THEME : (activeTheme(settings.chatTheme, settings.chatThemes)?.id ?? NO_THEME)
  const saved = clampStrength(settings.chatThemeStrength)
  const [strength, setStrength] = useState(saved)
  useEffect(() => setStrength(saved), [saved])
  const commit = () => strength !== saved && void update({ chatThemeStrength: strength })
  const custom = themes.filter((t) => !t.builtin)
  return (
    <>
      <Row label="Background" track="chatTheme" hint="An animated background behind the conversation. Ask a chat to make a new theme or adjust one, like “make the background slower and blue”. It stays still when your system is set to reduce motion.">
        <Select className="w-56 mobile:w-full" aria-label="Chat background" value={active} onChange={(e) => void update({ chatTheme: e.target.value })}>
          {themes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value={NO_THEME}>None</option>
        </Select>
      </Row>
      {active !== NO_THEME && (
        <Row label="Strength" track="chatThemeStrength" hint="How much of the background shows behind the chat.">
          <div className="flex w-56 items-center gap-3 mobile:w-full">
            <input
              type="range"
              aria-label="Background strength"
              min={STRENGTH_RANGE[0] * 100}
              max={STRENGTH_RANGE[1] * 100}
              step={5}
              value={Math.round(strength * 100)}
              onChange={(e) => setStrength(Number(e.target.value) / 100)}
              onPointerUp={commit}
              onKeyUp={commit}
              onBlur={commit}
              className="min-w-0 flex-1 accent-crimson"
            />
            <span className="w-10 text-right text-caption tabular-nums text-muted">{Math.round(strength * 100)}%</span>
          </div>
        </Row>
      )}
      {custom.length > 0 && (
        <Row label="Your themes" hint="Made here or by a chat. The built-in ones can't be deleted." stacked>
          <div className="flex flex-wrap gap-1.5">
            {custom.map((t) => (
              <span key={t.id} className="flex items-center gap-1.5 rounded-full border border-line bg-elev py-0.5 pl-1.5 pr-1 text-caption">
                <span className="flex overflow-hidden rounded-full" aria-hidden="true">
                  {t.colors.map((c) => (
                    <span key={c} className="h-3 w-2" style={{ background: c }} />
                  ))}
                </span>
                <span className="text-muted">{t.name}</span>
                <button
                  type="button"
                  aria-label={`Delete the ${t.name} theme`}
                  title="Delete"
                  onClick={async () => {
                    if (!(await confirmAction(`Delete the “${t.name}” theme?`, { title: 'Delete theme?', danger: true, confirmLabel: 'Delete' }))) return
                    await update({ chatThemes: settings.chatThemes.filter((x) => x.id !== t.id), ...(settings.chatTheme === t.id ? { chatTheme: DEFAULT_CHAT_THEME } : {}) })
                  }}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-dim hover:bg-elev-2 hover:text-fg"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        </Row>
      )}
    </>
  )
}

/** Wipe everything Cloth has saved and restart as if just installed. Downloaded models can stay (they're large). */
function ResetGroup() {
  const [resetting, setResetting] = useState(false)
  const reset = async () => {
    const choice = await chooseAction(
      'This deletes all your chats, projects, boards, knowledge, skills, agents, automations, providers and API keys, and every setting, then restarts Cloth as if it were just installed. Your own folders and repositories are left alone. This can’t be undone.',
      { title: 'Reset Cloth?', danger: true, confirmLabel: 'Delete everything', alternative: 'Keep downloaded models', cancelLabel: 'Cancel' }
    )
    if (choice === 'cancel') return
    setResetting(true)
    try {
      await api.app.reset({ keepModels: choice === 'alternative' })
    } catch (err) {
      setResetting(false)
      useApp.getState().toast(`Couldn't reset Cloth: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }
  return (
    <Group title="Reset">
      <Row label="Reset Cloth" hint="Deletes everything Cloth has saved and restarts it with only the defaults. You can keep downloaded models so they don't need downloading again.">
        <Button size="sm" variant="danger" icon={<ArrowCounterClockwise size={13} />} disabled={resetting} onClick={() => void reset()}>
          {resetting ? 'Restarting…' : 'Reset Cloth…'}
        </Button>
      </Row>
    </Group>
  )
}

const UPDATE_REPO = 'SKYZAP/Cloth-V3'
const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`

/** Check for updates from the GitHub releases, download when asked, restart into the new version. */
function UpdatesGroup() {
  const [st, setSt] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void api.updates.status().then(setSt)
  }, [])
  useEvent('updates', setSt)
  if (!st) return null

  const pct = st.progress && st.progress.total ? Math.round((st.progress.transferred / st.progress.total) * 100) : 0
  const summary = !st.supported
    ? 'This build can’t update itself. Installed Windows and Linux builds can.'
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
      <Group title="Updates" note={`Releases come from ${UPDATE_REPO} on GitHub. Cloth checks once a day at launch and downloads a new version in the background. Restarting installs it without the setup wizard; otherwise it goes in the next time Cloth quits.`}>
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
          {st.supported && (
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
      </Group>
    </div>
  )
}

/** A titled card of setting rows. */
/** The operating system's certificate store, as people know it. */
const settingsStoreName = () => (/Mac/i.test(navigator.platform) ? 'the macOS Keychain' : /Win/i.test(navigator.platform) ? 'Windows' : 'the system certificates')

/**
 * The certificate Cloth trusts on top of the computer's own, for networks that inspect HTTPS (company proxies, some
 * antivirus): the whole app and the programs it starts use it. Shows what the file holds, so a wrong pick is caught here.
 */
function NetworkSection({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  const [path, setPath] = useState(settings.webCaCertPath)
  const [info, setInfo] = useState<CertificateInfo | null>(null)
  useEffect(() => setPath(settings.webCaCertPath), [settings.webCaCertPath])
  useEffect(() => {
    const p = settings.webCaCertPath.trim()
    if (!p) return setInfo(null)
    void api.app.certificateInfo(p).then(setInfo, () => setInfo(null))
  }, [settings.webCaCertPath])
  const save = (next: string) => next.trim() !== settings.webCaCertPath && void update({ webCaCertPath: next.trim() })
  const pick = async () => {
    const [file] = await api.app.pickPaths({ title: 'Choose a certificate (PEM)', filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }] })
    if (file) {
      setPath(file)
      save(file)
    }
  }
  const expired = info && !('error' in info) && info.validTo < Date.now()
  const [check, setCheck] = useState<NetworkCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const runCheck = async () => {
    setChecking(true)
    try {
      setCheck(await api.network.check())
    } finally {
      setChecking(false)
    }
  }
  return (
    <>
    <Group title="Connection">
      <Row
        label="Check the connection"
        hint={check ? networkSummary(check) : `Connects to a few sites and says whether HTTPS on this network is inspected, and by whom. Certificates in ${settingsStoreName()} are always trusted.`}
      >
        <div className="flex items-center gap-2">
          {check && <NetworkPill check={check} />}
          <Button size="sm" variant="outline" loading={checking} onClick={() => void runCheck()}>
            {check ? 'Check again' : 'Check'}
          </Button>
        </div>
      </Row>
      {check?.state === 'untrusted' && (
        <div className="px-3 pb-3">
          <NetworkFix check={check} onChecked={setCheck} />
        </div>
      )}
    </Group>
    <Group
      title="Certificates"
      note="Applies straight away. Programs that were already running when you changed it, like an open terminal or a running MCP server, use it once they start again."
    >
      <Row
        label="Extra certificate"
        stacked
        hint={`Needed when your network re-signs HTTPS with a certificate that isn’t in ${settingsStoreName()}: a certificate authority (PEM) Cloth trusts on top of the computer’s own. Used for model providers, web search and web_fetch, MCP servers, the skills registry, updates, and the programs Cloth starts (the shell tool, terminals, npx and uvx).`}
      >
        <div className="flex gap-1.5">
          <Input className="font-mono text-caption" placeholder="None: only what this computer trusts" aria-label="Certificate file" value={path} onChange={(e) => setPath(e.target.value)} onBlur={() => save(path)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
          <Button size="sm" variant="outline" onClick={() => void pick()}>
            <FolderOpen size={14} /> Choose…
          </Button>
          {settings.webCaCertPath && (
            <Button size="sm" variant="ghost" onClick={() => (setPath(''), save(''))} aria-label="Remove the certificate">
              <X size={14} />
            </Button>
          )}
        </div>
        {info &&
          ('error' in info ? (
            <div role="alert" className="text-caption text-danger-hi">
              {info.error} Cloth keeps using only what this computer trusts.
            </div>
          ) : (
            <div className={clsx('text-caption', expired ? 'text-danger-hi' : 'text-dim')}>
              {info.subject}
              {info.issuer !== info.subject ? `, issued by ${info.issuer}` : ''} · {expired ? 'expired' : 'valid until'} {new Date(info.validTo).toLocaleDateString()}
              {info.count > 1 ? ` · ${info.count} certificates in the file` : ''}
              {!info.ca ? ' · not marked as a certificate authority, so it may not be the one your network uses' : ''}
            </div>
          ))}
      </Row>
    </Group>
    </>
  )
}

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
