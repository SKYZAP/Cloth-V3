import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelRef } from '@shared/types'
import { DEFAULT_DESIGN, designFiles, sanitizeDesign, toDesignMd, type DesignDraft, type DesignInput, type DesignSystem } from '@shared/design'
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
  "neutralTint": 0..1 (how much the greys lean towards the brand hue; 0 = pure grey),
  "mode": "dark" | "light" | "both",
  "fontSans": body font (a real Google Font, e.g. Inter, Geist, IBM Plex Sans, Manrope, DM Sans),
  "fontHeading": heading font (can match fontSans, or a display/serif font like Space Grotesk, Fraunces),
  "fontMono": code font (JetBrains Mono, Geist Mono, IBM Plex Mono, Fira Code),
  "baseSize": body size in px (13-18),
  "scale": type scale ratio (1.125, 1.2, 1.25, 1.333 or 1.5),
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
    const prompt = input.current ? `${input.prompt.trim()}\n\nCurrent system (change what the description asks for, keep the rest):\n${JSON.stringify(input.current)}` : input.prompt.trim()
    const { text } = await this.providers.complete(input.model, { system: GENERATE_SYSTEM, prompt, maxTokens: 2000, temperature: 0.7 })
    const raw = parseJsonObject(text)
    if (!raw) throw new Error('The model did not return a design — try again, or a different model')
    return {
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : 'Untitled',
      description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 300) : '',
      input: sanitizeDesign(raw, input.current ?? DEFAULT_DESIGN)
    }
  }

  /** Every export file, by name. */
  files(id: string): Record<string, string> {
    return designFiles(this.get(id))
  }

  /** DESIGN.md, for a project's chats. */
  markdown(id: string): string {
    return toDesignMd(this.get(id))
  }

  /** Writes DESIGN.md and the token files into `folder`. Returns the written paths. */
  async export(id: string, folder: string): Promise<string[]> {
    await mkdir(folder, { recursive: true })
    const out: string[] = []
    for (const [name, content] of Object.entries(this.files(id))) {
      const p = join(folder, name)
      await writeFile(p, content)
      out.push(p)
    }
    return out
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
