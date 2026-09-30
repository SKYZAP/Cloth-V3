import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'
import type {
  ModelRef,
  Skill,
  SkillAuditIssue,
  SkillCaseResult,
  SkillEvalCase,
  SkillHealth,
  SkillInput,
  SkillRun,
  SkillSource,
  SkillTestInput,
  SkillVerdict
} from '@shared/types'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import { parseJsonLoose } from '../core/llm-json'
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
  private pending = new Map<string, Promise<void>>()

  constructor(
    private ctx: Ctx,
    private providers: ProviderService
  ) {}

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
      evals: await readEvalsFile(dir),
      health: this.health(name),
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

  async saveEvals(name: string, cases: SkillEvalCase[]): Promise<Skill> {
    const clean = cases
      .filter((c) => c.prompt.trim())
      .map((c) => ({ id: c.id || newId('case_'), prompt: c.prompt, expectations: c.expectations.map((e) => e.trim()).filter(Boolean) }))
    await writeFile(join(this.dir(name), 'evals.json'), JSON.stringify({ cases: clean }, null, 2))
    return this.get(name)
  }

  /** Ask a model to draft eval cases for a skill. */
  async draftEvals(name: string, model: ModelRef): Promise<SkillEvalCase[]> {
    const skill = await this.get(name)
    const { text } = await this.providers.complete(model, {
      system: 'You write evaluation cases for AI agent skills. Reply with JSON only.',
      prompt: `Skill "${skill.name}": ${skill.description}\n\n${skill.body.slice(0, 12_000)}\n\nWrite 3 realistic user prompts that should trigger this skill, each with 2-4 objectively checkable expectations about a correct response (things the skill teaches that a model without it would likely miss). JSON: {"cases": [{"prompt": "...", "expectations": ["..."]}]}`,
      maxTokens: 3000,
      temperature: 0.4
    })
    const parsed = parseJsonLoose<{ cases: { prompt: string; expectations: string[] }[] }>(text)
    if (!parsed?.cases?.length) throw new Error('Model did not return eval cases')
    return parsed.cases.map((c) => ({ id: newId('case_'), prompt: String(c.prompt), expectations: (c.expectations ?? []).map(String) }))
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

  // ─── Testing ──────────────────────────────────────────────────────────────

  runs(name: string, limit = 20): SkillRun[] {
    const rows = this.ctx.db
      .prepare('SELECT data FROM skill_runs WHERE skill_name = ? ORDER BY created_at DESC LIMIT ?')
      .all(name, limit) as { data: string }[]
    return rows.map((r) => json<SkillRun>(r.data, null as unknown as SkillRun)).filter(Boolean)
  }

  private health(name: string): SkillHealth | null {
    const last = this.runs(name, 1)[0]
    if (!last || last.status !== 'done') return null
    return { verdict: last.verdict, lastRunAt: last.finishedAt ?? last.createdAt, lastScore: last.score, model: last.model }
  }

  private saveRun(run: SkillRun): void {
    this.ctx.db
      .prepare('INSERT INTO skill_runs (id, skill_name, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(run.id, run.skillName, JSON.stringify(run), run.createdAt)
    this.ctx.emit('skills', { type: 'run', run })
  }

  /** Starts a test run in the background; returns the run immediately. */
  startTest(input: SkillTestInput): SkillRun {
    const run: SkillRun = {
      id: newId('run_'),
      skillName: input.name,
      kind: 'eval',
      model: input.model,
      judge: input.judge ?? input.model,
      status: 'running',
      score: null,
      baselineScore: null,
      cases: [],
      issues: [],
      summary: '',
      verdict: 'untested',
      error: null,
      createdAt: Date.now(),
      finishedAt: null
    }
    this.saveRun(run)
    const done = this.executeTest(run, input)
      .catch((err) => {
        run.status = 'error'
        run.error = errorMessage(err)
        run.finishedAt = Date.now()
        this.saveRun(run)
      })
      .finally(() => this.pending.delete(run.id))
    this.pending.set(run.id, done)
    return run
  }

  /** Runs a test to completion (used by workflows and MCP). */
  async test(input: SkillTestInput): Promise<SkillRun> {
    const run = this.startTest(input)
    await this.pending.get(run.id)
    return run
  }

  private async executeTest(run: SkillRun, input: SkillTestInput): Promise<void> {
    const skill = await this.get(input.name)
    if (!skill.evals.length && !input.audit) throw new Error('This skill has no eval cases — add some, or run the freshness audit')
    run.kind = skill.evals.length ? 'eval' : 'audit'
    const judge = run.judge
    const previous = this.runs(skill.name, 10).find((r) => r.id !== run.id && r.status === 'done' && r.score !== null && sameModel(r.model, run.model))

    for (const c of skill.evals) {
      const result: SkillCaseResult = { caseId: c.id, prompt: c.prompt, output: '', expectations: [], score: 0 }
      result.output = (await this.providers.complete(run.model, { system: skillSystemPrompt(skill), prompt: c.prompt, maxTokens: 4000, temperature: 0 })).text
      result.expectations = await this.grade(judge, c, result.output)
      result.score = ratio(result.expectations)
      if (input.baseline) {
        result.baselineOutput = (await this.providers.complete(run.model, { system: 'You are a helpful assistant.', prompt: c.prompt, maxTokens: 4000, temperature: 0 })).text
        result.baselineScore = ratio(await this.grade(judge, c, result.baselineOutput))
      }
      run.cases.push(result)
      this.saveRun(run)
    }

    if (input.audit) {
      run.issues = await this.audit(skill, judge)
      this.saveRun(run)
    }

    run.score = run.cases.length ? avg(run.cases.map((c) => c.score)) : null
    run.baselineScore = input.baseline && run.cases.length ? avg(run.cases.map((c) => c.baselineScore ?? 0)) : null
    const { verdict, summary } = computeVerdict(run, previous?.score ?? null, !!input.audit)
    run.verdict = verdict
    run.summary = summary
    run.status = 'done'
    run.finishedAt = Date.now()
    this.saveRun(run)
  }

  private async grade(judge: ModelRef, c: SkillEvalCase, output: string) {
    if (!c.expectations.length) return []
    const { text } = await this.providers.complete(judge, {
      system: 'You are a strict grader. Judge only what the response actually contains. Reply with JSON only.',
      prompt: `User prompt:\n${c.prompt}\n\nResponse:\n${output.slice(0, 16_000)}\n\nExpectations:\n${c.expectations.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nFor each expectation decide pass/fail with a one-sentence reason. JSON: {"results": [{"i": 1, "pass": true, "reason": "..."}]}`,
      maxTokens: 1200,
      temperature: 0
    })
    const parsed = parseJsonLoose<{ results: { i: number; pass: boolean; reason: string }[] }>(text)
    return c.expectations.map((expectation, i) => {
      const r = parsed?.results?.find((x) => x.i === i + 1)
      return { expectation, pass: !!r?.pass, reason: r?.reason ?? 'Grader gave no verdict' }
    })
  }

  /** Freshness audit: the model reviews the skill for outdated APIs, versions and advice. */
  private async audit(skill: Skill, model: ModelRef): Promise<SkillAuditIssue[]> {
    const { text } = await this.providers.complete(model, {
      system: `You audit AI agent skills for staleness. Today is ${new Date().toISOString().slice(0, 10)}. Flag only concrete problems: deprecated or renamed APIs, outdated version numbers or install commands, removed CLI flags, advice superseded by current best practice, broken assumptions. Do not nitpick style. Reply with JSON only.`,
      prompt: `Skill "${skill.name}": ${skill.description}\n\n${skill.body.slice(0, 20_000)}\n\nJSON: {"issues": [{"severity": "high|medium|low", "excerpt": "exact short quote", "problem": "...", "suggestion": "..."}]}  — empty list if nothing is outdated.`,
      maxTokens: 2000,
      temperature: 0
    })
    const parsed = parseJsonLoose<{ issues: SkillAuditIssue[] }>(text)
    return (parsed?.issues ?? []).map((i) => ({
      severity: (['high', 'medium', 'low'].includes(i.severity) ? i.severity : 'low') as SkillAuditIssue['severity'],
      excerpt: String(i.excerpt ?? ''),
      problem: String(i.problem ?? ''),
      suggestion: String(i.suggestion ?? '')
    }))
  }
}

export function skillSystemPrompt(skill: Pick<Skill, 'name' | 'description' | 'body'>): string {
  return `You are a helpful assistant. The following skill has been loaded — follow its instructions when relevant.\n\n<skill name="${skill.name}">\n${skill.description}\n\n${skill.body}\n</skill>`
}

export function computeVerdict(
  run: Pick<SkillRun, 'score' | 'baselineScore' | 'issues' | 'cases'>,
  previousScore: number | null,
  audited: boolean
): { verdict: SkillVerdict; summary: string } {
  const high = run.issues.filter((i) => i.severity === 'high').length
  const parts: string[] = []
  if (run.score !== null) parts.push(`${Math.round(run.score * 100)}% of expectations met`)
  if (run.baselineScore !== null) parts.push(`baseline without skill ${Math.round(run.baselineScore * 100)}%`)
  if (audited) parts.push(run.issues.length ? `${run.issues.length} audit issue(s), ${high} high` : 'audit found nothing outdated')
  if (previousScore !== null && run.score !== null) parts.push(`previous run ${Math.round(previousScore * 100)}%`)
  const summary = parts.join(' · ') || 'Nothing to test — add eval cases or enable the audit'

  if (run.score === null && !audited) return { verdict: 'untested', summary }
  if (run.score !== null && run.score < 0.5) return { verdict: 'failing', summary }
  const regressed = previousScore !== null && run.score !== null && previousScore - run.score >= 0.2
  if (high > 0 || regressed || (run.score !== null && run.score < 0.8)) return { verdict: 'stale', summary }
  if (run.baselineScore !== null && run.score !== null && run.baselineScore >= run.score) return { verdict: 'redundant', summary }
  return { verdict: 'fresh', summary }
}

function ratio(results: { pass: boolean }[]): number {
  return results.length ? results.filter((r) => r.pass).length / results.length : 0
}
function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}
function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId
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

async function readEvalsFile(dir: string): Promise<SkillEvalCase[]> {
  const file = join(dir, 'evals.json')
  if (!existsSync(file)) return []
  const parsed = json<{ cases?: SkillEvalCase[] } | SkillEvalCase[]>(await readFile(file, 'utf8'), [])
  const cases = Array.isArray(parsed) ? parsed : (parsed.cases ?? [])
  return cases.map((c, i) => ({ id: c.id || `case_${i + 1}`, prompt: String(c.prompt ?? ''), expectations: (c.expectations ?? []).map(String) }))
}
