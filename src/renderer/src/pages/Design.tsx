import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowCounterClockwise, Check, Copy, DesktopTower, DeviceMobile, DownloadSimple, MagicWand, Moon, Palette, Plus, Sparkle, Sun, SwatchesIcon, Trash, Warning } from '@phosphor-icons/react'
import type { ModelRef } from '@shared/types'
import {
  buildDesign,
  designFiles,
  FONT_CHOICES,
  fontStack,
  isHex,
  NEUTRALS,
  normalizeHex,
  PRESETS,
  ROLE_INFO,
  SCALES,
  STEPS,
  sanitizeDesign,
  type BuiltDesign,
  type DesignInput,
  type DesignSystem,
  type NeutralFamily,
  type RoleName
} from '@shared/design'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { isMobile, useSideBySide } from '@/lib/platform'
import { BUNDLED_FONTS, loadDesignFont } from '@/lib/designFonts'
import { kitCss } from '@shared/kit'
import { Button, Empty, Field, IconButton, ListItem, ListPane, Modal, Segmented, Select, Switch, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { ComponentsPanel } from './design/Components'
import { PaletteField } from './design/Palette'

type PresetChoice = { name: string; input: Partial<DesignInput> } | null

export function DesignPage() {
  const [designs, setDesigns] = useState<DesignSystem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [picking, setPicking] = useState(false)

  const load = async (select?: string) => {
    const list = await api.design.list()
    setDesigns(list)
    setLoaded(true)
    if (select) setActiveId(select)
    else setActiveId((cur) => (cur && list.some((d) => d.id === cur) ? cur : (list[0]?.id ?? null)))
  }
  useEffect(() => {
    void load()
  }, [])

  const create = async (preset: PresetChoice) => {
    setPicking(false)
    const d = await attempt(() => api.design.create(preset ? { name: preset.name, input: sanitizeDesign(preset.input) } : {}))
    if (!d) return
    await load(d.id)
    setOpen(true)
  }

  const active = designs.find((d) => d.id === activeId) ?? null
  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        header={
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold">Design</div>
              <div className="text-[11px] text-dim">
                {designs.length} design system{designs.length === 1 ? '' : 's'}
              </div>
            </div>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setPicking(true)}>
              New
            </Button>
          </div>
        }
      >
        {designs.map((d) => (
          <ListItem key={d.id} active={d.id === activeId} onClick={() => (setActiveId(d.id), setOpen(true))}>
            <Swatches input={d.input} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium mobile:text-[14px]">{d.name}</div>
              <div className="truncate text-[11px] text-dim">
                {d.input.fontSans} · {d.input.mode === 'both' ? 'light & dark' : d.input.mode}
              </div>
            </div>
          </ListItem>
        ))}
        {loaded && !designs.length && (
          <div className="space-y-2 p-4 text-center">
            <div className="text-[12px] text-dim">No design systems yet.</div>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setPicking(true)}>
              Create one
            </Button>
          </div>
        )}
      </ListPane>
      <SplitDetail>
        {active ? (
          <DesignEditor key={active.id} design={active} onSaved={(d) => setDesigns((ds) => ds.map((x) => (x.id === d.id ? d : x)))} onDeleted={() => (setOpen(false), void load())} onDuplicated={(id) => void load(id)} />
        ) : (
          <Empty icon={<Palette size={20} />} title="Design systems" action={<Button variant="primary" onClick={() => setPicking(true)}>New design system</Button>}>
            Pick colours, type and shape, and export a DESIGN.md with tokens for your projects.
          </Empty>
        )}
      </SplitDetail>
      <PresetModal open={picking} title="New design system" blank onClose={() => setPicking(false)} onPick={(p) => void create(p)} />
    </SplitRoot>
  )
}

function Swatches({ input }: { input: DesignInput }) {
  const d = useMemo(() => buildDesign(input), [input])
  const theme = input.mode === 'light' ? d.roles.light : d.roles.dark
  return (
    <div className="flex shrink-0 -space-x-1.5">
      {[theme.primary, theme.accent, theme.surface].map((c, i) => (
        <span key={i} className="h-4 w-4 rounded-full border border-black/40" style={{ background: c }} />
      ))}
    </div>
  )
}

// ─── Presets ──────────────────────────────────────────────────────────────────

function PresetModal({ open, title, blank, onClose, onPick }: { open: boolean; title: string; blank?: boolean; onClose(): void; onPick(p: PresetChoice): void }) {
  useEffect(() => {
    if (!open) return
    for (const p of PRESETS) for (const f of [p.input.fontSans, p.input.fontHeading]) if (f) void loadDesignFont(f)
  }, [open])
  return (
    <Modal open={open} onClose={onClose} title={title} width={760}>
      <div className="grid grid-cols-2 gap-2.5 mobile:grid-cols-1">
        {blank && (
          <button onClick={() => onPick(null)} className="flex flex-col items-start justify-center gap-1 rounded-[14px] border border-dashed border-line-strong p-4 text-left hover:border-crimson-line">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <Plus size={14} /> Blank
            </span>
            <span className="text-[12px] text-dim">Cloth's neutral defaults — shape it yourself or with Generate.</span>
          </button>
        )}
        {PRESETS.map((p) => (
          <PresetCard key={p.id} preset={p} onPick={() => onPick(p)} />
        ))}
      </div>
    </Modal>
  )
}

function PresetCard({ preset, onPick }: { preset: (typeof PRESETS)[number]; onPick(): void }) {
  const input = useMemo(() => sanitizeDesign(preset.input), [preset])
  const d = useMemo(() => buildDesign(input), [input])
  const r = input.mode === 'light' ? d.roles.light : d.roles.dark
  return (
    <button onClick={onPick} className="group overflow-hidden rounded-[14px] border border-line text-left transition-colors hover:border-crimson-line">
      <div className="flex items-center gap-3 p-3.5" style={{ background: r.background, color: r.text, fontFamily: fontStack(input, 'sans') }}>
        <div className="min-w-0 flex-1">
          <div style={{ fontFamily: fontStack(input, 'heading'), fontWeight: input.headingWeight, letterSpacing: `${input.headingTracking}em`, fontSize: 19, lineHeight: 1.2 }}>{preset.name}</div>
          <div style={{ color: r.textMuted, fontSize: 12, marginTop: 2 }}>Aa Bb 123</div>
        </div>
        <span style={{ background: r.primary, color: r.onPrimary, borderRadius: Math.min(input.radius, 14), padding: '6px 12px', fontSize: 12, fontWeight: 600 }}>Action</span>
        {input.accent && <span style={{ width: 14, height: 14, borderRadius: 99, background: r.accent }} />}
      </div>
      <div className="border-t border-line bg-panel px-3.5 py-2.5 text-[12px] leading-snug text-dim">{preset.blurb}</div>
    </button>
  )
}

// ─── Editor ───────────────────────────────────────────────────────────────────

type Tab = 'preview' | 'components' | 'DESIGN.md' | 'tokens.css' | 'tailwind.css' | 'tokens.json'

function DesignEditor({ design, onSaved, onDeleted, onDuplicated }: { design: DesignSystem; onSaved(d: DesignSystem): void; onDeleted(): void; onDuplicated(id: string): void }) {
  const [name, setName] = useState(design.name)
  const [description, setDescription] = useState(design.description)
  const [input, setInput] = useState<DesignInput>(design.input)
  const [tab, setTab] = useState<Tab>('preview')
  const [phoneTab, setPhoneTab] = useState<'edit' | 'view'>('edit')
  const [theme, setTheme] = useState<'light' | 'dark'>(design.input.mode === 'light' ? 'light' : 'dark')
  const [width, setWidth] = useState<'wide' | 'phone'>('wide')
  const [aiOpen, setAiOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const side = useSideBySide()
  const built = useMemo(() => buildDesign(input), [input])
  const files = useMemo(() => designFiles({ name, description, input }), [name, description, input])

  // Save shortly after the last change.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => void api.design.update(design.id, { name, description, input }).then(onSaved, () => undefined), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, input])
  useEffect(() => {
    if (input.mode !== 'both') setTheme(input.mode)
  }, [input.mode])

  const set = (patch: Partial<DesignInput>) => setInput((i) => ({ ...i, ...patch }))
  const override = (role: RoleName, color: string | null) =>
    setInput((i) => {
      const picked = { ...i.overrides[theme] }
      if (color) picked[role] = color
      else delete picked[role]
      return { ...i, overrides: { ...i.overrides, [theme]: picked } }
    })

  const exportFiles = async () => {
    const [folder] = await api.app.pickPaths({ directory: true, title: 'Export DESIGN.md and tokens to…' })
    if (!folder) return
    await attempt(() => api.design.export(design.id, folder), `Exported DESIGN.md and tokens to ${folder}`)
  }
  const remove = async () => {
    if (!(await confirmAction(`“${design.name}” is deleted. Projects that follow it stop doing so.`, { title: 'Delete design system?', confirmLabel: 'Delete', danger: true }))) return
    await attempt(() => api.design.remove(design.id))
    onDeleted()
  }
  const duplicate = async () => {
    const d = await attempt(() => api.design.duplicate(design.id))
    if (d) onDuplicated(d.id)
  }
  const applyPreset = async (p: PresetChoice) => {
    setPresetsOpen(false)
    if (!p) return
    if (!(await confirmAction(`Colours, type and shape are replaced by “${p.name}”. The name and description stay.`, { title: 'Start from this preset?', confirmLabel: 'Use preset' }))) return
    setInput(sanitizeDesign(p.input))
  }

  const controls = <Controls input={input} set={set} description={description} setDescription={setDescription} />
  const view = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-4 py-2 mobile:px-3">
        <Segmented value={tab} onChange={setTab} items={(['preview', 'components', 'DESIGN.md', 'tokens.css', 'tailwind.css', 'tokens.json'] as Tab[]).map((t) => ({ value: t, label: t === 'preview' ? 'Preview' : t === 'components' ? 'Components' : t }))} />
        <div className="flex-1" />
        {tab === 'preview' && !isMobile && (
          <Segmented
            value={width}
            onChange={setWidth}
            items={[
              { value: 'wide', label: <DesktopTower size={13} />, title: 'Wide' },
              { value: 'phone', label: <DeviceMobile size={13} />, title: 'Phone width' }
            ]}
          />
        )}
        {tab === 'preview' && input.mode === 'both' && (
          <Segmented
            value={theme}
            onChange={setTheme}
            items={[
              { value: 'dark', label: <Moon size={13} />, title: 'Dark' },
              { value: 'light', label: <Sun size={13} />, title: 'Light' }
            ]}
          />
        )}
        {tab !== 'preview' && tab !== 'components' && <CopyButton text={files[tab]} />}
      </div>
      {tab === 'components' ? (
        <ComponentsPanel designId={design.id} input={input} setKit={(kit) => set({ kit })} theme={theme} setTheme={setTheme} />
      ) : (
      <div className={clsx('min-h-0 flex-1 overflow-auto', width === 'phone' && tab === 'preview' && 'bg-elev/40 py-6')}>
        {tab === 'preview' ? (
          <div className={clsx(width === 'phone' && 'mx-auto w-[390px] overflow-hidden rounded-[28px] border border-line-strong shadow-2xl shadow-black/50')}>
            <Preview name={name} input={input} built={built} theme={theme} onOverride={override} />
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed text-muted">{files[tab]}</pre>
        )}
      </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5 mobile:px-3">
        <SplitBack />
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold tracking-tight outline-none" />
        <Button icon={<SwatchesIcon size={14} />} onClick={() => setPresetsOpen(true)} title="Start over from a preset">
          <span className="mobile:hidden">Presets</span>
        </Button>
        <Button icon={<MagicWand size={14} />} onClick={() => setAiOpen(true)} title="Describe a look and let AI set the system up">
          <span className="mobile:hidden">Generate</span>
        </Button>
        <Button icon={<DownloadSimple size={14} />} onClick={() => void exportFiles()} title="Write DESIGN.md and the token files into a folder">
          <span className="mobile:hidden">Export</span>
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
          {/* The component playground needs the room; the system's controls come back on the other tabs. */}
          {tab !== 'components' && <div className="w-[330px] shrink-0 overflow-y-auto border-r border-line">{controls}</div>}
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
                { value: 'view', label: 'Preview & files' }
              ]}
            />
          </div>
          {phoneTab === 'edit' ? <div className="min-h-0 flex-1 overflow-y-auto">{controls}</div> : view}
        </>
      )}
      <GenerateModal
        open={aiOpen}
        current={input}
        onClose={() => setAiOpen(false)}
        onDraft={(d) => {
          setAiOpen(false)
          setInput(d.input)
          if (d.description) setDescription(d.description)
          if (/^New design/.test(name) && d.name) setName(d.name)
        }}
      />
      <PresetModal open={presetsOpen} title="Start from a preset" onClose={() => setPresetsOpen(false)} onPick={(p) => void applyPreset(p)} />
    </div>
  )
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-b border-line px-4 py-4 last:border-b-0 mobile:px-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim">{title}</div>
      {children}
    </section>
  )
}

const WEIGHTS: Record<number, string> = { 400: 'Regular', 450: 'Book', 500: 'Medium', 550: 'Medium+', 600: 'Semibold', 650: 'Semibold+', 700: 'Bold', 750: 'Bold+', 800: 'Extrabold', 850: 'Heavy', 900: 'Black' }

function Controls({ input, set, description, setDescription }: { input: DesignInput; set(p: Partial<DesignInput>): void; description: string; setDescription(s: string): void }) {
  const [principles, setPrinciples] = useState(input.principles.join('\n'))
  useEffect(() => setPrinciples(input.principles.join('\n')), [input.principles])
  const built = useMemo(() => buildDesign(input), [input])
  const scale = SCALES.find((s) => s.value === input.scale)
  return (
    <div>
      <Section title="Colour">
        <PaletteField input={input} set={set} />
        <ColorField label="Brand" value={input.brand} onChange={(v) => v && set({ brand: v })} />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">{input.pinBrand ? 'Buttons use exactly this colour' : 'Cloth picks the most readable shade'}</span>
          <Switch checked={input.pinBrand} onChange={(pinBrand) => set({ pinBrand })} label="Exact" />
        </div>
        <ColorField label="Accent" value={input.accent} optional onChange={(accent) => set({ accent })} />
        <div className="grid grid-cols-3 gap-2">
          <ColorField compact label="Success" value={input.success} onChange={(v) => v && set({ success: v })} />
          <ColorField compact label="Warning" value={input.warning} onChange={(v) => v && set({ warning: v })} />
          <ColorField compact label="Danger" value={input.danger} onChange={(v) => v && set({ danger: v })} />
        </div>
      </Section>
      <Section title="Greys and themes">
        <Field label="Grey family">
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(NEUTRALS) as NeutralFamily[]).filter((k) => k !== 'custom' || input.neutralSeed).map((k) => {
              const sample = buildDesign({ ...input, neutral: k, neutralTint: k === 'gray' ? 0 : Math.max(input.neutralTint, 0.5) }).scales.neutral
              return (
                <button
                  key={k}
                  onClick={() => set({ neutral: k })}
                  aria-pressed={input.neutral === k}
                  className={clsx('flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px]', input.neutral === k ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line text-muted hover:border-line-strong')}
                >
                  <span className="flex">
                    {([200, 500, 800] as const).map((s) => (
                      <span key={s} className="h-3 w-2 first:rounded-l-sm last:rounded-r-sm" style={{ background: sample[s] }} />
                    ))}
                  </span>
                  {NEUTRALS[k].label}
                </button>
              )
            })}
          </div>
        </Field>
        <Slider
          label="Grey tint"
          value={input.neutralTint}
          min={0}
          max={1}
          step={0.05}
          disabled={input.neutral === 'gray'}
          format={(v) => (input.neutral === 'gray' || v === 0 ? 'none' : v < 0.35 ? 'subtle' : v < 0.7 ? 'noticeable' : 'strong')}
          onChange={(neutralTint) => set({ neutralTint })}
        />
        <Field label="Themes">
          <Segmented
            value={input.mode}
            onChange={(mode) => set({ mode })}
            items={[
              { value: 'both', label: 'Light & dark' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' }
            ]}
          />
        </Field>
        {input.mode !== 'light' && (
          <Slider
            label="Dark background"
            value={input.darkDepth}
            min={0}
            max={1}
            step={0.05}
            format={(v) => (v < 0.2 ? 'near black' : v < 0.6 ? 'charcoal' : 'soft grey')}
            swatch={built.roles.dark.background}
            onChange={(darkDepth) => set({ darkDepth })}
          />
        )}
      </Section>
      <Section title="Type">
        <FontField label="Body" value={input.fontSans} options={FONT_CHOICES.sans} onChange={(fontSans) => set({ fontSans })} />
        <FontField label="Headings" value={input.fontHeading} options={FONT_CHOICES.heading} onChange={(fontHeading) => set({ fontHeading })} />
        <FontField label="Code" value={input.fontMono} options={FONT_CHOICES.mono} onChange={(fontMono) => set({ fontMono })} />
        <Slider label="Body size" value={input.baseSize} min={12} max={20} step={1} format={(v) => `${v}px`} onChange={(baseSize) => set({ baseSize })} />
        <Field label="Heading sizes" hint={scale ? `${scale.hint} — ${built.type.slice(1, 5).map((t) => t.size).join(' / ')}px` : undefined}>
          <Segmented value={String(input.scale)} onChange={(v) => set({ scale: Number(v) })} items={SCALES.map((s) => ({ value: String(s.value), label: s.label }))} />
        </Field>
        <Slider label="Heading weight" value={input.headingWeight} min={400} max={900} step={50} format={(v) => WEIGHTS[v] ?? String(v)} onChange={(headingWeight) => set({ headingWeight })} />
        <Slider label="Heading spacing" value={input.headingTracking} min={-0.05} max={0.03} step={0.005} format={(v) => (v < -0.015 ? 'tight' : v > 0.005 ? 'loose' : 'normal')} onChange={(headingTracking) => set({ headingTracking })} />
        <Slider label="Line height" value={input.bodyLeading} min={1.3} max={1.8} step={0.05} format={(v) => (v < 1.45 ? 'compact' : v > 1.65 ? 'airy' : 'normal')} onChange={(bodyLeading) => set({ bodyLeading })} />
      </Section>
      <Section title="Shape">
        <Slider label="Corner radius" value={input.radius} min={0} max={24} step={1} format={(v) => (v === 0 ? 'sharp' : v < 6 ? 'subtle' : v < 12 ? 'rounded' : 'soft')} onChange={(radius) => set({ radius })} />
        <Field label="Density">
          <Segmented
            value={input.density}
            onChange={(density) => set({ density })}
            items={[
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'spacious', label: 'Spacious' }
            ]}
          />
        </Field>
        <Field label="Shadows">
          <Segmented
            value={input.shadow}
            onChange={(shadow) => set({ shadow })}
            items={[
              { value: 'none', label: 'None' },
              { value: 'soft', label: 'Soft' },
              { value: 'strong', label: 'Strong' }
            ]}
          />
        </Field>
      </Section>
      <Section title="Voice">
        <Field label="Description">
          <Textarea rows={2} value={description} placeholder="What the product is and how it should feel" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Principles" hint="One per line.">
          <Textarea
            rows={4}
            value={principles}
            onChange={(e) => setPrinciples(e.target.value)}
            onBlur={() =>
              set({
                principles: principles
                  .split('\n')
                  .map((p) => p.trim())
                  .filter(Boolean)
              })
            }
          />
        </Field>
      </Section>
    </div>
  )
}

function ColorField({ label, value, onChange, optional, compact }: { label: string; value: string | null; onChange(v: string | null): void; optional?: boolean; compact?: boolean }) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const commit = () => {
    if (!text.trim() && optional) return onChange(null)
    if (isHex(text)) onChange(normalizeHex(text))
    else setText(value ?? '')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-[11.5px] font-medium text-muted">
        {label}
        {optional && value && (
          <button onClick={() => onChange(null)} className="text-[11px] text-dim hover:text-fg">
            Remove
          </button>
        )}
      </span>
      {optional && !value ? (
        <button onClick={() => onChange('#e0a43a')} className="flex h-8 items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 text-[12px] text-dim hover:text-fg">
          <Plus size={12} /> Add an accent
        </button>
      ) : (
        <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-panel pl-1 pr-2">
          <label className="relative h-6 w-6 shrink-0 cursor-pointer overflow-hidden rounded-[5px] border border-black/30" style={{ background: value ?? 'transparent' }}>
            <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" aria-label={`${label} colour`} />
          </label>
          {!compact && (
            <input
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              aria-label={`${label} hex`}
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] uppercase outline-none"
            />
          )}
          {compact && <span className="font-mono text-[10.5px] uppercase text-dim">{value?.slice(1)}</span>}
        </div>
      )}
    </div>
  )
}

function FontField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange(v: string): void }) {
  const all = options.includes(value) ? options : [value, ...options]
  return (
    <Field label={label} hint={BUNDLED_FONTS.has(value) || value.startsWith('System') ? undefined : 'Shown only if installed on this computer.'}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {all.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
  swatch
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format(v: number): string
  onChange(v: number): void
  disabled?: boolean
  swatch?: string
}) {
  return (
    <label className={clsx('flex flex-col gap-1.5', disabled && 'opacity-50')}>
      <span className="flex items-center justify-between text-[11.5px] font-medium text-muted">
        {label}
        <span className="flex items-center gap-1.5 text-[11px] text-dim">
          {swatch && <span className="h-3 w-3 rounded-[3px] border border-line-strong" style={{ background: swatch }} />}
          {format(value)}
        </span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="accent-[#dc2645]" />
    </label>
  )
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      icon={done ? <Check size={13} /> : <Copy size={13} />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        })
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </Button>
  )
}

// ─── AI ───────────────────────────────────────────────────────────────────────

function GenerateModal({ open, current, onClose, onDraft }: { open: boolean; current: DesignInput; onClose(): void; onDraft(d: { name: string; description: string; input: DesignInput }): void }) {
  const settings = useApp((s) => s.settings)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<ModelRef | null>(null)
  const [keep, setKeep] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setModel((m) => m ?? settings?.defaultModel ?? null)
  }, [open, settings?.defaultModel])
  const run = async () => {
    if (!model) return
    setBusy(true)
    const draft = await attempt(() => api.design.generate({ prompt, model, current: keep ? current : undefined }))
    setBusy(false)
    if (draft) onDraft(draft)
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Generate a design system"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<MagicWand size={14} />} loading={busy} disabled={!prompt.trim() || !model} onClick={() => void run()}>
            Generate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Describe the product and the feel">
          <Textarea rows={4} autoFocus={!isMobile} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. A calm, dense dashboard for on-call engineers. Dark first, sharp corners, technical but friendly. Paste a Coolors link to build from its palette." />
        </Field>
        <Field label="Model">
          <ModelPicker value={model} onChange={setModel} />
        </Field>
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="accent-[#dc2645]" />
          Adjust the current system instead of starting over
        </label>
      </div>
    </Modal>
  )
}

// ─── Preview ──────────────────────────────────────────────────────────────────

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/** The preview is styled only by the design's own variables, never by Cloth's theme. */
const PREVIEW_CSS = `
.dsp { background: var(--color-background); color: var(--color-text); font-family: var(--font-sans); font-size: var(--text-body); line-height: var(--leading-body); }
.dsp * { box-sizing: border-box; }
.dsp h1, .dsp h2, .dsp h3, .dsp h4 { font-family: var(--font-heading); margin: 0; color: var(--color-text); }
.dsp h1 { font-size: var(--text-h1); line-height: var(--leading-h1); font-weight: var(--weight-h1); letter-spacing: var(--tracking-h1); }
.dsp h3 { font-size: var(--text-h3); line-height: var(--leading-h3); font-weight: var(--weight-h3); letter-spacing: var(--tracking-h3); }
.dsp h4 { font-size: var(--text-h4); line-height: var(--leading-h4); font-weight: var(--weight-h4); letter-spacing: var(--tracking-h4); }
.dsp .big { font-family: var(--font-heading); font-size: var(--text-h2); font-weight: var(--weight-h2); letter-spacing: var(--tracking-h2); line-height: 1; }
.dsp .muted { color: var(--color-text-muted); } .dsp .subtle { color: var(--color-text-subtle); }
.dsp .small { font-size: var(--text-small); line-height: var(--leading-small); }
.dsp .nav { display: flex; align-items: center; gap: 18px; padding: 12px 20px; border-bottom: 1px solid var(--color-border); background: var(--color-surface); flex-wrap: wrap; }
.dsp .nav a { color: var(--color-text-muted); text-decoration: none; font-size: var(--text-small); } .dsp .nav a.on { color: var(--color-text); font-weight: 600; }
.dsp .bar { height: 8px; border-radius: 99px; background: var(--color-surface-raised); overflow: hidden; } .dsp .bar span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); }
.dsp table { width: 100%; border-collapse: collapse; font-size: var(--text-small); } .dsp th { text-align: left; color: var(--color-text-subtle); font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--color-border); }
.dsp td { padding: 10px; border-bottom: 1px solid var(--color-border); } .dsp tr:last-child td { border-bottom: 0; }
.dsp .toggle { width: 36px; height: 20px; border-radius: 999px; background: var(--color-primary); position: relative; display: inline-block; flex-shrink: 0; } .dsp .toggle::after { content: ''; position: absolute; top: 2px; right: 2px; width: 16px; height: 16px; border-radius: 999px; background: var(--color-on-primary); }
.dsp code { font-family: var(--font-mono); font-size: .9em; background: var(--color-surface-raised); padding: 1px 5px; border-radius: var(--radius-sm); }
.dsp .grid { padding: var(--space-8); display: grid; gap: var(--space-6); grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.dsp .full { grid-column: 1 / -1; }
`

function Preview({ name, input, built, theme, onOverride }: { name: string; input: DesignInput; built: BuiltDesign; theme: 'light' | 'dark'; onOverride(role: RoleName, color: string | null): void }) {
  const roles = built.roles[theme]
  useEffect(() => {
    for (const f of [input.fontSans, input.fontHeading, input.fontMono]) void loadDesignFont(f)
  }, [input.fontSans, input.fontHeading, input.fontMono])
  const vars = useMemo(() => {
    const v: Record<string, string> = {}
    for (const k of Object.keys(roles) as RoleName[]) v[`--color-${kebab(k)}`] = roles[k]
    v['--font-sans'] = fontStack(input, 'sans')
    v['--font-heading'] = fontStack(input, 'heading')
    v['--font-mono'] = fontStack(input, 'mono')
    for (const t of built.type) {
      v[`--text-${t.name}`] = `${t.size}px`
      v[`--leading-${t.name}`] = String(t.lineHeight)
      v[`--tracking-${t.name}`] = `${t.tracking}em`
      v[`--weight-${t.name}`] = String(t.weight)
    }
    for (const [k, r] of Object.entries(built.radii)) v[`--radius-${k}`] = `${r}px`
    built.space.forEach((s, i) => (v[`--space-${i}`] = `${s}px`))
    v['--control-height'] = `${built.control.height}px`
    v['--pad-x'] = `${built.control.paddingX}px`
    for (const [k, s] of Object.entries(built.shadows)) v[`--shadow-${k}`] = s
    return v as CSSProperties
  }, [roles, input, built])
  const picked = input.overrides[theme] ?? {}
  return (
    <div className="dsp min-h-full" style={vars}>
      <style>{PREVIEW_CSS}</style>
      <style>{kitCss(input.kit)}</style>
      <div className="nav">
        <h4>{name}</h4>
        <a className="on">Overview</a>
        <a>Projects</a>
        <a>Reports</a>
        <span style={{ flex: 1 }} />
        <button className="ds-button ds-button--primary">New project</button>
      </div>
      <div className="grid">
        <div className="full" style={{ display: 'grid', gap: 6 }}>
          <h1>Good morning, Sam</h1>
          <div className="muted" style={{ maxWidth: 560 }}>
            Three deploys went out overnight and one needs a look. Everything else is healthy.
          </div>
        </div>
        <div className="ds-card" style={{ alignContent: 'start' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="muted small">Monthly usage</span>
            <span className="ds-badge ds-badge--accent ds-badge--dot">New</span>
          </div>
          <div className="big">68%</div>
          <div className="bar">
            <span style={{ width: '68%' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'end', gap: 4, height: 44 }}>
            {[40, 55, 35, 70, 60, 85, 50, 75, 90, 65, 80, 95].map((h, i) => (
              <span key={i} style={{ flex: 1, height: `${h}%`, borderRadius: 'var(--radius-sm)', background: i === 11 ? roles.accent : `color-mix(in oklab, ${roles.accent} 35%, ${roles.surface})` }} />
            ))}
          </div>
        </div>
        <div className="ds-card" style={{ gap: 'var(--space-4)' }}>
          <h3>Create a project</h3>
          <label className="ds-field">
            <span className="ds-label">Name</span>
            <input className="ds-input" placeholder="e.g. Billing service" />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }} className="small">
            <span className="toggle" /> Enable backups
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="ds-button ds-button--primary">Create project</button>
            <button className="ds-button ds-button--secondary">Cancel</button>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 'var(--space-3)', alignContent: 'start' }}>
          <div className="ds-alert ds-alert--success">
            <span className="ds-alert__icon" style={{ fontWeight: 700 }}>✓</span>
            <span>Deployed in 42 seconds.</span>
          </div>
          <div className="ds-alert ds-alert--warning">
            <span className="ds-alert__icon" style={{ fontWeight: 700 }}>!</span>
            <span>Usage is at 85% of the plan.</span>
          </div>
          <div className="ds-alert ds-alert--danger">
            <span className="ds-alert__icon" style={{ fontWeight: 700 }}>×</span>
            <span>The build failed — see the log.</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="ds-button ds-button--ghost">Archive</button>
            <button className="ds-button ds-button--danger">Delete project</button>
          </div>
        </div>
        <div className="ds-menu" style={{ alignSelf: 'start' }}>
          <div className="ds-menu__item">Rename</div>
          <div className="ds-menu__item is-active">Duplicate</div>
          <div className="ds-menu__item">Move to…</div>
          <div className="ds-menu__sep" />
          <div className="ds-menu__item ds-menu__item--danger">Delete</div>
        </div>
        <div className="ds-card ds-card--flush full">
          <div className="ds-tabs" style={{ padding: '0 12px' }}>
            <span className="ds-tab is-active">Services</span>
            <span className="ds-tab">Deploys</span>
            <span className="ds-tab">Settings</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Status</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['api-gateway', 'Healthy', '42 ms'],
                  ['billing', 'Degraded', '310 ms'],
                  ['search', 'Healthy', '88 ms']
                ].map((r) => (
                  <tr key={r[0]}>
                    <td>
                      <code>{r[0]}</code>
                    </td>
                    <td>
                      <span className={r[1] === 'Healthy' ? 'ds-badge ds-badge--success' : 'ds-badge ds-badge--warning'}>
                        {r[1]}
                      </span>
                    </td>
                    <td className="muted">{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="ds-card full" style={{ textAlign: 'center', justifyItems: 'center', gap: 8, padding: 'var(--space-10) var(--space-6)' }}>
          <span style={{ width: 40, height: 40, borderRadius: 'var(--radius-lg)', background: roles.primarySoft, color: roles.primary, display: 'grid', placeItems: 'center' }}>
            <Sparkle size={20} weight="fill" />
          </span>
          <h4>No reports yet</h4>
          <div className="muted small" style={{ maxWidth: 320 }}>
            Reports appear here once a project has a week of data.
          </div>
          <button className="ds-button ds-button--secondary">Learn about reports</button>
        </div>
        <div className="ds-card full" style={{ gap: 10 }}>
          {built.type.map((t) => (
            <div key={t.name} style={{ display: 'flex', alignItems: 'baseline', gap: 16, minWidth: 0 }}>
              <span className="subtle" style={{ width: 84, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {t.name} · {t.size}
              </span>
              <span style={{ fontFamily: t.font === 'heading' ? 'var(--font-heading)' : 'var(--font-sans)', fontSize: t.size, lineHeight: t.lineHeight, fontWeight: t.weight, letterSpacing: `${t.tracking}em`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                {t.name === 'body' || t.name === 'small' || t.name === 'caption' ? 'The quick brown fox jumps over the lazy dog.' : 'Ship calm software'}
              </span>
            </div>
          ))}
        </div>
        <div className="ds-card full" style={{ gap: 12 }}>
          {Object.entries(built.scales)
            .filter(([, s]) => s)
            .map(([scaleName, s]) => (
              <div key={scaleName} style={{ display: 'grid', gridTemplateColumns: '64px repeat(11, 1fr)', gap: 4, alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 'var(--text-caption)' }}>
                  {scaleName}
                </span>
                {STEPS.map((st) => (
                  <div key={st} title={`${scaleName}-${st} ${s![st]}`} style={{ height: 26, borderRadius: 'var(--radius-sm)', background: s![st], border: '1px solid rgb(0 0 0 / .08)' }} />
                ))}
              </div>
            ))}
        </div>
        <div className="ds-card full" style={{ display: 'block' }}>
          <h4 style={{ marginBottom: 10 }}>Contrast ({theme})</h4>
          <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {built.checks
              .filter((c) => c.mode === theme)
              .map((c) => (
                <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 34, height: 26, borderRadius: 6, background: c.bg, color: c.fg, display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 12, border: '1px solid var(--color-border)' }}>Aa</span>
                  <span className="small" style={{ flex: 1 }}>
                    {c.label}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: c.ratio >= c.need ? roles.success : roles.danger, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {c.ratio >= c.need ? null : <Warning size={12} weight="fill" />}
                    {c.ratio.toFixed(1)}
                  </span>
                </div>
              ))}
          </div>
        </div>
        <div className="ds-card full" style={{ display: 'block' }}>
          <h4 style={{ marginBottom: 4 }}>Roles ({theme})</h4>
          <div className="muted small" style={{ marginBottom: 12 }}>
            Click a colour to set it yourself.
          </div>
          <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
            {(Object.keys(ROLE_INFO) as RoleName[]).map((k) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} title={ROLE_INFO[k]}>
                <label style={{ position: 'relative', width: 22, height: 22, borderRadius: 6, background: roles[k], border: '1px solid var(--color-border-strong)', flexShrink: 0, cursor: 'pointer', overflow: 'hidden' }}>
                  <input type="color" value={roles[k]} onChange={(e) => onOverride(k, e.target.value)} aria-label={`${kebab(k)} colour`} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', width: '100%', height: '100%' }} />
                </label>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kebab(k)}</span>
                <span className="subtle" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  {roles[k]}
                </span>
                {picked[k] && (
                  <button onClick={() => onOverride(k, null)} title={`Back to the generated ${built.generated[theme][k]}`} style={{ marginLeft: 'auto', color: 'var(--color-text-subtle)', background: 'none', border: 0, cursor: 'pointer', display: 'inline-flex' }}>
                    <ArrowCounterClockwise size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
