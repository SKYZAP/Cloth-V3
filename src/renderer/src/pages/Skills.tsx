import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { CheckCircle2, ChevronRight, Download, FileCode2, FlaskConical, FolderOpen, Import, Plus, Save, Search, Sparkles, Trash2, Upload, Wand2, XCircle } from 'lucide-react'
import type { ModelRef, Skill, SkillEvalCase, SkillRun, SkillVerdict } from '@shared/types'
import type { ExternalSkillInfo } from '@shared/api'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { duration, timeAgo } from '@/lib/format'
import { Badge, Button, Card, Dot, Empty, Field, IconButton, Input, ListItem, ListPane, Modal, PageHeader, Spinner, Switch, Tabs, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Editor } from '@/components/Editor'
import { Markdown } from '@/components/Markdown'

const VERDICT: Record<SkillVerdict, { tone: 'ok' | 'warn' | 'crimson' | 'info' | 'dim'; label: string; help: string }> = {
  fresh: { tone: 'ok', label: 'Fresh', help: 'Passes its evals and the audit found nothing outdated' },
  stale: { tone: 'warn', label: 'Stale', help: 'Score dropped, below 80%, or the audit flagged high-severity outdated content' },
  failing: { tone: 'crimson', label: 'Failing', help: 'Under 50% of expectations met with this model' },
  redundant: { tone: 'info', label: 'Redundant', help: 'The model scores as well without the skill — it may no longer be needed' },
  untested: { tone: 'dim', label: 'Untested', help: 'No completed test run yet' }
}

type Tab = 'instructions' | 'files' | 'tests'

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [activeName, setActiveName] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const load = async (select?: string) => {
    const list = await api.skills.list()
    setSkills(list)
    if (select) setActiveName(select)
    else if (!activeName || !list.some((s) => s.name === activeName)) setActiveName(list[0]?.name ?? null)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEvent('skills', (e) => {
    if (e.run.status !== 'running') void load(activeName ?? undefined)
  })

  const active = skills.find((s) => s.name === activeName)
  const shown = skills.filter((s) => !filter || `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase()))
  const counts = useMemo(() => {
    const c: Partial<Record<SkillVerdict, number>> = {}
    for (const s of skills) c[s.health?.verdict ?? 'untested'] = (c[s.health?.verdict ?? 'untested'] ?? 0) + 1
    return c
  }, [skills])

  return (
    <div className="flex h-full">
      <ListPane
        width={288}
        header={
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">Skill hub</div>
                <div className="text-[11px] text-dim">
                  {skills.length} skills{counts.stale || counts.failing ? ` · ${(counts.stale ?? 0) + (counts.failing ?? 0)} need attention` : ''}
                </div>
              </div>
              <div className="flex gap-1">
                <IconButton title="Import skills" onClick={() => setImporting(true)}>
                  <Import size={14} />
                </IconButton>
                <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
                  New
                </Button>
              </div>
            </div>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-2.5 text-dim" />
              <Input className="pl-7" placeholder="Filter skills" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          </div>
        }
      >
        {shown.map((s) => {
          const v = VERDICT[s.health?.verdict ?? 'untested']
          return (
            <ListItem key={s.name} active={s.name === activeName} onClick={() => setActiveName(s.name)}>
              <span title={v.label}>
                <Dot tone={v.tone === 'dim' ? 'dim' : v.tone} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px]">{s.name}</div>
                <div className="truncate text-[11px] text-dim">{s.description || 'No description'}</div>
              </div>
            </ListItem>
          )
        })}
      </ListPane>
      <div className="min-w-0 flex-1">
        {active ? (
          <SkillView key={active.name} skill={active} onChanged={(name) => void load(name)} />
        ) : (
          <Empty
            icon={<Sparkles size={20} />}
            title="Your central skill hub"
            action={
              <div className="flex gap-2">
                <Button onClick={() => setImporting(true)}>Import existing</Button>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Create a skill
                </Button>
              </div>
            }
          >
            Skills are folders with a SKILL.md (Claude/Agent-Skills compatible). Cloth serves them to its own agent and over MCP, and tests them against models to catch staleness.
          </Empty>
        )}
      </div>
      <NewSkill open={creating} onClose={() => setCreating(false)} onCreated={(n) => void load(n)} />
      <ImportSkills open={importing} onClose={() => setImporting(false)} onImported={() => void load()} />
    </div>
  )
}

function NewSkill({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(name: string): void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
    }
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New skill"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !description.trim()}
            onClick={async () => {
              const s = await attempt(() =>
                api.skills.create({
                  name,
                  description,
                  body: `# ${name}\n\n## When to use\n\n- \n\n## Instructions\n\n1. \n\n## Examples\n\n`
                })
              )
              if (s) {
                onCreated(s.name)
                onClose()
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name" hint="Lowercase, digits and dashes — it becomes the folder name.">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="nestjs-guards" />
        </Field>
        <Field label="Description" hint="What the skill does and when to use it. Agents decide whether to load a skill from this line alone.">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Write NestJS guards and role-based authorization. Use when protecting routes…" />
        </Field>
      </div>
    </Modal>
  )
}

function ImportSkills({ open, onClose, onImported }: { open: boolean; onClose(): void; onImported(): void }) {
  const [found, setFound] = useState<ExternalSkillInfo[] | null>(null)
  const [extra, setExtra] = useState<string[]>([])
  useEffect(() => {
    if (open) void api.skills.discover(extra).then(setFound)
  }, [open, extra])
  const bySource = useMemo(() => {
    const m = new Map<string, ExternalSkillInfo[]>()
    for (const s of found ?? []) m.set(s.source, [...(m.get(s.source) ?? []), s])
    return [...m.entries()]
  }, [found])

  const importOne = async (dir: string, overwrite = false) => {
    const names = await attempt(() => api.skills.importFrom(dir, overwrite))
    if (names) {
      useApp.getState().toast(names.length ? `Imported ${names.join(', ')}` : 'Already in the hub', names.length ? 'ok' : 'info')
      onImported()
      setFound(await api.skills.discover(extra))
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import skills"
      width={680}
      footer={
        <Button
          icon={<FolderOpen size={13} />}
          onClick={async () => {
            const [dir] = await api.app.pickPaths({ directory: true, title: 'Folder containing skills' })
            if (dir) setExtra((e) => [...new Set([...e, dir])])
          }}
        >
          Scan another folder…
        </Button>
      }
    >
      {!found ? (
        <Spinner />
      ) : !found.length ? (
        <div className="text-[12.5px] text-dim">No skills found in ~/.claude/skills, ~/.agents/skills, ~/.codex/skills, ~/.cursor/skills or ~/.omp/skills. Scan another folder below.</div>
      ) : (
        <div className="space-y-4">
          {bySource.map(([source, items]) => (
            <div key={source}>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-mono text-[11px] text-dim">{source}</span>
                <Button size="sm" variant="ghost" onClick={() => void importOne(source)}>
                  Import all new
                </Button>
              </div>
              <div className="overflow-hidden rounded-lg border border-line">
                {items.map((s) => (
                  <div key={s.dir} className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12px]">{s.name}</div>
                      <div className="truncate text-[11px] text-dim">{s.description}</div>
                    </div>
                    {s.imported ? (
                      <Button size="sm" variant="ghost" onClick={() => confirmAction(`Overwrite hub copy of ${s.name}?`) && void importOne(s.dir, true)}>
                        Re-import
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => void importOne(s.dir)}>
                        Import
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

function SkillView({ skill, onChanged }: { skill: Skill; onChanged(name?: string): void }) {
  const [tab, setTab] = useState<Tab>('instructions')
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [body, setBody] = useState(skill.body)
  const [saving, setSaving] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const dirty = name !== skill.name || description !== skill.description || body !== skill.body
  const v = VERDICT[skill.health?.verdict ?? 'untested']

  const save = async () => {
    setSaving(true)
    const s = await attempt(() => api.skills.update(skill.name, { name, description, body, frontmatter: skill.frontmatter }), 'Skill saved')
    setSaving(false)
    if (s) onChanged(s.name)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && dirty) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{skill.name}</span>
            <Badge tone={v.tone} title={v.help}>
              {v.label}
              {skill.health?.lastScore !== null && skill.health?.lastScore !== undefined ? ` · ${Math.round(skill.health.lastScore * 100)}%` : ''}
            </Badge>
          </span>
        }
        subtitle={skill.health ? `Last tested ${timeAgo(skill.health.lastRunAt)} with ${skill.health.model.modelId}` : `Updated ${timeAgo(skill.updatedAt)}`}
        actions={
          <>
            <IconButton title="Open folder" onClick={() => void api.app.openPath(skill.dir)}>
              <FolderOpen size={14} />
            </IconButton>
            <Button icon={<Upload size={13} />} onClick={() => setInstallOpen(true)}>
              Install to…
            </Button>
            <IconButton
              title="Delete (moves to skills-trash)"
              onClick={async () => {
                if (!confirmAction(`Move “${skill.name}” to the skills trash?`)) return
                await attempt(() => api.skills.remove(skill.name))
                onChanged()
              }}
            >
              <Trash2 size={14} />
            </IconButton>
            <Button variant="primary" icon={<Save size={13} />} disabled={!dirty} loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      />
      <Tabs
        className="px-3"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'instructions', label: 'SKILL.md' },
          { value: 'files', label: `Files (${skill.files.length})` },
          { value: 'tests', label: `Tests (${skill.evals.length})` }
        ]}
      />
      <div className="min-h-0 flex-1">
        {tab === 'instructions' && (
          <div className="flex h-full flex-col">
            <div className="grid grid-cols-[240px_1fr] gap-3 border-b border-line px-5 py-3">
              <Field label="Name">
                <Input className="font-mono" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Description">
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-2">
              <div className="min-h-0 overflow-hidden border-r border-line">
                <Editor value={body} onChange={setBody} />
              </div>
              <div className="min-h-0 overflow-y-auto px-6 py-4">
                <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Preview</div>
                <Markdown text={body} />
              </div>
            </div>
          </div>
        )}
        {tab === 'files' && <SkillFiles skill={skill} onChanged={() => onChanged(skill.name)} />}
        {tab === 'tests' && <SkillTests skill={skill} onChanged={() => onChanged(skill.name)} />}
      </div>
      <InstallModal open={installOpen} onClose={() => setInstallOpen(false)} skill={skill} />
    </div>
  )
}

function InstallModal({ open, onClose, skill }: { open: boolean; onClose(): void; skill: Skill }) {
  const [sources, setSources] = useState<string[]>([])
  useEffect(() => {
    if (open) void api.skills.knownSources().then(setSources)
  }, [open])
  const install = async (root: string) => {
    const path = await attempt(() => api.skills.exportTo(skill.name, root))
    if (path) useApp.getState().toast(`Installed to ${path}`, 'ok')
  }
  return (
    <Modal open={open} onClose={onClose} title={`Install ${skill.name}`}>
      <div className="mb-3 text-[12px] text-dim">Copies the skill folder into another tool's skills directory. Tools that speak MCP can use the hub directly via skill_list / skill_use instead.</div>
      <div className="space-y-1.5">
        {sources.map((s) => (
          <div key={s} className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{s}</span>
            <Button size="sm" icon={<Download size={12} />} onClick={() => void install(s)}>
              Install
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          icon={<FolderOpen size={13} />}
          onClick={async () => {
            const [dir] = await api.app.pickPaths({ directory: true, title: 'Target skills folder' })
            if (dir) await install(dir)
          }}
        >
          Other folder…
        </Button>
      </div>
    </Modal>
  )
}

function SkillFiles({ skill, onChanged }: { skill: Skill; onChanged(): void }) {
  const [path, setPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [newPath, setNewPath] = useState('')
  useEffect(() => {
    if (!path) return
    void api.skills.readFile(skill.name, path).then((c) => {
      setContent(c)
      setOriginal(c)
    })
  }, [path, skill.name])
  const lang = path?.endsWith('.json') ? 'json' : path?.endsWith('.md') ? 'markdown' : 'text'
  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r border-line">
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {skill.files.map((f) => (
            <ListItem key={f} active={f === path} onClick={() => setPath(f)}>
              <FileCode2 size={13} className="shrink-0 text-dim" />
              <span className="truncate font-mono text-[11.5px]">{f}</span>
            </ListItem>
          ))}
        </div>
        <div className="flex gap-1.5 border-t border-line p-2">
          <Input placeholder="references/api.md" value={newPath} onChange={(e) => setNewPath(e.target.value)} className="font-mono text-[11.5px]" />
          <Button
            size="sm"
            disabled={!newPath.trim()}
            onClick={async () => {
              await attempt(() => api.skills.writeFile(skill.name, newPath.trim(), ''))
              setPath(newPath.trim())
              setNewPath('')
              onChanged()
            }}
          >
            Add
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {path ? (
          <>
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <span className="font-mono text-[12px] text-muted">{path}</span>
              <Button
                size="sm"
                variant="primary"
                disabled={content === original || path === 'SKILL.md'}
                title={path === 'SKILL.md' ? 'Edit SKILL.md on the first tab' : undefined}
                onClick={async () => {
                  await attempt(() => api.skills.writeFile(skill.name, path, content), 'Saved')
                  setOriginal(content)
                  onChanged()
                }}
              >
                Save file
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <Editor value={content} onChange={setContent} lang={lang} readOnly={path === 'SKILL.md'} />
            </div>
          </>
        ) : (
          <Empty title="Bundled files">Skills can ship references, scripts and templates. The agent loads them on demand with skill_use(name, file).</Empty>
        )}
      </div>
    </div>
  )
}

function SkillTests({ skill, onChanged }: { skill: Skill; onChanged(): void }) {
  const settings = useApp((s) => s.settings)
  const [cases, setCases] = useState<SkillEvalCase[]>(skill.evals)
  const [model, setModel] = useState<ModelRef | null>(settings?.defaultModel ?? null)
  const [judge, setJudge] = useState<ModelRef | null>(null)
  const [baseline, setBaseline] = useState(true)
  const [audit, setAudit] = useState(true)
  const [runs, setRuns] = useState<SkillRun[]>([])
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const dirty = JSON.stringify(cases) !== JSON.stringify(skill.evals)

  useEffect(() => {
    void api.skills.runs(skill.name).then((r) => {
      setRuns(r)
      setOpenRun(r[0]?.id ?? null)
    })
  }, [skill.name])
  useEvent('skills', (e) => {
    if (e.run.skillName !== skill.name) return
    setRuns((rs) => {
      const i = rs.findIndex((r) => r.id === e.run.id)
      if (i < 0) return [e.run, ...rs]
      const next = rs.slice()
      next[i] = e.run
      return next
    })
  })

  const saveCases = async () => {
    await attempt(() => api.skills.saveEvals(skill.name, cases), 'Eval cases saved')
    onChanged()
  }

  const run = async () => {
    if (!model) return
    if (dirty) await api.skills.saveEvals(skill.name, cases)
    const r = await attempt(() => api.skills.test({ name: skill.name, model, judge: judge ?? undefined, baseline, audit }))
    if (r) setOpenRun(r.id)
  }

  const running = runs.some((r) => r.status === 'running')

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* Cases */}
      <div className="flex min-h-0 flex-col border-r border-line">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <div className="text-[12.5px] font-semibold">Eval cases</div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              icon={<Wand2 size={12} />}
              loading={drafting}
              disabled={!model}
              title={model ? 'Draft cases with the selected model' : 'Pick a model first'}
              onClick={async () => {
                setDrafting(true)
                const drafted = await attempt(() => api.skills.draftEvals(skill.name, model!))
                setDrafting(false)
                if (drafted) setCases((c) => [...c, ...drafted])
              }}
            >
              Draft with AI
            </Button>
            <Button size="sm" icon={<Plus size={12} />} onClick={() => setCases((c) => [...c, { id: `case_${Date.now()}`, prompt: '', expectations: [''] }])}>
              Case
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty} onClick={() => void saveCases()}>
              Save
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {!cases.length && <div className="text-[12px] text-dim">No eval cases. Add prompts that should trigger this skill and objectively checkable expectations — or draft them with AI.</div>}
          {cases.map((c, i) => (
            <Card key={c.id} className="p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-semibold text-dim">CASE {i + 1}</span>
                <IconButton onClick={() => setCases(cases.filter((x) => x.id !== c.id))}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
              <Textarea rows={2} placeholder="User prompt" value={c.prompt} onChange={(e) => setCases(cases.map((x) => (x.id === c.id ? { ...x, prompt: e.target.value } : x)))} />
              <div className="mt-2 text-[11px] font-medium text-dim">Expectations — one per line</div>
              <Textarea
                rows={Math.max(2, c.expectations.length)}
                className="mt-1 text-[12px]"
                value={c.expectations.join('\n')}
                onChange={(e) => setCases(cases.map((x) => (x.id === c.id ? { ...x, expectations: e.target.value.split('\n') } : x)))}
              />
            </Card>
          ))}
        </div>
      </div>

      {/* Runner + history */}
      <div className="flex min-h-0 flex-col">
        <div className="space-y-3 border-b border-line p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model under test">
              <ModelPicker value={model} onChange={setModel} />
            </Field>
            <Field label="Judge model">
              <ModelPicker value={judge} onChange={setJudge} allowNone noneLabel="Same as model under test" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Switch checked={baseline} onChange={setBaseline} label="Baseline without skill" />
            <Switch checked={audit} onChange={setAudit} label="Freshness audit" />
            <div className="flex-1" />
            <Button variant="primary" icon={<FlaskConical size={13} />} disabled={!model || running || (!cases.length && !audit)} loading={running} onClick={() => void run()}>
              Run test
            </Button>
          </div>
          <div className="text-[11px] leading-relaxed text-dim">
            The skill is loaded as system context and each case is graded by the judge. Baseline reruns without the skill: if the model does as well, the skill is <b className="text-info">redundant</b>. The audit reviews the skill text for deprecated APIs and outdated advice.
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!runs.length && <div className="text-[12px] text-dim">No runs yet.</div>}
          <div className="space-y-2">
            {runs.map((r) => (
              <RunCard key={r.id} run={r} open={openRun === r.id} onToggle={() => setOpenRun(openRun === r.id ? null : r.id)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function RunCard({ run, open, onToggle }: { run: SkillRun; open: boolean; onToggle(): void }) {
  const v = VERDICT[run.verdict]
  return (
    <Card className={clsx(run.status === 'error' && 'border-crimson-line')}>
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <ChevronRight size={13} className={clsx('text-dim transition-transform', open && 'rotate-90')} />
        {run.status === 'running' ? <Spinner size={13} className="text-crimson" /> : run.status === 'error' ? <XCircle size={13} className="text-crimson-hi" /> : <Badge tone={v.tone}>{v.label}</Badge>}
        <span className="font-mono text-[11.5px]">{run.model.modelId}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">{run.status === 'running' ? `running… ${run.cases.length} case(s) done` : run.error ?? run.summary}</span>
        <span className="shrink-0 text-[11px] text-dim">{run.finishedAt ? duration(run.finishedAt - run.createdAt) : timeAgo(run.createdAt)}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line p-3">
          {run.cases.map((c, i) => (
            <div key={c.caseId}>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[11px] font-semibold text-dim">CASE {i + 1}</span>
                <Badge tone={c.score >= 0.8 ? 'ok' : c.score >= 0.5 ? 'warn' : 'crimson'}>{Math.round(c.score * 100)}%</Badge>
                {c.baselineScore !== undefined && <Badge tone="dim">baseline {Math.round(c.baselineScore * 100)}%</Badge>}
              </div>
              <div className="mb-1.5 text-[12px] text-muted">{c.prompt}</div>
              <div className="space-y-1">
                {c.expectations.map((e, j) => (
                  <div key={j} className="flex gap-2 text-[11.5px]">
                    {e.pass ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={13} className="mt-0.5 shrink-0 text-crimson-hi" />}
                    <div>
                      <div>{e.expectation}</div>
                      <div className="text-dim">{e.reason}</div>
                    </div>
                  </div>
                ))}
              </div>
              <details className="mt-1.5">
                <summary className="cursor-default text-[11px] text-dim hover:text-muted">Model output</summary>
                <div className="mt-1 max-h-72 overflow-y-auto rounded border border-line bg-bg p-2.5">
                  <Markdown text={c.output} />
                </div>
              </details>
            </div>
          ))}
          {run.issues.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold text-dim">AUDIT FINDINGS</div>
              <div className="space-y-1.5">
                {run.issues.map((i, k) => (
                  <div key={k} className="rounded-md border border-line bg-bg p-2.5 text-[11.5px]">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone={i.severity === 'high' ? 'crimson' : i.severity === 'medium' ? 'warn' : 'dim'}>{i.severity}</Badge>
                      {i.excerpt && <code className="truncate font-mono text-[11px] text-muted">“{i.excerpt}”</code>}
                    </div>
                    <div>{i.problem}</div>
                    {i.suggestion && <div className="mt-0.5 text-ok">→ {i.suggestion}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {run.status === 'done' && !run.issues.length && run.kind === 'audit' && <div className="text-[12px] text-ok">Audit found nothing outdated.</div>}
        </div>
      )}
    </Card>
  )
}
