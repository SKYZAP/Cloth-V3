import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { CaretLeft, Copy, DesktopTower, DeviceMobile, Moon, Plus, Star, Sun, Trash } from '@phosphor-icons/react'
import type { Project } from '@shared/types'
import { buildDesign, fontStack, systemPalette, type DesignInput, type DesignSystem } from '@shared/design'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { isMobile, useSideBySide } from '@/lib/platform'
import { loadDesignFont } from '@/lib/designFonts'
import { Button, IconButton, Segmented, confirmAction } from '@/components/ui'
import { ProjectsSync } from './design/ProjectsSync'
import { GuidedSetup } from './design/Guided'
import { SampleScreen } from './design/Sample'
import { SimpleControls, UseInProject } from './design/Simple'

export function DesignPage() {
  // Opened for a project (from the chat sidebar), or from Settings.
  const focus = useApp((s) => s.designFocus)
  const [designs, setDesigns] = useState<DesignSystem[]>([])
  const [activeId, setActiveId] = useState<string | null>(() => focus?.designId ?? localStorage.getItem('cloth.design'))
  const [open, setOpen] = useState(() => !!focus?.designId)
  const [loaded, setLoaded] = useState(false)
  const [guided, setGuided] = useState<'describe' | 'presets' | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const settings = useApp((s) => s.settings)
  const defaultId = settings?.defaultDesignId ?? null
  const forProject = focus?.projectId ? (projects.find((p) => p.id === focus.projectId) ?? null) : null
  const back = focus?.projectId ? ({ page: 'chat', label: 'Chat' } as const) : ({ page: 'settings', label: 'Settings' } as const)
  const goBack = () => useApp.getState().setPage(back.page)

  const load = async (select?: string) => {
    const list = await api.design.list()
    setDesigns(list)
    setLoaded(true)
    void api.projects.list().then(setProjects, () => undefined)
    if (select) setActiveId(select)
  }
  useEffect(() => {
    void load()
  }, [])
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem('cloth.design', activeId)
    } catch {
      /* storage unavailable */
    }
  }, [activeId])

  const createBlank = async () => {
    const d = await attempt(() => api.design.create({}))
    if (!d) return
    setGuided(null)
    await load(d.id)
    setOpen(true)
  }
  const created = async (id: string) => {
    setGuided(null)
    await load(id)
    setOpen(true)
  }
  const openDesign = (id: string) => (setActiveId(id), setOpen(true))
  const setDefault = (id: string | null) => void useApp.getState().updateSettings({ defaultDesignId: id })

  const active = open ? (designs.find((d) => d.id === activeId) ?? null) : null
  if (guided) return <GuidedSetup start={guided} askDefault={!defaultId} onCancel={() => setGuided(null)} onCreated={(id) => void created(id)} onBlank={() => void createBlank()} />
  if (active)
    return (
      <DesignEditor
        key={active.id}
        design={active}
        isDefault={active.id === defaultId}
        forProjectId={forProject && forProject.designId !== active.id ? forProject.id : null}
        onDefault={(on) => setDefault(on ? active.id : null)}
        onBack={() => (setOpen(false), void load())}
        onSaved={(d) => setDesigns((ds) => ds.map((x) => (x.id === d.id ? d : x)))}
        onDeleted={() => (setOpen(false), void load())}
        onDuplicated={(id) => void load(id)}
      />
    )
  const hint = forProject && !forProject.designId && <p className="rounded-lg bg-elev-2 px-2.5 py-2 text-ui text-muted">Pick or make a design system for {forProject.name}.</p>
  // The default first, then the most recently changed.
  const ordered = [...designs].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
  if (loaded && !designs.length)
    return (
      <div className="flex h-full flex-col">
        <div className="shrink-0 px-4 pt-2.5 mobile:px-3">
          <BackLink label={back.label} onClick={goBack} />
        </div>
        <div className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-5">
          <div className="grid max-w-[520px] justify-items-center gap-3 py-10 text-center">
            <div className="mb-2 flex gap-2.5" aria-hidden="true">
              {[
                ['#f1f6f3', '#059669'],
                ['#fbf5f2', '#c46a45'],
                ['#17141a', '#b07ab0']
              ].map(([bg, c]) => (
                <span key={c} className="relative h-11 w-16 overflow-hidden rounded-lg border border-line-strong" style={{ background: bg }}>
                  <span className="absolute bottom-2 left-2 h-2.5 w-7 rounded" style={{ background: c }} />
                </span>
              ))}
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight">Make your first design</h1>
            <p className="text-ui text-muted">Colours, fonts and components that your projects’ chats follow.</p>
            {hint}
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => setGuided('describe')}>
                Get started
              </Button>
              <Button onClick={() => setGuided('presets')}>Pick from finished looks</Button>
            </div>
          </div>
        </div>
      </div>
    )
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-[min(1120px,calc(100%-40px))] gap-5 pt-10 pb-6 mobile:py-4">
        <div className="grid gap-1">
          <BackLink label={back.label} onClick={goBack} />
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-title font-semibold tracking-tight">Design systems</h1>
            </div>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setGuided('describe')}>
              New
            </Button>
          </div>
        </div>
        {hint}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {ordered.map((d) => (
            <DesignCard key={d.id} design={d} isDefault={d.id === defaultId} projects={projects.filter((p) => p.designId === d.id).length} onOpen={() => openDesign(d.id)} />
          ))}
          <button onClick={() => setGuided('describe')} className="flex min-h-[176px] flex-col items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-line-strong text-ui text-dim transition-colors hover:border-crimson-line hover:text-fg">
            <Plus size={18} />
            New design system
          </button>
        </div>
      </div>
    </div>
  )
}

/** Back to where the design page was opened from (it is not on the main nav). */
function BackLink({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button onClick={onClick} className="-ml-1.5 flex h-8 items-center gap-1 justify-self-start rounded-lg pl-1 pr-2 text-ui text-dim hover:bg-elev-2 hover:text-fg">
      <CaretLeft size={14} /> {label}
    </button>
  )
}

/** A system at a glance: its palette, its type, and how many projects follow it. */
function DesignCard({ design, isDefault, projects, onOpen }: { design: DesignSystem; isDefault: boolean; projects: number; onOpen(): void }) {
  const input = design.input
  const d = useMemo(() => buildDesign(input), [input])
  useEffect(() => {
    void loadDesignFont(input.fontHeading)
  }, [input.fontHeading])
  const r = input.mode === 'light' ? d.roles.light : d.roles.dark
  const strip = input.palette.length ? input.palette : systemPalette(input, d)
  return (
    <button onClick={onOpen} className="group overflow-hidden rounded-[14px] border border-line bg-panel text-left transition-colors hover:border-line-strong">
      <div className="flex h-9">
        {strip.slice(0, 6).map((c, i) => (
          <span key={i} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex items-center gap-3 px-3.5 py-3" style={{ background: r.background, color: r.text }}>
        <span style={{ fontFamily: fontStack(input, 'heading'), fontWeight: input.headingWeight, letterSpacing: `${input.headingTracking}em`, fontSize: 26, lineHeight: 1 }}>Aa</span>
        <span className="min-w-0 flex-1 truncate" style={{ fontFamily: fontStack(input, 'sans'), fontSize: 12, color: r.textMuted }}>
          {input.fontHeading}
          {input.fontSans !== input.fontHeading ? ` · ${input.fontSans}` : ''}
        </span>
        <span style={{ background: r.primary, color: r.onPrimary, borderRadius: Math.min(input.radius, 12), padding: '4px 10px', fontSize: 11.5, fontWeight: 600 }}>Action</span>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{design.name}</span>
        {isDefault && (
          <span className="flex shrink-0 items-center gap-1 text-caption text-warn" title="New projects follow this system">
            <Star size={11} weight="fill" /> Default
          </span>
        )}
        <span className="shrink-0 text-caption text-dim">{projects ? `${projects} project${projects === 1 ? '' : 's'}` : 'no projects'}</span>
      </div>
    </button>
  )
}

// ─── Editor ───────────────────────────────────────────────────────────────────

function DesignEditor({
  design,
  isDefault,
  forProjectId,
  onDefault,
  onBack,
  onSaved,
  onDeleted,
  onDuplicated
}: {
  design: DesignSystem
  isDefault: boolean
  /** Opened for this project: "Use in a project" offers it first. */
  forProjectId: string | null
  onDefault(on: boolean): void
  onBack(): void
  onSaved(d: DesignSystem): void
  onDeleted(): void
  onDuplicated(id: string): void
}) {
  const [name, setName] = useState(design.name)
  const [input, setInput] = useState<DesignInput>(design.input)
  const [saves, setSaves] = useState(0)
  const [phoneTab, setPhoneTab] = useState<'edit' | 'view'>('edit')
  const [theme, setTheme] = useState<'light' | 'dark'>(design.input.mode === 'light' ? 'light' : 'dark')
  const [width, setWidth] = useState<'wide' | 'phone'>('wide')
  const [tab, setTab] = useState<'sample' | 'projects'>('sample')
  const side = useSideBySide()

  // Save shortly after the last change.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => void api.design.update(design.id, { name, input }).then((d) => (onSaved(d), setSaves((n) => n + 1)), () => undefined), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, input])
  useEffect(() => {
    if (input.mode !== 'both') setTheme(input.mode)
  }, [input.mode])

  const remove = async () => {
    if (!(await confirmAction(`“${design.name}” is deleted. Projects that follow it stop doing so.`, { title: 'Delete design system?', confirmLabel: 'Delete', danger: true }))) return
    await attempt(() => api.design.remove(design.id))
    onDeleted()
  }
  const duplicate = async () => {
    const d = await attempt(() => api.design.duplicate(design.id))
    if (d) onDuplicated(d.id)
  }

  const controls = <SimpleControls input={input} set={setInput} />
  const themeSwitch = input.mode === 'both' && (
    <Segmented
      value={theme}
      onChange={setTheme}
      items={[
        { value: 'dark', label: <Moon size={13} />, title: 'Dark' },
        { value: 'light', label: <Sun size={13} />, title: 'Light' }
      ]}
    />
  )
  const widthSwitch = !isMobile && (
    <Segmented
      value={width}
      onChange={setWidth}
      items={[
        { value: 'wide', label: <DesktopTower size={13} />, title: 'Wide' },
        { value: 'phone', label: <DeviceMobile size={13} />, title: 'Phone width' }
      ]}
    />
  )
  const phoneFrame = width === 'phone' && tab === 'sample'
  const view = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-4 py-2 mobile:px-3">
        <Segmented
          value={tab}
          onChange={setTab}
          items={[
            { value: 'sample', label: 'Sample screen' },
            { value: 'projects', label: 'Projects' }
          ]}
        />
        <div className="flex-1" />
        {tab === 'sample' && widthSwitch}
        {tab === 'sample' && themeSwitch}
      </div>
      {tab === 'projects' ? (
        <div className="min-h-0 flex-1">
          <ProjectsSync designId={design.id} version={saves} />
        </div>
      ) : (
        <div className={clsx('min-h-0 flex-1 overflow-auto', phoneFrame && 'bg-elev/40 py-6')}>
          <div className={clsx(phoneFrame ? 'mx-auto w-[390px] overflow-hidden rounded-[28px] border border-line-strong shadow-2xl shadow-black/50' : 'flex min-h-full flex-col')}>
            <SampleScreen input={input} theme={theme} name={name} />
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5 mobile:px-3">
        <button onClick={onBack} className="-ml-1.5 flex h-8 items-center gap-1 rounded-lg pl-1 pr-2 text-ui text-dim hover:bg-elev-2 hover:text-fg" aria-label="All design systems">
          <CaretLeft size={14} /> <span className="mobile:hidden">Designs</span>
        </button>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" className="min-w-0 flex-1 bg-transparent text-section font-semibold tracking-tight outline-none" />
        <UseInProject designId={design.id} version={saves} forProjectId={forProjectId} />
        <Button icon={<Star size={14} weight={isDefault ? 'fill' : 'regular'} className={isDefault ? 'text-warn' : undefined} />} onClick={() => onDefault(!isDefault)} aria-pressed={isDefault} title={isDefault ? 'New projects follow this system. Click to stop.' : 'Make new projects follow this system'}>
          <span className="mobile:hidden">{isDefault ? 'Default' : 'Make default'}</span>
        </Button>
        <IconButton title="Duplicate" onClick={() => void duplicate()}>
          <Copy size={15} />
        </IconButton>
        <IconButton title="Delete" onClick={() => void remove()}>
          <Trash size={15} />
        </IconButton>
      </div>
      {side ? (
        <div className="flex min-h-0 flex-1">
          <div className="w-[300px] shrink-0 overflow-y-auto overflow-x-hidden border-r border-line">{controls}</div>
          {view}
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-line px-3 py-2">
            <Segmented
              value={phoneTab}
              onChange={setPhoneTab}
              items={[
                { value: 'edit', label: 'Edit' },
                { value: 'view', label: 'Preview' }
              ]}
            />
          </div>
          {phoneTab === 'edit' ? <div className="min-h-0 flex-1 overflow-y-auto">{controls}</div> : view}
        </>
      )}
    </div>
  )
}
