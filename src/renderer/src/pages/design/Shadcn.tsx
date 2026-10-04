import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import { fontStack, type BuiltDesign, type DesignInput } from '@shared/design'
import { shadcnVars } from '@shared/shadcn'
import { loadDesignFont } from '@/lib/designFonts'

/** shadcn/ui's new-york look, rebuilt with plain CSS on the theme's variables (scoped to .sc). */
const CSS = `
.sc { background: var(--background); color: var(--foreground); font-family: var(--font-sans); font-size: 14px; line-height: 1.5; padding: 28px; }
.sc * { box-sizing: border-box; border-color: var(--border); }
.sc h2, .sc h3 { font-family: var(--font-heading); margin: 0; }
.sc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
.sc-card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); padding: 24px 0; display: grid; gap: 20px; box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); }
.sc-card > * { padding: 0 24px; }
.sc-title { font-weight: 600; line-height: 1; font-size: 15px; }
.sc-desc { color: var(--muted-foreground); font-size: 13.5px; margin-top: 6px; }
.sc-label { font-size: 13.5px; font-weight: 500; display: block; margin-bottom: 8px; }
.sc-input { height: 36px; width: 100%; border: 1px solid var(--input); border-radius: calc(var(--radius) - 2px); background: transparent; padding: 0 12px; color: var(--foreground); font: inherit; font-size: 13.5px; }
.sc-input::placeholder { color: var(--muted-foreground); }
.sc-input.focus { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent); }
.sc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 16px; border-radius: calc(var(--radius) - 2px); font: inherit; font-size: 13.5px; font-weight: 500; border: 1px solid transparent; cursor: default; white-space: nowrap; }
.sc-btn.sm { height: 32px; padding: 0 12px; }
.sc-btn.primary { background: var(--primary); color: var(--primary-foreground); }
.sc-btn.primary:hover { background: color-mix(in oklab, var(--primary) 90%, transparent); }
.sc-btn.secondary { background: var(--secondary); color: var(--secondary-foreground); }
.sc-btn.outline { background: var(--background); border-color: var(--border); color: var(--foreground); }
.sc-btn.outline:hover, .sc-btn.ghost:hover { background: var(--accent); color: var(--accent-foreground); }
.sc-btn.ghost { background: transparent; color: var(--foreground); }
.sc-btn.destructive { background: var(--destructive); color: var(--destructive-foreground); }
.sc-btn.link { background: none; color: var(--primary); padding: 0; height: auto; text-decoration: underline; text-underline-offset: 4px; }
.sc-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sc-badge { display: inline-flex; align-items: center; border: 1px solid transparent; border-radius: calc(var(--radius) - 2px); padding: 2px 8px; font-size: 12px; font-weight: 500; }
.sc-badge.default { background: var(--primary); color: var(--primary-foreground); }
.sc-badge.secondary { background: var(--secondary); color: var(--secondary-foreground); }
.sc-badge.outline { border-color: var(--border); color: var(--foreground); }
.sc-badge.highlight { background: var(--highlight); color: var(--highlight-foreground); }
.sc-badge.destructive { background: var(--destructive); color: var(--destructive-foreground); }
.sc-stat { font-family: var(--font-heading); font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.sc-muted { color: var(--muted-foreground); font-size: 12.5px; }
.sc-tabs { display: inline-flex; background: var(--muted); border-radius: calc(var(--radius) + 2px); padding: 3px; gap: 2px; }
.sc-tab { border-radius: calc(var(--radius) - 2px); padding: 4px 12px; font-size: 13px; font-weight: 500; color: var(--muted-foreground); }
.sc-tab.on { background: var(--background); color: var(--foreground); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }
.sc-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.sc-table th { text-align: left; font-weight: 500; color: var(--muted-foreground); height: 36px; padding: 0 8px; border-bottom: 1px solid var(--border); }
.sc-table td { padding: 8px; border-bottom: 1px solid var(--border); }
.sc-table tr:last-child td { border-bottom: 0; }
.sc-table tr:hover td { background: color-mix(in oklab, var(--muted) 50%, transparent); }
.sc-alert { border: 1px solid var(--border); border-radius: calc(var(--radius) + 2px); padding: 12px 16px; display: grid; gap: 2px; background: var(--card); }
.sc-alert.destructive { color: var(--destructive); }
.sc-alert .sc-muted { color: inherit; opacity: 0.9; }
.sc-switch { width: 32px; height: 18px; border-radius: 99px; background: var(--primary); position: relative; flex: none; }
.sc-switch::after { content: ''; position: absolute; top: 2px; right: 2px; width: 14px; height: 14px; border-radius: 99px; background: var(--background); }
.sc-progress { height: 8px; border-radius: 99px; background: color-mix(in oklab, var(--primary) 20%, transparent); overflow: hidden; }
.sc-progress span { display: block; height: 100%; width: 62%; background: var(--primary); }
.sc-sep { height: 1px; background: var(--border); margin: 0 24px; padding: 0 !important; }
`

/** The theme on shadcn-style components, with the contrast checks that matter for it. */
export function ShadcnPreview({ input, built, theme }: { input: DesignInput; built: BuiltDesign; theme: 'light' | 'dark' }) {
  useEffect(() => {
    for (const f of [input.fontSans, input.fontHeading]) void loadDesignFont(f)
  }, [input.fontSans, input.fontHeading])
  const style = useMemo(() => {
    const v: Record<string, string> = {}
    for (const [k, c] of Object.entries(shadcnVars(built.roles[theme], built, theme))) v[`--${k}`] = c
    v['--radius'] = `${built.radii.md}px`
    v['--font-sans'] = fontStack(input, 'sans')
    v['--font-heading'] = fontStack(input, 'heading')
    return v as CSSProperties
  }, [built, theme, input])
  const [tab, setTab] = useState('Overview')
  const checks = built.checks.filter((c) => c.mode === theme)
  return (
    <div>
      <style>{CSS}</style>
      <div className="sc" style={style}>
        <div className="sc-grid">
          <div className="sc-card">
            <div>
              <div className="sc-title">Create project</div>
              <div className="sc-desc">Deploy your new project in one click.</div>
            </div>
            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <span className="sc-label">Name</span>
                <div className="sc-input focus" style={{ display: 'flex', alignItems: 'center' }}>
                  Northwind
                </div>
              </div>
              <div>
                <span className="sc-label">Framework</span>
                <div className="sc-input" style={{ display: 'flex', alignItems: 'center', color: 'var(--muted-foreground)' }}>
                  Select a framework
                </div>
              </div>
              <div className="sc-row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13.5 }}>Preview deployments</span>
                <span className="sc-switch" aria-hidden="true" />
              </div>
            </div>
            <div className="sc-row" style={{ justifyContent: 'space-between' }}>
              <span className="sc-btn outline">Cancel</span>
              <span className="sc-btn primary">Deploy</span>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 16 }}>
            <div className="sc-card" style={{ gap: 8 }}>
              <div className="sc-row" style={{ justifyContent: 'space-between' }}>
                <span className="sc-muted" style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--foreground)' }}>
                  Total revenue
                </span>
                <span className="sc-badge highlight">New</span>
              </div>
              <div className="sc-stat">$45,231.89</div>
              <div className="sc-muted">+20.1% from last month</div>
              <div>
                <div className="sc-progress">
                  <span />
                </div>
              </div>
            </div>
            <div className="sc-alert destructive">
              <strong style={{ fontSize: 13.5 }}>Your session has expired.</strong>
              <span className="sc-muted">Please sign in again to continue.</span>
            </div>
            <div className="sc-row">
              <span className="sc-badge default">Default</span>
              <span className="sc-badge secondary">Secondary</span>
              <span className="sc-badge outline">Outline</span>
              <span className="sc-badge highlight">Highlight</span>
              <span className="sc-badge destructive">Destructive</span>
            </div>
          </div>

          <div className="sc-card" style={{ gridColumn: '1 / -1' }}>
            <div className="sc-row" style={{ justifyContent: 'space-between' }}>
              <div className="sc-tabs" role="tablist">
                {['Overview', 'Invoices', 'Settings'].map((t) => (
                  <span key={t} role="tab" aria-selected={tab === t} className={clsx('sc-tab', tab === t && 'on')} onClick={() => setTab(t)}>
                    {t}
                  </span>
                ))}
              </div>
              <div className="sc-row">
                <span className="sc-btn ghost sm">Export</span>
                <span className="sc-btn secondary sm">Filter</span>
                <span className="sc-btn primary sm">Add invoice</span>
              </div>
            </div>
            <div>
              <table className="sc-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Status</th>
                    <th>Method</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['INV001', 'Paid', 'Credit card', '$250.00'],
                    ['INV002', 'Pending', 'PayPal', '$150.00'],
                    ['INV003', 'Unpaid', 'Bank transfer', '$350.00']
                  ].map(([a, b, c, d]) => (
                    <tr key={a}>
                      <td style={{ fontWeight: 500 }}>{a}</td>
                      <td>
                        <span className={clsx('sc-badge', b === 'Paid' ? 'secondary' : b === 'Unpaid' ? 'outline' : 'highlight')}>{b}</span>
                      </td>
                      <td>{c}</td>
                      <td style={{ textAlign: 'right' }}>{d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sc-row">
              <span className="sc-btn destructive sm">Delete selected</span>
              <span className="sc-btn link">View all invoices</span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line px-5 py-3 text-[11.5px]" aria-label="Contrast checks">
        {checks.map((c) => (
          <span key={c.label} className={clsx('flex items-center gap-1.5', c.ratio >= c.need ? 'text-muted' : 'text-warn')} title={`Needs ${c.need}:1`}>
            <span className="h-2.5 w-2.5 rounded-sm border border-black/30" style={{ background: c.bg }} />
            {c.label} <span className="font-mono">{c.ratio.toFixed(1)}</span>
            {c.ratio < c.need && ' fails'}
          </span>
        ))}
      </div>
    </div>
  )
}
