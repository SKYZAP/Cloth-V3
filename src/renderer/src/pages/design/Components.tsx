import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowsOut, Cube, DesktopTower, DeviceMobile, MagicWand, Minus, Moon, Plus, SlidersHorizontal, SquaresFour, Stack, Sun, Warning, X } from '@phosphor-icons/react'
import type { ModelRef } from '@shared/types'
import { componentLint, unknownTokens, type DesignComponent, type DesignInput } from '@shared/design'
import { KIT, KIT_NAMES, kitSpecimen, type KitName, type KitSettings } from '@shared/kit'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { isMobile, useSideBySide } from '@/lib/platform'
import { fontFaceCss } from '@/lib/designFonts'
import { Button, Modal, Segmented, Textarea, confirmAction } from '@/components/ui'
import { BottomSheet } from '@/components/BottomSheet'
import { ModelPicker } from '@/components/ModelPicker'
import { Canvas, type CanvasHandle, type CanvasTheme, type FrameSpec, type Selection } from './Canvas'
import { ComponentInspector, ElementInspector, KitInspector, Layers, Section } from './Inspector'
import { removeElement, setInnerHtml, shortLabel, type Path } from './htmlEdit'

const IDEAS = ['Buttons: primary, secondary, ghost, danger; sizes; loading and disabled', 'Text input with label, hint, error and a leading icon', 'Card with media, title, meta and actions', 'Modal dialog with title, body and actions', 'Top navigation bar with logo, links and an account menu', 'Data table with sortable headers, row selection and status badges', 'Toast notifications: success, warning, error', 'Pricing table with three tiers, the middle one featured', 'Tabs with counts', 'Avatar group with overflow count']
const EDIT_LABEL = 'Edited in the inspector'
const kitKey = (n: KitName) => `kit:${n}`

/**
 * The design system's component workspace: built-in components tuned with settings, AI-built ones edited
 * on a canvas (select, restyle with tokens, edit text) or changed by asking.
 */
export function ComponentsPanel({ designId, input, setKit, theme, setTheme }: { designId: string; input: DesignInput; setKit(k: KitSettings): void; theme: 'light' | 'dark'; setTheme(t: 'light' | 'dark'): void }) {
  const settings = useApp((s) => s.settings)
  const side = useSideBySide()
  const [items, setItems] = useState<DesignComponent[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [creating, setCreating] = useState(false)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [canvasTheme, setCanvasTheme] = useState<CanvasTheme>(input.mode === 'both' ? theme : input.mode)
  const [phone, setPhone] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [codeFor, setCodeFor] = useState<DesignComponent | null>(null)
  const [sheet, setSheet] = useState(false)
  const [, setTick] = useState(0)
  const canvas = useRef<CanvasHandle>(null)

  useEffect(() => {
    void api.design.components(designId).then(setItems)
    setSelection(null)
  }, [designId])
  useEffect(() => setModel((m) => m ?? settings?.defaultModel ?? null), [settings?.defaultModel])
  useEffect(() => {
    if (input.mode !== 'both') setCanvasTheme(input.mode)
  }, [input.mode])
  useEffect(() => {
    if (canvasTheme !== 'both') setTheme(canvasTheme)
  }, [canvasTheme])

  // ─── Saving hand edits (debounced; one history step per burst) ────────────
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const pending = useRef(new Map<string, { html: string; css: string }>())
  const save = useCallback(async (id: string) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    const code = pending.current.get(id)
    if (!code) return
    pending.current.delete(id)
    const saved = await attempt(() => api.design.updateComponent(id, code, { label: EDIT_LABEL }))
    // Keep newer local edits; take the server's history.
    if (saved) setItems((xs) => xs.map((x) => (x.id === id ? { ...x, history: saved.history, prompt: saved.prompt, updatedAt: saved.updatedAt } : x)))
  }, [])
  useEffect(() => () => void [...pending.current.keys()].forEach((id) => void save(id)), [save])
  const edit = (id: string, patch: { html?: string; css?: string }) => {
    setItems((xs) =>
      xs.map((x) => {
        if (x.id !== id) return x
        const next = { ...x, ...patch }
        pending.current.set(id, { html: next.html, css: next.css })
        return next
      })
    )
    clearTimeout(timers.current.get(id))
    timers.current.set(
      id,
      setTimeout(() => void save(id), 700)
    )
  }
  const put = (c: DesignComponent) => setItems((xs) => (xs.some((x) => x.id === c.id) ? xs.map((x) => (x.id === c.id ? c : x)) : [...xs, c]))

  // ─── Frames ────────────────────────────────────────────────────────────────
  const kitFrames = useMemo<FrameSpec[]>(() => KIT_NAMES.map((n) => ({ key: kitKey(n), kind: 'kit', title: KIT[n].label, html: kitSpecimen(n), css: '' })), [])
  const frames = useMemo<FrameSpec[]>(() => [...kitFrames, ...items.map((c) => ({ key: c.id, kind: 'custom' as const, title: c.name, html: c.html, css: c.css, warn: componentLint(c.css, c.html).length > 0 || unknownTokens(c.css, c.html, input).length > 0 }))], [kitFrames, items, input])
  const fontCss = useMemo(() => fontFaceCss([input.fontSans, input.fontHeading, input.fontMono]), [input.fontSans, input.fontHeading, input.fontMono])

  const kitName = selection?.frame.startsWith('kit:') ? (selection.frame.slice(4) as KitName) : null
  const comp = selection && !kitName ? (items.find((c) => c.id === selection.frame) ?? null) : null
  const path = comp ? (selection?.path ?? null) : null
  const element = comp && path ? (canvas.current?.element(comp.id, path) ?? null) : null

  const select = (s: Selection | null, reveal = false) => {
    setCreating(false)
    setSelection(s)
    if (reveal && s) requestAnimationFrame(() => canvas.current?.reveal(s.frame))
  }

  // ─── AI ────────────────────────────────────────────────────────────────────
  const generate = async (prompt: string, componentId?: string, scope?: Path) => {
    if (!model) return false
    if (componentId) await save(componentId)
    setBusy(componentId ? 'Changing…' : 'Building…')
    const c = await attempt(() => api.design.generateComponent({ designId, prompt, model, componentId, scope: scope ?? undefined }))
    setBusy(null)
    if (!c) return false
    put(c)
    setCreating(false)
    setSelection({ frame: c.id, path: componentId ? (selection?.path ?? null) : null })
    return true
  }
  const ask = async (request: string) => {
    if (kitName) return generate(`A component based on the built-in ${KIT[kitName].label} (.ds-${kitName}, keep using its classes): ${request}`)
    if (!comp) return generate(request)
    if (path?.length) return generate(request, comp.id, path)
    return generate(request, comp.id)
  }

  const undo = async (c: DesignComponent) => {
    await save(c.id)
    const back = await attempt(() => api.design.undoComponent(c.id))
    if (back) put(back)
  }
  const remove = async (c: DesignComponent) => {
    if (!(await confirmAction(`“${c.name}” is removed from the library.`, { title: 'Delete component?', confirmLabel: 'Delete', danger: true }))) return
    clearTimeout(timers.current.get(c.id))
    pending.current.delete(c.id)
    await attempt(() => api.design.removeComponent(c.id))
    setItems((xs) => xs.filter((x) => x.id !== c.id))
    setSelection(null)
  }

  // ─── Inspector ─────────────────────────────────────────────────────────────
  const inspector = creating ? (
    <NewComponent model={model} setModel={setModel} busy={busy} onCreate={(p) => generate(p)} />
  ) : kitName ? (
    <KitInspector name={kitName} kit={input.kit} onChange={setKit} />
  ) : comp && path ? (
    <ElementInspector
      comp={comp}
      path={path}
      element={element}
      input={input}
      onCss={(css) => edit(comp.id, { css })}
      onHtml={(html, p) => {
        edit(comp.id, { html })
        setSelection({ frame: comp.id, path: p })
      }}
      onSelect={(p) => setSelection({ frame: comp.id, path: p })}
    />
  ) : comp ? (
    <ComponentInspector
      comp={comp}
      input={input}
      onRepair={(css) => edit(comp.id, { css })}
      busy={!!busy}
      canAi={!!model}
      onRename={(name) => void attempt(() => api.design.updateComponent(comp.id, { name })).then((c) => c && setItems((xs) => xs.map((x) => (x.id === c.id ? { ...x, name: c.name } : x))))}
      onDescribe={(description) => void attempt(() => api.design.updateComponent(comp.id, { description })).then((c) => c && setItems((xs) => xs.map((x) => (x.id === c.id ? { ...x, description: c.description } : x))))}
      onFixLint={(lint, unknown) =>
        void generate(
          [lint.length ? `Replace these hard-coded colours with the system's colour variables: ${lint.join(', ')}.` : '', unknown.length ? `These CSS variables don't exist in the system, so the declarations using them are dropped: ${unknown.join(', ')}. Replace them with existing tokens.` : ''].filter(Boolean).join(' '),
          comp.id
        )
      }
      onEditCode={() => void save(comp.id).then(() => setCodeFor(items.find((x) => x.id === comp.id) ?? comp))}
      onUndo={() => void undo(comp)}
      onDelete={() => void remove(comp)}
    />
  ) : (
    <Section title="Components">
      <div className="space-y-2 text-[12px] text-dim">
        <p>Built-in components are tuned with settings; select one to change it everywhere it is used.</p>
        <p>Library components are built by AI from this system. Select one to style its parts, edit its text, or ask for changes.</p>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => (setSelection(null), setCreating(true))}>
          New component
        </Button>
      </div>
    </Section>
  )

  const list = (
    <div className="py-2">
      <ListHeading icon={<SquaresFour size={12} />}>Built-in</ListHeading>
      {KIT_NAMES.map((n) => (
        <ListRow key={n} active={selection?.frame === kitKey(n)} onClick={() => select({ frame: kitKey(n), path: null }, true)} icon={<SquaresFour size={14} />}>
          {KIT[n].label}
        </ListRow>
      ))}
      <ListHeading icon={<Cube size={12} />} action={<button onClick={() => (setSelection(null), setCreating(true))} className="text-dim hover:text-fg" aria-label="New component"><Plus size={12} /></button>}>
        Library
      </ListHeading>
      {items.map((c) => (
        <ListRow key={c.id} active={selection?.frame === c.id} onClick={() => select({ frame: c.id, path: null }, true)} icon={<Cube size={14} />} warn={componentLint(c.css, c.html).length > 0 || unknownTokens(c.css, c.html, input).length > 0}>
          {c.name}
        </ListRow>
      ))}
      {!items.length && <div className="px-3 py-1 text-[11.5px] text-dim">None yet</div>}
    </div>
  )
  const layers = comp && (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <ListHeading icon={<Stack size={12} />}>Layers · {comp.name}</ListHeading>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        <Layers html={comp.html} block={comp.name} selected={path} onSelect={(p) => setSelection({ frame: comp.id, path: p })} />
      </div>
    </div>
  )

  const scoped = comp && element ? shortLabel(element, comp.name) : kitName ? `new variant of ${KIT[kitName].label}` : null

  return (
    <div className="flex min-h-0 flex-1">
      {side && (
        <aside className="flex w-[230px] shrink-0 flex-col border-r border-line">
          <div className={clsx('overflow-y-auto', comp ? 'max-h-[45%] shrink-0' : 'min-h-0 flex-1')}>{list}</div>
          {layers}
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5">
          {!side && (
            <select
              value={selection?.frame ?? ''}
              onChange={(e) => select(e.target.value ? { frame: e.target.value, path: null } : null, true)}
              aria-label="Component"
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 text-[12.5px]"
            >
              <option value="">All components</option>
              {KIT_NAMES.map((n) => (
                <option key={n} value={kitKey(n)}>
                  {KIT[n].label} (built-in)
                </option>
              ))}
              {items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {side && <div className="flex-1" />}
          {input.mode === 'both' && (
            <Segmented
              value={canvasTheme}
              onChange={setCanvasTheme}
              items={[
                { value: 'dark', label: <Moon size={13} />, title: 'Dark' },
                { value: 'light', label: <Sun size={13} />, title: 'Light' },
                ...(isMobile ? [] : [{ value: 'both' as const, label: 'Both', title: 'Dark and light side by side' }])
              ]}
            />
          )}
          <Segmented
            value={phone ? 'phone' : 'wide'}
            onChange={(v) => setPhone(v === 'phone')}
            items={[
              { value: 'wide', label: <DesktopTower size={13} />, title: 'Wide' },
              { value: 'phone', label: <DeviceMobile size={13} />, title: 'Phone width' }
            ]}
          />
          <div className="flex items-center rounded-md border border-line">
            <button onClick={() => canvas.current?.zoomBy(1 / 1.2)} className="flex h-7 w-7 items-center justify-center text-muted hover:text-fg" aria-label="Zoom out" title="Zoom out (Ctrl −)">
              <Minus size={12} />
            </button>
            <span className="w-11 text-center font-mono text-[11px] text-muted">{Math.round(zoom * 100)}%</span>
            <button onClick={() => canvas.current?.zoomBy(1.2)} className="flex h-7 w-7 items-center justify-center text-muted hover:text-fg" aria-label="Zoom in" title="Zoom in (Ctrl +)">
              <Plus size={12} />
            </button>
          </div>
          <button onClick={() => canvas.current?.fit()} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev hover:text-fg" aria-label="Fit" title="Fit to screen (Ctrl 0)">
            <ArrowsOut size={14} />
          </button>
          {!side && (
            <Button size="sm" icon={<SlidersHorizontal size={13} />} onClick={() => setSheet(true)}>
              Inspect
            </Button>
          )}
        </div>
        <Canvas
          ref={canvas}
          input={input}
          frames={frames}
          theme={canvasTheme}
          phone={phone}
          fontCss={fontCss}
          selection={selection}
          onSelect={(s) => select(s?.frame === '__new' ? null : s)}
          onText={(frame, p, inner) => {
            const c = items.find((x) => x.id === frame)
            if (c) edit(frame, { html: setInnerHtml(c.html, p, inner) })
          }}
          onDelete={(frame, p) => {
            const c = items.find((x) => x.id === frame)
            if (!c) return
            edit(frame, { html: removeElement(c.html, p) })
            setSelection({ frame, path: null })
          }}
          onNew={() => (setSelection(null), setCreating(true), !side && setSheet(true))}
          newActive={creating}
          zoomLabel={setZoom}
          onLayout={() => setTick((n) => n + 1)}
        />
        {!creating && (
          <AskBar
            busy={busy}
            model={model}
            setModel={setModel}
            scope={scoped}
            onClearScope={comp && element ? () => setSelection({ frame: comp.id, path: null }) : undefined}
            placeholder={kitName ? `Describe a variant of the ${KIT[kitName].label.toLowerCase()} to build` : comp ? (element ? 'Change the selected part — e.g. make it a pill with an icon' : `Ask for a change to ${comp.name}`) : 'Describe a new component to build'}
            onAsk={ask}
          />
        )}
      </div>
      {side ? (
        <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-line">{inspector}</aside>
      ) : (
        <BottomSheet open={sheet} onClose={() => setSheet(false)} title={creating ? 'New component' : comp?.name ?? (kitName ? KIT[kitName].label : 'Components')} portal>
          {comp && (
            <details className="border-b border-line px-3 py-2">
              <summary className="cursor-pointer text-[12px] text-muted">Layers</summary>
              <Layers html={comp.html} block={comp.name} selected={path} onSelect={(p) => setSelection({ frame: comp.id, path: p })} />
            </details>
          )}
          {inspector}
          {!comp && !kitName && !creating && list}
        </BottomSheet>
      )}
      <CodeModal
        comp={codeFor}
        onClose={() => setCodeFor(null)}
        onSave={async (code) => {
          if (!codeFor) return
          const c = await attempt(() => api.design.updateComponent(codeFor.id, code), 'Saved')
          if (c) put(c)
          setCodeFor(null)
        }}
      />
    </div>
  )
}

function ListHeading({ icon, children, action }: { icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-dim">
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {action}
    </div>
  )
}

function ListRow({ active, onClick, icon, warn, children }: { active: boolean; onClick(): void; icon: React.ReactNode; warn?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx('mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-left text-[12.5px]', active ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev')}>
      <span className="shrink-0 text-dim">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {warn && <Warning size={12} weight="fill" className="shrink-0 text-warn" />}
    </button>
  )
}

function AskBar({ busy, model, setModel, scope, onClearScope, placeholder, onAsk }: { busy: string | null; model: ModelRef | null; setModel(m: ModelRef | null): void; scope: string | null; onClearScope?(): void; placeholder: string; onAsk(text: string): Promise<boolean | undefined> }) {
  const [text, setText] = useState('')
  const go = async () => {
    if (!text.trim() || busy || !model) return
    if (await onAsk(text.trim())) setText('')
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2">
      {scope && (
        <span className="flex items-center gap-1 rounded-full border border-crimson-line bg-crimson-soft py-0.5 pl-2 pr-1 font-mono text-[11px] text-crimson-hi">
          {scope}
          {onClearScope && (
            <button onClick={onClearScope} className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-crimson-line" aria-label="Change the whole component instead">
              <X size={9} weight="bold" />
            </button>
          )}
        </span>
      )}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void go()}
        placeholder={placeholder}
        aria-label="Ask AI"
        className="h-9 min-w-[200px] flex-1 rounded-[10px] border border-line bg-panel px-3 text-[13px] outline-none focus:border-crimson-line"
      />
      <ModelPicker className="w-52 mobile:w-full" value={model} onChange={setModel} />
      <Button variant="primary" icon={<MagicWand size={14} />} loading={!!busy} disabled={!text.trim() || !model} onClick={() => void go()}>
        {busy ?? 'Ask'}
      </Button>
    </div>
  )
}

function NewComponent({ model, setModel, busy, onCreate }: { model: ModelRef | null; setModel(m: ModelRef | null): void; busy: string | null; onCreate(p: string): Promise<boolean | undefined> }) {
  const [prompt, setPrompt] = useState('')
  return (
    <Section title="New component">
      <div className="text-[12px] text-dim">Describe it; it is built from this system's tokens and built-in components, with every variant and state.</div>
      <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. A search field with a ⌘K hint, clear button and a results dropdown" />
      <div className="flex flex-wrap gap-1.5">
        {IDEAS.map((i) => (
          <button key={i} onClick={() => setPrompt(i)} className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:border-line-strong hover:text-fg">
            {i.split(':')[0].split(' with ')[0]}
          </button>
        ))}
      </div>
      <ModelPicker value={model} onChange={setModel} />
      <Button variant="primary" className="w-full" icon={<MagicWand size={14} />} loading={!!busy} disabled={!prompt.trim() || !model} onClick={() => void onCreate(prompt).then((ok) => ok && setPrompt(''))}>
        {busy ?? 'Build'}
      </Button>
    </Section>
  )
}

function CodeModal({ comp, onClose, onSave }: { comp: DesignComponent | null; onClose(): void; onSave(code: { html: string; css: string; usage: string }): Promise<void> }) {
  const [view, setView] = useState<'html' | 'css' | 'usage'>('css')
  const [draft, setDraft] = useState({ html: '', css: '', usage: '' })
  useEffect(() => {
    if (comp) setDraft({ html: comp.html, css: comp.css, usage: comp.usage })
  }, [comp])
  const dirty = !!comp && (draft.html !== comp.html || draft.css !== comp.css || draft.usage !== comp.usage)
  return (
    <Modal
      open={!!comp}
      onClose={onClose}
      title={comp ? `${comp.name} — code` : 'Code'}
      width={820}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={() => void onSave(draft)}>
            Save code
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Segmented
          value={view}
          onChange={setView}
          items={[
            { value: 'css', label: 'CSS' },
            { value: 'html', label: 'HTML' },
            { value: 'usage', label: 'Usage' }
          ]}
        />
        <textarea
          value={draft[view]}
          onChange={(e) => setDraft((d) => ({ ...d, [view]: e.target.value }))}
          spellCheck={false}
          aria-label={view}
          className="h-[52vh] w-full resize-none rounded-[12px] border border-line bg-panel p-3 font-mono text-[12px] leading-relaxed text-fg outline-none focus:border-crimson-line"
        />
      </div>
    </Modal>
  )
}

export type { Path }
