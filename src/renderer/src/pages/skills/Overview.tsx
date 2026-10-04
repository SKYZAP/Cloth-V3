import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ChatCircleDots, CheckCircle, Info, Plus, ShieldCheck, Sparkle, Warning, X } from '@phosphor-icons/react'
import type { ModelRef, Skill, SkillInsight, SkillSafetyFinding, SkillTrigger } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { timeAgo } from '@/lib/format'
import { Button, Spinner } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'

const KIND: Record<SkillSafetyFinding['kind'], string> = {
  network: 'Reaches the network',
  shell: 'Runs commands',
  files: 'Writes or deletes files',
  injection: 'Reads like prompt injection'
}

/** What matters about a skill day to day: does it load when it should, is it used, is it sound and safe. */
export function SkillOverview({ skill, onOpenTab }: { skill: Skill; onOpenTab(tab: 'instructions' | 'files'): void }) {
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
      <div className="mx-auto grid w-[min(980px,calc(100%-40px))] grid-cols-2 gap-3 py-5 mobile:grid-cols-1">
        <div className="col-span-2 mobile:col-span-1">
          <TriggerCheck skill={skill} info={info} model={model} onModel={setModel} onChanged={load} />
        </div>
        <UsageCard info={info} />
        <ChecksCard info={info} onOpenTab={onOpenTab} />
        <SafetyCard skill={skill} info={info} onChanged={load} />
        <TryCard skill={skill} />
      </div>
    </div>
  )
}

function Card({ title, meta, children, className }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('grid content-start gap-2.5 rounded-[14px] border border-line bg-panel p-3.5', className)}>
      <div className="flex items-baseline gap-2">
        <h3 className="flex-1 text-[13px] font-semibold">{title}</h3>
        {meta && <span className="text-[11.5px] text-dim">{meta}</span>}
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
      <p className="text-[12px] text-dim">A model picks a skill for each request from every installed skill's description, the way a chat does. Failures usually mean the description needs the words people actually use.</p>
      <div className="grid gap-1">
        {rows.map((r, i) => {
          const res = result(r.prompt)
          return (
            <div key={i} className="flex items-center gap-2 rounded-[10px] border border-line bg-bg px-2 py-1.5">
              <input
                value={r.prompt}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)))}
                onBlur={() => void save(rows)}
                aria-label="Request"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none focus-visible:outline-none"
              />
              <button
                onClick={() => void save(rows.map((x, j) => (j === i ? { ...x, should: !x.should } : x)))}
                title="Whether this request should load the skill"
                className={clsx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px]', r.should ? 'text-muted hover:bg-elev-2' : 'text-dim hover:bg-elev-2')}
              >
                {r.should ? 'should load' : 'should not'}
              </button>
              {res && res.prompt === r.prompt && res.should === r.should && (
                <span
                  className={clsx('shrink-0 rounded-full px-2 py-px font-mono text-[10.5px]', res.ok ? 'bg-ok/10 text-ok' : 'bg-warn/10 text-warn')}
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
        {!rows.length && <div className="rounded-[10px] border border-dashed border-line px-3 py-3 text-[12px] text-dim">No requests yet. Suggest some from the description, or add your own.</div>}
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
        <div className="text-[12px] text-muted">
          {u.total} load{u.total === 1 ? '' : 's'} ({via.join(', ')}){u.chats ? ` in ${u.chats} chat${u.chats === 1 ? '' : 's'}` : ''}. Last used {timeAgo(u.lastUsedAt)}.
        </div>
      ) : (
        <div className="text-[12px] text-muted">Never used yet. If it stays that way, switch it off where it costs context, or check its description with the trigger check.</div>
      )}
    </Card>
  )
}

const LEVEL = {
  ok: { icon: CheckCircle, cls: 'text-ok' },
  note: { icon: Info, cls: 'text-info' },
  warn: { icon: Warning, cls: 'text-warn' }
}

function ChecksCard({ info, onOpenTab }: { info: SkillInsight; onOpenTab(tab: 'instructions' | 'files'): void }) {
  const warn = info.checks.filter((c) => c.level === 'warn').length
  const ok = info.checks.filter((c) => c.level === 'ok').length
  return (
    <Card title="Checks" meta={`${ok} pass${warn ? ` · ${warn} to fix` : ''}`}>
      <ul className="grid gap-1.5">
        {info.checks.map((c) => {
          const L = LEVEL[c.level]
          return (
            <li key={c.id} className="flex gap-2 text-[12px]">
              <L.icon size={14} weight="fill" className={clsx('mt-px shrink-0', L.cls)} />
              <span className="min-w-0">
                <span className="text-fg">{c.title}</span>
                {c.detail && <span className="block text-[11.5px] text-dim">{c.detail}</span>}
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

function SafetyCard({ skill, info, onChanged }: { skill: Skill; info: SkillInsight; onChanged(): void }) {
  const s = info.safety
  const groups = (Object.keys(KIND) as SkillSafetyFinding['kind'][]).map((k) => ({ k, items: s.findings.filter((f) => f.kind === k) })).filter((g) => g.items.length)
  const mark = async (reviewed: boolean) => {
    await attempt(() => api.skills.markReviewed(skill.name, reviewed))
    onChanged()
  }
  return (
    <Card
      title="Safety review"
      meta={s.reviewed ? <span className="flex items-center gap-1 text-ok"><ShieldCheck size={13} weight="fill" /> reviewed {timeAgo(s.reviewedAt)}</span> : s.reviewedAt ? 'changed since your review' : 'not reviewed'}
    >
      <div className="text-[12px] text-dim">{skill.source ? `From skills.sh (${skill.source.id.split('/').slice(0, 2).join('/')}).` : 'A local skill.'} What its scripts touch, and instructions that read like prompt injection. A list to read, not a verdict.</div>
      {groups.length ? (
        <div className="grid gap-2">
          {groups.map(({ k, items }) => (
            <details key={k} className="rounded-[10px] border border-line bg-bg">
              <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12px]">
                <Warning size={13} className={k === 'injection' ? 'text-crimson-hi' : 'text-warn'} />
                <span className="flex-1">{KIND[k]}</span>
                <span className="font-mono text-[11px] text-dim">{items.length}</span>
              </summary>
              <ul className="grid gap-1 border-t border-line px-2.5 py-2">
                {items.slice(0, 12).map((f, i) => (
                  <li key={i} className="grid text-[11.5px]">
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
        <div className="flex items-center gap-2 text-[12px] text-muted">
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
    </Card>
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
      <p className="text-[12px] text-dim">Opens a new chat with this skill set to Always, using your usual model and tools, so you can judge real output.</p>
      <div>
        <Button size="sm" icon={<ChatCircleDots size={14} />} onClick={() => void open()}>
          Open a chat with it
        </Button>
      </div>
    </Card>
  )
}
