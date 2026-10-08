import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowsClockwise, CaretLeft, ImageSquare, MagicWand, X } from '@phosphor-icons/react'
import { PRESETS, sanitizeDesign, type DesignInput } from '@shared/design'
import { CORNERS, CORNER_IDS, MODES, SPACINGS, SWATCHES, TEXT_FEELS, TEXT_FEEL_IDS, cornersOf, textFeelOf, withCorners, withTextFeel, type TextFeel } from '@shared/guided'
import type { ModelRef } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { isMobile } from '@/lib/platform'
import { loadDesignFont } from '@/lib/designFonts'
import { Button, Segmented, Textarea } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { SampleScreen } from './Sample'

interface Look {
  name: string
  why: string
  description: string
  input: DesignInput
}

const STEPS = [
  { id: 'colour', label: 'Colour' },
  { id: 'text', label: 'Text' },
  { id: 'shape', label: 'Corners and spacing' },
  { id: 'mode', label: 'Light or dark' },
  { id: 'name', label: 'Name' }
] as const

const presetLooks = (): Look[] => PRESETS.map((p) => ({ name: p.name, why: p.blurb, description: p.blurb, input: sanitizeDesign(p.input) }))

/**
 * A first design without design vocabulary: describe the product, pick one of three looks, confirm its
 * colour, text, shape and theme one at a time on a live screen of the product, then name it.
 */
export function GuidedSetup({ start, askDefault, onCancel, onCreated, onBlank }: { start: 'describe' | 'presets'; askDefault: boolean; onCancel(): void; onCreated(id: string): void; onBlank(): void }) {
  const settings = useApp((s) => s.settings)
  const [phase, setPhase] = useState<'describe' | 'looks' | 'choose'>(start === 'presets' ? 'looks' : 'describe')
  const [prompt, setPrompt] = useState('')
  const [logo, setLogo] = useState<{ url: string; color: string | null } | null>(null)
  const [model, setModel] = useState<ModelRef | null>(settings?.defaultModel ?? null)
  const [looks, setLooks] = useState<Look[]>(() => (start === 'presets' ? presetLooks() : []))
  const [fromPresets, setFromPresets] = useState(start === 'presets')
  const [seen, setSeen] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [base, setBase] = useState<Look | null>(null)
  const [input, setInput] = useState<DesignInput | null>(null)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [useDefault, setUseDefault] = useState(askDefault)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [creating, setCreating] = useState(false)

  useEffect(() => setModel((m) => m ?? settings?.defaultModel ?? null), [settings?.defaultModel])
  useEffect(() => {
    for (const id of TEXT_FEEL_IDS) for (const f of [TEXT_FEELS[id].fontHeading, TEXT_FEELS[id].fontSans]) void loadDesignFont(f)
  }, [])

  const generate = async (more: boolean) => {
    if (!model) return
    setFromPresets(false)
    setPhase('looks')
    setLoading(true)
    const avoid = more ? [...seen, ...looks.map((l) => l.name)] : []
    const res = await attempt(() => api.design.looks({ prompt, model, logoColor: logo?.color ?? null, avoid }))
    setLoading(false)
    if (!res) return setPhase(looks.length ? 'looks' : 'describe')
    setSeen(avoid)
    setLooks(res.looks)
  }
  const showPresets = () => (setFromPresets(true), setLooks(presetLooks()), setPhase('looks'))
  const pick = (l: Look) => {
    setBase(l)
    setInput(l.input)
    setName(l.name)
    setTheme(l.input.mode === 'dark' ? 'dark' : 'light')
    setStep(0)
    setPhase('choose')
  }
  const set = (next: DesignInput) => {
    setInput(next)
    if (next.mode !== 'both') setTheme(next.mode)
  }
  const create = async () => {
    if (!input || !base) return
    setCreating(true)
    const d = await attempt(() => api.design.create({ name: name.trim() || base.name, description: base.description || prompt.trim(), input }))
    setCreating(false)
    if (!d) return
    if (useDefault) await useApp.getState().updateSettings({ defaultDesignId: d.id })
    onCreated(d.id)
  }

  const header = (back: () => void, label: string) => (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
      <button onClick={back} className="flex h-8 items-center gap-1 rounded-lg pl-1 pr-2 text-[12.5px] text-dim hover:bg-elev-2 hover:text-fg">
        <CaretLeft size={14} /> Back
      </button>
      <span className="text-[13px] text-muted">{label}</span>
      <div className="flex-1" />
      <button onClick={onCancel} title="Cancel" aria-label="Cancel" className="flex h-8 w-8 items-center justify-center rounded-lg text-dim hover:bg-elev-2 hover:text-fg">
        <X size={15} />
      </button>
    </div>
  )

  // ─── Describe ───
  if (phase === 'describe')
    return (
      <div className="flex h-full flex-col">
        {header(onCancel, 'New design')}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-[min(620px,calc(100%-32px))] gap-5 py-10 mobile:py-6">
            <div className="grid gap-1.5">
              <h1 className="text-[22px] font-semibold tracking-tight">What are you making?</h1>
              <p className="text-[13px] text-muted">A sentence or two is enough. Say who it's for and how it should feel, and name a colour if you already have one in mind.</p>
            </div>
            <Textarea rows={4} autoFocus={!isMobile} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="What you're making" placeholder="e.g. A booking site for a small yoga studio. Calm and warm; most people book on their phone." />
            <LogoField logo={logo} onLogo={setLogo} />
            {model ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" icon={<MagicWand size={14} />} disabled={!prompt.trim()} onClick={() => void generate(false)}>
                  Show me three looks
                </Button>
                <div className="flex min-w-0 items-center gap-2 text-[12px] text-dim">
                  Made by
                  <div className="w-56 max-w-full">
                    <ModelPicker value={model} onChange={setModel} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-[12px] border border-line bg-elev px-4 py-3 text-[13px] text-muted">
                Cloth needs an AI model to make looks from a description. Add one on the Models page, or pick from finished looks below.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4 text-[12.5px] text-dim">
              <button onClick={showPresets} className="underline underline-offset-[3px] hover:text-fg">
                Pick from finished looks
              </button>
              <button onClick={onBlank} className="underline underline-offset-[3px] hover:text-fg">
                Start from scratch with every setting
              </button>
            </div>
          </div>
        </div>
      </div>
    )

  // ─── Three looks ───
  if (phase === 'looks')
    return (
      <div className="flex h-full flex-col">
        {header(() => (start === 'presets' && fromPresets ? onCancel() : setPhase('describe')), 'New design')}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-[min(1180px,calc(100%-32px))] gap-5 py-6">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[240px] flex-1">
                <h1 className="text-[19px] font-semibold tracking-tight">{fromPresets ? 'Pick a starting look' : loading ? 'Making three looks…' : 'Pick the closest look'}</h1>
                <p className="mt-0.5 text-[13px] text-muted">{fromPresets ? 'Each one is a complete design. You can change its colour, text and shape next.' : "You'll fine-tune colour, text and shape in the next steps."}</p>
              </div>
              {!fromPresets && (
                <Button icon={<ArrowsClockwise size={14} />} loading={loading} disabled={!model} onClick={() => void generate(true)}>
                  Show three more
                </Button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4 mobile:grid-cols-1 max-[1000px]:grid-cols-2">
              {loading
                ? [0, 1, 2].map((i) => <div key={i} className="h-[340px] animate-pulse rounded-[14px] bg-elev motion-reduce:animate-none" />)
                : looks.map((l, i) => (
                    <div key={i} className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-panel">
                      {/* The whole screen, shrunk, so a look is judged on more than its headline. */}
                      <div className="pointer-events-none h-[300px] overflow-hidden border-b border-line" aria-hidden="true">
                        <div style={{ zoom: 0.5 }}>
                          <SampleScreen input={l.input} theme={l.input.mode === 'dark' ? 'dark' : 'light'} />
                        </div>
                      </div>
                      <div className="grid flex-1 content-start gap-1.5 p-3.5">
                        <span className="text-[14px] font-semibold">{l.name}</span>
                        <span className="text-[12.5px] leading-snug text-muted">{l.why}</span>
                        <Button variant="primary" size="sm" className="mt-1.5 justify-self-start" onClick={() => pick(l)}>
                          Use this look
                        </Button>
                      </div>
                    </div>
                  ))}
            </div>
          </div>
        </div>
      </div>
    )

  // ─── Choices ───
  if (!input || !base) return null
  const current = STEPS[step]
  const last = step === STEPS.length - 1
  return (
    <div className="flex h-full flex-col">
      {header(() => (step === 0 ? setPhase('looks') : setStep(step - 1)), 'New design')}
      <div className="flex min-h-0 flex-1 mobile:flex-col">
        <div className="flex w-[400px] shrink-0 flex-col border-r border-line mobile:max-h-[58%] mobile:w-full mobile:border-b mobile:border-r-0">
          <div className="flex gap-1 px-5 pt-4" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s.id} className={clsx('h-1 flex-1 rounded-full', i < step ? 'bg-crimson' : i === step ? 'bg-crimson-hi' : 'bg-line-strong')} />
            ))}
          </div>
          <div className="px-5 pt-2 text-[12px] text-dim">
            Step {step + 1} of {STEPS.length}: {current.label}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-4">
            <StepChoices id={current.id} input={input} base={base.input} logo={logo?.color ?? null} set={set} name={name} setName={setName} useDefault={useDefault} setUseDefault={setUseDefault} askDefault={askDefault} />
          </div>
          <div className="flex items-center gap-2 border-t border-line px-4 py-3">
            <div className="flex-1" />
            {!last && (
              <Button variant="ghost" onClick={() => setStep(STEPS.length - 1)}>
                Skip to the end
              </Button>
            )}
            {last ? (
              <Button variant="primary" loading={creating} onClick={() => void create()}>
                Create design
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setStep(step + 1)}>
                Next
              </Button>
            )}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0d0d0f]">
          <div className="flex shrink-0 items-center gap-3 px-5 py-3">
            <span className="flex-1 text-[12.5px] text-dim">A screen of your product in this design. It changes as you choose.</span>
            {input.mode === 'both' && (
              <Segmented
                value={theme}
                onChange={setTheme}
                items={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' }
                ]}
              />
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            <div className="overflow-hidden rounded-[14px] border border-line-strong">
              <SampleScreen input={input} theme={theme} name={name} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Option({ on, onClick, children, suggested }: { on: boolean; onClick(): void; children: ReactNode; suggested?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={clsx('grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[11px] border px-3 py-2.5 text-left transition-colors', on ? 'border-crimson-line bg-crimson-soft' : 'border-line bg-elev hover:bg-hover')}
    >
      {children}
      {suggested ? <span className="whitespace-nowrap rounded-full border border-ok/35 px-2 py-px text-[11px] text-ok">Suggested</span> : <span />}
    </button>
  )
}

function Ask({ title, why, children }: { title: string; why: string; children: ReactNode }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h2 className="text-[18px] font-semibold leading-tight tracking-tight">{title}</h2>
        <p className="text-[13px] text-muted">{why}</p>
      </div>
      {children}
    </div>
  )
}

function StepChoices({
  id,
  input,
  base,
  logo,
  set,
  name,
  setName,
  useDefault,
  setUseDefault,
  askDefault
}: {
  id: (typeof STEPS)[number]['id']
  input: DesignInput
  base: DesignInput
  logo: string | null
  set(i: DesignInput): void
  name: string
  setName(s: string): void
  useDefault: boolean
  setUseDefault(b: boolean): void
  askDefault: boolean
}) {
  if (id === 'colour') {
    const colours = [{ color: base.brand, name: 'This look' }, ...(logo ? [{ color: logo, name: 'Your logo' }] : []), ...SWATCHES].filter((c, i, all) => all.findIndex((x) => x.color.toLowerCase() === c.color.toLowerCase()) === i)
    return (
      <Ask title="Pick your main colour" why="Used for buttons, links and anything people should notice. Cloth keeps text on it readable.">
        <div className="grid grid-cols-3 gap-2">
          {colours.map((c) => (
            <button
              key={c.color}
              onClick={() => set({ ...input, brand: c.color })}
              aria-pressed={input.brand.toLowerCase() === c.color.toLowerCase()}
              className={clsx('grid gap-1.5 rounded-[11px] border p-2 text-left text-[12px]', input.brand.toLowerCase() === c.color.toLowerCase() ? 'border-crimson-line bg-crimson-soft text-fg' : 'border-line bg-elev text-muted hover:bg-hover')}
            >
              <span className="h-8 rounded-[7px]" style={{ background: c.color }} />
              {c.name}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2.5 text-[13px] text-muted">
          <span className="relative h-8 w-10 overflow-hidden rounded-lg border border-line-strong" style={{ background: input.brand }}>
            <input type="color" value={input.brand} onChange={(e) => set({ ...input, brand: e.target.value })} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
          </span>
          Or choose any colour
        </label>
      </Ask>
    )
  }
  if (id === 'text') {
    const baseFeel = textFeelOf(base)
    const feel = textFeelOf(input)
    const own = !baseFeel
    const ownOn = own && input.fontHeading === base.fontHeading && input.fontSans === base.fontSans
    return (
      <Ask title="How should text feel?" why="One choice sets the fonts for headings and everything else.">
        <div className="grid gap-2">
          {own && (
            <Option on={ownOn} suggested onClick={() => set({ ...input, fontHeading: base.fontHeading, fontSans: base.fontSans, fontMono: base.fontMono, headingWeight: base.headingWeight, headingTracking: base.headingTracking })}>
              <Aa font={base.fontHeading} />
              <span>
                <span className="block text-[13.5px] font-semibold">This look</span>
                <span className="text-[12.5px] text-muted">
                  {base.fontHeading}
                  {base.fontSans !== base.fontHeading ? ` and ${base.fontSans}` : ''}
                </span>
              </span>
            </Option>
          )}
          {TEXT_FEEL_IDS.map((t: TextFeel) => (
            <Option key={t} on={feel === t && !ownOn} suggested={baseFeel === t} onClick={() => set(withTextFeel(input, t))}>
              <Aa font={TEXT_FEELS[t].fontHeading} />
              <span>
                <span className="block text-[13.5px] font-semibold" style={{ fontFamily: `'${TEXT_FEELS[t].fontHeading}', sans-serif` }}>
                  {TEXT_FEELS[t].label}
                </span>
                <span className="text-[12.5px] text-muted">{TEXT_FEELS[t].hint}</span>
              </span>
            </Option>
          ))}
        </div>
      </Ask>
    )
  }
  if (id === 'shape') {
    const corners = cornersOf(input)
    return (
      <Ask title="Corners and spacing" why="Rounder and roomier feels friendlier. Sharper and tighter fits more on screen.">
        <div className="grid gap-2">
          {CORNER_IDS.map((c) => (
            <Option key={c} on={corners === c} suggested={cornersOf(base) === c} onClick={() => set(withCorners(input, c))}>
              <span className="block h-7 w-16 bg-muted" style={{ borderRadius: c === 'pill' ? 999 : CORNERS[c].radius }} />
              <span className="text-[13.5px] font-semibold">{CORNERS[c].label}</span>
            </Option>
          ))}
        </div>
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-medium text-muted">Spacing</span>
          <Segmented value={input.density} onChange={(density) => set({ ...input, density })} items={(Object.keys(SPACINGS) as DesignInput['density'][]).map((d) => ({ value: d, label: SPACINGS[d] }))} />
        </div>
      </Ask>
    )
  }
  if (id === 'mode')
    return (
      <Ask title="Light or dark?" why="With both, your product follows each person's device setting.">
        <div className="grid gap-2">
          {(Object.keys(MODES) as DesignInput['mode'][]).map((m) => (
            <Option key={m} on={input.mode === m} suggested={base.mode === m} onClick={() => set({ ...input, mode: m })}>
              <span className="h-9 w-11 rounded-lg border border-line-strong" style={{ background: m === 'light' ? '#f4f4f5' : m === 'dark' ? '#16161a' : 'linear-gradient(135deg,#f4f4f5 50%,#16161a 50%)' }} />
              <span>
                <span className="block text-[13.5px] font-semibold">{MODES[m].label}</span>
                <span className="text-[12.5px] text-muted">{MODES[m].hint}</span>
              </span>
            </Option>
          ))}
        </div>
      </Ask>
    )
  const feel = textFeelOf(input)
  return (
    <Ask title="Name your design" why="You'll see the name in the gallery and when you add the design to a project.">
      <label className="grid gap-1.5">
        <span className="text-[12.5px] font-medium text-muted">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="h-9 rounded-[10px] border border-line-strong bg-elev px-3 text-[13.5px] outline-none focus:border-crimson-line" />
      </label>
      {askDefault && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} className="h-4 w-4 accent-[#dc2645]" />
          Use for new projects
        </label>
      )}
      <div className="grid text-[13px]">
        {[
          ['Colour', <span key="c" className="inline-block h-3.5 w-3.5 rounded-[4px] align-[-2px]" style={{ background: input.brand }} />],
          ['Text', feel ? TEXT_FEELS[feel].label : input.fontHeading],
          ['Corners', `${CORNERS[cornersOf(input)].label}, ${SPACINGS[input.density].toLowerCase()} spacing`],
          ['Light or dark', MODES[input.mode].label]
        ].map(([k, v]) => (
          <div key={String(k)} className="flex justify-between gap-3 border-b border-line py-2 text-muted last:border-b-0">
            <span>{k}</span>
            <span className="text-fg">{v}</span>
          </div>
        ))}
      </div>
    </Ask>
  )
}

function Aa({ font }: { font: string }) {
  return (
    <span className="grid h-10 w-11 place-items-center rounded-lg border border-line bg-bg text-[19px]" style={{ fontFamily: `'${font}', sans-serif` }}>
      Aa
    </span>
  )
}

function LogoField({ logo, onLogo }: { logo: { url: string; color: string | null } | null; onLogo(l: { url: string; color: string | null } | null): void }) {
  const read = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const img = new Image()
      img.onload = () => onLogo({ url, color: mainColour(img) })
      img.src = url
    }
    reader.readAsDataURL(file)
  }
  return (
    <div className="grid gap-1.5">
      <span className="text-[12.5px] font-medium text-muted">Logo (optional)</span>
      <div className="flex items-center gap-3 rounded-[12px] border border-dashed border-line-strong px-3 py-2.5">
        {logo ? <img src={logo.url} alt="" className="h-10 w-10 rounded-md bg-white object-contain" /> : <ImageSquare size={22} className="text-dim" />}
        <span className="min-w-0 flex-1 text-[12.5px] text-muted">
          {logo ? (
            logo.color ? (
              <>
                Looks will use your logo's colour <span className="inline-block h-3 w-3 rounded-[3px] align-[-1px]" style={{ background: logo.color }} />
              </>
            ) : (
              "Couldn't find a clear colour in this logo."
            )
          ) : (
            'Add a logo and Cloth will match its colour.'
          )}
        </span>
        <label className="cursor-pointer rounded-lg border border-line-strong bg-elev px-2.5 py-1 text-[12px] hover:bg-hover">
          {logo ? 'Change' : 'Choose image'}
          <input type="file" accept="image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
        </label>
        {logo && (
          <button onClick={() => onLogo(null)} className="text-[12px] text-dim hover:text-fg">
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

/** The logo's main colour: the most common clearly-coloured pixels, averaged. */
function mainColour(img: HTMLImageElement): string | null {
  const c = document.createElement('canvas')
  c.width = c.height = 48
  const x = c.getContext('2d')
  if (!x) return null
  x.drawImage(img, 0, 0, 48, 48)
  const px = x.getImageData(0, 0, 48, 48).data
  const buckets = new Map<string, number[][]>()
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]]
    if (a < 128 || Math.max(r, g, b) - Math.min(r, g, b) < 40) continue
    const k = `${r >> 5},${g >> 5},${b >> 5}`
    buckets.set(k, [...(buckets.get(k) ?? []), [r, g, b]])
  }
  const best = [...buckets.values()].sort((a, b) => b.length - a.length)[0]
  if (!best) return null
  return '#' + [0, 1, 2].map((j) => Math.round(best.reduce((s, p) => s + p[j], 0) / best.length).toString(16).padStart(2, '0')).join('')
}
