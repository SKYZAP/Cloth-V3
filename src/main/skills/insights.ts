import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelRef, Skill, SkillCheck, SkillInsight, SkillSafetyFinding, SkillTrigger, SkillTriggerRun, SkillUsage } from '@shared/types'
import type { Ctx } from '../core/context'
import { parseJsonLoose } from '../core/llm-json'
import type { ProviderService } from '../providers/providers'
import type { SkillService } from './skills'

const DAY = 86_400_000
const WEEKS = 6
const SCRIPT = /\.(py|js|mjs|cjs|ts|sh|ps1|bash)$/i
const TEXT = /\.(md|txt|py|js|mjs|cjs|ts|sh|ps1|bash|json|ya?ml|toml|html|css|csv)$/i

/** Patterns worth a look in an imported skill, by what they touch. Not proof of harm: a list to read. */
const RISKS: { kind: SkillSafetyFinding['kind']; re: RegExp; scripts?: boolean; docs?: boolean }[] = [
  { kind: 'network', re: /\b(fetch\(|axios|requests\.(get|post|put)|urllib|http\.client|XMLHttpRequest|curl\s|wget\s|Invoke-WebRequest|Invoke-RestMethod)/, scripts: true },
  { kind: 'shell', re: /\b(subprocess|child_process|os\.system|os\.popen|execSync|execFile|spawn\(|Invoke-Expression|\beval\(|\bexec\()/, scripts: true },
  { kind: 'files', re: /\b(writeFile|appendFile|fs\.(write|rm|unlink)|open\([^)]*['"][wa]b?['"]|shutil\.rmtree|os\.remove|unlink\(|rm\s+-rf|Remove-Item)/, scripts: true },
  { kind: 'injection', re: /(ignore (all |any )?(previous|prior|above) instructions|do not (tell|inform|show) the user|without (telling|asking|informing) the user|exfiltrat|reveal (your|the) system prompt|disable (safety|approvals))/i, docs: true }
]

const STOP = new Set('this that with when from your have will them they then than what which into about such also uses using used user users skill skills these those their there where while more most must should would could each other only very just like make made does when'.split(' '))
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z-]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [])

/** What the Skills page shows about a skill besides its text: use, checks, a safety scan and trigger checks. */
export class SkillInsights {
  private runtimes = new Map<string, boolean>()

  constructor(
    private ctx: Ctx,
    private skills: SkillService,
    private providers: ProviderService
  ) {}

  async insight(name: string): Promise<SkillInsight> {
    const skill = await this.skills.get(name)
    const all = await this.skills.list()
    const overlaps = this.overlaps(skill, all)
    const files = await this.texts(skill)
    return {
      usage: this.usage(name),
      checks: await this.checks(skill, files, overlaps),
      safety: { findings: this.scan(files), ...this.review(name, files) },
      triggers: this.ctx.kv.get<SkillTrigger[]>(`skillTriggers:${name}`, []),
      lastTrigger: this.ctx.kv.get<SkillTriggerRun | null>(`skillTriggerRun:${name}`, null),
      overlaps
    }
  }

  /** How many times each skill was used, and when last (for the skill list). */
  usageAll(): Record<string, { total: number; lastUsedAt: number }> {
    const rows = this.ctx.db.prepare("SELECT name, COUNT(*) AS n, MAX(at) AS last FROM usage_events WHERE kind = 'skill' GROUP BY name").all() as { name: string; n: number; last: number }[]
    return Object.fromEntries(rows.map((r) => [r.name, { total: r.n, lastUsedAt: r.last }]))
  }

  /** Last used, how often per week, how it was invoked and in how many chats. */
  usage(name: string, now = Date.now()): SkillUsage {
    const rows = this.ctx.db.prepare("SELECT at, detail, source, ref FROM usage_events WHERE kind = 'skill' AND name = ? ORDER BY at").all(name) as { at: number; detail: string | null; source: string; ref: string | null }[]
    const weeks = Array.from({ length: WEEKS }, () => 0)
    const byVia: Record<string, number> = {}
    const chats = new Set<string>()
    for (const r of rows) {
      const ago = Math.floor((now - r.at) / (7 * DAY))
      if (ago >= 0 && ago < WEEKS) weeks[WEEKS - 1 - ago]++
      const via = r.detail === 'tool' ? 'auto' : (r.detail ?? 'other')
      byVia[via] = (byVia[via] ?? 0) + 1
      if (r.source === 'chat' && r.ref) chats.add(r.ref)
    }
    return { total: rows.length, byVia, weeks, chats: chats.size, lastUsedAt: rows.at(-1)?.at ?? null }
  }

  /** Quick local checks: the description, references to files, paths and runtimes, and size. */
  private async checks(skill: Skill, files: Map<string, string>, overlaps: string[]): Promise<SkillCheck[]> {
    const out: SkillCheck[] = []
    const d = skill.description.trim()
    if (!d) out.push({ id: 'description', level: 'warn', title: 'No description', detail: 'Agents decide whether to load a skill from its description alone.' })
    else if (d.length < 40) out.push({ id: 'description', level: 'warn', title: 'Description is very short', detail: 'Say what it does and when to use it, with words people use when they need it.' })
    else if (d.length > 1024) out.push({ id: 'description', level: 'warn', title: 'Description is over 1024 characters', detail: 'Some tools cut it off; keep the trigger words early.' })
    else if (/\b(when|whenever|use (it |this )?(for|before|after))\b/i.test(d)) out.push({ id: 'description', level: 'ok', title: 'Description says when to use it' })
    else out.push({ id: 'description', level: 'note', title: "Description doesn't say when to use it", detail: 'Add "Use when …" with the situations and words that should load it.' })

    const body = files.get('SKILL.md') ?? skill.body
    const refs = [...new Set([...body.matchAll(/(?<![\w/:.])((?:\.\/)?[\w-]+(?:\/[\w.-]+)+\.[a-z]{1,5})\b/gi)].map((m) => m[1].replace(/^\.\//, '')))].filter((r) => !/^https?:/.test(r))
    const missing = refs.filter((r) => !skill.files.includes(r) && !r.includes('${'))
    if (missing.length) out.push({ id: 'refs', level: 'warn', title: `${missing.length} referenced file${missing.length > 1 ? 's are' : ' is'} missing`, detail: missing.slice(0, 6).join(', ') })
    else if (refs.length) out.push({ id: 'refs', level: 'ok', title: 'Referenced files are all there' })

    const plugin = [...files].filter(([, text]) => text.includes('${CLAUDE_PLUGIN_ROOT}')).map(([f]) => f)
    if (plugin.length) out.push({ id: 'plugin-root', level: 'warn', title: 'Uses ${CLAUDE_PLUGIN_ROOT}', detail: `Only Claude Code plugins define it, so these paths won't resolve here (${plugin.slice(0, 3).join(', ')}). Use \${CLAUDE_SKILL_DIR} instead.` })

    const scripts = skill.files.filter((f) => SCRIPT.test(f))
    const need = new Set<string>()
    for (const f of scripts) {
      if (/\.py$/i.test(f)) need.add('python')
      if (/\.(sh|bash)$/i.test(f)) need.add('bash')
    }
    for (const rt of need) {
      const found = this.hasRuntime(rt)
      out.push(found ? { id: `rt-${rt}`, level: 'ok', title: `Its scripts need ${rt === 'python' ? 'Python' : 'bash'}, which was found` } : { id: `rt-${rt}`, level: 'warn', title: `Its scripts need ${rt === 'python' ? 'Python' : 'bash'}, which wasn't found`, detail: `Install ${rt === 'python' ? 'Python 3' : 'Git for Windows (bash)'} or the skill's scripts will fail.` })
    }

    const tokens = Math.ceil(this.skills.instructions(skill).length / 4)
    out.push(tokens > 6000 ? { id: 'size', level: 'warn', title: `Large: about ${(tokens / 1000).toFixed(1)}k tokens when loaded`, detail: 'Move reference material into bundled files the agent loads only when needed.' } : { id: 'size', level: 'ok', title: `About ${(tokens / 1000).toFixed(1)}k tokens when loaded` })

    if (overlaps.length) out.push({ id: 'overlap', level: 'note', title: `Overlaps with ${overlaps.join(', ')}`, detail: 'Their descriptions share many words, so they may compete for the same requests. Run the trigger check to see which one wins.' })
    return out
  }

  private hasRuntime(rt: string): boolean {
    if (this.runtimes.has(rt)) return this.runtimes.get(rt)!
    const tries = rt === 'python' ? [['python', ['--version']], ['python3', ['--version']], ['py', ['-3', '--version']]] : [['bash', ['--version']]]
    const ok = tries.some(([cmd, args]) => {
      try {
        return spawnSync(cmd as string, args as string[], { timeout: 4000, windowsHide: true }).status === 0
      } catch {
        return false
      }
    })
    this.runtimes.set(rt, ok)
    return ok
  }

  /** Skills whose descriptions share many words with this one. */
  private overlaps(skill: Skill, all: Skill[]): string[] {
    const mine = words(skill.description)
    if (mine.size < 3) return []
    return all
      .filter((o) => o.name !== skill.name)
      .filter((o) => {
        const theirs = words(o.description)
        const shared = [...mine].filter((w) => theirs.has(w)).length
        return shared >= 3 && shared / Math.min(mine.size, theirs.size || 1) >= 0.3
      })
      .map((o) => o.name)
  }

  private async texts(skill: Skill): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const f of skill.files) {
      if (!TEXT.test(f)) continue
      try {
        const path = join(skill.dir, f)
        if ((await stat(path)).size > 400_000) continue
        out.set(f, await readFile(path, 'utf8'))
      } catch {
        /* unreadable: skip */
      }
    }
    return out
  }

  /** Lines in scripts that reach the network, run commands or write files, and instructions that read like prompt injection. */
  private scan(files: Map<string, string>): SkillSafetyFinding[] {
    const out: SkillSafetyFinding[] = []
    for (const [file, text] of files) {
      const script = SCRIPT.test(file)
      const doc = /\.md$/i.test(file)
      text.split(/\r?\n/).forEach((line, i) => {
        for (const r of RISKS) {
          if ((r.scripts && !script) || (r.docs && !doc)) continue
          if (r.re.test(line)) out.push({ kind: r.kind, file, line: i + 1, text: line.trim().slice(0, 160) })
        }
      })
    }
    return out.slice(0, 60)
  }

  private hash(files: Map<string, string>): string {
    const h = createHash('sha1')
    for (const [f, t] of [...files].sort(([a], [b]) => a.localeCompare(b))) h.update(f).update('\0').update(t).update('\0')
    return h.digest('hex')
  }

  private review(name: string, files: Map<string, string>): { reviewedAt: number | null; reviewed: boolean } {
    const r = this.ctx.kv.get<{ hash: string; at: number } | null>(`skillReview:${name}`, null)
    return { reviewedAt: r?.at ?? null, reviewed: !!r && r.hash === this.hash(files) }
  }

  /** Record that the user read the skill as it is now; any change to its files clears it. */
  async markReviewed(name: string, reviewed = true): Promise<void> {
    const skill = await this.skills.get(name)
    this.ctx.kv.set(`skillReview:${name}`, reviewed ? { hash: this.hash(await this.texts(skill)), at: Date.now() } : null)
  }

  saveTriggers(name: string, triggers: SkillTrigger[]): SkillTrigger[] {
    const clean = triggers.map((t) => ({ prompt: t.prompt.trim(), should: !!t.should })).filter((t) => t.prompt).slice(0, 20)
    this.ctx.kv.set(`skillTriggers:${name}`, clean)
    return clean
  }

  /** Requests that should and shouldn't load the skill, written by a model from its description. */
  async draftTriggers(name: string, model: ModelRef): Promise<SkillTrigger[]> {
    const skill = await this.skills.get(name)
    const system = 'You write test requests for an AI skill router. Given a skill, write 3 realistic requests a developer might type where this skill should be loaded, and 2 related-sounding requests where it should NOT be. Vary the wording; do not repeat the description\'s words verbatim. Reply with JSON only: {"should": ["..."], "shouldNot": ["..."]}'
    const { text } = await this.providers.complete(model, { system, prompt: `Skill: ${skill.name}\nDescription: ${skill.description}`, maxTokens: 600, temperature: 0.6, thinking: 'off' })
    const parsed = parseJsonLoose<{ should?: string[]; shouldNot?: string[] }>(text)
    if (!parsed) throw new Error("The model's reply couldn't be read. Try again.")
    return this.saveTriggers(name, [...(parsed.should ?? []).map((prompt) => ({ prompt, should: true })), ...(parsed.shouldNot ?? []).map((prompt) => ({ prompt, should: false }))])
  }

  /**
   * Ask the model which skill it would load for each request, choosing among every installed skill's
   * description the way a chat does, and compare with what each request expects.
   */
  async runTriggers(name: string, model: ModelRef): Promise<SkillTriggerRun> {
    const triggers = this.ctx.kv.get<SkillTrigger[]>(`skillTriggers:${name}`, [])
    if (!triggers.length) throw new Error('Add a few requests to check first')
    const all = await this.skills.list()
    const system = [
      'You decide which skill an AI coding agent should load before answering a request. These skills are installed:',
      ...all.map((s) => `- ${s.name}: ${s.description}`),
      '',
      'Reply with JSON only: {"skill": "<name>"} for the one skill you would load first, or {"skill": null} when none clearly applies.'
    ].join('\n')
    const started = Date.now()
    const results = await Promise.all(
      triggers.map(async (t) => {
        try {
          const { text } = await this.providers.complete(model, { system, prompt: t.prompt, maxTokens: 120, temperature: 0, thinking: 'off' })
          const raw = parseJsonLoose<{ skill?: string | null }>(text)?.skill ?? null
          const picked = raw && all.some((s) => s.name === raw) ? raw : null
          return { prompt: t.prompt, should: t.should, picked, ok: t.should ? picked === name : picked !== name }
        } catch (err) {
          return { prompt: t.prompt, should: t.should, picked: null, ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      })
    )
    const run: SkillTriggerRun = { model: model.modelId, at: Date.now(), ms: Date.now() - started, results }
    this.ctx.kv.set(`skillTriggerRun:${name}`, run)
    return run
  }
}
