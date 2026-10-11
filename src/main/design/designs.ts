import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createTwoFilesPatch } from 'diff'
import { dirname, join } from 'node:path'
import type { ModelRef } from '@shared/types'
import {
  buildDesign,
  DEFAULT_DESIGN,
  designFiles,
  sanitizeDesign,
  parsePalette,
  sanitizeSample,
  FONT_CHOICES,
  type DesignLooks,
  toDesignMd,
  type DesignDraft,
  type DesignInput,
  type DesignProjectSync,
  type DesignSystem
} from '@shared/design'
import { json } from '../core/db'
import { newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'

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

const LOOKS_SYSTEM = `You help someone who is not a designer start a design system for what they're making. Propose THREE clearly different looks that all fit their description, and write the words for a sample screen of their product.
Answer with ONLY a JSON object (no prose, no code fence):
{
  "sample": {
    "app": the product's name (invent a plausible one if none is given, 1-3 words),
    "nav": 3 short header links,
    "title": the main headline of the product's home screen (under 60 characters),
    "subtitle": one supporting sentence,
    "field": label of the main input on that screen (a search, booking or sign-up field),
    "placeholder": example text for that field,
    "primary": main button label (verb first, 1-3 words),
    "secondary": second button label (1-3 words),
    "section": heading above three cards,
    "items": exactly 3 cards, each { "title": short name, "meta": one detail such as a date, price or place, "tag": 1-2 word status or category },
    "done": a one-sentence confirmation message the product would show
  },
  "looks": [3 objects, each with:
    "name": 1-2 word name for the look,
    "why": one plain sentence saying how it feels and why it suits the product (no design jargon),
    "brand": main colour #rrggbb, "accent": second colour #rrggbb or null,
    "success", "warning", "danger": #rrggbb in harmony with the brand,
    "neutral": "brand" | "slate" | "zinc" | "gray" | "stone" | "sand" | "olive", "neutralTint": 0..1,
    "mode": "light" | "dark" | "both", "darkDepth": 0..1,
    "fontHeading": one of {{HEADINGS}}, "fontSans": one of {{SANS}}, "fontMono": one of {{MONOS}},
    "baseSize": 14-18, "scale": 1.125-1.5, "headingWeight": 500-800, "headingTracking": -0.04..0.01, "bodyLeading": 1.4-1.75,
    "radius": 0-16, "pill": true for fully round buttons, "density": "compact" | "comfortable" | "spacious", "shadow": "none" | "soft" | "strong",
    "principles": 3 short, concrete rules in this look's voice
  ]
}
Make the three looks differ in feel: vary the fonts, corner shape, spacing and light/dark, and vary colour unless the person named one — then every look uses it as the brand and they differ in everything else. Write sample words in the person's language, specific to their product.`

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

  /** Three different looks for a description, and the words for its sample screen. Nothing is saved. */
  async looks(input: { prompt: string; model: ModelRef; logoColor?: string | null; avoid?: string[] }): Promise<DesignLooks> {
    if (!input.prompt.trim()) throw new Error('Describe what you are making')
    const system = LOOKS_SYSTEM.replace('{{HEADINGS}}', FONT_CHOICES.heading.filter((f) => !f.startsWith('System')).join(', '))
      .replace('{{SANS}}', FONT_CHOICES.sans.filter((f) => !f.startsWith('System')).join(', '))
      .replace('{{MONOS}}', FONT_CHOICES.mono.filter((f) => !f.startsWith('System')).join(', '))
    const notes = [
      input.logoColor ? `Their logo's main colour is ${input.logoColor}; use it as the brand of at least the first look.` : '',
      input.avoid?.length ? `They have already seen looks named ${input.avoid.join(', ')}; make these three different from those.` : ''
    ].filter(Boolean)
    const prompt = [input.prompt.trim(), ...notes].join('\n\n')
    const { text } = await this.providers.complete(input.model, { system, prompt, maxTokens: 4000, temperature: 0.9 })
    const raw = parseJsonObject(text)
    const list = Array.isArray(raw?.looks) ? (raw.looks as unknown[]).filter((l): l is Record<string, unknown> => !!l && typeof l === 'object') : []
    if (!list.length) throw new Error('The model did not return any looks. Try again, or pick from finished looks.')
    const sample = sanitizeSample(raw!.sample)
    return {
      sample,
      looks: list.slice(0, 3).map((l) => {
        const base = sanitizeDesign({ ...l, sample }, DEFAULT_DESIGN)
        const pill = l.pill === true
        return {
          name: typeof l.name === 'string' && l.name.trim() ? l.name.trim().slice(0, 30) : 'Look',
          why: typeof l.why === 'string' ? l.why.trim().slice(0, 200) : '',
          description: typeof l.why === 'string' ? l.why.trim().slice(0, 300) : '',
          input: pill ? { ...base, kit: { ...base.kit, button: { ...base.kit.button, radius: 'full' as const }, badge: { ...base.kit.badge, radius: 'full' as const } } } : base
        }
      })
    }
  }

  /** Every export file, by name. */
  files(id: string): Record<string, string> {
    return designFiles(this.get(id))
  }

  /** DESIGN.md, for a project's chats. */
  markdown(id: string): string {
    const d = this.get(id)
    return toDesignMd(d, buildDesign(d.input))
  }

  /** Writes DESIGN.md, the token files and the built-in component pages into `folder`. Returns the written paths. */
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

  // ─── Projects ───────────────────────────────────────────────────────────────

  /**
   * Every project with a folder, and the state of each of this system's files in its design/ folder:
   * missing, current, outdated (Cloth wrote it and nobody touched it since) or edited by hand.
   */
  async projectSync(designId: string): Promise<DesignProjectSync[]> {
    const files = this.files(designId)
    const rows = this.ctx.db.prepare('SELECT id, name, color, folder, design_id FROM projects ORDER BY name COLLATE NOCASE').all() as { id: string; name: string; color: string; folder: string | null; design_id: string | null }[]
    const out: DesignProjectSync[] = []
    for (const p of rows) {
      const states = p.folder ? await Promise.all(Object.entries(files).map(async ([path, content]) => ({ path, state: await this.fileState(p.id, p.folder!, path, content) }))) : []
      out.push({ projectId: p.id, name: p.name, color: p.color, folder: p.folder, linked: p.design_id === designId, files: states })
    }
    return out
  }

  /** What writing a file would change in the project, as a unified diff. */
  async projectDiff(designId: string, projectId: string, path: string): Promise<string> {
    const folder = this.projectFolder(projectId)
    const next = this.files(designId)[path]
    if (next === undefined) throw new Error(`${path} is not one of the system's files`)
    const cur = await readFile(join(folder, 'design', ...path.split('/')), 'utf8').catch(() => '')
    return createTwoFilesPatch(`design/${path}`, `design/${path}`, cur, next, 'in the project', 'from the design system', { context: 3 })
  }

  /** Write files into the project's design/ folder, and make the project follow the system. */
  async writeProject(designId: string, projectId: string, paths: string[]): Promise<DesignProjectSync> {
    const folder = this.projectFolder(projectId)
    const files = this.files(designId)
    for (const path of paths) {
      const content = files[path]
      if (content === undefined) continue
      const abs = join(folder, 'design', ...path.split('/'))
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
      this.ctx.kv.set(`designWritten:${projectId}:${path}`, sha(content))
    }
    this.ctx.db.prepare('UPDATE projects SET design_id = ?, updated_at = ? WHERE id = ?').run(designId, Date.now(), projectId)
    return (await this.projectSync(designId)).find((p) => p.projectId === projectId)!
  }

  private projectFolder(projectId: string): string {
    const row = this.ctx.db.prepare('SELECT folder FROM projects WHERE id = ?').get(projectId) as { folder: string | null } | undefined
    if (!row) throw new Error('Project not found')
    if (!row.folder) throw new Error('This project has no folder to write to')
    return row.folder
  }

  private async fileState(projectId: string, folder: string, path: string, content: string): Promise<DesignProjectSync['files'][number]['state']> {
    const disk = await readFile(join(folder, 'design', ...path.split('/')), 'utf8').catch(() => null)
    if (disk === null) return 'missing'
    if (disk === content) return 'current'
    // Unchanged since Cloth wrote it: safe to update. Anything else was changed by someone.
    return this.ctx.kv.get<string | null>(`designWritten:${projectId}:${path}`, null) === sha(disk) ? 'outdated' : 'edited'
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

const sha = (s: string) => createHash('sha1').update(s).digest('hex')
