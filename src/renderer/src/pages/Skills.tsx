import { useEffect, useMemo, useState } from 'react'
import { Download, ExternalLink, FileCode2, FolderOpen, Plus, RefreshCw, Save, Search, Sparkles, Store, Trash2, Upload, Wand2 } from 'lucide-react'
import type { ModelRef, RegistryPreview, RegistrySkill, Skill, SkillRegistryStatus, SkillUpdateFile } from '@shared/types'
import type { ExternalSkillInfo } from '@shared/api'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { bytes, compact, timeAgo } from '@/lib/format'
import { Badge, Button, Empty, Field, IconButton, Input, ListItem, ListPane, Modal, PageHeader, Spinner, Tabs, Textarea, confirmAction } from '@/components/ui'
import { SplitDetail, SplitRoot } from '@/components/SplitView'
import { ModelPicker } from '@/components/ModelPicker'
import { Editor } from '@/components/Editor'
import { Markdown } from '@/components/Markdown'
import { DiffView } from '@/components/DiffView'
import { SkillOverview } from './skills/Overview'

type Tab = 'overview' | 'instructions' | 'files'

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeName, setActiveName] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [creating, setCreating] = useState<NewMode | null>(null)
  const [adding, setAdding] = useState<{ open: boolean; tab: AddTab }>({ open: false, tab: 'registry' })
  const [used, setUsed] = useState<Record<string, { total: number; lastUsedAt: number }>>({})

  const load = async (select?: string) => {
    void api.skills.usageAll().then(setUsed, () => undefined)
    const list = await api.skills.list()
    setSkills(list)
    setLoaded(true)
    if (select) {
      setActiveName(select)
      setOpen(true)
    }
    else if (!activeName || !list.some((s) => s.name === activeName)) setActiveName(list[0]?.name ?? null)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEvent('skills', (e) => {
    if (e.type === 'changed') void load(activeName ?? undefined)
  })

  const active = skills.find((s) => s.name === activeName)
  const shown = skills.filter((s) => !filter || `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase()))
  const unused = useMemo(() => skills.filter((s) => !used[s.name]).length, [skills, used])

  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        width={288}
        header={
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold">Skill hub</div>
                <div className="text-[11px] text-dim">
                  {skills.length} skill{skills.length === 1 ? '' : 's'}{unused && skills.length ? ` · ${unused} never used` : ''}
                </div>
              </div>
              <div className="flex gap-1">
                <IconButton title="Browse skills.sh" onClick={() => setAdding({ open: true, tab: 'registry' })}>
                  <Store size={14} />
                </IconButton>
                <IconButton title="Import from local folders" onClick={() => setAdding({ open: true, tab: 'local' })}>
                  <FolderOpen size={14} />
                </IconButton>
                <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreating('ai')}>
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
          const u = used[s.name]
          return (
            <ListItem key={s.name} active={s.name === activeName} onClick={() => (setActiveName(s.name), setOpen(true))}>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{s.name}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-dim" title={u ? `Last used ${timeAgo(u.lastUsedAt)}` : 'Not used yet'}>
                    {u ? `${u.total} used` : 'never'}
                  </span>
                </div>
                <div className="truncate text-[11px] text-dim">{s.description || 'No description'}</div>
              </div>
            </ListItem>
          )
        })}
        {loaded && !skills.length && (
          <div className="space-y-2 p-4 text-center">
            <div className="text-[12px] text-dim">No skills yet. Describe one and let AI write it, or bring in existing ones.</div>
            <div className="flex flex-wrap justify-center gap-1.5">
              <Button size="sm" variant="primary" icon={<Wand2 size={13} />} onClick={() => setCreating('ai')}>
                Generate with AI
              </Button>
              <Button size="sm" icon={<Store size={13} />} onClick={() => setAdding({ open: true, tab: 'registry' })}>
                Browse skills.sh
              </Button>
              <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => setAdding({ open: true, tab: 'local' })}>
                Import
              </Button>
            </div>
          </div>
        )}
      </ListPane>
      <SplitDetail>
        {active ? (
          <SkillView key={active.name} skill={active} onChanged={(name) => void load(name)} />
        ) : (
          <Empty
            icon={<Sparkles size={20} />}
            title="Your central skill hub"
            action={
              <div className="flex gap-2">
                <Button icon={<Store size={13} />} onClick={() => setAdding({ open: true, tab: 'registry' })}>
                  Browse skills.sh
                </Button>
                <Button onClick={() => setAdding({ open: true, tab: 'local' })}>Import existing</Button>
                <Button variant="primary" icon={<Wand2 size={13} />} onClick={() => setCreating('ai')}>
                  Generate with AI
                </Button>
              </div>
            }
          >
            Skills are folders with a SKILL.md (Claude/Agent-Skills compatible). Cloth serves them to its own agent and over MCP, checks that they load when they should, and shows how much each one is used.
          </Empty>
        )}
      </SplitDetail>
      <NewSkill open={!!creating} mode={creating ?? 'ai'} onClose={() => setCreating(null)} onCreated={(n) => void load(n)} />
      <AddSkills
        open={adding.open}
        tab={adding.tab}
        onTab={(tab) => setAdding((a) => ({ ...a, tab }))}
        onClose={() => setAdding((a) => ({ ...a, open: false }))}
        onImported={(name) => void load(name)}
      />
    </SplitRoot>
  )
}

type NewMode = 'ai' | 'manual'

function NewSkill({ open, mode: initialMode, onClose, onCreated }: { open: boolean; mode: NewMode; onClose(): void; onCreated(name: string): void }) {
  const settings = useApp((s) => s.settings)
  const [mode, setMode] = useState<NewMode>(initialMode)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [request, setRequest] = useState('')
  const [model, setModel] = useState<ModelRef | null>(settings?.defaultModel ?? null)
  const [generating, setGenerating] = useState(false)
  useEffect(() => {
    if (open) {
      setMode(initialMode)
      setName('')
      setDescription('')
      setRequest('')
    }
  }, [open, initialMode])
  useEffect(() => {
    if (!model && settings?.defaultModel) setModel(settings.defaultModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.defaultModel])

  const createManual = async () => {
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
  }
  const generate = async () => {
    if (!model) return
    setGenerating(true)
    const s = await attempt(() => api.skills.generate({ request, model, name: name.trim() || undefined }), 'Skill drafted — review it before you rely on it')
    setGenerating(false)
    if (s) {
      onCreated(s.name)
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !generating && onClose()}
      title="New skill"
      width={560}
      footer={
        <>
          <Button variant="ghost" disabled={generating} onClick={onClose}>
            Cancel
          </Button>
          {mode === 'ai' ? (
            <Button variant="primary" icon={<Wand2 size={13} />} loading={generating} disabled={!request.trim() || !model} onClick={() => void generate()}>
              {generating ? 'Writing the skill…' : 'Generate skill'}
            </Button>
          ) : (
            <Button variant="primary" disabled={!name.trim() || !description.trim()} onClick={() => void createManual()}>
              Create skill
            </Button>
          )}
        </>
      }
    >
      <Tabs
        className="-mt-1 mb-4"
        value={mode}
        onChange={setMode}
        items={[
          { value: 'ai', label: <><Wand2 size={13} /> Generate with AI</> },
          { value: 'manual', label: 'Write it myself' }
        ]}
      />
      {mode === 'ai' ? (
        <div className="space-y-3">
          <Field label="What should the skill do?" >
            <Textarea
              autoFocus
              rows={6}
              value={request}
              disabled={generating}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && request.trim() && model && !generating) void generate()
              }}
              placeholder="Write database migrations with Drizzle for our Postgres setup: generate them with drizzle-kit, never edit applied ones, and always add a down step…"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3 mobile:grid-cols-1">
            <Field label="Name (optional)">
              <Input value={name} disabled={generating} onChange={(e) => setName(e.target.value)} placeholder="drizzle-migrations" />
            </Field>
            <Field label="Model" hint={model ? 'Writes the skill.' : 'Add a model on the Providers page first.'}>
              <ModelPicker value={model} onChange={setModel} />
            </Field>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Name" hint="Lowercase, digits and dashes — it becomes the folder name.">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="nestjs-guards" />
          </Field>
          <Field label="Description" hint="Agents decide whether to load it from this line.">
            <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Write NestJS guards and role-based authorization. Use when protecting routes…" />
          </Field>
        </div>
      )}
    </Modal>
  )
}

type AddTab = 'registry' | 'local'

function AddSkills({ open, tab, onTab, onClose, onImported }: { open: boolean; tab: AddTab; onTab(t: AddTab): void; onClose(): void; onImported(name?: string): void }) {
  return (
    <Modal open={open} onClose={onClose} title="Add skills" width={900}>
      <Tabs
        className="-mx-4 -mt-4 mb-4 px-3"
        value={tab}
        onChange={onTab}
        items={[
          { value: 'registry', label: <span className="flex items-center gap-1.5"><Store size={13} /> skills.sh registry</span> },
          { value: 'local', label: <span className="flex items-center gap-1.5"><FolderOpen size={13} /> Local folders</span> }
        ]}
      />
      {tab === 'registry' ? <RegistryBrowser onInstalled={onImported} /> : <LocalImport open={open} onImported={() => onImported()} />}
    </Modal>
  )
}

const REGISTRY_TOPICS = ['react', 'testing', 'git', 'security', 'design', 'docs', 'python', 'nestjs']

function RegistryBrowser({ onInstalled }: { onInstalled(name: string): void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistrySkill[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<RegistryPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults(null)
      setError(null)
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      api.skills
        .registrySearch(q)
        .then((r) => {
          setResults(r)
          setError(null)
          if (r[0] && !r.some((x) => x.id === selected)) setSelected(r[0].id)
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  useEffect(() => {
    if (!selected) return setPreview(null)
    setPreview(null)
    setPreviewError(null)
    let live = true
    api.skills
      .registryPreview(selected)
      .then((p) => live && setPreview(p))
      .catch((err) => live && setPreviewError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [selected])

  const install = async (overwrite = false) => {
    if (!preview) return
    setInstalling(true)
    try {
      const name = await api.skills.registryInstall(preview.id, overwrite)
      useApp.getState().toast(`Installed ${name} from skills.sh`, 'ok')
      setPreview({ ...preview, installedAs: name })
      setResults((rs) => rs?.map((r) => (r.id === preview.id ? { ...r, installedAs: name } : r)) ?? null)
      onInstalled(name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/already exists/.test(msg) && (await confirmAction(`${msg}.`, { title: 'Replace the existing skill?', confirmLabel: 'Replace', danger: true }))) {
        setInstalling(false)
        return install(true)
      }
      useApp.getState().toast(msg, 'error')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="grid h-[min(520px,60vh)] grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-4">
      <div className="flex min-h-0 flex-col">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-2.5 text-dim" />
          <Input autoFocus className="pl-7" placeholder="Search skills.sh — e.g. react, testing, commit" value={query} onChange={(e) => setQuery(e.target.value)} />
          {searching && <Spinner size={13} className="absolute right-2.5 top-2.5" />}
        </div>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {error && <div className="rounded-lg border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">{error}</div>}
          {!results && !error && (
            <div className="p-2">
              <div className="mb-2 text-[11.5px] text-dim">Browse the open agent-skills registry. Popular topics:</div>
              <div className="flex flex-wrap gap-1.5">
                {REGISTRY_TOPICS.map((t) => (
                  <button key={t} onClick={() => setQuery(t)} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-muted hover:border-crimson-line hover:text-fg">
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          {results && !results.length && <div className="p-3 text-[12px] text-dim">No skills match “{query}”.</div>}
          {results?.map((r) => (
            <ListItem key={r.id} active={r.id === selected} onClick={() => setSelected(r.id)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12px] text-fg">{r.name}</span>
                  {r.installedAs && <Badge tone="ok">installed</Badge>}
                </div>
                <div className="truncate text-[11px] text-dim">{r.source}</div>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-dim" title={`${r.installs.toLocaleString()} installs`}>
                <Download size={11} />
                {compact(r.installs)}
              </span>
            </ListItem>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-col rounded-[10px] border border-line bg-bg">
        {!selected ? (
          <Empty icon={<Store size={20} />} title="skills.sh">
            Search the registry, pick a skill to preview its SKILL.md, then install it into your hub.
          </Empty>
        ) : previewError ? (
          <div className="p-4 text-[12.5px] text-crimson-hi">{previewError}</div>
        ) : !preview ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="border-b border-line p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[14px] font-semibold">{preview.name}</div>
                  <div className="mt-0.5 line-clamp-3 text-[12px] text-muted">{preview.description || 'No description'}</div>
                  <button onClick={() => void api.app.openExternal(preview.url)} className="mt-1 flex max-w-full items-center gap-1 font-mono text-[11px] text-dim hover:text-crimson-hi" title={preview.url}>
                    <ExternalLink size={11} className="shrink-0" />
                    <span className="truncate">{preview.id}</span>
                  </button>
                </div>
                {preview.installedAs ? (
                  <Button size="sm" icon={<RefreshCw size={12} />} loading={installing} onClick={() => void install(true)} title="Download the latest snapshot again">
                    Reinstall
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" icon={<Download size={12} />} loading={installing} onClick={() => void install()}>
                    Install
                  </Button>
                )}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1">
                {preview.files.slice(0, 6).map((f) => (
                  <Badge key={f.path} tone="dim">
                    {f.path} · {bytes(f.bytes)}
                  </Badge>
                ))}
                {preview.files.length > 6 && (
                  <Badge tone="dim" title={preview.files.slice(6).map((f) => f.path).join('\n')}>
                    +{preview.files.length - 6} more files
                  </Badge>
                )}
              </div>
              <div className="mt-2 text-[11px] text-dim">Third-party instructions from a public repository — review them before relying on the skill. Nothing in a skill runs until an agent chooses to follow it.</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <Markdown text={preview.body} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function LocalImport({ open, onImported }: { open: boolean; onImported(): void }) {
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
    <div className="h-[min(520px,60vh)] overflow-y-auto">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[12px] text-dim">Skills found in ~/.claude/skills, ~/.agents/skills, ~/.codex/skills, ~/.cursor/skills and ~/.omp/skills.</div>
        <Button
          size="sm"
          icon={<FolderOpen size={13} />}
          onClick={async () => {
            const [dir] = await api.app.pickPaths({ directory: true, title: 'Folder containing skills' })
            if (dir) setExtra((e) => [...new Set([...e, dir])])
          }}
        >
          Scan another folder…
        </Button>
      </div>
      {!found ? (
        <Spinner />
      ) : !found.length ? (
        <div className="text-[12.5px] text-dim">No skills found in those folders.</div>
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
                      <Button size="sm" variant="ghost" onClick={async () => (await confirmAction(`The hub's copy of ${s.name} will be replaced with the version in ${s.source}.`, { title: 'Re-import skill?', confirmLabel: 'Re-import', danger: true })) && void importOne(s.dir, true)}>
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
    </div>
  )
}

function SkillView({ skill, onChanged }: { skill: Skill; onChanged(name?: string): void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)
  const [body, setBody] = useState(skill.body)
  const [saving, setSaving] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [update, setUpdate] = useState<SkillUpdateFile[] | null>(null)
  const [status, setStatus] = useState<SkillRegistryStatus | null>(null)
  const dirty = name !== skill.name || description !== skill.description || body !== skill.body
  const linked = status ? status.linked : (skill.source ?? null)

  /** Fetches the skills.sh link and update state; the main process may link it from the skills CLI lock file, so reload the skill when the link changed. */
  const refreshStatus = async () => {
    const s = await api.skills.registryStatus(skill.name).catch(() => null)
    if (!s) return
    setStatus(s)
    if ((s.linked?.id ?? null) !== (skill.source?.id ?? null)) onChanged(skill.name)
  }
  useEffect(() => {
    void refreshStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.name])

  const startUpdate = async () => {
    setUpdating(true)
    const diff = await attempt(() => api.skills.registryUpdateDiff(skill.name))
    setUpdating(false)
    if (!diff) return
    if (!diff.length) {
      useApp.getState().toast('Already up to date', 'ok')
      void refreshStatus()
      return
    }
    setUpdate(diff)
  }
  const applyUpdate = async () => {
    setUpdating(true)
    const updated = await attempt(() => api.skills.registryUpdate(skill.name), `Updated ${skill.name}`)
    setUpdating(false)
    setUpdate(null)
    if (updated) {
      onChanged(updated)
      void refreshStatus()
    }
  }

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
          </span>
        }
        subtitle={
          linked ? (
            <span className="flex items-center gap-1">
              <button onClick={() => void api.app.openExternal(linked.url)} className="flex items-center gap-1 text-dim hover:text-crimson-hi" title={linked.url}>
                <Store size={11} /> {linked.id.split('/').slice(0, 2).join('/')} on skills.sh
              </button>
              {` · updated ${timeAgo(skill.updatedAt)}`}
            </span>
          ) : (
            `Updated ${timeAgo(skill.updatedAt)}`
          )
        }
        actions={
          <>
            <IconButton title="Open folder" onClick={() => void api.app.openPath(skill.dir)}>
              <FolderOpen size={14} />
            </IconButton>
            {linked && (
              <Button icon={<RefreshCw size={13} />} loading={updating} onClick={() => void startUpdate()} title={status?.updateAvailable ? 'Update available from skills.sh' : 'Up to date — check again'}>
                Update
                {status?.updateAvailable && <span className="h-1.5 w-1.5 rounded-full bg-crimson" aria-label="Update available" />}
              </Button>
            )}
            <Button icon={<Upload size={13} />} onClick={() => setInstallOpen(true)}>
              Install to…
            </Button>
            <IconButton
              title="Delete (moves to skills-trash)"
              onClick={async () => {
                if (!(await confirmAction(`“${skill.name}” will be moved to the skills-trash folder, where you can still recover it.`, { title: 'Delete skill?', confirmLabel: 'Move to trash', danger: true }))) return
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
          { value: 'overview', label: 'Overview' },
          { value: 'instructions', label: 'SKILL.md' },
          { value: 'files', label: `Files (${skill.files.length})` }
        ]}
      />
      <div className="min-h-0 flex-1">
        {tab === 'overview' && <SkillOverview skill={skill} linked={linked} status={status} updating={updating} onUpdate={() => void startUpdate()} onLinkChanged={() => void refreshStatus()} onOpenTab={setTab} />}
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
                <div className="mb-2 text-[12px] font-medium text-dim">Preview</div>
                <Markdown text={body} />
              </div>
            </div>
          </div>
        )}
        {tab === 'files' && <SkillFiles skill={skill} onChanged={() => onChanged(skill.name)} />}
      </div>
      <InstallModal open={installOpen} onClose={() => setInstallOpen(false)} skill={skill} />
      <Modal
        open={!!update}
        onClose={() => setUpdate(null)}
        title={`Update ${skill.name} from skills.sh`}
        width={860}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUpdate(null)}>
              Keep mine
            </Button>
            <Button variant="primary" loading={updating} onClick={() => void applyUpdate()}>
              Update
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[12px] text-dim">
          {update?.length ? `${update.length} file${update.length === 1 ? '' : 's'} would change. Red is what you have; green is the new version.` : 'Only the version number changed: the files are the same.'}
        </p>
        <div className="grid gap-3">
          {update?.map((f) => (
            <div key={f.path}>
              <div className="mb-1 flex items-center gap-2 text-[12px]">
                <span className="font-mono text-muted">{f.path}</span>
                <span className={f.kind === 'removed' ? 'text-crimson-hi' : f.kind === 'added' ? 'text-ok' : 'text-dim'}>{f.kind}</span>
              </div>
              <DiffView diff={f.diff} maxHeight={280} />
            </div>
          ))}
        </div>
      </Modal>
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
          <Empty title="No bundled files" />
        )}
      </div>
    </div>
  )
}
