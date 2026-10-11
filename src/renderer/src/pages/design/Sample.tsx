import { useEffect, useMemo, type CSSProperties } from 'react'
import { buildDesign, DEFAULT_SAMPLE, fontStack, type BuiltDesign, type DesignInput, type RoleName, type SampleContent } from '@shared/design'
import { kitCss } from '@shared/kit'
import { loadDesignFont } from '@/lib/designFonts'

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

/** The design's tokens as CSS variables, so a preview is styled only by the design, never by Cloth's theme. */
export function designVars(input: DesignInput, built: BuiltDesign, theme: 'light' | 'dark'): CSSProperties {
  const roles = built.roles[theme]
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
}

export function useDesignFonts(input: DesignInput): void {
  useEffect(() => {
    for (const f of [input.fontSans, input.fontHeading, input.fontMono]) void loadDesignFont(f)
  }, [input.fontSans, input.fontHeading, input.fontMono])
}

const SAMPLE_CSS = `
.dss { flex: 1; background: var(--color-background); color: var(--color-text); font-family: var(--font-sans); font-size: var(--text-body); line-height: var(--leading-body); container-type: inline-size; }
.dss * { box-sizing: border-box; }
.dss h1, .dss h2, .dss h3 { font-family: var(--font-heading); margin: 0; color: var(--color-text); text-wrap: balance; }
.dss h1 { font-size: var(--text-display); line-height: var(--leading-display); font-weight: var(--weight-display); letter-spacing: var(--tracking-display); }
.dss h2 { font-size: var(--text-h3); line-height: var(--leading-h3); font-weight: var(--weight-h3); letter-spacing: var(--tracking-h3); }
.dss h3 { font-size: var(--text-h4); line-height: var(--leading-h4); font-weight: var(--weight-h4); letter-spacing: var(--tracking-h4); }
.dss .muted { color: var(--color-text-muted); }
.dss .small { font-size: var(--text-small); line-height: var(--leading-small); }
.dss-nav { display: flex; align-items: center; gap: var(--space-5); padding: var(--space-3) var(--space-6); border-bottom: 1px solid var(--color-border); background: var(--color-surface); }
.dss-logo { width: 26px; height: 26px; border-radius: var(--radius-md); background: var(--color-primary); flex-shrink: 0; }
.dss-app { font-family: var(--font-heading); font-weight: var(--weight-h4); font-size: var(--text-h4); margin-right: auto; }
.dss-nav a { color: var(--color-text-muted); font-size: var(--text-small); text-decoration: none; }
.dss-nav a:first-of-type { color: var(--color-text); font-weight: 600; }
.dss-hero { padding: var(--space-10) var(--space-6) var(--space-8); display: grid; gap: var(--space-5); background: linear-gradient(180deg, var(--color-primary-soft), var(--color-background)); }
.dss-hero p { margin: 0; max-width: 56ch; }
.dss-search { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; max-width: 620px; }
.dss-search .ds-field { flex: 1; min-width: 200px; }
.dss-body { padding: var(--space-6); display: grid; gap: var(--space-4); }
.dss-cards { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
.dss-thumb { height: 84px; border-radius: var(--radius-md); background: linear-gradient(135deg, color-mix(in oklab, var(--color-primary) 55%, var(--color-surface)), color-mix(in oklab, var(--color-accent) 40%, var(--color-surface-raised))); }
.dss-card-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.dss-row { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
@container (max-width: 520px) { .dss-nav a { display: none; } .dss-cards { grid-template-columns: 1fr; } }
`

/**
 * A screen of the product built from the design: its colours, fonts, spacing and built-in components,
 * with the product's own words when the design has them.
 */
export function SampleScreen({ input, theme, name }: { input: DesignInput; theme: 'light' | 'dark'; name?: string }) {
  const built = useMemo(() => buildDesign(input), [input])
  const vars = useMemo(() => designVars(input, built, theme), [input, built, theme])
  useDesignFonts(input)
  const s: SampleContent = input.sample ?? { ...DEFAULT_SAMPLE, app: name || DEFAULT_SAMPLE.app }
  return (
    <div className="dss" style={vars}>
      <style>{SAMPLE_CSS}</style>
      <style>{kitCss(input.kit)}</style>
      <div className="dss-nav">
        <span className="dss-logo" />
        <span className="dss-app">{s.app}</span>
        {s.nav.map((n) => (
          <a key={n}>{n}</a>
        ))}
        <button className="ds-button ds-button--secondary ds-button--sm" tabIndex={-1}>
          Sign in
        </button>
      </div>
      <div className="dss-hero">
        <h1>{s.title}</h1>
        <p className="muted">{s.subtitle}</p>
        <div className="dss-search">
          <label className="ds-field">
            <span className="ds-label">{s.field}</span>
            <input className="ds-input" placeholder={s.placeholder} tabIndex={-1} readOnly />
          </label>
          <button className="ds-button ds-button--primary" tabIndex={-1}>
            {s.primary}
          </button>
        </div>
      </div>
      <div className="dss-body">
        <h2>{s.section}</h2>
        <div className="dss-cards">
          {s.items.map((it, i) => (
            <div key={i} className="ds-card">
              <div className="dss-thumb" style={{ filter: `hue-rotate(${i * 25}deg)` }} />
              <div className="dss-card-top">
                <h3>{it.title}</h3>
                <span className={i === 0 ? 'ds-badge ds-badge--accent' : 'ds-badge'}>{it.tag}</span>
              </div>
              <span className="muted small">{it.meta}</span>
              <div className="dss-row">
                <button className={i === 0 ? 'ds-button ds-button--primary ds-button--sm' : 'ds-button ds-button--secondary ds-button--sm'} tabIndex={-1}>
                  {i === 0 ? s.primary : s.secondary}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="ds-alert ds-alert--success dss-done">
          <span className="ds-alert__icon" style={{ fontWeight: 700 }}>
            ✓
          </span>
          <span>{s.done}</span>
        </div>
      </div>
    </div>
  )
}
