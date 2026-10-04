import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, ArrowElbowLeftUp, CaretDown, CaretRight, Code, Copy, CopySimple, Plus, Trash, Warning, X } from '@phosphor-icons/react'
import { buildDesign, componentLint, componentSlug, repairTokens, ROLE_INFO, sanitizeComponentHtml, unknownTokens, type DesignComponent, type DesignInput, type RoleName } from '@shared/design'
import { DEFAULT_KIT, KIT, KIT_USAGE, type KitName, type KitSettings } from '@shared/kit'
import { ensureRule, listRules, restingSelector, setDeclaration, type CssRule } from '@shared/cssEdit'
import { Button, Segmented, Select, Switch } from '@/components/ui'
import { describe, shortLabel, stripBlock, duplicateElement, moveElement, ownText, removeElement, samePath, setClasses, setInnerHtml, type Path } from './htmlEdit'

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="space-y-2.5 border-b border-line px-4 py-3.5 last:border-b-0">
      <div className="flex items-center justify-between text-[12px] font-medium text-dim">
        {title}
        {right}
      </div>
      {children}
    </section>
  )
}

// ─── Built-in components ──────────────────────────────────────────────────────

export function KitInspector({ name, kit, onChange }: { name: KitName; kit: KitSettings; onChange(next: KitSettings): void }) {
  const spec = KIT[name]
  const values = kit[name] as Record<string, unknown>
  const set = (key: string, v: unknown) => onChange({ ...kit, [name]: { ...values, [key]: v } })
  const isDefault = JSON.stringify(values) === JSON.stringify(DEFAULT_KIT[name])
  return (
    <div>
      <Section
        title="Built-in component"
        right={
          !isDefault && (
            <button onClick={() => onChange({ ...kit, [name]: DEFAULT_KIT[name] })} className="text-[11px] normal-case tracking-normal text-dim hover:text-fg">
              Reset
            </button>
          )
        }
      >
        <div>
          <div className="text-[15px] font-semibold">{spec.label}</div>
          <div className="text-[12px] text-dim">{spec.description}</div>
        </div>
      </Section>
      <Section title="Settings">
        {spec.controls.map((c) => {
          const v = values[c.key]
          if (c.type === 'switch')
            return (
              <div key={c.key} className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-muted">{c.label}</span>
                <Switch checked={!!v} onChange={(b) => set(c.key, b)} />
              </div>
            )
          if (c.type === 'slider')
            return (
              <label key={c.key} className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between text-[11.5px] font-medium text-muted">
                  {c.label}
                  <span className="text-[11px] text-dim">{c.format(v as number)}</span>
                </span>
                <input type="range" min={c.min} max={c.max} step={c.step} value={v as number} onChange={(e) => set(c.key, Math.round(Number(e.target.value) * 100) / 100)} className="accent-[#dc2645]" />
              </label>
            )
          return (
            <label key={c.key} className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium text-muted">{c.label}</span>
              {c.options.length <= 3 ? (
                <Segmented value={String(v)} onChange={(x) => set(c.key, x)} items={c.options.map((o) => ({ value: o.value, label: o.label }))} />
              ) : (
                <Select value={String(v)} onChange={(e) => set(c.key, e.target.value)}>
                  {c.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </label>
          )
        })}
      </Section>
      <Section title="Usage" right={<CopyText text={KIT_USAGE[name]} />}>
        <pre className="whitespace-pre-wrap break-all rounded-[10px] border border-line bg-panel p-2.5 font-mono text-[11px] leading-relaxed text-muted">{KIT_USAGE[name]}</pre>
      </Section>
    </div>
  )
}

function CopyText({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
      className="flex items-center gap-1 text-[11px] normal-case tracking-normal text-dim hover:text-fg"
    >
      <CopySimple size={12} /> {done ? 'Copied' : 'Copy'}
    </button>
  )
}

// ─── Layers ───────────────────────────────────────────────────────────────────

interface LayerNode {
  path: Path
  label: string
  text: string
  children: LayerNode[]
}

function tree(html: string): LayerNode[] {
  const doc = new DOMParser().parseFromString(`<body>${sanitizeComponentHtml(html)}</body>`, 'text/html')
  const walk = (el: Element, path: Path): LayerNode => ({
    path,
    label: describe(el),
    text: ownText(el).slice(0, 40),
    // An inline SVG is one layer; its shapes are not worth listing.
    children: el.tagName.toLowerCase() === 'svg' ? [] : [...el.children].map((c, i) => walk(c, [...path, i]))
  })
  return [...doc.body.children].map((c, i) => walk(c, [i]))
}

export function Layers({ html, block, selected, onSelect }: { html: string; block: string; selected: Path | null; onSelect(p: Path): void }) {

  const nodes = useMemo(() => tree(html), [html])
  const [closed, setClosed] = useState<Set<string>>(new Set())
  // Open the way down to the selection.
  useEffect(() => {
    if (!selected) return
    setClosed((cur) => {
      const next = new Set(cur)
      for (let i = 1; i < selected.length; i++) next.delete(selected.slice(0, i).join('.'))
      return next.size === cur.size ? cur : next
    })
  }, [selected])
  const row = (n: LayerNode, depth: number): ReactNode => {
    const id = n.path.join('.')
    const open = !closed.has(id)
    const on = samePath(n.path, selected)
    return (
      <div key={id}>
        <div
          onClick={() => onSelect(n.path)}
          ref={(el) => {
            if (on && el) el.scrollIntoView({ block: 'nearest' })
          }}
          className={clsx('flex h-7 cursor-pointer items-center gap-1 rounded-md pr-2 text-[12px]', on ? 'bg-crimson-soft text-fg' : 'text-muted hover:bg-elev')}
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          {n.children.length ? (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setClosed((cur) => {
                  const next = new Set(cur)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-dim"
              aria-label={open ? 'Collapse' : 'Expand'}
            >
              {open ? <CaretDown size={10} /> : <CaretRight size={10} />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="min-w-0 shrink truncate font-mono text-[11px]" title={n.label}>
            {stripBlock(n.label, block)}
          </span>
          {n.text && <span className="min-w-0 flex-1 truncate text-dim">{n.text}</span>}
        </div>
        {open && n.children.map((c) => row(c, depth + 1))}
      </div>
    )
  }
  return <div className="py-1">{nodes.map((n) => row(n, 0))}</div>
}

// ─── Element inspector ────────────────────────────────────────────────────────

type Kind = 'color' | 'space' | 'radius' | 'text' | 'weight' | 'leading' | 'tracking' | 'font' | 'shadow' | 'plain'
interface PropSpec {
  prop: string
  kind: Kind
  options?: string[]
  /** Only shown when the element lays out its children. */
  layout?: boolean
}

const GROUPS: { title: string; props: PropSpec[] }[] = [
  {
    title: 'Layout',
    props: [
      { prop: 'display', kind: 'plain', options: ['block', 'flex', 'inline-flex', 'grid', 'inline-block', 'inline', 'none'] },
      { prop: 'flex-direction', kind: 'plain', options: ['row', 'column'], layout: true },
      { prop: 'align-items', kind: 'plain', options: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'], layout: true },
      { prop: 'justify-content', kind: 'plain', options: ['flex-start', 'center', 'flex-end', 'space-between'], layout: true },
      { prop: 'gap', kind: 'space', layout: true },
      { prop: 'flex-wrap', kind: 'plain', options: ['nowrap', 'wrap'], layout: true }
    ]
  },
  { title: 'Spacing', props: [{ prop: 'padding', kind: 'space' }, { prop: 'margin', kind: 'space' }] },
  { title: 'Size', props: [{ prop: 'width', kind: 'plain' }, { prop: 'height', kind: 'plain' }, { prop: 'min-height', kind: 'plain' }, { prop: 'max-width', kind: 'plain' }] },
  {
    title: 'Text',
    props: [
      { prop: 'color', kind: 'color' },
      { prop: 'font-family', kind: 'font' },
      { prop: 'font-size', kind: 'text' },
      { prop: 'font-weight', kind: 'weight' },
      { prop: 'line-height', kind: 'leading' },
      { prop: 'letter-spacing', kind: 'tracking' },
      { prop: 'text-align', kind: 'plain', options: ['left', 'center', 'right'] },
      { prop: 'text-transform', kind: 'plain', options: ['none', 'uppercase', 'capitalize'] }
    ]
  },
  { title: 'Fill and border', props: [{ prop: 'background', kind: 'color' }, { prop: 'border', kind: 'plain' }, { prop: 'border-color', kind: 'color' }, { prop: 'border-radius', kind: 'radius' }] },
  { title: 'Effects', props: [{ prop: 'box-shadow', kind: 'shadow' }, { prop: 'opacity', kind: 'plain' }] }
]
const KNOWN = new Set(GROUPS.flatMap((g) => g.props.map((p) => p.prop)))
const TYPE_NAMES = ['display', 'h1', 'h2', 'h3', 'h4', 'body', 'small', 'caption']

function tokens(kind: Kind, input: DesignInput): string[] {
  const d = buildDesign(input)
  switch (kind) {
    case 'color':
      return [...(Object.keys(ROLE_INFO) as RoleName[]).map((k) => `var(--color-${kebab(k)})`), 'transparent', 'currentColor']
    case 'space':
      return d.space.map((_, i) => `var(--space-${i})`)
    case 'radius':
      return ['0', ...Object.keys(d.radii).map((k) => `var(--radius-${k})`)]
    case 'text':
      return TYPE_NAMES.map((t) => `var(--text-${t})`)
    case 'weight':
      return ['400', '500', '600', '700', '800', ...TYPE_NAMES.map((t) => `var(--weight-${t})`)]
    case 'leading':
      return TYPE_NAMES.map((t) => `var(--leading-${t})`)
    case 'tracking':
      return ['0', ...TYPE_NAMES.map((t) => `var(--tracking-${t})`)]
    case 'font':
      return ['var(--font-sans)', 'var(--font-heading)', 'var(--font-mono)']
    case 'shadow':
      return ['none', 'var(--shadow-sm)', 'var(--shadow-md)', 'var(--shadow-lg)']
    default:
      return []
  }
}

/** Rules that style this element at rest, and the ones for its states (hover, focus …). */
function matchingRules(css: string, el: Element): { rule: CssRule; states: string[] }[] {
  const out: { rule: CssRule; states: string[] }[] = []
  for (const rule of listRules(css)) {
    const states = new Set<string>()
    let hit = false
    for (const sel of rule.selectors) {
      const { base, states: st } = restingSelector(sel)
      try {
        if (el.matches(base)) {
          hit = true
          st.forEach((s) => states.add(s))
        }
      } catch {
        /* a selector the browser can't match (e.g. ::-webkit-…) */
      }
    }
    if (hit) out.push({ rule, states: [...states] })
  }
  return out
}

export function ElementInspector({
  comp,
  path,
  element,
  input,
  onCss,
  onHtml,
  onSelect
}: {
  comp: DesignComponent
  path: Path
  element: Element | null
  input: DesignInput
  onCss(css: string): void
  onHtml(html: string, path: Path | null): void
  onSelect(p: Path | null): void
}) {
  const matches = useMemo(() => (element ? matchingRules(comp.css, element) : []), [comp.css, element])
  const resting = matches.filter((m) => !m.states.length)
  const [ruleIndex, setRuleIndex] = useState<number | null>(null)
  // A new element: start on its most specific resting rule (the last one in the sheet).
  useEffect(() => setRuleIndex(resting.at(-1)?.rule.index ?? matches.at(-1)?.rule.index ?? null), [path.join('.'), comp.id])
  const current = matches.find((m) => m.rule.index === ruleIndex) ?? null
  const computed = element ? element.ownerDocument.defaultView?.getComputedStyle(element) : null
  const classes = element ? [...element.classList] : []
  const [newClass, setNewClass] = useState('')

  if (!element) return <div className="px-4 py-6 text-[12px] text-dim">Select an element on the canvas or in the layers.</div>

  const set = (prop: string, value: string | null) => {
    if (!current) return
    onCss(setDeclaration(comp.css, current.rule.index, prop, value))
  }
  const createRule = () => {
    let cls = classes.find((c) => !c.startsWith('is-') && !c.startsWith('specimen'))
    let html = comp.html
    if (!cls) {
      cls = `c-${componentSlug(comp.name)}__${element.tagName.toLowerCase()}`
      html = setClasses(comp.html, path, [...classes, cls])
    }
    const { css, index } = ensureRule(comp.css, `.${cls}`)
    if (html !== comp.html) onHtml(html, path)
    onCss(css)
    setRuleIndex(index)
  }
  const display = computed?.display ?? ''
  const lays = /flex|grid/.test(display)
  const simpleText = element.children.length === 0 && !!element.textContent?.trim()

  return (
    <div>
      <Section title="Element">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg" title={describe(element)}>{shortLabel(element, comp.name)}</span>
          <IconAction title="Select parent (Esc)" disabled={path.length <= 1} onClick={() => onSelect(path.slice(0, -1))}>
            <ArrowElbowLeftUp size={14} />
          </IconAction>
          <IconAction title="Move up" disabled={path[path.length - 1] === 0} onClick={() => (({ html, path: p }) => onHtml(html, p))(moveElement(comp.html, path, -1))}>
            <ArrowUp size={14} />
          </IconAction>
          <IconAction title="Move down" disabled={!element.nextElementSibling} onClick={() => (({ html, path: p }) => onHtml(html, p))(moveElement(comp.html, path, 1))}>
            <ArrowDown size={14} />
          </IconAction>
          <IconAction title="Duplicate" onClick={() => onHtml(duplicateElement(comp.html, path), [...path.slice(0, -1), path[path.length - 1] + 1])}>
            <Copy size={14} />
          </IconAction>
          <IconAction title="Delete (Del)" onClick={() => onHtml(removeElement(comp.html, path), null)}>
            <Trash size={14} />
          </IconAction>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {classes.map((c) => (
            <span key={c} className="flex items-center gap-1 rounded-md border border-line bg-panel py-0.5 pl-1.5 pr-0.5 font-mono text-[11px] text-muted">
              .{c}
              <button onClick={() => onHtml(setClasses(comp.html, path, classes.filter((x) => x !== c)), path)} className="flex h-4 w-4 items-center justify-center rounded text-dim hover:text-fg" aria-label={`Remove class ${c}`}>
                <X size={9} weight="bold" />
              </button>
            </span>
          ))}
          <input
            value={newClass}
            onChange={(e) => setNewClass(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newClass) {
                onHtml(setClasses(comp.html, path, [...new Set([...classes, newClass])]), path)
                setNewClass('')
              }
            }}
            placeholder="+ class"
            aria-label="Add a class"
            className="h-6 w-20 rounded-md bg-transparent px-1.5 font-mono text-[11px] outline-none placeholder:text-dim focus:bg-panel"
          />
        </div>
        {simpleText && <TextField key={path.join('.')} value={element.textContent ?? ''} onCommit={(t) => onHtml(setInnerHtml(comp.html, path, escapeHtml(t)), path)} />}
        <div className="text-[11px] text-dim">Double-click text on the canvas to edit it in place.</div>
      </Section>

      <Section title="Style rule">
        {matches.length ? (
          <Select value={String(ruleIndex ?? '')} onChange={(e) => setRuleIndex(Number(e.target.value))}>
            {matches.map((m) => (
              <option key={m.rule.index} value={m.rule.index}>
                {m.rule.selector.replace(/\s+/g, ' ').slice(0, 60)}
                {m.states.length ? ` · ${m.states.join(', ')}` : ''}
                {m.rule.context ? ` · ${m.rule.context}` : ''}
              </option>
            ))}
          </Select>
        ) : (
          <div className="text-[12px] text-dim">No rule styles this element yet.</div>
        )}
        <button onClick={createRule} className="flex items-center gap-1 text-[11.5px] text-dim hover:text-fg">
          <Plus size={11} /> {classes.some((c) => !c.startsWith('is-')) ? `Rule for .${classes.find((c) => !c.startsWith('is-'))}` : 'Give it a class and a rule'}
        </button>
      </Section>

      {current &&
        GROUPS.map((g) => {
          const props = g.props.filter((p) => !p.layout || lays || current.rule.decls.some((d) => d.prop === p.prop))
          return (
            <Section key={g.title} title={g.title}>
              {props.map((p) => (
                <PropRow key={`${current.rule.index}:${p.prop}`} spec={p} input={input} value={current.rule.decls.findLast((d) => d.prop === p.prop)?.value ?? null} computed={computed?.getPropertyValue(p.prop) ?? ''} onChange={(v) => set(p.prop, v)} />
              ))}
            </Section>
          )
        })}
      {current && (
        <Section title="Other properties">
          {current.rule.decls
            .filter((d) => !KNOWN.has(d.prop))
            .map((d, i) => (
              <PropRow key={`${current.rule.index}:${d.prop}:${i}`} spec={{ prop: d.prop, kind: 'plain' }} input={input} value={d.value} computed="" onChange={(v) => set(d.prop, v)} />
            ))}
          <AddProperty onAdd={(prop, value) => set(prop, value)} />
        </Section>
      )}
    </div>
  )
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function TextField({ value, onCommit }: { value: string; onCommit(v: string): void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <textarea
      value={text}
      rows={Math.min(4, Math.max(1, Math.ceil(text.length / 34)))}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      aria-label="Text"
      className="w-full resize-none rounded-[8px] border border-line bg-panel px-2 py-1.5 text-[12.5px] outline-none focus:border-crimson-line"
    />
  )
}

function IconAction({ title, onClick, disabled, children }: { title: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <button title={title} aria-label={title} disabled={disabled} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-elev-2 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}

function PropRow({ spec, input, value, computed, onChange }: { spec: PropSpec; input: DesignInput; value: string | null; computed: string; onChange(v: string | null): void }) {
  const missing = value ? unknownTokens(`a{x:${value}}`, '', input) : []
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const list = spec.options ?? tokens(spec.kind, input)
  const id = `dl-${spec.kind}-${spec.options ? spec.prop : 'tok'}`
  const literal = (value ? componentLint(`a{x:${value}}`, '').length > 0 : false) || missing.length > 0
  const commit = () => {
    const v = text.trim()
    if (v === (value ?? '')) return
    onChange(v || null)
  }
  return (
    <div className="flex items-center gap-2">
      <span className={clsx('w-[92px] shrink-0 truncate font-mono text-[11px]', value ? 'text-fg' : 'text-dim')} title={spec.prop}>
        {spec.prop}
      </span>
      <div className={clsx('flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-panel px-1.5', literal ? 'border-warn/60' : 'border-line focus-within:border-crimson-line')}>
        {spec.kind === 'color' && <span className="h-3.5 w-3.5 shrink-0 rounded-[3px] border border-line-strong" style={{ background: computed || 'transparent' }} />}
        <input
          value={text}
          list={id}
          spellCheck={false}
          placeholder={computed.length < 28 ? computed : ''}
          onChange={(e) => {
            setText(e.target.value)
            // Picking from the list commits straight away.
            if (list.includes(e.target.value)) onChange(e.target.value)
          }}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label={spec.prop}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11px] outline-none placeholder:text-dim/70"
        />
        {literal && (
          <span title={missing.length ? `${missing.join(', ')} is not defined in this system` : 'A literal colour, not a token'} className="flex shrink-0">
            <Warning size={12} weight="fill" className="text-warn" aria-label={missing.length ? 'Unknown token' : 'Not a token'} />
          </span>
        )}
        {value && (
          <button onClick={() => onChange(null)} className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-dim hover:text-fg" aria-label={`Remove ${spec.prop}`}>
            <X size={9} weight="bold" />
          </button>
        )}
      </div>
      <datalist id={id}>
        {list.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  )
}

function AddProperty({ onAdd }: { onAdd(prop: string, value: string): void }) {
  const [prop, setProp] = useState('')
  const [value, setValue] = useState('')
  const add = () => {
    if (!/^-{0,2}[a-z][a-z0-9-]*$/.test(prop.trim()) || !value.trim()) return
    onAdd(prop.trim(), value.trim())
    setProp('')
    setValue('')
  }
  return (
    <div className="flex items-center gap-2">
      <input value={prop} onChange={(e) => setProp(e.target.value)} placeholder="property" aria-label="New property" className="h-7 w-[92px] rounded-md border border-line bg-panel px-1.5 font-mono text-[11px] outline-none focus:border-crimson-line" />
      <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="value" aria-label="New value" className="h-7 min-w-0 flex-1 rounded-md border border-line bg-panel px-1.5 font-mono text-[11px] outline-none focus:border-crimson-line" />
      <Button size="sm" onClick={add} disabled={!prop || !value}>
        Add
      </Button>
    </div>
  )
}

// ─── Component (nothing selected inside it) ───────────────────────────────────

export function ComponentInspector({
  comp,
  input,
  onRepair,
  busy,
  canAi,
  onRename,
  onDescribe,
  onFixLint,
  onEditCode,
  onUndo,
  onDelete
}: {
  comp: DesignComponent
  input: DesignInput
  onRepair(css: string): void
  busy: boolean
  canAi: boolean
  onRename(name: string): void
  onDescribe(text: string): void
  onFixLint(colours: string[], unknown: string[]): void
  onEditCode(): void
  onUndo(): void
  onDelete(): void
}) {
  const lint = useMemo(() => componentLint(comp.css, comp.html), [comp.css, comp.html])
  const unknown = useMemo(() => unknownTokens(comp.css, comp.html, input), [comp.css, comp.html, input])
  const repaired = useMemo(() => repairTokens(comp.css), [comp.css])
  return (
    <div>
      <Section title="Component">
        <input key={comp.name} defaultValue={comp.name} onBlur={(e) => e.target.value.trim() && e.target.value !== comp.name && onRename(e.target.value.trim())} aria-label="Component name" className="w-full bg-transparent text-[15px] font-semibold outline-none" />
        <textarea
          key={comp.description}
          defaultValue={comp.description}
          rows={2}
          onBlur={(e) => e.target.value !== comp.description && onDescribe(e.target.value)}
          placeholder="What it is for"
          aria-label="Description"
          className="w-full resize-none bg-transparent text-[12px] text-muted outline-none placeholder:text-dim"
        />
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon={<Code size={13} />} onClick={onEditCode}>
            Code
          </Button>
          <Button size="sm" disabled={!comp.history.length} onClick={onUndo} title={comp.history.length ? `Back to: ${comp.history[0].prompt.slice(0, 60)}` : 'No earlier version'}>
            Undo
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash size={13} />} onClick={onDelete}>
            Delete
          </Button>
        </div>
      </Section>
      {(lint.length > 0 || unknown.length > 0) && (
        <Section title="Check">
          {lint.length > 0 && (
            <div className="flex items-start gap-2 text-[12px] text-warn">
              <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
              <span>
                {lint.length} colour{lint.length === 1 ? '' : 's'} bypass the tokens: <span className="font-mono">{lint.slice(0, 4).join(', ')}</span>
              </span>
            </div>
          )}
          {unknown.length > 0 && (
            <div className="flex items-start gap-2 text-[12px] text-warn">
              <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
              <span>
                {unknown.length} variable{unknown.length === 1 ? " isn't" : "s aren't"} in this system, so the styles using {unknown.length === 1 ? 'it' : 'them'} are ignored: <span className="font-mono">{unknown.slice(0, 4).join(', ')}</span>
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {repaired !== comp.css && (
              <Button size="sm" onClick={() => onRepair(repaired)} title="Replace named weights like --weight-bold with numbers">
                Fix weights
              </Button>
            )}
            <Button size="sm" disabled={busy || !canAi} onClick={() => onFixLint(lint, unknown)}>
              Fix with AI
            </Button>
          </div>
        </Section>
      )}
      <Section title="Edit">
        <ul className="list-disc space-y-1 pl-4 text-[12px] text-dim">
          <li>Click an element on the canvas, or pick it in Layers, to style it.</li>
          <li>Double-click text to change it in place.</li>
          <li>Ask for bigger changes in the bar below the canvas; with an element selected, only that part changes.</li>
        </ul>
      </Section>
    </div>
  )
}

