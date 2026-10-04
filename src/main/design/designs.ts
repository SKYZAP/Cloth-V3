import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createTwoFilesPatch } from 'diff'
import { parseHTML } from 'linkedom'
import { mergeRules } from '@shared/cssEdit'
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
  repairTokens,
  parsePalette,
  toDesignMd,
  type ComponentVersion,
  type DesignComponent,
  type DesignDraft,
  type DesignInput,
  type DesignProjectSync,
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
    const copy = this.create({ name: `${d.name} copy`, description: d.description, input: d.input })
    // The component library comes along (current versions; the copy starts its own history).
    const insert = this.ctx.db.prepare('INSERT INTO design_components (id, design_id, name, description, html, css, usage, prompt, history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const c of this.components(id)) insert.run(newId('cmp_'), copy.id, c.name, c.description, c.html, c.css, c.usage, c.prompt, '[]', c.createdAt, c.updatedAt)
    return copy
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
  async generateComponent(input: { designId: string; prompt: string; model: ModelRef; componentId?: string; scope?: number[] }): Promise<DesignComponent> {
    const request = input.prompt.trim()
    if (!request) throw new Error('Describe the component')
    const design = this.get(input.designId)
    const current = input.componentId ? this.component(input.componentId) : null
    // A change to one element: the model writes only that element and the rules it touches, and the
    // rest of the component is spliced back around it untouched.
    const part = current && input.scope?.length ? elementHtml(current.html, input.scope) : null
    if (current && input.scope?.length && !part) throw new Error('That element is no longer in the component')
    const prompt = part
      ? `Change one part of the "${current!.name}" component: ${request}\n\nThe part (an element of the component's specimen page):\n${part}\n\nAnswer in the usual format, except: === HTML === holds ONLY the new markup that replaces this one element, and === CSS === holds ONLY the complete rules you add or change (a rule with the same selector replaces the old one; leave it empty if no CSS changes). Leave === USAGE === empty unless the usage snippet must change. Keep the component's class names.\n\nThe component's current CSS, for reference:\n${current!.css}`
      : current
        ? `Change the "${current.name}" component: ${request}\n\nKeep everything else as it is. Its current code:\n=== CSS ===\n${current.css}\n=== HTML ===\n${current.html}\n=== USAGE ===\n${current.usage}`
        : `Build this component: ${request}`
    const { text } = await this.providers.complete(input.model, { system: componentPrompt(design), prompt, maxTokens: 8000, temperature: 0.4 })
    const answer = parseComponentAnswer(text, { partial: !!part })
    if (!answer) throw new Error('The model did not return a component — try again, or a different model')
    const merged = part && current ? { html: replaceElement(current.html, input.scope!, sanitizeComponentHtml(answer.html)), css: mergeRules(current.css, repairTokens(sanitizeComponentCss(answer.css))), usage: answer.usage.trim() ? answer.usage : current.usage } : answer
    const version: ComponentVersion = { html: sanitizeComponentHtml(merged.html), css: repairTokens(sanitizeComponentCss(merged.css)), usage: sanitizeComponentHtml(merged.usage), prompt: request, createdAt: Date.now() }
    if (current) {
      const history = [{ html: current.html, css: current.css, usage: current.usage, prompt: current.prompt, createdAt: current.updatedAt }, ...current.history].slice(0, HISTORY_LIMIT)
      this.ctx.db
        .prepare('UPDATE design_components SET description = ?, html = ?, css = ?, usage = ?, prompt = ?, history = ?, updated_at = ? WHERE id = ?')
        .run((!part && answer.description) || current.description, version.html, version.css, version.usage, version.prompt, JSON.stringify(history), version.createdAt, current.id)
      return this.component(current.id)
    }
    const id = newId('cmp_')
    this.ctx.db
      .prepare('INSERT INTO design_components (id, design_id, name, description, html, css, usage, prompt, history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, design.id, answer.name || 'Component', answer.description, version.html, version.css, version.usage, version.prompt, '[]', version.createdAt, version.createdAt)
    return this.component(id)
  }

  /**
   * Hand edits (name, description or code); the previous code goes into the history. Edits with the
   * same `label` within a minute of each other (the inspector's) share one history step.
   */
  updateComponent(id: string, patch: Partial<Pick<DesignComponent, 'name' | 'description' | 'html' | 'css' | 'usage'>>, opts: { label?: string } = {}): DesignComponent {
    const cur = this.component(id)
    const label = opts.label?.trim().slice(0, 80) || 'Edited by hand'
    const codeChanged = (patch.html !== undefined && patch.html !== cur.html) || (patch.css !== undefined && patch.css !== cur.css) || (patch.usage !== undefined && patch.usage !== cur.usage)
    const sameStep = codeChanged && cur.prompt === label && Date.now() - cur.updatedAt < 60_000
    const history = codeChanged && !sameStep ? [{ html: cur.html, css: cur.css, usage: cur.usage, prompt: cur.prompt, createdAt: cur.updatedAt }, ...cur.history].slice(0, HISTORY_LIMIT) : cur.history
    this.ctx.db
      .prepare('UPDATE design_components SET name = ?, description = ?, html = ?, css = ?, usage = ?, prompt = ?, history = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name?.trim() || cur.name,
        patch.description ?? cur.description,
        patch.html === undefined ? cur.html : sanitizeComponentHtml(patch.html),
        patch.css === undefined ? cur.css : sanitizeComponentCss(patch.css),
        patch.usage === undefined ? cur.usage : sanitizeComponentHtml(patch.usage),
        codeChanged ? label : cur.prompt,
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

// ─── Markup by element path (child-element indices from <body>, as the editor addresses them) ──

// linkedom's DOM is untyped for a Node tsconfig (no DOM lib); keep the `any` contained here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dom = any

function walk(html: string, path: number[]): { body: Dom; el: Dom | null } {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`) as Dom
  let el: Dom = document.body
  for (const i of path) {
    el = el?.children?.[i] ?? null
    if (!el) break
  }
  return { body: document.body, el: el === document.body ? null : el }
}

function elementHtml(html: string, path: number[]): string | null {
  return walk(html, path).el?.outerHTML ?? null
}

function replaceElement(html: string, path: number[], replacement: string): string {
  const { body, el } = walk(html, path)
  if (!el) throw new Error('That element is no longer in the component')
  const holder = el.ownerDocument.createElement('div')
  holder.innerHTML = replacement
  el.replaceWith(...holder.childNodes)
  return body.innerHTML
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex')
