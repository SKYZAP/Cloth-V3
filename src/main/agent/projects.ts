import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_COLORS, type ChatSession, type Project, type ProjectDefaults, type ProjectInput } from '@shared/types'
import { json } from '../core/db'
import { newId, type Ctx } from '../core/context'
import type { ChatService } from './chat'
import type { DesignService } from '../design/designs'

interface ProjectRow {
  id: string
  name: string
  folder: string | null
  color: string
  instructions: string
  defaults: string
  design_id: string | null
  created_at: number
  updated_at: number
}

/** Files in a project folder whose contents become part of every chat's instructions. */
const NOTE_FILES = ['AGENTS.md', 'CLAUDE.md']
const NOTE_LIMIT = 12_000

/** kv key holding the Automation project's id (its stable marker: the name may change). */
const AUTOMATION_KEY = 'automation.projectId'
const AUTOMATION_MIGRATED_KEY = 'automation.chatsMigrated'
const AUTOMATION_COLOR = PROJECT_COLORS[6]

const toProject = (r: ProjectRow, automationId: string | null): Project => ({
  id: r.id,
  name: r.name,
  folder: r.folder,
  color: r.color,
  instructions: r.instructions,
  defaults: json<ProjectDefaults>(r.defaults, {}),
  designId: r.design_id ?? null,
  ...(r.id === automationId ? { builtin: 'automation' as const } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

/** Projects group chats under a shared folder, instructions and starting settings. */
export class ProjectService {
  constructor(
    private ctx: Ctx,
    private chats: () => ChatService,
    private designs?: DesignService,
    private defaultDesign: () => string | null = () => null
  ) {}

  list(): Project[] {
    const automationId = this.automationId()
    return (this.ctx.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as unknown as ProjectRow[]).map((r) => toProject(r, automationId))
  }

  get(id: string): Project {
    const row = this.ctx.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined
    if (!row) throw new Error('Project not found')
    return toProject(row, this.automationId())
  }

  find(id: string | null | undefined): Project | null {
    if (!id) return null
    try {
      return this.get(id)
    } catch {
      return null
    }
  }

  create(input: ProjectInput): Project {
    const name = input.name?.trim()
    if (!name) throw new Error('Give the project a name')
    const id = newId('prj_')
    const now = Date.now()
    const color = input.color ?? PROJECT_COLORS[this.list().length % PROJECT_COLORS.length]
    this.ctx.db
      .prepare('INSERT INTO projects (id, name, folder, color, instructions, defaults, design_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, input.folder || null, color, input.instructions ?? '', JSON.stringify(input.defaults ?? {}), input.designId === undefined ? (this.designs?.find(this.defaultDesign())?.id ?? null) : input.designId, now, now)
    return this.get(id)
  }

  update(id: string, patch: ProjectInput): Project {
    const cur = this.get(id)
    const name = patch.name === undefined ? cur.name : patch.name.trim()
    if (!name) throw new Error('Give the project a name')
    const folder = patch.folder === undefined ? cur.folder : patch.folder || null
    this.ctx.db
      .prepare('UPDATE projects SET name = ?, folder = ?, color = ?, instructions = ?, defaults = ?, design_id = ?, updated_at = ? WHERE id = ?')
      .run(name, folder, patch.color ?? cur.color, patch.instructions ?? cur.instructions, JSON.stringify(patch.defaults ?? cur.defaults), patch.designId === undefined ? cur.designId : patch.designId, Date.now(), id)
    // Chats still working in the old folder follow the project to the new one.
    if (folder !== cur.folder) {
      for (const c of this.chatsIn(id)) if (c.workspace === cur.folder) this.chats().update(c.id, { workspace: folder })
    }
    return this.get(id)
  }

  /** Deletes the project; its chats are kept (moved out of it) unless `deleteChats`. */
  remove(id: string, opts: { deleteChats?: boolean } = {}): void {
    const p = this.get(id)
    if (p.builtin) throw new Error(`${p.name} is built in: automations file their chats there, so it can be edited but not deleted`)
    for (const c of this.chatsIn(id)) {
      if (opts.deleteChats) this.chats().remove(c.id)
      else this.chats().update(c.id, { projectId: null })
    }
    this.ctx.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  /**
   * The project automation chats are filed under, made on first use. Found by the id kept in kv, so a
   * rename keeps it. It is built in and cannot be deleted (one deleted before that rule is made again).
   */
  automationProject(): Project {
    const known = this.find(this.automationId())
    if (known) return known
    const p = this.create({ name: 'Automation', folder: null, color: AUTOMATION_COLOR, designId: null })
    this.ctx.kv.set(AUTOMATION_KEY, p.id)
    return this.get(p.id)
  }

  private automationId(): string | null {
    return this.ctx.kv.get<string | null>(AUTOMATION_KEY, null)
  }

  /**
   * Once: files chats automations made before they had a project (given by id, plus any marked with an
   * automation origin) under the Automation project. Chats already in a project stay where they are.
   */
  migrateAutomationChats(chatIds: Iterable<string>): number {
    if (this.ctx.kv.get(AUTOMATION_MIGRATED_KEY, false)) return 0
    const ids = new Set(chatIds)
    const loose = this.chats()
      .list()
      .filter((c) => !c.projectId && (ids.has(c.id) || c.origin?.kind === 'automation'))
    if (loose.length) {
      const projectId = this.automationProject().id
      for (const c of loose) this.chats().update(c.id, { projectId })
    }
    this.ctx.kv.set(AUTOMATION_MIGRATED_KEY, true)
    return loose.length
  }

  /** Settings for a new chat in this project: its defaults, plus the folder as the workspace. */
  chatConfig(id: string): Partial<ChatSession> {
    const p = this.get(id)
    return { ...p.defaults, projectId: p.id, ...(p.folder ? { workspace: p.folder } : {}) }
  }

  /** The project's part of a chat's system prompt: its instructions and the folder's AGENTS.md / CLAUDE.md. */
  async instructions(id: string | null): Promise<string> {
    const p = this.find(id)
    if (!p) return ''
    const parts = [`This chat belongs to the project "${p.name}".`]
    if (p.instructions.trim()) parts.push(p.instructions.trim())
    if (p.folder) {
      for (const file of NOTE_FILES) {
        const text = await readFile(join(p.folder, file), 'utf8').catch(() => null)
        if (text === null || !text.trim()) continue
        const body = text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}\n… (truncated)` : text
        parts.push(`Project notes from ${file}:\n\n${body.trim()}`)
        break
      }
    }
    const design = this.designs?.find(p.designId)
    if (design) parts.push(`The project follows the design system below: build any UI with its tokens and rules.\n\n${this.designs!.markdown(design.id)}`)
    return parts.join('\n\n')
  }

  private chatsIn(id: string): ChatSession[] {
    return this.chats()
      .list()
      .filter((c) => c.projectId === id)
  }
}
