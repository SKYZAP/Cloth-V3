import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'
import type { ModelRef, Skill, SkillInput, SkillSource } from '@shared/types'
import { json } from '../core/db'
import type { Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface ExternalSkill {
  name: string
  description: string
  dir: string
  source: string
  imported: boolean
}

export function parseSkillMd(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return { frontmatter: {}, body: text.trim() }
  let frontmatter: Record<string, unknown> = {}
  try {
    frontmatter = (YAML.parse(m[1]) as Record<string, unknown>) ?? {}
  } catch {
    frontmatter = {}
  }
  return { frontmatter, body: m[2].trim() }
}

export function serializeSkillMd(fm: Record<string, unknown>, body: string): string {
  const { name, description, ...rest } = fm
  const ordered = { name, description, ...rest }
  return `---\n${YAML.stringify(ordered, { lineWidth: 0 }).trim()}\n---\n\n${body.trim()}\n`
}

const SKILL_AUTHOR = `You write agent skills: a SKILL.md file that teaches an AI coding agent how to do one kind of task well.

Format — reply with the file only, no commentary and no code fence around it:
---
name: kebab-case-name
description: One or two sentences. Say what the skill does AND when to use it (the situations, keywords or file types that should trigger it). Agents decide whether to load the skill from this line alone.
---

# Title

Then the instructions, in Markdown. Good skills:
- Start with a short "When to use" list, then numbered steps the agent should follow.
- Are concrete: exact commands, file names, code patterns, APIs and settings, with short examples.
- Cover the pitfalls and checks a capable engineer would otherwise miss; skip generic advice the agent already knows.
- Stay focused on one job and under ~400 lines.`

/** Pull name / description / body out of a model-written SKILL.md (tolerating a code fence around it). */
export function parseGeneratedSkill(text: string): SkillInput {
  const raw = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, '$1').trim()
  const start = raw.indexOf('---')
  const { frontmatter, body } = parseSkillMd(start > 0 ? raw.slice(start) : raw)
  const name = slugify(String(frontmatter.name ?? ''))
  const description = String(frontmatter.description ?? '').trim()
  if (!name || !description || !body) throw new Error('The model did not return a usable SKILL.md (it needs a name, a description and instructions)')
  const { name: _n, description: _d, ...rest } = frontmatter
  return { name, description, body, frontmatter: rest }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export class SkillService {
  constructor(
    private ctx: Ctx,
    private providers: ProviderService
  ) {}

  /** Where a skill's files live (scripts it bundles run from here). */
  folder(name: string): string {
    return this.dir(name)
  }

  /**
   * A skill's instructions as an agent should see them: ${CLAUDE_SKILL_DIR} (and ${SKILL_DIR}) point at
   * its folder, so skills written for Claude Code can run their bundled scripts.
   */
  instructions(skill: Pick<Skill, 'name' | 'body' | 'files'>): string {
    const folder = this.dir(skill.name).replace(/\\/g, '/')
    const body = skill.body.replace(/\$\{(CLAUDE_SKILL_DIR|SKILL_DIR)\}/g, folder)
    const scripts = skill.files.filter((f) => /\.(py|js|mjs|cjs|sh|ps1|ts)$/i.test(f))
    if (!scripts.length) return body
    const list = `${scripts.slice(0, 4).join(', ')}${scripts.length > 4 ? ', …' : ''}`
    return `${body}\n\nThis skill's folder is ${folder} — run its scripts (${list}) from there with the shell when shell access is on.`
  }

  private dir(name: string): string {
    if (!NAME_RE.test(name)) throw new Error(`Invalid skill name "${name}" — use lowercase letters, digits and dashes`)
    return join(this.ctx.skillsDir, name)
  }

  async list(): Promise<Skill[]> {
    await mkdir(this.ctx.skillsDir, { recursive: true })
    const entries = await readdir(this.ctx.skillsDir, { withFileTypes: true })
    const skills: Skill[] = []
    for (const e of entries) {
      if (!e.isDirectory() || !existsSync(join(this.ctx.skillsDir, e.name, 'SKILL.md'))) continue
      try {
        skills.push(await this.get(e.name))
      } catch (err) {
        this.ctx.log('skills', `failed to read ${e.name}`, err)
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(name: string): Promise<Skill> {
    const dir = this.dir(name)
    const file = join(dir, 'SKILL.md')
    const raw = await readFile(file, 'utf8')
    const { frontmatter, body } = parseSkillMd(raw)
    const s = await stat(file)
    return {
      name,
      description: String(frontmatter.description ?? ''),
      body,
      frontmatter,
      dir,
      files: await listFiles(dir),
      updatedAt: s.mtimeMs,
      source: await readSourceFile(dir)
    }
  }

  async create(input: SkillInput, opts: { files?: { path: string; content: string }[]; unique?: boolean } = {}): Promise<Skill> {
    let name = slugify(input.name)
    if (!name) throw new Error('A skill needs a name')
    if (opts.unique) for (let i = 2; existsSync(join(this.ctx.skillsDir, name)); i++) name = `${slugify(input.name).slice(0, 60)}-${i}`
    const dir = this.dir(name)
    if (existsSync(dir)) throw new Error(`Skill "${name}" already exists`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), serializeSkillMd({ ...(input.frontmatter ?? {}), name, description: input.description }, input.body))
    try {
      for (const f of opts.files ?? []) {
        if (/^skill\.md$/i.test(f.path.trim())) continue
        await this.writeFile(name, f.path, f.content)
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true })
      throw err
    }
    this.ctx.emit('skills', { type: 'changed', name })
    return this.get(name)
  }

  /** Have a model write a skill from a plain-language request, then save it (under a free name). */
  async generate(input: { request: string; model: ModelRef; name?: string }): Promise<Skill> {
    const request = input.request.trim()
    if (!request) throw new Error('Describe what the skill should do')
    const existing = (await this.list()).map((s) => s.name)
    const { text } = await this.providers.complete(input.model, {
      system: SKILL_AUTHOR,
      prompt: [
        `Write a skill for this request:\n\n${request}`,
        input.name?.trim() ? `\nName it "${slugify(input.name)}".` : '',
        existing.length ? `\nSkills that already exist (do not duplicate their names): ${existing.join(', ')}` : ''
      ].join(''),
      maxTokens: 8000,
      temperature: 0.4
    })
    const draft = parseGeneratedSkill(text)
    if (input.name?.trim()) draft.name = slugify(input.name)
    return this.create(draft, { unique: true })
  }

  async update(name: string, input: SkillInput): Promise<Skill> {
    const nextName = slugify(input.name) || name
    let dir = this.dir(name)
    if (nextName !== name) {
      const target = this.dir(nextName)
      if (existsSync(target)) throw new Error(`Skill "${nextName}" already exists`)
      await rename(dir, target)
      this.ctx.db.prepare('UPDATE skill_runs SET skill_name = ? WHERE skill_name = ?').run(nextName, name)
      dir = target
    }
    await writeFile(join(dir, 'SKILL.md'), serializeSkillMd({ ...(input.frontmatter ?? {}), name: nextName, description: input.description }, input.body))
    this.ctx.emit('skills', { type: 'changed', name: nextName })
    return this.get(nextName)
  }

  /** Soft delete: moves the folder into <data>/skills-trash. */
  async remove(name: string): Promise<void> {
    const trash = join(this.ctx.dataDir, 'skills-trash')
    await mkdir(trash, { recursive: true })
    await rename(this.dir(name), join(trash, `${name}-${Date.now()}`))
    this.ctx.emit('skills', { type: 'changed', name })
  }

  async readFile(name: string, rel: string): Promise<string> {
    const dir = this.dir(name)
    const full = resolve(dir, rel)
    if (!full.startsWith(dir + sep)) throw new Error('Path escapes the skill folder')
    return readFile(full, 'utf8')
  }

  async writeFile(name: string, rel: string, content: string): Promise<void> {
    const dir = this.dir(name)
    const full = resolve(dir, rel)
    if (!full.startsWith(dir + sep)) throw new Error('Path escapes the skill folder')
    await mkdir(resolve(full, '..'), { recursive: true })
    await writeFile(full, content)
  }

  // ─── External sources ─────────────────────────────────────────────────────

  knownSources(): string[] {
    const home = homedir()
    return [join(home, '.claude', 'skills'), join(home, '.agents', 'skills'), join(home, '.codex', 'skills'), join(home, '.cursor', 'skills'), join(home, '.omp', 'skills')]
  }

  async discover(extra: string[] = []): Promise<ExternalSkill[]> {
    const local = new Set((await this.list()).map((s) => s.name))
    const out: ExternalSkill[] = []
    for (const src of [...this.knownSources(), ...extra]) {
      if (!existsSync(src)) continue
      for (const dir of await findSkillDirs(src)) {
        try {
          const { frontmatter } = parseSkillMd(await readFile(join(dir, 'SKILL.md'), 'utf8'))
          const name = slugify(String(frontmatter.name ?? basename(dir)))
          out.push({ name, description: String(frontmatter.description ?? ''), dir, source: src, imported: local.has(name) })
        } catch {
          /* skip unreadable */
        }
      }
    }
    return out
  }

  /** Copy a skill folder (or every skill under a folder) into the hub. */
  async importFrom(path: string, overwrite = false): Promise<string[]> {
    const dirs = existsSync(join(path, 'SKILL.md')) ? [path] : await findSkillDirs(path)
    if (!dirs.length) throw new Error('No SKILL.md found at that location')
    const imported: string[] = []
    for (const dir of dirs) {
      const { frontmatter } = parseSkillMd(await readFile(join(dir, 'SKILL.md'), 'utf8'))
      const name = slugify(String(frontmatter.name ?? basename(dir)))
      const target = this.dir(name)
      if (existsSync(target)) {
        if (!overwrite) continue
        await rm(target, { recursive: true, force: true })
      }
      await cp(dir, target, { recursive: true })
      imported.push(name)
    }
    return imported
  }

  /** Install a hub skill into another tool's skills folder (e.g. ~/.claude/skills). */
  async exportTo(name: string, targetRoot: string): Promise<string> {
    const target = join(targetRoot, name)
    await mkdir(targetRoot, { recursive: true })
    await rm(target, { recursive: true, force: true })
    await cp(this.dir(name), target, { recursive: true })
    return target
  }
}

export function skillSystemPrompt(skill: Pick<Skill, 'name' | 'description' | 'body'>): string {
  return `You are a helpful assistant. The following skill has been loaded — follow its instructions when relevant.\n\n<skill name="${skill.name}">\n${skill.description}\n\n${skill.body}\n</skill>`
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (!e.name.startsWith('.cloth')) out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  await walk(dir)
  return out.sort()
}

async function findSkillDirs(root: string, depth = 3): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, level: number) => {
    if (existsSync(join(d, 'SKILL.md'))) {
      out.push(d)
      return
    }
    if (level >= depth) return
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.git')) await walk(join(d, e.name), level + 1)
  }
  await walk(root, 0)
  return out
}

async function readSourceFile(dir: string): Promise<SkillSource | null> {
  const file = join(dir, '.cloth-source.json')
  if (!existsSync(file)) return null
  return json<SkillSource | null>(await readFile(file, 'utf8'), null)
}
