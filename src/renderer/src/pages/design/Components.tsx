import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowCounterClockwise, Cube, DesktopTower, DeviceMobile, MagicWand, Moon, Plus, Sun, Trash, Warning } from '@phosphor-icons/react'
import type { ModelRef } from '@shared/types'
import { componentDocument, componentLint, type DesignComponent, type DesignInput } from '@shared/design'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { fontFaceCss } from '@/lib/designFonts'
import { Button, IconButton, Segmented, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'

const IDEAS = ['Buttons: primary, secondary, ghost, danger; sizes; loading and disabled', 'Text input with label, hint, error and a leading icon', 'Card with media, title, meta and actions', 'Modal dialog with title, body and actions', 'Top navigation bar with logo, links and an account menu', 'Data table with sortable headers, row selection and status badges', 'Toast notifications: success, warning, error', 'Pricing table with three tiers, the middle one featured', 'Tabs with counts', 'Avatar group with overflow count']

type View = 'preview' | 'html' | 'css' | 'usage'

/** The design system's component library: build components by description, refine them, check they stay on-system. */
export function ComponentsPanel({ designId, input, theme, setTheme }: { designId: string; input: DesignInput; theme: 'light' | 'dark'; setTheme(t: 'light' | 'dark'): void }) {
  const settings = useApp((s) => s.settings)
  const [items, setItems] = useState<DesignComponent[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    void api.design.components(designId).then((list) => {
      setItems(list)
      setSelected((cur) => cur ?? list[0]?.id ?? null)
    })
  }, [designId])
  useEffect(() => setModel((m) => m ?? settings?.defaultModel ?? null), [settings?.defaultModel])

  const current = items.find((c) => c.id === selected) ?? null
  const put = (c: DesignComponent) => setItems((xs) => (xs.some((x) => x.id === c.id) ? xs.map((x) => (x.id === c.id ? c : x)) : [...xs, c]))

  const generate = async (prompt: string, componentId?: string) => {
    if (!model) return
    setBusy(componentId ? 'Changing…' : 'Building…')
    const c = await attempt(() => api.design.generateComponent({ designId, prompt, model, componentId }))
    setBusy(null)
    if (c) {
      put(c)
      setSelected(c.id)
    }
    return !!c
  }

  return (
    <div className="flex min-h-0 flex-1 mobile:flex-col">
      <div className="flex w-[220px] shrink-0 flex-col border-r border-line mobile:w-full mobile:border-b mobile:border-r-0">
        <div className="p-2">
          <Button size="sm" className="w-full" icon={<Plus size={13} />} onClick={() => setSelected(null)}>
            New component
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 mobile:flex mobile:gap-1 mobile:overflow-x-auto mobile:pb-2">
          {items.map((c) => {
            const lint = componentLint(c.css, c.html)
            return (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={clsx('flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[12.5px] mobile:w-auto mobile:shrink-0', c.id === selected ? 'bg-elev-2 text-fg' : 'text-muted hover:bg-elev')}
              >
                <Cube size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {lint.length > 0 && <Warning size={13} weight="fill" className="shrink-0 text-warn" />}
              </button>
            )
          })}
        </div>
      </div>
      {current ? (
        <ComponentView key={current.id} comp={current} input={input} theme={theme} setTheme={setTheme} model={model} setModel={setModel} busy={busy} onRefine={(p) => generate(p, current.id)} onChange={put} onDeleted={() => (setItems((xs) => xs.filter((x) => x.id !== current.id)), setSelected(null))} />
      ) : (
        <NewComponent model={model} setModel={setModel} busy={busy} onCreate={(p) => generate(p)} />
      )}
    </div>
  )
}

function NewComponent({ model, setModel, busy, onCreate }: { model: ModelRef | null; setModel(m: ModelRef | null): void; busy: string | null; onCreate(p: string): Promise<boolean | undefined> }) {
  const [prompt, setPrompt] = useState('')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5 mobile:p-3">
      <div className="mx-auto max-w-[620px] space-y-3">
        <div>
          <div className="text-[15px] font-semibold">New component</div>
          <div className="text-[12.5px] text-dim">Describe it; it is built from this system's tokens, with every variant and state.</div>
        </div>
        <Textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. A search field with a ⌘K hint, clear button and a results dropdown" />
        <div className="flex flex-wrap gap-1.5">
          {IDEAS.map((i) => (
            <button key={i} onClick={() => setPrompt(i)} className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:border-line-strong hover:text-fg">
              {i.split(':')[0].split(' with ')[0]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <ModelPicker className="flex-1" value={model} onChange={setModel} />
          <Button variant="primary" icon={<MagicWand size={14} />} loading={!!busy} disabled={!prompt.trim() || !model} onClick={() => void onCreate(prompt).then((ok) => ok && setPrompt(''))}>
            {busy ?? 'Build'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ComponentView({
  comp,
  input,
  theme,
  setTheme,
  model,
  setModel,
  busy,
  onRefine,
  onChange,
  onDeleted
}: {
  comp: DesignComponent
  input: DesignInput
  theme: 'light' | 'dark'
  setTheme(t: 'light' | 'dark'): void
  model: ModelRef | null
  setModel(m: ModelRef | null): void
  busy: string | null
  onRefine(prompt: string): Promise<boolean | undefined>
  onChange(c: DesignComponent): void
  onDeleted(): void
}) {
  const [view, setView] = useState<View>('preview')
  const [width, setWidth] = useState<'wide' | 'phone'>('wide')
  const [change, setChange] = useState('')
  const [draft, setDraft] = useState({ html: comp.html, css: comp.css, usage: comp.usage })
  useEffect(() => setDraft({ html: comp.html, css: comp.css, usage: comp.usage }), [comp.html, comp.css, comp.usage])
  const lint = useMemo(() => componentLint(comp.css, comp.html), [comp.css, comp.html])
  const fontCss = useMemo(() => fontFaceCss([input.fontSans, input.fontHeading, input.fontMono]), [input.fontSans, input.fontHeading, input.fontMono])
  const doc = useMemo(() => componentDocument(input, comp, { theme, fontCss }), [input, comp, theme, fontCss])
  const dirty = draft.html !== comp.html || draft.css !== comp.css || draft.usage !== comp.usage

  const refine = async (p: string) => {
    if (await onRefine(p)) setChange('')
  }
  const remove = async () => {
    if (!(await confirmAction(`“${comp.name}” is removed from the library.`, { title: 'Delete component?', confirmLabel: 'Delete', danger: true }))) return
    await attempt(() => api.design.removeComponent(comp.id))
    onDeleted()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 mobile:px-3">
        <input
          key={comp.name}
          defaultValue={comp.name}
          aria-label="Component name"
          onBlur={(e) => e.target.value.trim() && e.target.value !== comp.name && void attempt(() => api.design.updateComponent(comp.id, { name: e.target.value })).then((c) => c && onChange(c))}
          className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold outline-none"
        />
        <Segmented
          value={view}
          onChange={setView}
          items={[
            { value: 'preview', label: 'Preview' },
            { value: 'html', label: 'HTML' },
            { value: 'css', label: 'CSS' },
            { value: 'usage', label: 'Usage' }
          ]}
        />
        {view === 'preview' && (
          <>
            <Segmented
              value={width}
              onChange={setWidth}
              items={[
                { value: 'wide', label: <DesktopTower size={13} />, title: 'Wide' },
                { value: 'phone', label: <DeviceMobile size={13} />, title: 'Phone width' }
              ]}
            />
            {input.mode === 'both' && (
              <Segmented
                value={theme}
                onChange={setTheme}
                items={[
                  { value: 'dark', label: <Moon size={13} />, title: 'Dark' },
                  { value: 'light', label: <Sun size={13} />, title: 'Light' }
                ]}
              />
            )}
          </>
        )}
        <IconButton title={comp.history.length ? `Undo (back to: ${comp.history[0].prompt.slice(0, 60)})` : 'No earlier version'} disabled={!comp.history.length} onClick={() => void attempt(() => api.design.undoComponent(comp.id)).then((c) => c && onChange(c))}>
          <ArrowCounterClockwise size={15} />
        </IconButton>
        <IconButton title="Delete component" onClick={() => void remove()}>
          <Trash size={15} />
        </IconButton>
      </div>
      {comp.description && <div className="shrink-0 px-4 pt-2 text-[12px] text-dim mobile:px-3">{comp.description}</div>}
      {lint.length > 0 && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 rounded-[10px] border border-warn/40 bg-warn/[0.07] px-3 py-2 text-[12px] text-warn mobile:mx-3">
          <Warning size={14} weight="fill" className="shrink-0" />
          <span className="min-w-0 flex-1">
            {lint.length} colour{lint.length === 1 ? '' : 's'} bypass the tokens: <span className="font-mono">{lint.slice(0, 4).join(', ')}</span>
          </span>
          <Button size="sm" disabled={!!busy || !model} onClick={() => void refine(`Replace these hard-coded colours with the system's colour variables: ${lint.join(', ')}`)}>
            Fix with AI
          </Button>
        </div>
      )}
      <div className={clsx('min-h-0 flex-1 p-4 mobile:p-3', view === 'preview' && width === 'phone' && 'flex justify-center bg-elev/40')}>
        {view === 'preview' ? (
          <iframe
            title={`${comp.name} preview`}
            sandbox="allow-same-origin"
            srcDoc={doc}
            className={clsx('h-full rounded-[14px] border border-line bg-bg', width === 'phone' ? 'w-[390px]' : 'w-full')}
          />
        ) : (
          <div className="flex h-full flex-col gap-2">
            <textarea
              value={draft[view]}
              onChange={(e) => setDraft((d) => ({ ...d, [view]: e.target.value }))}
              spellCheck={false}
              aria-label={view}
              className="min-h-0 w-full flex-1 resize-none rounded-[12px] border border-line bg-panel p-3 font-mono text-[12px] leading-relaxed text-fg outline-none focus:border-crimson-line"
            />
            {dirty && (
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDraft({ html: comp.html, css: comp.css, usage: comp.usage })}>
                  Discard
                </Button>
                <Button size="sm" variant="primary" onClick={() => void attempt(() => api.design.updateComponent(comp.id, draft), 'Saved').then((c) => c && onChange(c))}>
                  Save code
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-2.5 mobile:flex-wrap mobile:px-3">
        <input
          value={change}
          onChange={(e) => setChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && change.trim() && !busy && void refine(change)}
          placeholder="Ask for a change — e.g. make the sizes smaller and add an icon-only variant"
          aria-label="Change request"
          className="h-9 min-w-0 flex-1 rounded-[10px] border border-line bg-panel px-3 text-[13px] outline-none focus:border-crimson-line"
        />
        <ModelPicker className="w-52 mobile:w-full" value={model} onChange={setModel} />
        <Button variant="primary" icon={<MagicWand size={14} />} loading={!!busy} disabled={!change.trim() || !model} onClick={() => void refine(change)}>
          {busy ?? 'Change'}
        </Button>
      </div>
    </div>
  )
}
