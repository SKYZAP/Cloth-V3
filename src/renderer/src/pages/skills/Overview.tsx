import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowClockwise, ChatCircleDots, CheckCircle, Info, Plus, ShieldCheck, Sparkle, Warning, X } from '@phosphor-icons/react'
import type { ModelRef, Skill, SkillAuditStatus, SkillAudits, SkillInsight, SkillLinkCandidate, SkillRegistryStatus, SkillSafetyFinding, SkillSource, SkillTrigger } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { timeAgo } from '@/lib/format'
import { Button, IconButton, Spinner, confirmAction } from '@/components/ui'
import { Markdown } from '@/components/Markdown'
import { ModelPicker } from '@/components/ModelPicker'

const KIND: Record<SkillSafetyFinding['kind'], string> = {
  network: 'Reaches the network',
  shell: 'Runs commands',
  files: 'Writes or deletes files',
  injection: 'Reads like prompt injection'
}

/** What matters about a skill day to day: does it load when it should, is it used, is it sound and safe. */
export function SkillOverview({
  skill,
  linked,
  status,
  updating,
  onUpdate,
  onLinkChanged,
  onOpenTab
}: {
  skill: Skill
  /** The skills.sh link, or null for a local skill. */
  linked: SkillSource | null
  status: SkillRegistryStatus | null
  updating: boolean
  /** Starts the same update flow as the header's Update button. */
  onUpdate(): void
  /** Called after linking or unlinking so the parent refreshes the status and the skill. */
  onLinkChanged(): void
  onOpenTab(tab: 'instructions' | 'files'): void
}) {
  const settings = useApp((s) => s.settings)
  const [info, setInfo] = useState<SkillInsight | null>(null)
  const [model, setModel] = useState<ModelRef | null>(settings?.defaultModel ?? null)
  useEffect(() => {
    if (!model && settings?.defaultModel) setModel(settings.defaultModel)
  }, [settings?.defaultModel]) // eslint-disable-line react-hooks/exhaustive-deps
  const load = () => void api.skills.insight(skill.name).then(setInfo, () => undefined)
  useEffect(load, [skill.name, skill.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!info)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-[min(980px,calc(100%-40px))] grid-cols-[minmax(0,1fr)_300px] items-start gap-4 py-5 max-[1000px]:grid-cols-1">
        <div className="grid min-w-0 gap-4">
          <SummaryCard info={info} onOpenTab={onOpenTab} />
          <TriggerCheck skill={skill} info={info} model={model} onModel={setModel} onChanged={load} />
          <SkillMdCard skill={skill} onEdit={() => onOpenTab('instructions')} />
        </div>
        <div className="sticky top-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 max-[1000px]:static">
          <UsageCard info={info} />
          <AuditsCard skill={skill} linked={linked} info={info} onChanged={load} />
          <SourceCard skill={skill} linked={linked} status={status} updating={updating} onUpdate={onUpdate} onLinkChanged={onLinkChanged} />
          <TryCard skill={skill} />
        </div>
      </div>
    </div>
  )
}

function Card({ title, meta, children, className }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('grid content-start gap-2.5 rounded-[14px] border border-line bg-panel p-3.5', className)}>
      <div className="flex items-baseline gap-2">
        <h3 className="flex-1 text-ui font-semibold">{title}</h3>
        {meta && <span className="text-caption text-dim">{meta}</span>}
      </div>
      {children}
    </section>
  )
}

/** Requests that should and shouldn't load the skill, and which skill a model actually picks for each. */
function TriggerCheck({ skill, info, model, onModel, onChanged }: { skill: Skill; info: SkillInsight; model: ModelRef | null; onModel(m: ModelRef | null): void; onChanged(): void }) {
  const [rows, setRows] = useState<SkillTrigger[]>(info.triggers)
  const [busy, setBusy] = useState<'run' | 'draft' | null>(null)
  useEffect(() => setRows(info.triggers), [info.triggers])
  const run = info.lastTrigger
  const save = async (next: SkillTrigger[]) => {
    setRows(next)
    await attempt(() => api.skills.saveTriggers(skill.name, next))
  }
  const draft = async () => {
    if (!model) return
    setBusy('draft')
    const t = await attempt(() => api.skills.draftTriggers(skill.name, model))
    setBusy(null)
    if (t) (setRows(t), onChanged())
  }
  const check = async () => {
    if (!model) return
    await api.skills.saveTriggers(skill.name, rows).catch(() => undefined)
    setBusy('run')
    await attempt(() => api.skills.runTriggers(skill.name, model))
    setBusy(null)
    onChanged()
  }
  const result = (prompt: string) => run?.results.find((r) => r.prompt === prompt)
  const passed = run ? run.results.filter((r) => r.ok).length : 0
  return (
    <Card title="Trigger check" meta={run ? `${passed} of ${run.results.length} as expected · ${run.model} · ${Math.max(1, Math.round(run.ms / 1000))}s · ${timeAgo(run.at)}` : 'Does it load when it should, and only then?'}>
      <div className="grid gap-1">
        {rows.map((r, i) => {
          const res = result(r.prompt)
          return (
            <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-line bg-bg px-2 py-1.5">
              <input
                value={r.prompt}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))}
                onBlur={() => void save(rows)}
                aria-label="Request"
                className="min-w-0 flex-1 bg-transparent text-ui outline-none focus-visible:outline-none mobile:basis-full"
              />
              <button
                onClick={() => void save(rows.map((x, j) => (j === i ? { ...x, should: !x.should } : x)))}
                title="Whether this request should load the skill"
                className={clsx('shrink-0 rounded-md px-1.5 py-0.5 text-caption', r.should ? 'text-muted hover:bg-elev-2' : 'text-dim hover:bg-elev-2')}
              >
                {r.should ? 'should load' : 'should not'}
              </button>
              {res && res.prompt === r.prompt && res.should === r.should && (
                <span
                  className={clsx('shrink-0 rounded-full px-2 py-px font-mono text-micro', res.ok ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn')}
                  title={res.error ?? (res.picked ? `The model picked ${res.picked}` : 'The model picked no skill')}
                >
                  {res.error ? 'error' : res.picked === skill.name ? 'loads' : res.picked ? res.picked : 'skipped'}
                </span>
              )}
              <button onClick={() => void save(rows.filter((_, j) => j !== i))} aria-label="Remove request" className="shrink-0 text-dim hover:text-fg">
                <X size={12} />
              </button>
            </div>
          )
        })}
        {!rows.length && <div className="rounded-[10px] border border-dashed border-line px-3 py-3 text-caption text-dim">No requests yet. Suggest some from the description, or add your own.</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setRows([...rows, { prompt: '', should: true }])}>
          Add request
        </Button>
        <Button size="sm" variant="ghost" icon={<Sparkle size={13} />} loading={busy === 'draft'} disabled={!model || !!busy} onClick={() => void draft()}>
          Suggest requests
        </Button>
        <div className="flex-1" />
        <div className="w-56 mobile:w-full">
          <ModelPicker value={model} onChange={(m) => onModel(m)} />
        </div>
        <Button size="sm" variant="primary" loading={busy === 'run'} disabled={!model || !rows.some((r) => r.prompt.trim()) || !!busy} onClick={() => void check()}>
          Run check
        </Button>
      </div>
    </Card>
  )
}

function UsageCard({ info }: { info: SkillInsight }) {
  const u = info.usage
  const max = Math.max(1, ...u.weeks)
  const via = Object.entries(u.byVia)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k === 'auto' ? 'automatic' : k === 'slash' ? '/slash' : k === 'mcp' ? 'over MCP' : k === 'workflow' ? 'in flows' : k}`)
  return (
    <Card title="Usage" meta="last six weeks">
      <div className="flex h-12 items-end gap-1.5" aria-label={`Loads per week: ${u.weeks.join(', ')}`} role="img">
        {u.weeks.map((n, i) => (
          <span key={i} className={clsx('flex-1 rounded-t-[4px]', i === u.weeks.length - 1 ? 'bg-skill-dot' : 'bg-elev-2')} style={{ height: `${Math.max(6, (n / max) * 100)}%` }} title={`${n} load${n === 1 ? '' : 's'}`} />
        ))}
      </div>
      {u.total ? (
        <div className="text-caption text-muted">
          {u.total} load{u.total === 1 ? '' : 's'} ({via.join(', ')}){u.chats ? ` in ${u.chats} chat${u.chats === 1 ? '' : 's'}` : ''}. Last used {timeAgo(u.lastUsedAt)}.
        </div>
      ) : (
        <div className="text-caption text-muted">Never used yet.</div>
      )}
    </Card>
  )
}

const LEVEL = {
  ok: { icon: CheckCircle, cls: 'text-ok' },
  note: { icon: Info, cls: 'text-info' },
  warn: { icon: Warning, cls: 'text-warn' }
}

function SummaryCard({ info, onOpenTab }: { info: SkillInsight; onOpenTab(tab: 'instructions' | 'files'): void }) {
  const warn = info.checks.filter((c) => c.level === 'warn').length
  const ok = info.checks.filter((c) => c.level === 'ok').length
  return (
    <Card title="Summary" meta={`${ok} pass${warn ? ` · ${warn} to fix` : ''}`}>
      <ul className="grid gap-1.5">
        {info.checks.map((c) => {
          const L = LEVEL[c.level]
          return (
            <li key={c.id} className="flex gap-2 text-caption">
              <L.icon size={14} weight="fill" className={clsx('mt-px shrink-0', L.cls)} />
              <span className="min-w-0">
                <span className="text-fg">{c.title}</span>
                {c.detail && <span className="block text-caption text-dim">{c.detail}</span>}
              </span>
            </li>
          )
        })}
      </ul>
      {warn > 0 && (
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => onOpenTab('instructions')}>
            Edit SKILL.md
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenTab('files')}>
            Files
          </Button>
        </div>
      )}
    </Card>
  )
}

function SkillMdCard({ skill, onEdit }: { skill: Skill; onEdit(): void }) {
  return (
    <Card
      title="SKILL.md"
      meta={
        <button onClick={onEdit} className="text-dim hover:text-fg">
          Edit
        </button>
      }
    >
      <div className="max-h-[520px] overflow-y-auto">
        <Markdown text={skill.body} />
      </div>
    </Card>
  )
}

const AUDIT: Record<SkillAuditStatus, { label: string; cls: string }> = {
  pass: { label: 'Pass', cls: 'bg-ok/15 text-ok' },
  warn: { label: 'Warn', cls: 'bg-warn/15 text-warn' },
  fail: { label: 'Fail', cls: 'bg-danger-soft text-danger-hi' },
  pending: { label: 'Pending', cls: 'bg-elev-2 text-dim' },
  unknown: { label: 'Unknown', cls: 'bg-elev-2 text-dim' }
}

/** skills.sh security audits for linked skills, with Cloth's own local scan alongside (or instead, for local skills). */
function AuditsCard({ skill, linked, info, onChanged }: { skill: Skill; linked: SkillSource | null; info: SkillInsight; onChanged(): void }) {
  // undefined = loading, null = could not load
  const [audits, setAudits] = useState<SkillAudits | null | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const linkedId = linked?.id ?? null
  const fetchAudits = (refresh = false) => {
    let live = true
    if (refresh) setRefreshing(true)
    else setAudits(undefined)
    api.skills
      .registryAudits(skill.name, refresh)
      .then(
        (a) => live && setAudits(a),
        () => live && setAudits(null)
      )
      .finally(() => live && setRefreshing(false))
    return () => {
      live = false
    }
  }
  useEffect(() => {
    if (!linkedId) return
    return fetchAudits()
  }, [skill.name, linkedId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!linked)
    return (
      <Card title="Security audits" meta={<ReviewMeta info={info} />}>
        <div className="text-caption text-dim">Not linked to skills.sh, so there are no audits. Cloth's own scan:</div>
        <LocalScan skill={skill} info={info} onChanged={onChanged} />
      </Card>
    )
  return (
    <Card title="Security audits">
      {audits === undefined ? (
        <div className="grid gap-1.5" aria-label="Loading audits">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-elev-2" />
          ))}
        </div>
      ) : audits === null ? (
        <div className="flex items-center justify-between gap-2 text-caption text-dim">
          <span>Couldn't load audits from skills.sh.</span>
          <Button size="sm" variant="ghost" onClick={() => void fetchAudits()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="grid">
            {audits.audits.map((a) => {
              const st = AUDIT[a.status] ?? AUDIT.unknown
              return (
                <div key={a.provider} className="flex items-center justify-between gap-2 py-1.5 text-ui">
                  <button onClick={() => void api.app.openExternal(a.reportUrl)} className="min-w-0 truncate text-left text-fg hover:text-fg" title="Open the report on skills.sh">
                    {a.provider}
                  </button>
                  <span className={clsx('shrink-0 rounded px-1.5 py-0.5 text-caption font-medium', st.cls)}>{st.label}</span>
                </div>
              )
            })}
            {!audits.audits.length && <div className="py-1.5 text-caption text-dim">skills.sh lists no audits for this skill yet.</div>}
          </div>
          <div className="flex items-center justify-between gap-2 text-caption text-dim">
            <span>From skills.sh, checked {timeAgo(audits.fetchedAt)}</span>
            <IconButton title="Check again" aria-label="Refresh audits" disabled={refreshing} onClick={() => void fetchAudits(true)}>
              <ArrowClockwise size={13} className={clsx(refreshing && 'animate-spin')} />
            </IconButton>
          </div>
        </>
      )}
      <details className="rounded-[10px] border border-line bg-bg">
        <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-caption">
          <span className="flex-1">Cloth's local scan</span>
          <span className="text-caption text-dim">
            <ReviewMeta info={info} />
          </span>
        </summary>
        <div className="grid gap-2.5 border-t border-line px-2.5 py-2">
          <LocalScan skill={skill} info={info} onChanged={onChanged} />
        </div>
      </details>
    </Card>
  )
}

function ReviewMeta({ info }: { info: SkillInsight }) {
  const s = info.safety
  if (s.reviewed)
    return (
      <span className="flex items-center gap-1 text-ok">
        <ShieldCheck size={13} weight="fill" /> reviewed {timeAgo(s.reviewedAt)}
      </span>
    )
  return <>{s.reviewedAt ? 'changed since your review' : 'not reviewed'}</>
}

const LINKED_BY: Record<NonNullable<SkillSource['linkedBy']>, string> = {
  install: 'Installed from skills.sh',
  lock: 'Linked through the skills CLI',
  user: 'Linked by you'
}

/** Where the skill comes from: its skills.sh link with update and unlink, or a way to link a local skill. */
function SourceCard({
  skill,
  linked,
  status,
  updating,
  onUpdate,
  onLinkChanged
}: {
  skill: Skill
  linked: SkillSource | null
  status: SkillRegistryStatus | null
  updating: boolean
  onUpdate(): void
  onLinkChanged(): void
}) {
  const [cands, setCands] = useState<SkillLinkCandidate[] | null>(null)
  const [finding, setFinding] = useState(false)
  const [linking, setLinking] = useState<string | null>(null)
  const [unlinking, setUnlinking] = useState(false)
  useEffect(() => setCands(null), [skill.name, linked?.id])

  const find = async () => {
    setFinding(true)
    const c = await attempt(() => api.skills.registryLinkCandidates(skill.name))
    setFinding(false)
    if (c) setCands(c)
  }
  const link = async (id: string) => {
    setLinking(id)
    const ok = await attempt(() => api.skills.registryLink(skill.name, id), `Linked ${skill.name} to skills.sh`)
    setLinking(null)
    if (ok) onLinkChanged()
  }
  const unlink = async () => {
    if (!(await confirmAction("Cloth stops showing audits and updates for it. The skill's files stay as they are.", { title: 'Unlink from skills.sh?', confirmLabel: 'Unlink' }))) return
    setUnlinking(true)
    const ok = await attempt(async () => {
      await api.skills.registryUnlink(skill.name)
      return true
    })
    setUnlinking(false)
    if (ok) onLinkChanged()
  }

  if (linked)
    return (
      <Card title="Source">
        <div className="grid gap-0.5 text-ui">
          <span className="text-fg">skills.sh</span>
          <button onClick={() => void api.app.openExternal(linked.url)} className="min-w-0 truncate text-left font-mono text-caption text-dim hover:text-fg" title={linked.url}>
            {linked.id}
          </button>
          <span className="text-caption text-muted">{LINKED_BY[linked.linkedBy ?? 'install']}</span>
        </div>
        {status?.updateAvailable ? (
          <div className="flex items-center justify-between gap-2 text-caption">
            <span className="text-warn">Update available</span>
            <Button size="sm" loading={updating} onClick={onUpdate}>
              Update
            </Button>
          </div>
        ) : status ? (
          <div className="flex items-center gap-1.5 text-caption text-ok">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Up to date
          </div>
        ) : null}
        <div>
          <Button size="sm" variant="ghost" loading={unlinking} onClick={() => void unlink()}>
            Unlink
          </Button>
        </div>
      </Card>
    )
  return (
    <Card title="Source">
      <div className="text-ui text-fg">Local skill</div>
      {!cands ? (
        <div>
          <Button size="sm" loading={finding} onClick={() => void find()}>
            Link to skills.sh…
          </Button>
        </div>
      ) : !cands.length ? (
        <div className="text-caption text-dim">No match on skills.sh.</div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
          {cands.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-[10px] border border-line bg-bg px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-caption text-fg" title={c.id}>
                  {c.id}
                </div>
                <div className="flex items-center gap-1.5 text-caption text-dim">
                  {c.installs.toLocaleString()} installs
                  {c.identical && <span className="rounded bg-ok/15 px-1.5 py-px text-micro font-medium text-ok">Identical</span>}
                </div>
              </div>
              <Button size="sm" loading={linking === c.id} disabled={!!linking && linking !== c.id} onClick={() => void link(c.id)}>
                Link
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/** Cloth's own scan: what the skill's scripts touch, and instructions that read like prompt injection. */
function LocalScan({ skill, info, onChanged }: { skill: Skill; info: SkillInsight; onChanged(): void }) {
  const s = info.safety
  const groups = (Object.keys(KIND) as SkillSafetyFinding['kind'][]).map((k) => ({ k, items: s.findings.filter((f) => f.kind === k) })).filter((g) => g.items.length)
  const mark = async (reviewed: boolean) => {
    await attempt(() => api.skills.markReviewed(skill.name, reviewed))
    onChanged()
  }
  return (
    <>
      {groups.length ? (
        <div className="grid gap-2">
          {groups.map(({ k, items }) => (
            <details key={k} className="rounded-[10px] border border-line bg-bg">
              <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-caption">
                <Warning size={13} className={k === 'injection' ? 'text-danger-hi' : 'text-warn'} />
                <span className="flex-1">{KIND[k]}</span>
                <span className="font-mono text-caption text-dim">{items.length}</span>
              </summary>
              <ul className="grid gap-1 border-t border-line px-2.5 py-2">
                {items.slice(0, 12).map((f, i) => (
                  <li key={i} className="grid text-caption">
                    <span className="font-mono text-dim">
                      {f.file}:{f.line}
                    </span>
                    <code className="truncate font-mono text-muted">{f.text}</code>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-caption text-muted">
          <CheckCircle size={14} weight="fill" className="text-ok" /> Nothing found: no network, commands, file writes or injection-like text.
        </div>
      )}
      <div>
        {s.reviewed ? (
          <Button size="sm" variant="ghost" onClick={() => void mark(false)}>
            Clear review
          </Button>
        ) : (
          <Button size="sm" icon={<ShieldCheck size={13} />} onClick={() => void mark(true)}>
            Mark as reviewed
          </Button>
        )}
      </div>
    </>
  )
}

function TryCard({ skill }: { skill: Skill }) {
  const setPage = useApp((s) => s.setPage)
  const open = async () => {
    const chat = await attempt(() => api.skills.tryInChat(skill.name))
    if (!chat) return
    try {
      localStorage.setItem('cloth.chat', chat.id)
    } catch {
      /* storage unavailable */
    }
    setPage('chat')
  }
  return (
    <Card title="Try it">
      <div>
        <Button size="sm" icon={<ChatCircleDots size={14} />} onClick={() => void open()}>
          Open a chat with it
        </Button>
      </div>
    </Card>
  )
}
