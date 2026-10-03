import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ModelRef } from '@shared/types'
import {
  buildDesign,
  componentPrompt,
  DEFAULT_DESIGN,
  designFiles,
  parseComponentAnswer,
  sanitizeComponentCss,
  sanitizeComponentHtml,
  sanitizeDesign,
  parsePalette,
  toDesignMd,
  type ComponentVersion,
  type DesignComponent,
  type DesignDraft,
  type DesignInput,
  type DesignSystem
} from '@shared/design'
import { json } from '../core/db'
import { newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'

const HISTORY_LIMIT = 20

interface ComponentRow {
  id: string
  design_id: string
  name: string
  description: string
  html: string
  css: string
  usage: string
  prompt: string
  history: string
  created_at: number
  updated_at: number
}

const toComponent = (r: ComponentRow): DesignComponent => ({
  id: r.id,
  designId: r.design_id,
  name: r.name,
  description: r.description,
  html: r.html,
  css: r.css,
  usage: r.usage,
  prompt: r.prompt,
  history: json<ComponentVersion[]>(r.history, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

interface DesignRow {
  id: string
  name: string
  description: string
  input: string
  created_at: number
  updated_at: number
}

const toDesign = (r: DesignRow): DesignSystem => ({
  id: r.id,
  name: r.name,
  description: r.description,
  input: sanitizeDesign(json<Partial<DesignInput>>(r.input, {})),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const GENERATE_SYSTEM = `You are a senior product designer. From the user's description, design a UI design system and answer with ONLY a JSON object (no prose, no code fence) with these fields:
{
  "name": short evocative name (1-3 words),
  "description": one sentence on the product feel and who it is for,
  "brand": main brand colour as #rrggbb,
  "accent": second highlight colour as #rrggbb, or null for brand-only systems,
  "success": "#rrggbb", "warning": "#rrggbb", "danger": "#rrggbb" (harmonised with the brand, still clearly green / amber / red),
  "pinBrand": true to use the brand colour exactly for buttons (for a signature colour), false to let Cloth pick the most readable shade,
  "neutral": grey family — "brand" (greys lean to the brand hue), "slate" (cool blue-grey), "zinc" (cool, faint), "gray" (pure), "stone" (warm), "sand" (warmer), "olive", or "custom" (greys take the hue of neutralSeed),
  "neutralSeed": with "custom" only: a #rrggbb whose hue the greys take (e.g. an off-white or deep grey from the user's palette), else null,
  "neutralTint": 0..1 (how strongly the greys show that family's hue),
  "mode": "dark" | "light" | "both",
  "darkDepth": 0..1 (dark background: 0 near black, 0.5 charcoal, 1 soft grey),
  "fontSans": body font (a real Google Font, e.g. Inter, Geist, IBM Plex Sans, Manrope, DM Sans),
  "fontHeading": heading font (can match fontSans, or a display/serif font like Space Grotesk, Fraunces),
  "fontMono": code font (JetBrains Mono, Geist Mono, IBM Plex Mono, Fira Code),
  "baseSize": body size in px (13-18),
  "scale": type scale ratio (1.125 tight, 1.2 balanced, 1.25 roomy, 1.333 expressive, 1.5 dramatic),
  "headingWeight": 400-900 (headline weight),
  "headingTracking": -0.05..0.03 (headline letter-spacing in em; negative = tighter, typical -0.02),
  "bodyLeading": 1.3-1.8 (body line height),
  "radius": base corner radius in px (0 sharp … 16 very round),
  "density": "compact" | "comfortable" | "spacious",
  "shadow": "none" | "soft" | "strong",
  "principles": 3-5 short, concrete design rules in this system's voice
}
Choose colours with intent: the brand colour should suit the product, and the system must stay accessible (Cloth adjusts shades for contrast).`

export class DesignService {
  constructor(
    private ctx: Ctx,
    private providers: ProviderService
  ) {}

  list(): DesignSystem[] {
    return (this.ctx.db.prepare('SELECT * FROM design_systems ORDER BY updated_at DESC').all() as unknown as DesignRow[]).map(toDesign)
  }

  get(id: string): DesignSystem {
    const row = this.ctx.db.prepare('SELECT * FROM design_systems WHERE id = ?').get(id) as unknown as DesignRow | undefined
    if (!row) throw new Error('Design system not found')
    return toDesign(row)
  }

  find(id: string | null | undefined): DesignSystem | null {
    if (!id) return null
    try {
      return this.get(id)
    } catch {
      return null
    }
  }

  create(draft: Partial<DesignDraft> = {}): DesignSystem {
    const id = newId('dsn_')
    const now = Date.now()
    const name = draft.name?.trim() || this.nextName()
    this.ctx.db
      .prepare('INSERT INTO design_systems (id, name, description, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, draft.description ?? '', JSON.stringify(sanitizeDesign(draft.input ?? DEFAULT_DESIGN)), now, now)
    return this.get(id)
  }

  update(id: string, patch: Partial<DesignDraft>): DesignSystem {
    const cur = this.get(id)
    const name = patch.name === undefined ? cur.name : patch.name.trim() || cur.name
    const input = patch.input ? sanitizeDesign(patch.input, cur.input) : cur.input
    this.ctx.db.prepare('UPDATE design_systems SET name = ?, description = ?, input = ?, updated_at = ? WHERE id = ?').run(name, patch.description ?? cur.description, JSON.stringify(input), Date.now(), id)
    return this.get(id)
  }

  duplicate(id: string): DesignSystem {
    const d = this.get(id)
    return this.create({ name: `${d.name} copy`, description: d.description, input: d.input })
  }

  /** Projects that followed it stop doing so. */
  remove(id: string): void {
    this.ctx.db.prepare('UPDATE projects SET design_id = NULL WHERE design_id = ?').run(id)
    this.ctx.db.prepare('DELETE FROM design_systems WHERE id = ?').run(id)
  }

  /** A design proposed by a model from a description (not saved — the editor applies it). */
  async generate(input: { prompt: string; model: ModelRef; current?: DesignInput }): Promise<DesignDraft> {
    if (!input.prompt.trim()) throw new Error('Describe the look you want')
    // A pasted palette (a Coolors link or a list of colours) is the colour brief.
    const palette = parsePalette(input.prompt)
    const brief =
      palette.length >= 2
        ? `\n\nBuild the colours from this palette: ${palette.join(', ')}. Brand and accent must be palette colours exactly; take the greys' hue from its near-greys (neutral "custom" with neutralSeed) when it has them. Keep success/warning/danger recognisable but in harmony with it.`
        : ''
    const prompt = input.current
      ? `${input.prompt.trim()}${brief}\n\nCurrent system (change what the description asks for, keep the rest):\n${JSON.stringify(input.current)}`
      : `${input.prompt.trim()}${brief}`
    const { text } = await this.providers.complete(input.model, { system: GENERATE_SYSTEM, prompt, maxTokens: 2000, temperature: 0.7 })
    const raw = parseJsonObject(text)
    if (!raw) throw new Error('The model did not return a design — try again, or a different model')
    return {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : 'Untitled',
      description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 300) : '',
      input: sanitizeDesign({ ...raw, ...(palette.length >= 2 ? { palette } : {}) }, input.current ?? DEFAULT_DESIGN)
    }
  }

  /** Every export file, by name. */
  files(id: string): Record<string, string> {
    return designFiles(this.get(id), this.components(id))
  }

  /** DESIGN.md (with the component library), for a project's chats. */
  markdown(id: string): string {
    const d = this.get(id)
    return toDesignMd(d, buildDesign(d.input), this.components(id))
  }

  /** Writes DESIGN.md, the token files and the component library into `folder`. Returns the written paths. */
  async export(id: string, folder: string): Promise<string[]> {
    const out: string[] = []
    for (const [name, content] of Object.entries(this.files(id))) {
      const p = join(folder, ...name.split('/'))
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, content)
      out.push(p)
    }
    return out
  }

  // ─── Component library ──────────────────────────────────────────────────────

  components(designId: string): DesignComponent[] {
    return (this.ctx.db.prepare('SELECT * FROM design_components WHERE design_id = ? ORDER BY created_at').all(designId) as unknown as ComponentRow[]).map(toComponent)
  }

  component(id: string): DesignComponent {
    const row = this.ctx.db.prepare('SELECT * FROM design_components WHERE id = ?').get(id) as unknown as ComponentRow | undefined
    if (!row) throw new Error('Component not found')
    return toComponent(row)
  }

  /**
   * Builds a new component from a description, or (with componentId) a new version of an existing
   * one from a change request. The model sees the system's tokens and rules, and the current code.
   */
  async generateComponent(input: { designId: string; prompt: string; model: ModelRef; componentId?: string }): Promise<DesignComponent> {
    const request = input.prompt.trim()
    if (!request) throw new Error('Describe the component')
    const design = this.get(input.designId)
    const current = input.componentId ? this.component(input.componentId) : null
    const prompt = current
      ? `Change the "${current.name}" component: ${request}\n\nKeep everything else as it is. Its current code:\n=== CSS ===\n${current.css}\n=== HTML ===\n${current.html}\n=== USAGE ===\n${current.usage}`
      : `Build this component: ${request}`
    const { text } = await this.providers.complete(input.model, { system: componentPrompt(design), prompt, maxTokens: 8000, temperature: 0.4 })
    const answer = parseComponentAnswer(text)
    if (!answer) throw new Error('The model did not return a component — try again, or a different model')
    const version: ComponentVersion = { html: sanitizeComponentHtml(answer.html), css: sanitizeComponentCss(answer.css), usage: sanitizeComponentHtml(answer.usage), prompt: request, createdAt: Date.now() }
    if (current) {
      const history = [{ html: current.html, css: current.css, usage: current.usage, prompt: current.prompt, createdAt: current.updatedAt }, ...current.history].slice(0, HISTORY_LIMIT)
      this.ctx.db
        .prepare('UPDATE design_components SET description = ?, html = ?, css = ?, usage = ?, prompt = ?, history = ?, updated_at = ? WHERE id = ?')
        .run(answer.description || current.description, version.html, version.css, version.usage, version.prompt, JSON.stringify(history), version.createdAt, current.id)
      return this.component(current.id)
    }
    const id = newId('cmp_')
    this.ctx.db
      .prepare('INSERT INTO design_components (id, design_id, name, description, html, css, usage, prompt, history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, design.id, answer.name || 'Component', answer.description, version.html, version.css, version.usage, version.prompt, '[]', version.createdAt, version.createdAt)
    return this.component(id)
  }

  /** Hand edits (name, description or code); the previous code goes into the history. */
  updateComponent(id: string, patch: Partial<Pick<DesignComponent, 'name' | 'description' | 'html' | 'css' | 'usage'>>): DesignComponent {
    const cur = this.component(id)
    const codeChanged = (patch.html !== undefined && patch.html !== cur.html) || (patch.css !== undefined && patch.css !== cur.css) || (patch.usage !== undefined && patch.usage !== cur.usage)
    const history = codeChanged ? [{ html: cur.html, css: cur.css, usage: cur.usage, prompt: cur.prompt, createdAt: cur.updatedAt }, ...cur.history].slice(0, HISTORY_LIMIT) : cur.history
    this.ctx.db
      .prepare('UPDATE design_components SET name = ?, description = ?, html = ?, css = ?, usage = ?, prompt = ?, history = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name?.trim() || cur.name,
        patch.description ?? cur.description,
        patch.html === undefined ? cur.html : sanitizeComponentHtml(patch.html),
        patch.css === undefined ? cur.css : sanitizeComponentCss(patch.css),
        patch.usage === undefined ? cur.usage : sanitizeComponentHtml(patch.usage),
        codeChanged ? 'Edited by hand' : cur.prompt,
        JSON.stringify(history),
        Date.now(),
        id
      )
    return this.component(id)
  }

  /** Back to the previous version. */
  undoComponent(id: string): DesignComponent {
    const cur = this.component(id)
    const [prev, ...rest] = cur.history
    if (!prev) throw new Error('No earlier version')
    this.ctx.db.prepare('UPDATE design_components SET html = ?, css = ?, usage = ?, prompt = ?, history = ?, updated_at = ? WHERE id = ?').run(prev.html, prev.css, prev.usage, prev.prompt, JSON.stringify(rest), Date.now(), id)
    return this.component(id)
  }

  removeComponent(id: string): void {
    this.ctx.db.prepare('DELETE FROM design_components WHERE id = ?').run(id)
  }

  private nextName(): string {
    const taken = new Set(this.list().map((d) => d.name))
    for (let i = 1; ; i++) {
      const n = i === 1 ? 'New design' : `New design ${i}`
      if (!taken.has(n)) return n
    }
  }
}

/** The first JSON object in a model's reply (tolerates code fences and stray prose). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const body = text.replace(/```(?:json)?/gi, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(body.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
