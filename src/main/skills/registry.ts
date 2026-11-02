import { createTwoFilesPatch } from 'diff'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type {
  RegistryPreview,
  RegistrySkill,
  Skill,
  SkillGroup,
  SkillAudits,
  SkillAuditStatus,
  SkillLinkCandidate,
  SkillRegistryStatus,
  SkillSource,
  SkillUpdateFile
} from '@shared/types'
import type { Ctx } from '../core/context'
import { fetchWithWebCa } from '../web/transport'
import { parseSkillMd, slugify, type SkillService } from './skills'

/**
 * Client for the skills.sh registry, using the same public endpoints as the official `skills` CLI:
 *   GET /api/search?q=…&limit=…            → { skills: [{ id, source, skillId, name, installs }] }
 *   GET /api/download/{owner}/{repo}/{id}  → { files: [{ path, contents }], hash }
 * Security audits come from the skill's page (GET /{owner}/{repo}/{id}), with the audit API as fallback:
 *   GET /tele/audit?source={owner}/{repo}&skills={id} → { [id]: { ath?, socket?, snyk? } }
 */
export const SKILLS_REGISTRY = 'https://skills.sh'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const SOURCE_FILE = '.cloth-source.json'
const AUDIT_KEY = 'skillAudit:'
const UNLINKED_KEY = 'skillUnlinked:'
const AUDIT_TTL = 24 * 60 * 60_000
const AUDIT_TIMEOUT = 5_000
const DOWNLOAD_TTL = 5 * 60_000

interface DownloadResponse {
  files?: { path: string; contents: string | null }[]
  hash?: string | null
}

export class SkillRegistry {
  private cache = new Map<string, { at: number; data: DownloadResponse }>()
  /** Hub skills whose lock-file entry was checked recently and did not match. */
  private lockTried = new Map<string, number>()

  constructor(
    private ctx: Ctx,
    private skills: SkillService,
    private base = process.env.CLOTH_SKILLS_REGISTRY || SKILLS_REGISTRY,
    private caCertPath: () => string = () => '',
    private lockFile: () => string = skillsLockFile
  ) {}

  async search(query: string, limit = 30): Promise<RegistrySkill[]> {
    const q = query.trim()
    if (q.length < 2) return []
    const url = new URL('/api/search', this.base)
    url.searchParams.set('q', q)
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)))
    const res = await fetchWithWebCa(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } }, this.caCertPath())
    if (!res.ok) throw new Error(`skills.sh search failed (HTTP ${res.status})`)
    const body = (await res.json()) as { skills?: { id: string; source?: string; skillId?: string; name: string; installs?: number }[] }
    const installed = await this.installedSources()
    return (body.skills ?? [])
      .filter((s) => typeof s.id === 'string' && s.id.split('/').length >= 3)
      .map((s) => ({
        id: s.id,
        source: s.source ?? s.id.split('/').slice(0, 2).join('/'),
        skillId: s.skillId ?? s.id.split('/').pop()!,
        name: s.name,
        installs: s.installs ?? 0,
        url: `${SKILLS_REGISTRY}/${s.id}`,
        installedAs: installed.get(s.id.toLowerCase()) ?? null
      }))
  }

  async preview(id: string): Promise<RegistryPreview> {
    const data = await this.download(id)
    const files = (data.files ?? []).filter((f) => f.contents !== null)
    const skillMd = files.find((f) => f.path === 'SKILL.md')
    if (!skillMd?.contents) throw new Error('This registry entry has no SKILL.md snapshot yet — open it on skills.sh instead')
    const { frontmatter, body } = parseSkillMd(skillMd.contents)
    const installed = await this.installedSources()
    return {
      id,
      name: String(frontmatter.name ?? id.split('/').pop()),
      description: String(frontmatter.description ?? ''),
      body,
      files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.contents ?? '') })),
      hash: data.hash ?? null,
      url: `${SKILLS_REGISTRY}/${id}`,
      installedAs: installed.get(id.toLowerCase()) ?? null
    }
  }

  /** Download a registry skill into the hub. Returns the local skill name. */
  async install(id: string, opts: { overwrite?: boolean } = {}): Promise<string> {
    const data = await this.download(id, true)
    const files = snapshotFiles(data)
    const skillMd = files.find((f) => f.path === 'SKILL.md')
    if (!skillMd) throw new Error('Registry entry has no SKILL.md')
    const { frontmatter } = parseSkillMd(skillMd.contents)
    let name = slugify(String(frontmatter.name ?? id.split('/').pop()))
    if (!name) throw new Error('Could not derive a skill name')

    const installed = await this.installedSources()
    // Installed before: reinstall into the same folder, whatever it is called now.
    const existingName = installed.get(id.toLowerCase())
    const taken = (n: string) => existsSync(join(this.ctx.skillsDir, n))
    // Another set (or the person) already has a skill by this name: install this one beside it under a name that
    // says which set it came from, e.g. "pdf" from acme/agent-skills becomes "agent-skills-pdf".
    if (!existingName && !opts.overwrite && taken(name)) name = setQualifiedName(name, id, taken)
    if (existingName) name = existingName
    const dir = join(this.ctx.skillsDir, name)
    const source: SkillSource = { registry: 'skills.sh', id, hash: data.hash ?? null, installedAt: Date.now(), url: `${SKILLS_REGISTRY}/${id}`, linkedBy: 'install' }
    await this.writeSnapshot(dir, name, files, source)
    this.ctx.kv.set(`${UNLINKED_KEY}${name}`, false)
    this.ctx.log('skills', `installed ${id} from skills.sh as ${name}`)
    return name
  }

  /**
   * Update a linked hub skill to the latest skills.sh snapshot, in its existing folder (the local name stays
   * even if upstream renamed the skill). evals.json and the link are kept.
   */
  async update(name: string): Promise<string> {
    const skill = await this.skills.get(name)
    const linked = await this.linkFor(skill)
    if (!linked) throw new Error(`${name} is not linked to skills.sh`)
    const data = await this.download(linked.id, true)
    const files = snapshotFiles(data)
    if (!files.some((f) => f.path === 'SKILL.md')) throw new Error('Registry entry has no SKILL.md')
    await this.writeSnapshot(skill.dir, name, files, { ...linked, hash: data.hash ?? null, installedAt: Date.now() })
    this.ctx.log('skills', `updated ${name} from skills.sh (${linked.id})`)
    this.ctx.emit('skills', { type: 'changed', name })
    return name
  }

  /** For hub skills linked to the registry: is a newer snapshot available? (Always asks skills.sh.) */
  async checkUpdate(name: string): Promise<{ updateAvailable: boolean; current: string | null; latest: string | null }> {
    const skill = await this.skills.get(name)
    const linked = await this.linkFor(skill)
    if (!linked) throw new Error(`${name} was not installed from skills.sh`)
    await this.download(linked.id, true)
    const status = await this.status(name)
    return { updateAvailable: status.updateAvailable, current: linked.hash, latest: status.latest }
  }

  /**
   * A hub skill's skills.sh link and whether an update is available (uses the 5-minute download cache).
   * Skills installed with the `skills` CLI get linked here, lazily, when their lock entry matches.
   */
  async status(name: string): Promise<SkillRegistryStatus> {
    const skill = await this.skills.get(name)
    const linked = await this.linkFor(skill)
    if (!linked) return { linked: null, updateAvailable: false, latest: null }
    try {
      const data = await this.download(linked.id)
      const latest = data.hash ?? null
      const updateAvailable = linked.hash ? !!latest && latest !== linked.hash : (await this.diffAgainst(skill, data)).length > 0
      return { linked, updateAvailable, latest }
    } catch (err) {
      this.ctx.log('skills', `update check for ${name} failed`, err)
      return { linked, updateAvailable: false, latest: null }
    }
  }

  /** What updating would change: each file added, changed or removed, with a diff (line endings and BOM ignored). */
  async updateDiff(name: string): Promise<SkillUpdateFile[]> {
    const skill = await this.skills.get(name)
    const linked = await this.linkFor(skill)
    if (!linked) throw new Error(`${name} was not installed from skills.sh`)
    return this.diffAgainst(skill, await this.download(linked.id))
  }

  /** skills.sh entries that may be where a local skill came from. Searches only when called. */
  async linkCandidates(name: string): Promise<SkillLinkCandidate[]> {
    const skill = await this.skills.get(name)
    const hits = await this.search(skill.name, 10)
    const ranked = hits
      .map((hit, i) => ({ hit, i, exact: hit.skillId === skill.name || slugify(hit.name) === skill.name }))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || a.i - b.i)
      .slice(0, 3)
    const out: SkillLinkCandidate[] = []
    for (const { hit } of ranked) {
      try {
        const data = await this.download(hit.id)
        out.push({ id: hit.id, installs: hit.installs, identical: await this.identical(skill, data) })
      } catch (err) {
        this.ctx.log('skills', `link candidate ${hit.id} could not be downloaded`, err)
      }
    }
    return out
  }

  /** Link a hub skill to a skills.sh entry by hand. */
  async link(name: string, id: string): Promise<SkillSource> {
    const skill = await this.skills.get(name)
    const data = await this.download(id)
    const same = await this.identical(skill, data)
    const source: SkillSource = { registry: 'skills.sh', id, hash: same ? (data.hash ?? null) : null, installedAt: Date.now(), url: `${SKILLS_REGISTRY}/${id}`, linkedBy: 'user' }
    await writeFile(join(skill.dir, SOURCE_FILE), JSON.stringify(source, null, 2))
    this.ctx.kv.set(`${UNLINKED_KEY}${name}`, false)
    this.ctx.emit('skills', { type: 'changed', name })
    return source
  }

  /** Forget a hub skill's skills.sh link. It is not linked again from the lock file. */
  async unlink(name: string): Promise<void> {
    const skill = await this.skills.get(name)
    await rm(join(skill.dir, SOURCE_FILE), { force: true })
    this.ctx.kv.set(`${UNLINKED_KEY}${name}`, true)
    this.ctx.emit('skills', { type: 'changed', name })
  }

  /** Security audits skills.sh shows for a linked skill, cached for 24 h. Never throws: null when unavailable. */
  async audits(name: string, opts: { refresh?: boolean } = {}): Promise<SkillAudits | null> {
    let id: string
    try {
      const linked = await this.linkFor(await this.skills.get(name))
      if (!linked) return null
      id = linked.id
    } catch (err) {
      this.ctx.log('skills', `audits for ${name} unavailable`, err)
      return null
    }
    const key = `${AUDIT_KEY}${id}`
    const cached = this.ctx.kv.get<SkillAudits | null>(key, null)
    if (!opts.refresh && cached && Date.now() - cached.fetchedAt < AUDIT_TTL) return cached
    const fresh = (await this.auditsFromPage(id)) ?? (await this.auditsFromApi(id))
    if (!fresh) return null
    this.ctx.kv.set(key, fresh)
    return fresh
  }

  private async auditsFromPage(id: string): Promise<SkillAudits | null> {
    try {
      const url = `${this.base}/${id.split('/').map(encodeURIComponent).join('/')}`
      const res = await fetchWithWebCa(url, { signal: AbortSignal.timeout(AUDIT_TIMEOUT), headers: { accept: 'text/html' } }, this.caCertPath())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const audits = parseAuditsPage(await res.text(), id)
      if (audits.length) return { fetchedAt: Date.now(), source: 'page', audits }
      this.ctx.log('skills', `no security audits found on the skills.sh page for ${id}`)
      return null
    } catch (err) {
      this.ctx.log('skills', `skills.sh page for ${id} could not be read`, err)
      return null
    }
  }

  private async auditsFromApi(id: string): Promise<SkillAudits | null> {
    try {
      const parts = id.split('/')
      const slug = parts.slice(2).join('/')
      const url = new URL('/tele/audit', this.base)
      url.searchParams.set('source', parts.slice(0, 2).join('/'))
      url.searchParams.set('skills', slug)
      const res = await fetchWithWebCa(url, { signal: AbortSignal.timeout(AUDIT_TIMEOUT), headers: { accept: 'application/json' } }, this.caCertPath())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as Record<string, AuditApiEntry | undefined> | null
      return { fetchedAt: Date.now(), source: 'api', audits: mapAuditApi(body?.[slug], id) }
    } catch (err) {
      this.ctx.log('skills', `skills.sh audit API for ${id} failed`, err)
      return null
    }
  }

  /** The skill's link: its .cloth-source.json, or a match from the `skills` CLI lock file (saved on first match). */
  private async linkFor(skill: Skill): Promise<SkillSource | null> {
    if (skill.source) return skill.source
    if (this.ctx.kv.get(`${UNLINKED_KEY}${skill.name}`, false)) return null
    const tried = this.lockTried.get(skill.name)
    if (tried && Date.now() - tried < DOWNLOAD_TTL) return null
    const id = lockCandidate(this.lockFile(), skill.name)
    if (!id) return null
    try {
      const data = await this.download(id)
      const upstream = snapshotFiles(data).find((f) => f.path === 'SKILL.md')
      const local = await readFile(join(skill.dir, 'SKILL.md'), 'utf8')
      if (!upstream || normalise(upstream.contents) !== normalise(local)) {
        this.lockTried.set(skill.name, Date.now())
        return null
      }
      const source: SkillSource = { registry: 'skills.sh', id, hash: data.hash ?? null, installedAt: Date.now(), url: `${SKILLS_REGISTRY}/${id}`, linkedBy: 'lock' }
      await writeFile(join(skill.dir, SOURCE_FILE), JSON.stringify(source, null, 2))
      this.ctx.log('skills', `linked ${skill.name} to ${id} from the skills lock file`)
      this.ctx.emit('skills', { type: 'changed', name: skill.name })
      return source
    } catch (err) {
      this.lockTried.set(skill.name, Date.now())
      this.ctx.log('skills', `could not match ${skill.name} with ${id}`, err)
      return null
    }
  }

  /** Every file in the snapshot equals the local file (ignoring CRLF and BOM). */
  private async identical(skill: Skill, data: DownloadResponse): Promise<boolean> {
    const files = snapshotFiles(data)
    if (!files.length) return false
    for (const f of files) {
      const local = await this.readLocal(skill, f.path)
      if (local === null || normalise(local) !== normalise(f.contents)) return false
    }
    return true
  }

  private async diffAgainst(skill: Skill, data: DownloadResponse): Promise<SkillUpdateFile[]> {
    const next = new Map(snapshotFiles(data).map((f) => [f.path, normalise(f.contents)]))
    const local = skill.files.filter((f) => f !== 'evals.json' && f !== SOURCE_FILE)
    const out: SkillUpdateFile[] = []
    for (const path of [...new Set([...local, ...next.keys()])].sort()) {
      const before = local.includes(path) ? normalise((await this.readLocal(skill, path)) ?? '') : null
      const after = next.get(path) ?? null
      if (before === after) continue
      const kind = before === null ? 'added' : after === null ? 'removed' : 'changed'
      out.push({ path, kind, diff: createTwoFilesPatch(path, path, before ?? '', after ?? '', 'yours', 'skills.sh', { context: 3 }) })
    }
    return out
  }

  private async readLocal(skill: Skill, path: string): Promise<string | null> {
    const root = resolve(skill.dir)
    const full = resolve(root, ...path.split('/'))
    if (!full.startsWith(root + sep)) return null
    return readFile(full, 'utf8').catch(() => null)
  }

  /** Replace a skill folder with a snapshot, through a staging folder. Keeps the local evals.json. */
  private async writeSnapshot(dir: string, name: string, files: { path: string; contents: string }[], source: SkillSource): Promise<void> {
    let total = 0
    for (const f of files) {
      total += Buffer.byteLength(f.contents)
      if (Buffer.byteLength(f.contents) > MAX_FILE_BYTES) throw new Error(`${f.path} is larger than 2 MB`)
    }
    if (total > MAX_TOTAL_BYTES) throw new Error('Skill is larger than 20 MB')

    // Write to a staging folder first so a failed download never leaves a half-updated skill.
    const staging = join(this.ctx.dataDir, 'skills-staging', `${name}-${Date.now()}`)
    await mkdir(staging, { recursive: true })
    try {
      for (const f of files) {
        const target = resolve(staging, f.path)
        if (!target.startsWith(staging + sep) || f.path.includes('\0')) throw new Error(`Refusing unsafe path in registry skill: ${f.path}`)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, f.contents)
      }
      await writeFile(join(staging, SOURCE_FILE), JSON.stringify(source, null, 2))
      // Keep locally authored eval cases across updates.
      if (existsSync(join(dir, 'evals.json')) && !files.some((f) => f.path === 'evals.json')) {
        await writeFile(join(staging, 'evals.json'), await readFile(join(dir, 'evals.json')))
      }
      await rm(dir, { recursive: true, force: true })
      await mkdir(this.ctx.skillsDir, { recursive: true })
      await rename(staging, dir)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async download(id: string, fresh = false): Promise<DownloadResponse> {
    const parts = id.split('/')
    if (parts.length < 3 || parts.some((p) => !p || p === '..')) throw new Error(`Invalid registry id "${id}"`)
    const cached = this.cache.get(id)
    if (!fresh && cached && Date.now() - cached.at < DOWNLOAD_TTL) return cached.data
    const [owner, repo, ...rest] = parts
    const url = `${this.base}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(rest.join('/'))}`
    const res = await fetchWithWebCa(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } }, this.caCertPath())
    if (res.status === 404) throw new Error('skills.sh has no downloadable snapshot for this skill yet')
    if (!res.ok) throw new Error(`skills.sh download failed (HTTP ${res.status})`)
    const data = (await res.json()) as DownloadResponse
    this.cache.set(id, { at: Date.now(), data })
    return data
  }

  /**
   * Hub skills by the GitHub repository they came from: their skills.sh link, else the `skills` CLI lock file.
   * Skills from neither (written here, or imported from a folder) are in no group.
   */
  async groups(): Promise<SkillGroup[]> {
    const fromLock = lockSources(this.lockFile())
    // GitHub names aren't case-sensitive, and skills.sh lowercases the owner where the lock file may not.
    const repos = new Map<string, { repo: string; skills: string[] }>()
    for (const s of await this.skills.list()) {
      const repo = s.source ? s.source.id.split('/').slice(0, 2).join('/') : fromLock.get(s.name)
      if (!repo) continue
      const g = repos.get(repo.toLowerCase()) ?? { repo, skills: [] }
      g.skills.push(s.name)
      repos.set(repo.toLowerCase(), g)
    }
    return [...repos.values()].map(({ repo, skills }) => ({ repo, url: `https://github.com/${repo}`, skills }))
  }

  /** registry id (lowercase) → local skill name: linked skills, and ones the `skills` CLI lock file says came from that repository. */
  private async installedSources(): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const fromLock = lockSources(this.lockFile())
    for (const s of await this.skills.list()) {
      const id = s.source?.id ?? (fromLock.has(s.name) ? `${fromLock.get(s.name)}/${s.name}` : null)
      if (id) out.set(id.toLowerCase(), s.name)
    }
    return out
  }
}

interface AuditApiResult {
  risk?: string
  alerts?: number
  analyzedAt?: string
}
interface AuditApiEntry {
  ath?: AuditApiResult
  socket?: AuditApiResult
  snyk?: AuditApiResult
}

const AUDIT_PROVIDERS: { key: keyof AuditApiEntry; provider: string; slug: string }[] = [
  { key: 'ath', provider: 'Gen Agent Trust Hub', slug: 'agent-trust-hub' },
  { key: 'socket', provider: 'Socket', slug: 'socket' },
  { key: 'snyk', provider: 'Snyk', slug: 'snyk' }
]

/**
 * A free hub name for a registry skill whose own name is taken by a skill from elsewhere: the set's repository
 * first ("agent-skills-pdf"), then its owner too ("acme-agent-skills-pdf"), then a number.
 */
export function setQualifiedName(name: string, id: string, taken: (name: string) => boolean): string {
  const [owner = '', repo = ''] = id.split('/')
  const tries = [slugify(`${repo}-${name}`), slugify(`${owner}-${repo}-${name}`)]
  for (const n of tries) if (n && n !== name && !taken(n)) return n
  for (let i = 2; ; i++) {
    const n = `${tries[1].slice(0, 60)}-${i}`
    if (!taken(n)) return n
  }
}

function snapshotFiles(data: DownloadResponse): { path: string; contents: string }[] {
  return (data.files ?? []).filter((f): f is { path: string; contents: string } => typeof f.contents === 'string')
}

/** Text for comparing: no BOM, LF line endings. */
export function normalise(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/** Where the `skills` CLI keeps its global lock file. */
export function skillsLockFile(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim()
  if (xdg && existsSync(join(xdg, 'skills', '.skill-lock.json'))) return join(xdg, 'skills', '.skill-lock.json')
  return join(homedir(), '.agents', '.skill-lock.json')
}

/** Each skill the `skills` CLI lock file records, with the owner/repo it came from. */
export function lockSources(file: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!file || !existsSync(file)) return out
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { skills?: Record<string, { source?: unknown } | undefined> }
    for (const [name, entry] of Object.entries(lock?.skills ?? {})) {
      const source = typeof entry?.source === 'string' ? entry.source.replace(/^\/+|\/+$/g, '') : ''
      if (source.split('/').length === 2 && source.split('/').every(Boolean)) out.set(name, source)
    }
  } catch {
    /* an unreadable lock file groups nothing */
  }
  return out
}

/** The skills.sh id the `skills` CLI lock file records for a skill (v3: skills[name] = { source: 'owner/repo', skillPath }). */
export function lockCandidate(file: string, name: string): string | null {
  if (!file || !existsSync(file)) return null
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { skills?: Record<string, { source?: unknown; skillPath?: unknown } | undefined> }
    const entry = lock?.skills?.[name]
    if (typeof entry?.source !== 'string' || typeof entry.skillPath !== 'string') return null
    const slug = basename(dirname(entry.skillPath.replace(/\\/g, '/')))
    const source = entry.source.replace(/^\/+|\/+$/g, '')
    if (!slug || slug === '.' || slug === '..' || source.split('/').length !== 2) return null
    return `${source}/${slug}`
  } catch {
    return null
  }
}

/** An audit label as skills.sh shows it (Pass, Warn, Fail, Safe, Low/Med/High Risk, Pending…) as a status. */
export function auditStatus(label: string): SkillAuditStatus {
  const t = label.trim().toLowerCase()
  if (/pending|analy[sz]ing|queued/.test(t)) return 'pending'
  if (/fail|high|critical/.test(t)) return 'fail'
  if (/warn|med/.test(t)) return 'warn'
  if (/pass|safe|low/.test(t)) return 'pass'
  return 'unknown'
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** The SECURITY AUDITS entries on a skill's skills.sh page: links to /{id}/security/{provider} with a name and a status. */
export function parseAuditsPage(html: string, id: string): SkillAudits['audits'] {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<a\\b[^>]*?\\shref=["']/${escaped}/security/([A-Za-z0-9_-]+)/?["'][^>]*>([\\s\\S]*?)</a>`, 'gi')
  const out: SkillAudits['audits'] = []
  const seen = new Set<string>()
  for (const m of html.matchAll(re)) {
    const slug = m[1].toLowerCase()
    if (seen.has(slug)) continue
    seen.add(slug)
    const texts = m[2]
      .replace(/<!--[\s\S]*?-->/g, '')
      .split(/<[^>]*>/)
      .map((t) => decodeEntities(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const provider = texts[0] ?? AUDIT_PROVIDERS.find((p) => p.slug === slug)?.provider ?? slug
    out.push({ provider, status: texts.length > 1 ? auditStatus(texts[texts.length - 1]) : 'unknown', reportUrl: `${SKILLS_REGISTRY}/${id}/security/${slug}` })
  }
  return out
}

/** The audit API's per-provider risk levels as statuses. */
export function mapAuditApi(entry: AuditApiEntry | undefined, id: string): SkillAudits['audits'] {
  const out: SkillAudits['audits'] = []
  for (const p of AUDIT_PROVIDERS) {
    const r = entry?.[p.key]
    if (!r) continue
    const risk = String(r.risk ?? '').toLowerCase()
    const status: SkillAuditStatus = risk === 'safe' || risk === 'low' ? 'pass' : risk === 'medium' ? 'warn' : risk === 'high' || risk === 'critical' ? 'fail' : 'unknown'
    out.push({
      provider: p.provider,
      status,
      reportUrl: `${SKILLS_REGISTRY}/${id}/security/${p.slug}`,
      ...(r.analyzedAt ? { analyzedAt: String(r.analyzedAt) } : {}),
      ...(typeof r.alerts === 'number' ? { alerts: r.alerts } : {})
    })
  }
  return out
}
