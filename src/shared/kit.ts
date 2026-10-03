// The built-in component kit: a fixed set of components every design system has, styled only from the
// system's tokens and tuned with typed settings (rather than free-form code like AI components).

export type KitName = 'button' | 'input' | 'card' | 'badge' | 'tabs' | 'alert' | 'menu'
export type RadiusToken = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full'
export type ShadowToken = 'none' | 'sm' | 'md' | 'lg'

export interface KitSettings {
  button: { radius: RadiusToken; size: 'sm' | 'md' | 'lg'; weight: number; textCase: 'none' | 'uppercase'; tracking: number; primary: 'solid' | 'soft' | 'outline'; shadow: ShadowToken }
  input: { radius: RadiusToken; style: 'outline' | 'filled' | 'underline'; fill: 'background' | 'surface'; focus: 'ring' | 'border'; labelWeight: number }
  card: { radius: RadiusToken; padding: number; border: boolean; shadow: ShadowToken; surface: 'surface' | 'background' | 'raised'; dividers: boolean }
  badge: { radius: RadiusToken; style: 'soft' | 'solid' | 'outline'; weight: number; textCase: 'none' | 'uppercase' }
  tabs: { style: 'underline' | 'pills' | 'segmented'; indicator: 'primary' | 'text'; weight: number }
  alert: { style: 'soft' | 'outline' | 'bar'; radius: RadiusToken; icon: boolean }
  menu: { radius: RadiusToken; shadow: ShadowToken; highlight: 'primary-soft' | 'surface-raised'; density: 'compact' | 'comfortable' }
}

export const KIT_NAMES: KitName[] = ['button', 'input', 'card', 'badge', 'tabs', 'alert', 'menu']

export const DEFAULT_KIT: KitSettings = {
  button: { radius: 'md', size: 'md', weight: 600, textCase: 'none', tracking: 0, primary: 'solid', shadow: 'none' },
  input: { radius: 'md', style: 'outline', fill: 'background', focus: 'ring', labelWeight: 500 },
  card: { radius: 'lg', padding: 6, border: true, shadow: 'sm', surface: 'surface', dividers: false },
  badge: { radius: 'full', style: 'soft', weight: 600, textCase: 'none' },
  tabs: { style: 'underline', indicator: 'primary', weight: 600 },
  alert: { style: 'soft', radius: 'md', icon: true },
  menu: { radius: 'md', shadow: 'md', highlight: 'primary-soft', density: 'comfortable' }
}

type Option = { value: string; label: string }
export type KitControl =
  | { key: string; label: string; type: 'select'; options: Option[] }
  | { key: string; label: string; type: 'slider'; min: number; max: number; step: number; format(v: number): string }
  | { key: string; label: string; type: 'switch' }

const RADIUS: Option[] = [
  { value: 'none', label: 'Square' },
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
  { value: 'xl', label: 'X-large' },
  { value: 'full', label: 'Pill' }
]
const SHADOW: Option[] = [
  { value: 'none', label: 'None' },
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' }
]
const WEIGHT = (key: string, label = 'Weight'): KitControl => ({ key, label, type: 'slider', min: 400, max: 800, step: 100, format: (v) => ({ 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extrabold' })[v] ?? String(v) })
const CASE = (key: string): KitControl => ({ key, label: 'Letter case', type: 'select', options: [{ value: 'none', label: 'As written' }, { value: 'uppercase', label: 'UPPERCASE' }] })

export const KIT: Record<KitName, { label: string; description: string; controls: KitControl[] }> = {
  button: {
    label: 'Button',
    description: 'Primary, secondary, ghost and danger actions in three sizes',
    controls: [
      { key: 'primary', label: 'Primary style', type: 'select', options: [{ value: 'solid', label: 'Solid' }, { value: 'soft', label: 'Soft' }, { value: 'outline', label: 'Outline' }] },
      { key: 'radius', label: 'Corners', type: 'select', options: RADIUS },
      { key: 'size', label: 'Default size', type: 'select', options: [{ value: 'sm', label: 'Small' }, { value: 'md', label: 'Medium' }, { value: 'lg', label: 'Large' }] },
      WEIGHT('weight'),
      CASE('textCase'),
      { key: 'tracking', label: 'Letter spacing', type: 'slider', min: -0.02, max: 0.1, step: 0.01, format: (v) => (v === 0 ? 'normal' : `${v > 0 ? '+' : ''}${v.toFixed(2)}em`) },
      { key: 'shadow', label: 'Shadow', type: 'select', options: SHADOW }
    ]
  },
  input: {
    label: 'Input',
    description: 'Text fields, selects and text areas with label, hint and error',
    controls: [
      { key: 'style', label: 'Style', type: 'select', options: [{ value: 'outline', label: 'Outline' }, { value: 'filled', label: 'Filled' }, { value: 'underline', label: 'Underline' }] },
      { key: 'fill', label: 'Background', type: 'select', options: [{ value: 'background', label: 'Page' }, { value: 'surface', label: 'Surface' }] },
      { key: 'radius', label: 'Corners', type: 'select', options: RADIUS },
      { key: 'focus', label: 'Focus', type: 'select', options: [{ value: 'ring', label: 'Ring' }, { value: 'border', label: 'Border only' }] },
      WEIGHT('labelWeight', 'Label weight')
    ]
  },
  card: {
    label: 'Card',
    description: 'Panels with an optional header, body and footer',
    controls: [
      { key: 'surface', label: 'Fill', type: 'select', options: [{ value: 'surface', label: 'Surface' }, { value: 'background', label: 'Page' }, { value: 'raised', label: 'Raised' }] },
      { key: 'radius', label: 'Corners', type: 'select', options: RADIUS },
      { key: 'padding', label: 'Padding', type: 'slider', min: 3, max: 10, step: 1, format: (v) => `space-${v}` },
      { key: 'border', label: 'Border', type: 'switch' },
      { key: 'shadow', label: 'Shadow', type: 'select', options: SHADOW },
      { key: 'dividers', label: 'Header and footer dividers', type: 'switch' }
    ]
  },
  badge: {
    label: 'Badge',
    description: 'Small status and category labels',
    controls: [
      { key: 'style', label: 'Style', type: 'select', options: [{ value: 'soft', label: 'Soft' }, { value: 'solid', label: 'Solid' }, { value: 'outline', label: 'Outline' }] },
      { key: 'radius', label: 'Corners', type: 'select', options: RADIUS },
      WEIGHT('weight'),
      CASE('textCase')
    ]
  },
  tabs: {
    label: 'Tabs',
    description: 'Switch between views of the same thing',
    controls: [
      { key: 'style', label: 'Style', type: 'select', options: [{ value: 'underline', label: 'Underline' }, { value: 'pills', label: 'Pills' }, { value: 'segmented', label: 'Segmented' }] },
      { key: 'indicator', label: 'Active colour', type: 'select', options: [{ value: 'primary', label: 'Primary' }, { value: 'text', label: 'Text' }] },
      WEIGHT('weight', 'Active weight')
    ]
  },
  alert: {
    label: 'Alert',
    description: 'Inline messages for info, success, warning and errors',
    controls: [
      { key: 'style', label: 'Style', type: 'select', options: [{ value: 'soft', label: 'Soft tint' }, { value: 'outline', label: 'Outline' }, { value: 'bar', label: 'Side bar' }] },
      { key: 'radius', label: 'Corners', type: 'select', options: RADIUS },
      { key: 'icon', label: 'Icon', type: 'switch' }
    ]
  },
  menu: {
    label: 'Menu',
    description: 'Dropdown and context menus',
    controls: [
      { key: 'highlight', label: 'Hover row', type: 'select', options: [{ value: 'primary-soft', label: 'Primary tint' }, { value: 'surface-raised', label: 'Neutral' }] },
      { key: 'radius', label: 'Corners', type: 'select', options: RADIUS },
      { key: 'shadow', label: 'Shadow', type: 'select', options: SHADOW },
      { key: 'density', label: 'Density', type: 'select', options: [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }] }
    ]
  }
}

/** Valid settings for every kit component; unknown keys and out-of-range values fall back. */
export function sanitizeKit(raw: unknown, base: KitSettings = DEFAULT_KIT): KitSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, Record<string, unknown>>) : {}
  const out = {} as Record<KitName, Record<string, unknown>>
  for (const name of KIT_NAMES) {
    const cur = { ...(DEFAULT_KIT[name] as Record<string, unknown>), ...((base[name] ?? {}) as Record<string, unknown>) }
    const given = src[name] && typeof src[name] === 'object' ? src[name] : {}
    for (const c of KIT[name].controls) {
      const v = given[c.key]
      if (v === undefined) continue
      if (c.type === 'select' && typeof v === 'string' && c.options.some((o) => o.value === v)) cur[c.key] = v
      if (c.type === 'switch' && typeof v === 'boolean') cur[c.key] = v
      if (c.type === 'slider' && typeof v === 'number' && Number.isFinite(v)) cur[c.key] = Math.min(c.max, Math.max(c.min, Math.round(v / c.step) * c.step))
    }
    // Floating-point steps (0.01em) drift; keep two decimals.
    for (const [k, v] of Object.entries(cur)) if (typeof v === 'number') cur[k] = Math.round(v * 100) / 100
    out[name] = cur
  }
  return out as unknown as KitSettings
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

const radius = (r: RadiusToken) => (r === 'none' ? '0' : `var(--radius-${r})`)
const shadow = (s: ShadowToken) => (s === 'none' ? 'none' : `var(--shadow-${s})`)
const tint = (role: string, pct: number, over = 'var(--color-surface)') => `color-mix(in oklab, var(--color-${role}) ${pct}%, ${over})`
const STATUS = ['success', 'warning', 'danger'] as const
const focusRing = 'outline: 2px solid var(--color-focus); outline-offset: 2px;'

function buttonCss(s: KitSettings['button']): string {
  const h = { sm: 'calc(var(--control-height) - 8px)', md: 'var(--control-height)', lg: 'calc(var(--control-height) + 8px)' }
  const pad = { sm: 'var(--space-3)', md: 'var(--space-4)', lg: 'var(--space-5)' }
  const primary = {
    solid: ['background: var(--color-primary); color: var(--color-on-primary);', 'background: var(--color-primary-hover);'],
    soft: ['background: var(--color-primary-soft); color: var(--color-on-primary-soft);', `background: ${tint('primary', 22, 'var(--color-primary-soft)')};`],
    outline: ['background: transparent; color: var(--color-primary); border-color: var(--color-primary);', 'background: var(--color-primary-soft); color: var(--color-on-primary-soft);']
  }[s.primary]
  const size = (k: 'sm' | 'md' | 'lg') => `height: ${h[k]}; padding: 0 ${pad[k]}; font-size: ${k === 'lg' ? 'var(--text-body)' : 'var(--text-small)'};`
  return `.ds-button { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); ${size(s.size)} border: 1px solid transparent; border-radius: ${radius(s.radius)}; font-family: var(--font-sans); font-weight: ${s.weight}; line-height: 1; letter-spacing: ${s.tracking}em; text-transform: ${s.textCase}; text-decoration: none; white-space: nowrap; cursor: pointer; box-shadow: ${shadow(s.shadow)}; transition: background-color .15s, border-color .15s, color .15s; background: var(--color-surface); color: var(--color-text); border-color: var(--color-border); }
.ds-button svg { width: 16px; height: 16px; flex-shrink: 0; }
.ds-button:focus-visible, .ds-button.is-focus { ${focusRing} }
.ds-button--sm { ${size('sm')} }
.ds-button--md { ${size('md')} }
.ds-button--lg { ${size('lg')} }
.ds-button--primary { ${primary[0]}${s.primary === 'outline' ? '' : ' border-color: transparent;'} }
.ds-button--primary:hover, .ds-button--primary.is-hover { ${primary[1]} }
.ds-button--secondary { background: var(--color-surface); color: var(--color-text); border-color: var(--color-border); }
.ds-button--secondary:hover, .ds-button--secondary.is-hover { border-color: var(--color-border-strong); background: var(--color-surface-raised); }
.ds-button--ghost { background: transparent; color: var(--color-text-muted); border-color: transparent; box-shadow: none; }
.ds-button--ghost:hover, .ds-button--ghost.is-hover { background: var(--color-surface-raised); color: var(--color-text); }
.ds-button--danger { background: var(--color-danger); color: var(--color-on-danger); border-color: transparent; }
.ds-button--danger:hover, .ds-button--danger.is-hover { background: color-mix(in oklab, var(--color-danger) 88%, black); }
.ds-button--icon { padding: 0; aspect-ratio: 1; }
.ds-button:disabled, .ds-button.is-disabled { opacity: .5; cursor: not-allowed; }
`
}

function inputCss(s: KitSettings['input']): string {
  const fill = s.fill === 'surface' ? 'var(--color-surface)' : 'var(--color-background)'
  const look = {
    outline: `background: ${fill}; border: 1px solid var(--color-border); border-radius: ${radius(s.radius)};`,
    filled: `background: var(--color-surface-raised); border: 1px solid transparent; border-radius: ${radius(s.radius)};`,
    underline: 'background: transparent; border: 0; border-bottom: 1px solid var(--color-border-strong); border-radius: 0; padding-left: 0; padding-right: 0;'
  }[s.style]
  const focus = s.focus === 'ring' ? `border-color: var(--color-primary); ${focusRing}` : `border-color: var(--color-primary); outline: none; box-shadow: inset 0 0 0 1px var(--color-primary);`
  return `.ds-field { display: grid; gap: var(--space-2); }
.ds-label { font-size: var(--text-small); font-weight: ${s.labelWeight}; color: var(--color-text-muted); }
.ds-hint { font-size: var(--text-caption); color: var(--color-text-subtle); }
.ds-error { font-size: var(--text-caption); color: var(--color-danger); }
.ds-input { width: 100%; min-height: var(--control-height); padding: 0 var(--space-3); ${look} color: var(--color-text); font-family: var(--font-sans); font-size: var(--text-small); line-height: var(--leading-small); transition: border-color .15s, box-shadow .15s; }
textarea.ds-input { padding-top: var(--space-2); padding-bottom: var(--space-2); min-height: calc(var(--control-height) * 2.4); resize: vertical; }
.ds-input::placeholder { color: var(--color-text-subtle); }
.ds-input:hover, .ds-input.is-hover { border-color: var(--color-border-strong); }
.ds-input:focus, .ds-input:focus-visible, .ds-input.is-focus { ${focus} }
.ds-input[aria-invalid='true'], .ds-input.is-invalid { border-color: var(--color-danger); }
.ds-input:disabled, .ds-input.is-disabled { opacity: .55; cursor: not-allowed; }
`
}

function cardCss(s: KitSettings['card']): string {
  const fill = { surface: 'var(--color-surface)', background: 'var(--color-background)', raised: 'var(--color-surface-raised)' }[s.surface]
  const pad = `var(--space-${s.padding})`
  const divider = s.dividers ? 'border-bottom: 1px solid var(--color-border);' : ''
  return `.ds-card { background: ${fill}; color: var(--color-text); border: ${s.border ? '1px solid var(--color-border)' : '0'}; border-radius: ${radius(s.radius)}; box-shadow: ${shadow(s.shadow)}; padding: ${pad}; display: grid; gap: var(--space-3); }
.ds-card--flush { padding: 0; gap: 0; overflow: hidden; }
.ds-card__header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); ${s.dividers ? `margin: calc(${pad} * -1) calc(${pad} * -1) 0; padding: var(--space-4) ${pad}; ${divider}` : ''} }
.ds-card__title { margin: 0; font-family: var(--font-heading); font-size: var(--text-h4); line-height: var(--leading-h4); font-weight: var(--weight-h4); letter-spacing: var(--tracking-h4); }
.ds-card__meta { font-size: var(--text-small); color: var(--color-text-muted); }
.ds-card__body { color: var(--color-text-muted); font-size: var(--text-body); }
.ds-card__footer { display: flex; gap: var(--space-2); justify-content: flex-end; ${s.dividers ? `margin: 0 calc(${pad} * -1) calc(${pad} * -1); padding: var(--space-3) ${pad}; border-top: 1px solid var(--color-border);` : ''} }
.ds-card--interactive { cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.ds-card--interactive:hover, .ds-card--interactive.is-hover { border-color: var(--color-border-strong); box-shadow: var(--shadow-md); }
`
}

function badgeCss(s: KitSettings['badge']): string {
  const base = `.ds-badge { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: ${radius(s.radius)}; font-family: var(--font-sans); font-size: var(--text-caption); font-weight: ${s.weight}; text-transform: ${s.textCase}; letter-spacing: ${s.textCase === 'uppercase' ? '.04em' : '0'}; line-height: 1; white-space: nowrap; border: 1px solid var(--color-border); background: var(--color-surface-raised); color: var(--color-text-muted); }
.ds-badge--dot::before { content: ''; width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
`
  // Status colours have no on- role: their text stays --color-text, the colour shows in a dot and the tint.
  const status = STATUS.map((r) => {
    const look = s.style === 'outline' ? `background: transparent; border-color: var(--color-${r}); color: var(--color-text);` : `background: ${tint(r, s.style === 'solid' ? 26 : 14)}; border-color: transparent; color: var(--color-text);`
    return `.ds-badge--${r} { ${look} }\n.ds-badge--${r}::before { content: ''; width: 6px; height: 6px; border-radius: 999px; background: var(--color-${r}); }`
  }).join('\n')
  const brand = {
    soft: ['background: var(--color-primary-soft); color: var(--color-on-primary-soft); border-color: transparent;', 'background: var(--color-accent-soft); color: var(--color-on-accent-soft); border-color: transparent;'],
    solid: ['background: var(--color-primary); color: var(--color-on-primary); border-color: transparent;', 'background: var(--color-accent); color: var(--color-on-accent); border-color: transparent;'],
    outline: ['background: transparent; color: var(--color-primary); border-color: var(--color-primary);', 'background: transparent; color: var(--color-text); border-color: var(--color-accent);']
  }[s.style]
  return `${base}.ds-badge--primary { ${brand[0]} }\n.ds-badge--accent { ${brand[1]} }\n${status}\n`
}

function tabsCss(s: KitSettings['tabs']): string {
  const active = s.indicator === 'primary' ? 'var(--color-primary)' : 'var(--color-text)'
  const common = `.ds-tab { appearance: none; background: none; border: 0; font-family: var(--font-sans); font-size: var(--text-small); color: var(--color-text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-2); white-space: nowrap; }
.ds-tab:hover, .ds-tab.is-hover { color: var(--color-text); }
.ds-tab:focus-visible, .ds-tab.is-focus { ${focusRing} }
.ds-tab__count { font-size: var(--text-caption); color: var(--color-text-subtle); }
`
  if (s.style === 'underline')
    return `.ds-tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--color-border); }
${common}.ds-tab { padding: var(--space-3) var(--space-3); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.ds-tab.is-active, .ds-tab[aria-selected='true'] { color: var(--color-text); font-weight: ${s.weight}; border-bottom-color: ${active}; }
`
  if (s.style === 'pills')
    return `.ds-tabs { display: flex; gap: var(--space-1); }
${common}.ds-tab { padding: var(--space-2) var(--space-3); border-radius: var(--radius-full); }
.ds-tab.is-active, .ds-tab[aria-selected='true'] { font-weight: ${s.weight}; ${s.indicator === 'primary' ? 'background: var(--color-primary-soft); color: var(--color-on-primary-soft);' : 'background: var(--color-surface-raised); color: var(--color-text);'} }
`
  return `.ds-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--color-surface-raised); border: 1px solid var(--color-border); }
${common}.ds-tab { padding: var(--space-2) var(--space-3); border-radius: calc(var(--radius-md) - 2px); }
.ds-tab.is-active, .ds-tab[aria-selected='true'] { font-weight: ${s.weight}; background: var(--color-background); color: ${s.indicator === 'primary' ? 'var(--color-primary)' : 'var(--color-text)'}; box-shadow: var(--shadow-sm); }
`
}

function alertCss(s: KitSettings['alert']): string {
  const roles = [['info', 'primary'], ...STATUS.map((r) => [r, r])] as const
  const look = (role: string) =>
    ({
      soft: `background: ${tint(role, 12)}; border: 1px solid ${tint(role, 35)};`,
      outline: `background: var(--color-surface); border: 1px solid var(--color-${role});`,
      bar: `background: var(--color-surface); border: 1px solid var(--color-border); border-left: 3px solid var(--color-${role});`
    })[s.style]
  return `.ds-alert { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3) var(--space-4); border-radius: ${radius(s.radius)}; color: var(--color-text); font-size: var(--text-small); line-height: var(--leading-small); }
.ds-alert__icon { ${s.icon ? 'display: inline-flex;' : 'display: none;'} width: 18px; height: 18px; flex-shrink: 0; margin-top: 1px; }
.ds-alert__title { font-weight: 600; margin: 0 0 2px; }
.ds-alert__body { color: var(--color-text-muted); }
${roles.map(([name, role]) => `.ds-alert--${name} { ${look(role)} }\n.ds-alert--${name} .ds-alert__icon { color: var(--color-${role}); }`).join('\n')}
`
}

function menuCss(s: KitSettings['menu']): string {
  const pad = s.density === 'compact' ? 'var(--space-1) var(--space-2)' : 'var(--space-2) var(--space-3)'
  const hl = s.highlight === 'primary-soft' ? 'background: var(--color-primary-soft); color: var(--color-on-primary-soft);' : 'background: var(--color-surface-raised); color: var(--color-text);'
  return `.ds-menu { display: grid; gap: 1px; min-width: 200px; padding: var(--space-1); background: ${s.highlight === 'surface-raised' ? 'var(--color-surface)' : 'var(--color-surface-raised)'}; border: 1px solid var(--color-border); border-radius: ${radius(s.radius)}; box-shadow: ${shadow(s.shadow)}; font-size: var(--text-small); }
.ds-menu__label { padding: ${pad}; font-size: var(--text-caption); font-weight: 600; color: var(--color-text-subtle); }
.ds-menu__item { display: flex; align-items: center; gap: var(--space-2); padding: ${pad}; border-radius: ${s.radius === 'none' ? '0' : 'var(--radius-sm)'}; color: var(--color-text); background: none; border: 0; font: inherit; text-align: left; cursor: pointer; }
.ds-menu__item:hover, .ds-menu__item.is-active { ${hl} }
.ds-menu__item:focus-visible { ${focusRing} }
.ds-menu__shortcut { margin-left: auto; font-size: var(--text-caption); color: var(--color-text-subtle); }
.ds-menu__item--danger { color: var(--color-danger); }
.ds-menu__sep { height: 1px; margin: var(--space-1) 0; background: var(--color-border); }
`
}

const CSS: { [K in KitName]: (s: KitSettings[K]) => string } = { button: buttonCss, input: inputCss, card: cardCss, badge: badgeCss, tabs: tabsCss, alert: alertCss, menu: menuCss }

export function kitComponentCss(name: KitName, kit: KitSettings): string {
  return (CSS[name] as (s: KitSettings[KitName]) => string)(kit[name])
}

/** The whole kit's styles (components.css starts with these). */
export function kitCss(kit: KitSettings): string {
  return KIT_NAMES.map((n) => `/* ── ${KIT[n].label} (built-in) ── */\n${kitComponentCss(n, kit)}`).join('\n')
}

// ─── Specimens and usage ──────────────────────────────────────────────────────

const ICON = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  info: '<svg class="ds-alert__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  check: '<svg class="ds-alert__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  warn: '<svg class="ds-alert__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>',
  x: '<svg class="ds-alert__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>'
}
const section = (label: string, body: string) => `<section class="specimen-section">\n  <div class="specimen-label">${label}</div>\n  <div class="specimen-row">${body}</div>\n</section>`

const SPECIMENS: Record<KitName, string> = {
  button: [
    section('Variants', '<button class="ds-button ds-button--primary">Save changes</button><button class="ds-button ds-button--secondary">Cancel</button><button class="ds-button ds-button--ghost">Skip</button><button class="ds-button ds-button--danger">Delete</button>'),
    section('Sizes', `<button class="ds-button ds-button--primary ds-button--sm">Small</button><button class="ds-button ds-button--primary ds-button--md">Medium</button><button class="ds-button ds-button--primary ds-button--lg">Large</button><button class="ds-button ds-button--secondary ds-button--icon" aria-label="Add">${ICON.plus}</button>`),
    section('States', `<button class="ds-button ds-button--primary is-hover">Hover</button><button class="ds-button ds-button--primary is-focus">Focus</button><button class="ds-button ds-button--primary" disabled>Disabled</button><button class="ds-button ds-button--secondary">${ICON.plus} With icon</button>`)
  ].join('\n'),
  input: [
    section('Field', '<label class="ds-field" style="width:280px"><span class="ds-label">Project name</span><input class="ds-input" placeholder="e.g. Billing service"><span class="ds-hint">Shown in the sidebar.</span></label>'),
    section('States', '<label class="ds-field" style="width:220px"><span class="ds-label">Focused</span><input class="ds-input is-focus" value="api-gateway"></label><label class="ds-field" style="width:220px"><span class="ds-label">Invalid</span><input class="ds-input" aria-invalid="true" value="Billing!"><span class="ds-error">Use letters, numbers and dashes.</span></label><label class="ds-field" style="width:220px"><span class="ds-label">Disabled</span><input class="ds-input" disabled value="Locked"></label>'),
    section('Select and text area', '<label class="ds-field" style="width:220px"><span class="ds-label">Region</span><select class="ds-input"><option>Europe (Frankfurt)</option></select></label><label class="ds-field" style="width:300px"><span class="ds-label">Notes</span><textarea class="ds-input" placeholder="Anything the team should know"></textarea></label>')
  ].join('\n'),
  card: [
    section(
      'Card',
      '<article class="ds-card" style="width:300px"><header class="ds-card__header"><h3 class="ds-card__title">Billing service</h3><span class="ds-badge ds-badge--success">Healthy</span></header><p class="ds-card__body" style="margin:0">Handles invoices, refunds and the monthly usage report.</p><footer class="ds-card__footer"><button class="ds-button ds-button--ghost ds-button--sm">Logs</button><button class="ds-button ds-button--secondary ds-button--sm">Open</button></footer></article><article class="ds-card ds-card--interactive is-hover" style="width:240px"><span class="ds-card__meta">Interactive · hover</span><h3 class="ds-card__title">Weekly report</h3><p class="ds-card__body" style="margin:0">12 deploys, 0 incidents.</p></article>'
    )
  ].join('\n'),
  badge: [
    section('Brand', '<span class="ds-badge">Draft</span><span class="ds-badge ds-badge--primary">Selected</span><span class="ds-badge ds-badge--accent ds-badge--dot">New</span>'),
    section('Status', '<span class="ds-badge ds-badge--success">Healthy</span><span class="ds-badge ds-badge--warning">Degraded</span><span class="ds-badge ds-badge--danger">Down</span>')
  ].join('\n'),
  tabs: [section('Tabs', '<div class="ds-tabs" role="tablist" style="min-width:380px"><button class="ds-tab is-active" role="tab" aria-selected="true">Services <span class="ds-tab__count">12</span></button><button class="ds-tab" role="tab">Deploys</button><button class="ds-tab is-hover" role="tab">Settings</button></div>')].join('\n'),
  alert: [
    section(
      'Alerts',
      `<div style="display:grid;gap:10px;width:min(480px,100%)"><div class="ds-alert ds-alert--info" role="status">${ICON.info}<div><p class="ds-alert__title">Maintenance on Sunday</p><div class="ds-alert__body">Deploys pause from 02:00 to 03:00 UTC.</div></div></div><div class="ds-alert ds-alert--success" role="status">${ICON.check}<div><p class="ds-alert__title">Deployed in 42 seconds</p></div></div><div class="ds-alert ds-alert--warning" role="status">${ICON.warn}<div><p class="ds-alert__title">Usage at 85%</p><div class="ds-alert__body">Upgrade or trim old builds.</div></div></div><div class="ds-alert ds-alert--danger" role="alert">${ICON.x}<div><p class="ds-alert__title">The build failed</p><div class="ds-alert__body">Step 3 of 5 exited with code 1.</div></div></div></div>`
    )
  ].join('\n'),
  menu: [
    section(
      'Menu',
      '<div class="ds-menu" role="menu"><div class="ds-menu__label">Project</div><button class="ds-menu__item" role="menuitem">Rename <span class="ds-menu__shortcut">F2</span></button><button class="ds-menu__item is-active" role="menuitem">Duplicate <span class="ds-menu__shortcut">⌘D</span></button><button class="ds-menu__item" role="menuitem">Move to…</button><div class="ds-menu__sep" role="separator"></div><button class="ds-menu__item ds-menu__item--danger" role="menuitem">Delete</button></div>'
    )
  ].join('\n')
}

export function kitSpecimen(name: KitName): string {
  return `<div class="specimen">\n${SPECIMENS[name]}\n</div>`
}

export const KIT_USAGE: Record<KitName, string> = {
  button: '<button class="ds-button ds-button--primary">Save</button>  <!-- --secondary | --ghost | --danger · --sm | --lg · --icon -->',
  input: '<label class="ds-field"><span class="ds-label">Name</span><input class="ds-input"><span class="ds-hint">Hint</span></label>  <!-- aria-invalid="true" + .ds-error for errors -->',
  card: '<article class="ds-card"><header class="ds-card__header"><h3 class="ds-card__title">Title</h3></header><p class="ds-card__body">…</p><footer class="ds-card__footer">…</footer></article>',
  badge: '<span class="ds-badge ds-badge--success">Healthy</span>  <!-- --primary | --accent | --success | --warning | --danger · --dot -->',
  tabs: '<div class="ds-tabs" role="tablist"><button class="ds-tab" role="tab" aria-selected="true">One</button><button class="ds-tab" role="tab">Two</button></div>',
  alert: '<div class="ds-alert ds-alert--warning" role="status"><svg class="ds-alert__icon">…</svg><div><p class="ds-alert__title">Title</p><div class="ds-alert__body">Details</div></div></div>',
  menu: '<div class="ds-menu" role="menu"><button class="ds-menu__item" role="menuitem">Rename</button><div class="ds-menu__sep"></div><button class="ds-menu__item ds-menu__item--danger" role="menuitem">Delete</button></div>'
}

/** How the kit is set up, in words, for DESIGN.md. */
export function kitMarkdown(kit: KitSettings): string[] {
  const opt = (name: KitName, key: string) => {
    const c = KIT[name].controls.find((x) => x.key === key)
    const v = (kit[name] as Record<string, unknown>)[key]
    if (!c) return String(v)
    if (c.type === 'select') return (c.options.find((o) => o.value === v)?.label ?? String(v)).toLowerCase()
    if (c.type === 'slider') return c.format(v as number)
    return v ? 'yes' : 'no'
  }
  const b = kit.button
  return [
    'Built-in components ship in `components.css` (classes start with `ds-`). Use them instead of restyling buttons, fields and cards; AI-built components below reuse them too.',
    '',
    `- **Button** \`.ds-button\` + \`--primary\` / \`--secondary\` / \`--ghost\` / \`--danger\`, sizes \`--sm\` / \`--md\` / \`--lg\`, \`--icon\`. Primary is ${opt('button', 'primary')}; ${opt('button', 'radius')} corners; ${opt('button', 'weight')} text${b.textCase === 'uppercase' ? ', uppercase' : ''}. One primary button per view.`,
    `- **Input** \`.ds-field\` > \`.ds-label\`, \`.ds-input\` (also on \`select\` and \`textarea\`), \`.ds-hint\` / \`.ds-error\`. ${opt('input', 'style')} style, focus shown as ${opt('input', 'focus')}. Mark errors with \`aria-invalid="true"\`.`,
    `- **Card** \`.ds-card\` with \`__header\`, \`__title\`, \`__meta\`, \`__body\`, \`__footer\`; \`--interactive\` for clickable cards, \`--flush\` for edge-to-edge content. ${opt('card', 'surface')} fill, padding ${opt('card', 'padding')}, ${kit.card.border ? 'bordered' : 'no border'}, shadow ${opt('card', 'shadow')}.`,
    `- **Badge** \`.ds-badge\` + \`--primary\` / \`--accent\` / \`--success\` / \`--warning\` / \`--danger\`, \`--dot\`. ${opt('badge', 'style')} style.`,
    `- **Tabs** \`.ds-tabs\` > \`.ds-tab\` (\`aria-selected="true"\` or \`.is-active\`), optional \`.ds-tab__count\`. ${opt('tabs', 'style')} style.`,
    `- **Alert** \`.ds-alert\` + \`--info\` / \`--success\` / \`--warning\` / \`--danger\`, with \`.ds-alert__icon\`, \`__title\`, \`__body\`. ${opt('alert', 'style')} style. Text stays \`--color-text\`; the status colour is in the icon and tint.`,
    `- **Menu** \`.ds-menu\` > \`.ds-menu__item\` (\`--danger\`), \`.ds-menu__label\`, \`.ds-menu__sep\`, \`.ds-menu__shortcut\`. Hover row: ${opt('menu', 'highlight')}.`
  ]
}
