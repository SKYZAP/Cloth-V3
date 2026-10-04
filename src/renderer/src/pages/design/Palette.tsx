import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowSquareOut, ClipboardText, X } from '@phosphor-icons/react'
import { applyPaletteColor, contrast, coolorsUrl, paletteToDesign, parsePalette, systemPalette, type DesignInput, type PaletteUse } from '@shared/design'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { Button, Input } from '@/components/ui'

const USES: { use: PaletteUse; label: string; short: string }[] = [
  { use: 'brand', label: 'Brand (buttons, links)', short: 'Brand' },
  { use: 'accent', label: 'Accent (highlights)', short: 'Accent' },
  { use: 'greys', label: 'Grey tint', short: 'Greys' },
  { use: 'lightBackground', label: 'Light theme background', short: 'Light bg' },
  { use: 'darkBackground', label: 'Dark theme background', short: 'Dark bg' },
  { use: 'lightText', label: 'Light theme text', short: 'Text' }
]

/** Where a palette colour is used in the system, for its label. */
function usesOf(input: DesignInput, hex: string): string[] {
  const out: string[] = []
  if (input.brand === hex) out.push('Brand')
  if (input.accent === hex) out.push('Accent')
  if (input.neutral === 'custom' && input.neutralSeed === hex) out.push('Greys')
  if (input.overrides.light.background === hex) out.push('Light bg')
  if (input.overrides.dark.background === hex) out.push('Dark bg')
  if (input.overrides.light.text === hex) out.push('Text')
  return out
}

/** Import a palette (Coolors link, export or hex list), show it, and assign its colours to roles. */
export function PaletteField({ input, set }: { input: DesignInput; set(p: Partial<DesignInput>): void }) {
  const [importing, setImporting] = useState(false)
  const [text, setText] = useState('')
  const [menu, setMenu] = useState<string | null>(null)
  const parsed = parsePalette(text)

  const apply = (colors: string[]) => {
    if (!colors.length) return
    set(paletteToDesign(colors, input))
    setImporting(false)
    setText('')
    useApp.getState().toast(`Palette applied — ${colors.length} colour${colors.length > 1 ? 's' : ''}. Click a swatch to change what it's used for.`, 'ok')
  }

  const pasteClipboard = async () => {
    const clip = await navigator.clipboard.readText().catch(() => '')
    const colors = parsePalette(clip)
    if (colors.length) apply(colors)
    else {
      setImporting(true)
      useApp.getState().toast('No colours on the clipboard — copy a Coolors link or its export first', 'error')
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-[11.5px] font-medium text-muted">
        Palette
        <span className="flex items-center gap-2.5">
          <button onClick={() => void pasteClipboard()} className="flex items-center gap-1 text-[11px] text-dim hover:text-fg" title="Use the palette on the clipboard">
            <ClipboardText size={12} /> Paste
          </button>
          <button onClick={() => setImporting((v) => !v)} className={clsx('text-[11px] hover:text-fg', importing ? 'text-fg' : 'text-dim')}>
            Import
          </button>
          <button onClick={() => void attempt(() => api.app.openExternal(coolorsUrl(systemPalette(input))))} className="flex items-center gap-1 text-[11px] text-dim hover:text-fg" title="Open these colours in Coolors to explore or generate more — then copy the link back">
            Coolors <ArrowSquareOut size={11} />
          </button>
        </span>
      </span>

      {importing && (
        <div className="space-y-2 rounded-md border border-line bg-panel p-2">
          <Input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply(parsed)
              if (e.key === 'Escape') setImporting(false)
            }}
            placeholder="coolors.co/54494b-f1f7ed-b33951 or #hex, #hex…"
            spellCheck={false}
            className="h-8 font-mono text-[12px]"
          />
          <div className="flex items-center gap-2">
            <div className="flex h-6 min-w-0 flex-1 overflow-hidden rounded-[5px] border border-line">
              {parsed.length ? parsed.map((c) => <span key={c} className="flex-1" style={{ background: c }} title={c} />) : <span className="px-2 text-[11px] leading-6 text-dim">A Coolors link, its export (CSS, JSON, SCSS…) or colours</span>}
            </div>
            <Button size="sm" variant="primary" disabled={!parsed.length} onClick={() => apply(parsed)}>
              Use
            </Button>
          </div>
        </div>
      )}

      {input.palette.length > 0 && (
        <div className="relative">
          <div className="flex h-14 overflow-hidden rounded-md border border-line">
            {input.palette.map((c) => {
              const uses = usesOf(input, c)
              const ink = contrast(c, '#ffffff') >= contrast(c, '#111111') ? '#ffffff' : '#111111'
              return (
                <button
                  key={c}
                  onClick={() => setMenu(menu === c ? null : c)}
                  className="group/sw flex min-w-0 flex-1 flex-col items-center justify-end gap-0.5 pb-1.5 transition-[flex-grow] hover:flex-[1.4]"
                  style={{ background: c, color: ink }}
                  aria-label={`${c}${uses.length ? `, used as ${uses.join(', ')}` : ''}`}
                >
                  {uses.length > 0 && <span className="max-w-full truncate px-1 text-[9.5px] font-semibold">{uses.join(' · ')}</span>}
                  <span className="font-mono text-[9.5px] uppercase opacity-70 group-hover/sw:opacity-100">{c.slice(1)}</span>
                </button>
              )
            })}
          </div>
          <button onClick={() => set({ palette: [] })} className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-line-strong bg-panel text-dim hover:text-fg" aria-label="Forget the palette" title="Forget the palette (keeps the colours in use)">
            <X size={9} weight="bold" />
          </button>
          {menu && <UseMenu input={input} color={menu} onPick={(use) => set(applyPaletteColor(input, menu, use))} onClose={() => setMenu(null)} />}
        </div>
      )}
    </div>
  )
}

function UseMenu({ input, color, onPick, onClose }: { input: DesignInput; color: string; onPick(u: PaletteUse): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])
  const current = usesOf(input, color)
  return (
    <div ref={ref} className="sheet-glass absolute inset-x-0 top-full z-30 mt-1.5 overflow-hidden rounded-[10px] border border-line-strong p-1 text-[12.5px]">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-dim">
        <span className="h-3 w-3 rounded-[3px] border border-black/30" style={{ background: color }} />
        <span className="font-mono uppercase">{color}</span> — use as
      </div>
      {USES.map((u) => (
        <button
          key={u.use}
          onClick={() => {
            onPick(u.use)
            onClose()
          }}
          className={clsx('flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left hover:bg-elev-2', current.includes(u.short) ? 'text-fg' : 'text-muted')}
        >
          {u.label}
          {current.includes(u.short) && <span className="text-[11px] text-crimson-hi">in use</span>}
        </button>
      ))}
      <button
        onClick={() => {
          void navigator.clipboard.writeText(color)
          onClose()
        }}
        className="flex w-full rounded-lg px-2.5 py-1.5 text-left text-muted hover:bg-elev-2"
      >
        Copy hex
      </button>
    </div>
  )
}
