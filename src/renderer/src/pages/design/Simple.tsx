import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { CaretDown, Check, FolderSimple, Shuffle } from '@phosphor-icons/react'
import type { DesignInput, DesignProjectSync } from '@shared/design'
import { CORNERS, CORNER_IDS, MODES, SPACINGS, SWATCHES, TEXT_FEELS, TEXT_FEEL_IDS, cornersOf, textFeelOf, variation, withCorners, withTextFeel } from '@shared/guided'
import type { Project } from '@shared/types'
import { api } from '@/lib/api'
import { attempt } from '@/lib/store'
import { Button, Segmented } from '@/components/ui'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-b border-line px-4 py-4 last:border-b-0">
      <h3 className="text-[12px] font-medium text-dim">{title}</h3>
      {children}
    </section>
  )
}

/** Five plain controls; every other setting follows from them. */
export function SimpleControls({ input, set }: { input: DesignInput; set(next: DesignInput): void }) {
  const feel = textFeelOf(input)
  const corners = cornersOf(input)
  const known = SWATCHES.some((s) => s.color.toLowerCase() === input.brand.toLowerCase())
  return (
    <div>
      <Group title="Main colour">
        <div className="flex flex-wrap items-center gap-2">
          {[...(known ? [] : [{ color: input.brand, name: 'Current' }]), ...SWATCHES].map((s) => (
            <button
              key={s.color}
              title={s.name}
              aria-label={s.name}
              aria-pressed={s.color.toLowerCase() === input.brand.toLowerCase()}
              onClick={() => set({ ...input, brand: s.color })}
              className={clsx('h-7 w-7 rounded-full border-2 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]', s.color.toLowerCase() === input.brand.toLowerCase() ? 'border-fg' : 'border-transparent')}
              style={{ background: s.color }}
            />
          ))}
          <label title="Any colour" className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border border-dashed border-line-strong">
            <span className="absolute inset-0 grid place-items-center text-[14px] text-dim">+</span>
            <input type="color" value={input.brand} onChange={(e) => set({ ...input, brand: e.target.value })} aria-label="Any colour" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
          </label>
        </div>
      </Group>
      <Group title="Text">
        <div className="grid gap-1.5">
          {!feel && (
            <div aria-pressed="true" className="flex min-w-0 items-center gap-2.5 rounded-[9px] border border-crimson-line bg-crimson-soft px-2.5 py-1.5 text-[12.5px]">
              <b className="w-7 shrink-0 text-[16px]" style={{ fontFamily: `'${input.fontHeading}', sans-serif` }}>
                Aa
              </b>
              <span className="min-w-0 truncate">
                {input.fontHeading}
                {input.fontSans !== input.fontHeading ? ` and ${input.fontSans}` : ''}
              </span>
            </div>
          )}
          {TEXT_FEEL_IDS.map((t) => (
            <button
              key={t}
              onClick={() => set(withTextFeel(input, t))}
              aria-pressed={feel === t}
              className={clsx('flex w-full min-w-0 items-center gap-2.5 rounded-[9px] border px-2.5 py-1.5 text-left text-[12.5px]', feel === t ? 'border-crimson-line bg-crimson-soft' : 'border-line bg-elev hover:bg-hover')}
            >
              <b className="w-7 shrink-0 text-[16px]" style={{ fontFamily: `'${TEXT_FEELS[t].fontHeading}', sans-serif` }}>
                Aa
              </b>
              <span className="shrink-0 font-medium">{TEXT_FEELS[t].label}</span>
              <span className="min-w-0 truncate text-dim">{TEXT_FEELS[t].hint}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title="Corners">
        <Segmented value={corners} onChange={(c) => set(withCorners(input, c))} items={CORNER_IDS.map((c) => ({ value: c, label: CORNERS[c].short, title: CORNERS[c].label }))} />
      </Group>
      <Group title="Spacing">
        <Segmented value={input.density} onChange={(density) => set({ ...input, density })} items={(Object.keys(SPACINGS) as DesignInput['density'][]).map((d) => ({ value: d, label: SPACINGS[d] }))} />
      </Group>
      <Group title="Light or dark">
        <Segmented value={input.mode} onChange={(mode) => set({ ...input, mode })} items={(Object.keys(MODES) as DesignInput['mode'][]).map((m) => ({ value: m, label: MODES[m].label, title: MODES[m].hint }))} />
      </Group>
      <div className="grid gap-3 px-4 py-4">
        <Button icon={<Shuffle size={14} />} onClick={() => set(variation(input))} className="justify-self-start">
          Try a variation
        </Button>
        <p className="text-[12px] text-dim">Greys, type sizes, shadows and each component's details follow from these.</p>
      </div>
    </div>
  )
}

/**
 * Pick the projects that use this design. Their chats follow it; a project with a folder also gets the
 * design files, except files someone edited by hand (those wait in the Projects tab). Opened for a
 * project (`forProjectId`), the list starts open with that project marked.
 */
export function UseInProject({ designId, version, forProjectId = null }: { designId: string; version: number; forProjectId?: string | null }) {
  const [open, setOpen] = useState(() => !!forProjectId)
  const [projects, setProjects] = useState<Project[]>([])
  const [sync, setSync] = useState<DesignProjectSync[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const load = async () => {
    const [p, s] = await Promise.all([api.projects.list(), api.design.projects(designId)])
    setProjects(p)
    setSync(s)
  }
  useEffect(() => {
    if (open) void load().catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const write = async (p: Project) => {
    const files = sync.find((s) => s.projectId === p.id)?.files ?? []
    const paths = files.filter((f) => f.state !== 'edited' && f.state !== 'current').map((f) => f.path)
    if (paths.length) await api.design.writeProject(designId, p.id, paths)
    const kept = files.filter((f) => f.state === 'edited').length
    setNote(kept ? `${kept} file${kept === 1 ? '' : 's'} in ${p.name} you edited by hand were left alone. Compare them in the Projects tab.` : null)
  }
  const toggle = async (p: Project) => {
    setBusy(p.id)
    const on = p.designId === designId
    await attempt(async () => {
      if (on) await api.projects.update(p.id, { designId: null })
      else {
        await api.projects.update(p.id, { designId })
        if (p.folder) await write(p)
      }
    })
    await load().catch(() => undefined)
    setBusy(null)
  }
  const update = async (p: Project) => {
    setBusy(p.id)
    await attempt(() => write(p))
    await load().catch(() => undefined)
    setBusy(null)
  }
  const linked = projects.filter((p) => p.designId === designId).length
  return (
    <div ref={wrap} className="relative">
      <Button variant="primary" icon={<FolderSimple size={14} />} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog">
        <span className="mobile:hidden">Use in a project</span>
        {linked > 0 && <span className="rounded-full bg-white/20 px-1.5 text-[11px]">{linked}</span>}
        <CaretDown size={11} />
      </Button>
      {open && (
        <div role="dialog" aria-label="Use in a project" className="absolute right-0 top-full z-40 mt-2 grid w-[320px] max-w-[calc(100vw-24px)] gap-2 rounded-[14px] border border-line-strong bg-elev p-3 shadow-[0_24px_60px_-18px_rgb(0_0_0/0.85)]">
          <div className="text-[13px] font-semibold">Use in a project</div>
          <p className="text-[12px] text-dim">Chats in the project follow this design. If the project has a folder, Cloth also writes the design files into its design/ folder.</p>
          <div className="grid max-h-[280px] gap-1 overflow-y-auto">
            {projects.map((p) => {
              const on = p.designId === designId
              const s = sync.find((x) => x.projectId === p.id)
              const outdated = on && !!s?.files.some((f) => f.state === 'outdated' || f.state === 'missing')
              return (
                <div key={p.id} className={clsx('flex items-center gap-2 rounded-[9px] px-1.5 py-1 hover:bg-hover', p.id === forProjectId && 'bg-hover')}>
                  <button onClick={() => void toggle(p)} disabled={busy === p.id} aria-pressed={on} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px]">
                    <span className={clsx('grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border', on ? 'border-crimson bg-crimson text-white' : 'border-line-strong')}>{on && <Check size={11} weight="bold" />}</span>
                    <FolderSimple size={14} weight="fill" style={{ color: p.color }} className="shrink-0" />
                    <span className="min-w-0 truncate">{p.name}</span>
                    {p.designId && !on && <span className="shrink-0 text-[11px] text-dim">uses another</span>}
                    {!p.folder && <span className="shrink-0 text-[11px] text-dim">no folder</span>}
                  </button>
                  {outdated && p.folder && (
                    <button onClick={() => void update(p)} disabled={busy === p.id} className="shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] text-warn hover:bg-elev-2">
                      Update files
                    </button>
                  )}
                </div>
              )
            })}
            {!projects.length && <p className="px-1.5 py-2 text-[12.5px] text-dim">No projects yet. Make one from the chat list, then come back.</p>}
          </div>
          {note && <p className="rounded-lg bg-elev-2 px-2.5 py-2 text-[12px] text-muted">{note}</p>}
        </div>
      )}
    </div>
  )
}
