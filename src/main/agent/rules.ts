import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { parse, type NapiConfig } from '@ast-grep/napi'
import ignore, { type Ignore } from 'ignore'
import { parseAllDocuments } from 'yaml'
import { languageOf, resolveLanguage } from './ast'

/**
 * The user's coding rules. Instructions: the global Coding rules setting and a folder's AGENTS.md /
 * CLAUDE.md, in the system prompt of every agent working in that folder. Checks: ast-grep rule files
 * (the folder's sgconfig.yml and the global rules folder) run on each file the agent changes, and
 * what they find is reported in the tool result so the model fixes it in the same turn.
 */

/** Files in a folder whose contents become part of the instructions of agents working there (the first one found). */
export const NOTE_FILES = ['AGENTS.md', 'CLAUDE.md']
const NOTE_LIMIT = 12_000

/** ast-grep project configs, relative to the workspace root; their ruleDirs are relative to the config. */
const RULE_CONFIGS = ['sgconfig.yml', join('.rules', 'ast-grep', 'sgconfig.yml')]
const MAX_RULE_FILES = 200
const MAX_CHECKED_FILES = 20
const MAX_REPORTED = 8

/** The global rules folder inside Cloth's data folder. */
export function globalRulesDir(dataDir: string): string {
  return join(dataDir, 'rules')
}

/** The folder's AGENTS.md (or CLAUDE.md) as a prompt section, or '' when it has none. */
export async function folderNotes(folder: string): Promise<string> {
  for (const file of NOTE_FILES) {
    const text = await readFile(join(folder, file), 'utf8').catch(() => null)
    if (text === null || !text.trim()) continue
    const body = text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}\n… (truncated)` : text
    return `Project notes from ${file}:\n\n${body.trim()}`
  }
  return ''
}

/** One ast-grep rule, ready to match. */
export interface CodeRule {
  id: string
  /** ast-grep language name (as resolveLanguage returns it). */
  lang: string
  severity: string
  message: string
  config: NapiConfig
  /** Only files matching these globs (relative to the workspace); null = all. */
  files: Ignore | null
  ignores: Ignore | null
}

export interface RuleViolation {
  rule: string
  severity: string
  message: string
  line: number
}

interface RuleDoc {
  id?: unknown
  language?: unknown
  severity?: unknown
  message?: unknown
  rule?: unknown
  constraints?: unknown
  utils?: unknown
  files?: unknown
  ignores?: unknown
}

/** Parsed rule files by path, kept until the file changes. */
const cache = new Map<string, { mtimeMs: number; rules: CodeRule[] }>()

const globs = (value: unknown) => (Array.isArray(value) && value.length ? ignore().add(value.map(String)) : null)

/** The rules in one YAML file (several rules may share it, separated by ---). Rules ast-grep would skip are skipped. */
function parseRuleFile(text: string, source: string): CodeRule[] {
  const rules: CodeRule[] = []
  for (const doc of parseAllDocuments(text)) {
    const r = (doc.toJS() ?? {}) as RuleDoc
    if (!r.rule || typeof r.rule !== 'object' || r.severity === 'off') continue
    let lang: string | null
    try {
      lang = resolveLanguage(typeof r.language === 'string' ? r.language : undefined)
    } catch {
      continue
    }
    if (!lang) continue
    rules.push({
      id: typeof r.id === 'string' ? r.id : source,
      lang,
      severity: typeof r.severity === 'string' ? r.severity : 'hint',
      message: typeof r.message === 'string' ? r.message.trim() : '',
      config: { rule: r.rule, ...(r.constraints ? { constraints: r.constraints } : {}), ...(r.utils ? { utils: r.utils } : {}) } as NapiConfig,
      files: globs(r.files),
      ignores: globs(r.ignores)
    })
  }
  return rules
}

async function rulesIn(file: string): Promise<CodeRule[]> {
  const info = await stat(file)
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === info.mtimeMs) return hit.rules
  const rules = parseRuleFile(await readFile(file, 'utf8'), file)
  cache.set(file, { mtimeMs: info.mtimeMs, rules })
  return rules
}

async function ruleFilesIn(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (out.length >= MAX_RULE_FILES) break
    const abs = join(dir, e.name)
    if (e.isDirectory()) await ruleFilesIn(abs, out)
    else if (e.isFile() && ['.yml', '.yaml'].includes(extname(e.name).toLowerCase())) out.push(abs)
  }
  return out
}

/** The rule folders a workspace's ast-grep configs point at. */
async function projectRuleDirs(root: string): Promise<string[]> {
  const dirs: string[] = []
  for (const name of RULE_CONFIGS) {
    const config = join(root, name)
    const text = await readFile(config, 'utf8').catch(() => null)
    if (text === null) continue
    const ruleDirs = (parseAllDocuments(text)[0]?.toJS() as { ruleDirs?: unknown } | null)?.ruleDirs
    if (Array.isArray(ruleDirs)) dirs.push(...ruleDirs.map((d) => join(dirname(config), String(d))))
  }
  return dirs
}

/** Every rule that applies in a workspace: its own (sgconfig.yml) and the global rules folder's. */
export async function loadRules(root: string, globalDir: string | null): Promise<CodeRule[]> {
  const dirs = [...(globalDir ? [globalDir] : []), ...(await projectRuleDirs(root))]
  const files = (await Promise.all(dirs.map((d) => ruleFilesIn(d)))).flat()
  const loaded = await Promise.all(files.map((f) => rulesIn(f).catch(() => [])))
  return loaded.flat()
}

/** What the rules find in one file's new contents. `rel` is relative to the workspace, with / separators. */
export function checkRules(rel: string, source: string, rules: CodeRule[]): RuleViolation[] {
  const lang = languageOf(rel)
  const applicable = rules.filter((r) => r.lang === lang && (!r.files || r.files.ignores(rel)) && !r.ignores?.ignores(rel))
  if (!lang || !applicable.length) return []
  const root = parse(lang, source).root()
  const found: RuleViolation[] = []
  for (const r of applicable) {
    try {
      for (const node of root.findAll(r.config)) found.push({ rule: r.id, severity: r.severity, message: r.message, line: node.range().start.line + 1 })
    } catch {
      /* a rule the parser rejects is skipped, like an unknown language */
    }
  }
  return found.sort((a, b) => a.line - b.line)
}

export function formatViolations(rel: string, items: RuleViolation[], max = MAX_REPORTED): string {
  const shown = items.slice(0, max).map((v) => `- ${rel}:${v.line} [${v.rule}, ${v.severity}] ${v.message}`)
  const more = items.length > max ? [`- …and ${items.length - max} more`] : []
  return [`${rel}: ${items.length} coding rule ${items.length === 1 ? 'violation' : 'violations'}`, ...shown, ...more].join('\n')
}

/** Notes for the tool result after a change: one per changed file that breaks a rule. */
export async function ruleNotes(root: string, globalDir: string | null, files: { rel: string; after: string }[]): Promise<string[]> {
  const rules = await loadRules(root, globalDir)
  if (!rules.length) return []
  const notes: string[] = []
  for (const f of files.slice(0, MAX_CHECKED_FILES)) {
    const found = checkRules(f.rel, f.after, rules)
    if (found.length) notes.push(`Coding rule violations after this change (fix them unless the user wants otherwise) — ${formatViolations(f.rel, found)}`)
  }
  return notes
}
