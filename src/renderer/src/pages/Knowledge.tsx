import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ChevronDown, ChevronUp, FilePlus2, FolderPlus, Globe, GraduationCap, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Trash2, Type as TypeIcon, Zap } from 'lucide-react'
import type { Collection, IngestProgress, ModelRef, RagAskResult, RagDocument, RagHit, RagMode } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { bytes, timeAgo } from '@/lib/format'
import { Button, Field, IconButton, Input, Modal, Segmented, Spinner, Switch, Textarea, confirmAction, PageTitle } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Markdown } from '@/components/Markdown'
import { Inspector, InspectorHead, refocus } from '@/components/Inspector'

type Open = { kind: 'add' } | { kind: 'doc'; id: string } | { kind: 'settings' } | null
type Source = { key: string; label: string; kind: 'folder' | 'site' | 'text'; docs: RagDocument[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What a collection needs, in words (null when it's fine). */
function attention(docs: RagDocument[] | undefined, c: Collection): string | null {
  if (!docs) return null
  const indexing = docs.filter((d) => d.status === 'indexing' || d.status === 'pending').length
  if (indexing) return `indexing ${indexing}`
  const failed = docs.filter((d) => d.status === 'error').length
  if (failed) return `${failed} failed`
  const missing = c.embedding ? docs.filter((d) => d.status === 'ready' && !d.embedded).length : 0
  return missing ? `${missing} to embed` : null
}

/** Documents grouped by where they came from: top folders, sites, pasted text. */
function sourcesOf(docs: RagDocument[]): Source[] {
  const out = new Map<string, Source>()
  const add = (key: string, label: string, kind: 'folder' | 'site' | 'text', d: RagDocument) => {
    const g = out.get(key) ?? { key, label, kind, docs: [] }
    g.docs.push(d)
    out.set(key, g)
  }
  const dir = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
  const files = docs.filter((d) => d.sourceType === 'file')
  // Sub-folders fold into the top-most folder that has documents.
  const roots: string[] = []
  for (const d of [...new Set(files.map((f) => dir(f.source)))].sort((a, b) => a.length - b.length)) if (!roots.some((r) => d.startsWith(r + '\\') || d.startsWith(r + '/'))) roots.push(d)
  for (const f of files) {
    const root = roots.find((r) => dir(f.source) === r || f.source.startsWith(r + '\\') || f.source.startsWith(r + '/')) ?? dir(f.source)
    add(root, root, 'folder', f)
  }
  for (const d of docs.filter((x) => x.sourceType === 'url')) {
    let origin = d.source
    try {
      origin = new URL(d.source).origin
    } catch {
      /* not a URL */
    }
    add(origin, origin.replace(/^https?:\/\//, ''), 'site', d)
  }
  for (const d of docs.filter((x) => x.sourceType === 'text')) add('text', 'Pasted text', 'text', d)
  return [...out.values()]
}

const shortLabel = (s: Source) => (s.kind === 'folder' ? s.label.split(/[\\/]/).slice(-2).join('/') : s.label)

const needsAttention = (d: RagDocument, c: Collection) => d.status !== 'ready' || (!!c.embedding && !d.embedded)

/**
 * What Cloth knows, and whether it finds the right passage: an overview of every collection with a search
 * across all of them, and a page per collection with its health, sources, documents and search.
 * Adding sources and reading a document happen in a panel.
 */
export function KnowledgePage() {
  const collections = useApp((s) => s.collections)
  const loadCollections = useApp((s) => s.loadCollections)
  const [openId, setOpenId] = useState<string | null>(null)
  const [docsBy, setDocsBy] = useState<Record<string, RagDocument[]>>({})
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState<Open>(null)
  const [log, setLog] = useState<IngestProgress[]>([])
  const [loadingExamples, setLoadingExamples] = useState(false)
  const refreshTimer = useRef<number | null>(null)

  const loadDocs = async (ids: string[]) => {
    const lists = await Promise.all(ids.map((id) => api.rag.documents(id).then((d) => [id, d] as const, () => [id, [] as RagDocument[]] as const)))
    setDocsBy((cur) => ({ ...cur, ...Object.fromEntries(lists) }))
  }
  useEffect(() => {
    void loadCollections().then(() => setLoaded(true))
  }, [loadCollections])
  useEffect(() => {
    if (openId && !collections.some((c) => c.id === openId)) setOpenId(null)
    void loadDocs(collections.map((c) => c.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections])
  useEvent('ingest', (p) => {
    setLog((l) => [p, ...l].slice(0, 200))
    if (refreshTimer.current) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      void loadDocs([p.collectionId])
      void loadCollections()
    }, 600)
  })

  const active = collections.find((c) => c.id === openId)
  const docs = active ? docsBy[active.id] : undefined
  const hasExamples = collections.some((c) => c.name === 'Cloth examples')
  const openCollection = (id: string) => {
    setOpen(null)
    setOpenId(id)
    refocus('knowledge-back')
  }
  const back = () => {
    const id = openId
    setOpen(null)
    setOpenId(null)
    refocus(id)
  }
  const loadExamples = async () => {
    setLoadingExamples(true)
    const col = await attempt(() => api.rag.loadExamples())
    setLoadingExamples(false)
    await loadCollections()
    if (col) openCollection(col.id)
    else if (col === null) useApp.getState().toast('No example documents are bundled with this build', 'info')
  }
  const openKey = open?.kind === 'doc' ? open.id : (open?.kind ?? null)
  const close = () => {
    const key = openKey
    setOpen(null)
    refocus(key)
  }
  const names = useMemo(() => Object.fromEntries(collections.map((c) => [c.id, c.name])), [collections])

  if (loaded && !collections.length)
    return (
      <div className="grid h-full place-items-center overflow-y-auto px-5">
        <div className="grid max-w-[520px] justify-items-center gap-3 py-10 text-center">
          <h1 className="text-title font-semibold tracking-tight">Give Cloth something to know</h1>
          <p className="text-ui text-muted">Chats search your collections and cite what they find.</p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button icon={<GraduationCap size={13} />} loading={loadingExamples} onClick={() => void loadExamples()}>
              Load the examples
            </Button>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
              New collection
            </Button>
          </div>
        </div>
        <NewCollection open={creating} onClose={() => setCreating(false)} onCreated={(c) => openCollection(c.id)} />
      </div>
    )

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[calc(100%-48px)] max-w-[2200px] gap-4 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          {active ? (
            <CollectionPage
              key={active.id}
              collection={active}
              docs={docs}
              onBack={back}
              onAdd={() => setOpen({ kind: 'add' })}
              onSettings={() => setOpen({ kind: 'settings' })}
              onOpenDoc={(id) => setOpen({ kind: 'doc', id })}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[220px] flex-1">
                  <PageTitle>Knowledge</PageTitle>
                </div>
                {!hasExamples && (
                  <Button icon={<GraduationCap size={13} />} loading={loadingExamples} onClick={() => void loadExamples()}>
                    Examples
                  </Button>
                )}
                <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
                  New collection
                </Button>
              </div>

              {collections.length > 0 && <SearchPanel collections={collections} placeholder="Search all knowledge" names={names} />}

              <section aria-label="Collections" className="grid grid-cols-[repeat(auto-fill,minmax(max(280px,calc((100%_-_36px)/4)),1fr))] gap-3">
                {collections.map((c) => (
                  <CollectionCard key={c.id} collection={c} docs={docsBy[c.id]} onOpen={() => openCollection(c.id)} />
                ))}
                <button
                  onClick={() => setCreating(true)}
                  className="flex flex-col items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-line-strong p-4 text-center text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-crimson-line"
                >
                  <Plus size={16} aria-hidden="true" />
                  <span className="text-ui font-medium">New collection</span>
                  <span className="text-caption text-dim">Folders, web pages or pasted text</span>
                </button>
              </section>
            </>
          )}
        </div>
      </div>

      <Inspector open={!!open && !!active} label={open?.kind === 'add' ? 'Add sources' : open?.kind === 'settings' ? `${active?.name} settings` : 'Document'} onClose={close} width={760}>
        {active && open?.kind === 'add' && (
          <>
            <InspectorHead title={`Add to ${active.name}`} onClose={close} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AddSources collection={active} log={log.filter((l) => l.collectionId === active.id)} />
            </div>
          </>
        )}
        {active && open?.kind === 'settings' && (
          <CollectionSettings
            collection={active}
            docs={docs ?? []}
            onClose={close}
            onDeleted={() => {
              setOpen(null)
              setOpenId(null)
            }}
          />
        )}
        {active && open?.kind === 'doc' && <DocView doc={docs?.find((d) => d.id === open.id)} onClose={close} reload={() => loadDocs([active.id]).then(() => loadCollections())} />}
      </Inspector>
      <NewCollection open={creating} onClose={() => setCreating(false)} onCreated={(c) => openCollection(c.id)} />
    </div>
  )
}

function CollectionCard({ collection: c, docs, onOpen }: { collection: Collection; docs?: RagDocument[]; onOpen(): void }) {
  const sources = useMemo(() => sourcesOf(docs ?? []), [docs])
  const need = attention(docs, c)
  const updated = docs?.length ? Math.max(...docs.map((d) => d.updatedAt)) : null
  return (
    <button
      data-focus-key={c.id}
      onClick={onOpen}
      className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-panel p-4 text-left outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-crimson-line"
    >
      <span className="truncate text-body font-semibold">{c.name}</span>
      {c.description && <span className="line-clamp-2 text-ui text-muted">{c.description}</span>}
      <span className="text-ui tabular-nums text-dim">
        {plural(c.docCount, 'document')}, {plural(c.chunkCount, 'passage')}
      </span>
      <span className={clsx('flex items-center gap-1.5 text-ui', need ? 'text-warn' : 'text-ok')}>
        <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', need ? 'bg-warn' : 'bg-ok')} aria-hidden="true" />
        {need ?? (c.embedding ? 'All embedded' : 'Keyword search')}
      </span>
      <span className="mt-auto flex items-center gap-2 border-t border-line pt-2 text-caption text-dim">
        <span className="min-w-0 truncate" translate="no">
          {sources.length ? `${shortLabel(sources[0])}${sources.length > 1 ? ` +${sources.length - 1} more` : ''}` : 'No sources yet'}
        </span>
        {updated !== null && <span className="ml-auto shrink-0">updated {timeAgo(updated)}</span>}
      </span>
    </button>
  )
}

function CollectionPage({
  collection: c,
  docs,
  onBack,
  onAdd,
  onSettings,
  onOpenDoc
}: {
  collection: Collection
  docs?: RagDocument[]
  onBack(): void
  onAdd(): void
  onSettings(): void
  onOpenDoc(id: string): void
}) {
  const [tab, setTab] = useState<'documents' | 'search'>('documents')
  const [syncing, setSyncing] = useState<string | null>(null)
  const missing = c.embedding ? (docs ?? []).filter((d) => d.status === 'ready' && !d.embedded).length : 0
  const need = attention(docs, c)
  const sources = useMemo(() => sourcesOf(docs ?? []), [docs])
  const sync = async (key: string) => {
    setSyncing(key)
    const r = await attempt(() => api.rag.syncSource(c.id, key))
    setSyncing(null)
    if (r) useApp.getState().toast(r.removed ? `Re-checking ${plural(r.queued, 'file')}; removed ${r.removed} that are gone` : `Re-checking ${plural(r.queued, 'document')}`, 'info')
  }
  const tabs = useRef<HTMLDivElement>(null)
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const next = tab === 'documents' ? 'search' : 'documents'
    setTab(next)
    requestAnimationFrame(() => (tabs.current?.querySelector(`[data-tab="${next}"]`) as HTMLElement | null)?.focus())
  }

  return (
    <>
      <div>
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={onBack} data-focus-key="knowledge-back">
          Knowledge
        </Button>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[220px] flex-1">
          <h1 className="text-title font-semibold tracking-tight">{c.name}</h1>
          {c.description && <p className="mt-0.5 text-ui text-dim">{c.description}</p>}
        </div>
        <Button icon={<Plus size={13} />} onClick={onAdd} data-focus-key="add">
          Add sources
        </Button>
        <Button variant="ghost" icon={<Settings2 size={13} />} onClick={onSettings} data-focus-key="settings">
          Settings
        </Button>
      </div>

      <section aria-label="Health" className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[12px] border border-line bg-elev px-4 py-3">
        <dl className="contents">
          <Fact label="documents" value={c.docCount} />
          <Fact label="passages" value={c.chunkCount} />
          <Fact label="embedding model" value={c.embedding?.modelId ?? 'none'} small />
          <Fact label="search" value={c.embeddingDim ? 'keywords + meaning' : 'keywords only'} small />
        </dl>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className={clsx('rounded-full border px-2 py-px text-caption', need ? 'border-warn/35 text-warn' : 'border-ok/35 text-ok')}>{need ?? (c.embedding ? 'all embedded' : 'keyword search')}</span>
          {missing > 0 && (
            <Button size="sm" icon={<Zap size={12} />} onClick={() => void attempt(() => api.rag.embedMissing(c.id), 'Embedding complete')}>
              Embed {plural(missing, 'document')}
            </Button>
          )}
        </div>
      </section>

      <div ref={tabs} role="tablist" aria-label={c.name} onKeyDown={onTabKey} className="flex gap-1 border-b border-line">
        {(
          [
            ['documents', 'Documents'],
            ['search', 'Search']
          ] as const
        ).map(([value, label]) => {
          const on = tab === value
          return (
            <button
              key={value}
              data-tab={value}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(value)}
              className={clsx('-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-ui', on ? 'border-crimson text-fg' : 'border-transparent text-muted hover:text-fg')}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" aria-label={tab === 'documents' ? 'Documents' : 'Search'} className="grid min-w-0 gap-4">
        {tab === 'search' ? (
          <SearchPanel key={c.id} collections={[c]} placeholder={`Search ${c.name}`} suggest />
        ) : (
          <>
            {sources.length > 0 && (
              <div aria-label="Sources" className="flex flex-wrap gap-2">
                {sources.map((s) => (
                  <div key={s.key} className="flex min-w-0 items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-ui">
                    {s.kind === 'folder' ? <FolderPlus size={13} className="shrink-0 text-dim" aria-hidden="true" /> : s.kind === 'site' ? <Globe size={13} className="shrink-0 text-dim" aria-hidden="true" /> : <TypeIcon size={13} className="shrink-0 text-dim" aria-hidden="true" />}
                    <span className="min-w-0 truncate" title={s.label} translate="no">
                      {shortLabel(s)}
                    </span>
                    <span className="shrink-0 text-caption tabular-nums text-dim">{s.docs.length}</span>
                    {s.kind !== 'text' && (
                      <Button size="sm" variant="ghost" icon={<RefreshCw size={11} />} loading={syncing === s.key} onClick={() => void sync(s.key)} title={`Re-index ${s.label}: new and changed ${s.kind === 'folder' ? 'files' : 'pages'} come in, missing ones go`}>
                        Sync
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <DocumentTable collection={c} docs={docs} sources={sources} onOpen={onOpenDoc} onAdd={onAdd} />
          </>
        )}
      </div>
    </>
  )
}

function Fact({ label, value, small }: { label: string; value: ReactNode; small?: boolean }) {
  return (
    <div className="min-w-0">
      <dd className={clsx('truncate font-semibold tabular-nums', small ? 'text-ui' : 'text-section')}>{value}</dd>
      <dt className="text-caption text-dim">{label}</dt>
    </div>
  )
}

type SortKey = 'name' | 'passages' | 'updated'

function DocumentTable({ collection: c, docs, sources, onOpen, onAdd }: { collection: Collection; docs?: RagDocument[]; sources: Source[]; onOpen(id: string): void; onAdd(): void }) {
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'all' | 'attention'>('all')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'updated', desc: true })
  const sourceOf = useMemo(() => new Map(sources.flatMap((s) => s.docs.map((d) => [d.id, s] as const))), [sources])
  // Sites often give every page the same title; then the page's path tells them apart.
  const name = useMemo(() => {
    const seen = new Map<string, number>()
    for (const d of docs ?? []) seen.set(d.title, (seen.get(d.title) ?? 0) + 1)
    return (d: RagDocument) => {
      if ((seen.get(d.title) ?? 0) < 2) return d.title
      if (d.sourceType === 'url') {
        try {
          const u = new URL(d.source)
          return decodeURIComponent(u.pathname + u.hash).replace(/^\/$/, u.host) || d.title
        } catch {
          return d.title
        }
      }
      return d.source.split(/[\\/]/).slice(-2).join('/')
    }
  }, [docs])
  const matching = useMemo(() => {
    const q = filter.toLowerCase()
    const list = (docs ?? []).filter((d) => (!q || `${d.title} ${d.source}`.toLowerCase().includes(q)) && (view === 'all' || needsAttention(d, c)))
    const by = (a: RagDocument, b: RagDocument) => (sort.key === 'name' ? name(a).localeCompare(name(b)) : sort.key === 'passages' ? a.chunkCount - b.chunkCount : a.updatedAt - b.updatedAt)
    return list.sort((a, b) => (sort.desc ? by(b, a) : by(a, b)))
  }, [docs, filter, view, sort, name, c])
  const shown = matching.slice(0, 200)

  if (docs && !docs.length)
    return (
      <div className="grid justify-items-center gap-3 rounded-[12px] border border-dashed border-line-strong px-4 py-8 text-center">
        <p className="text-ui text-muted">No documents yet.</p>
        <Button icon={<Plus size={13} />} onClick={onAdd}>
          Add sources
        </Button>
      </div>
    )

  const cols = 'grid grid-cols-[minmax(0,1fr)_160px_80px_90px_70px] items-center gap-3 px-3.5 mobile:grid-cols-[minmax(0,1fr)_80px]'
  const head = (key: SortKey, label: string, right?: boolean) => {
    const on = sort.key === key
    return (
      <button
        onClick={() => setSort(on ? { key, desc: !sort.desc } : { key, desc: key !== 'name' })}
        aria-label={`Sort by ${label.toLowerCase()}`}
        className={clsx('flex items-center gap-1 hover:text-fg', right && 'justify-self-end', on && 'text-muted')}
      >
        {label}
        {on && (sort.desc ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronUp size={11} aria-hidden="true" />)}
      </button>
    )
  }

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Filter documents" aria-label="Filter documents" className="w-[260px] mobile:w-full" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Segmented
          value={view}
          onChange={setView}
          items={[
            { value: 'all', label: 'All' },
            { value: 'attention', label: 'Needs attention' }
          ]}
        />
        <span className="ml-auto text-caption tabular-nums text-dim">{plural(matching.length, 'document')}</span>
      </div>
      <div className="overflow-hidden rounded-[12px] border border-line">
        <div className={clsx(cols, 'border-b border-line py-2 text-caption text-dim')}>
          {head('name', 'Name')}
          <span className="mobile:hidden">Source</span>
          {head('passages', 'Passages', true)}
          <span className="mobile:hidden">{head('updated', 'Updated')}</span>
          <span className="text-right mobile:hidden">Size</span>
        </div>
        {shown.map((d) => {
          const state = d.status === 'error' ? 'failed' : d.status !== 'ready' ? 'indexing' : null
          const s = sourceOf.get(d.id)
          return (
            <button key={d.id} data-focus-key={d.id} onClick={() => onOpen(d.id)} aria-haspopup="dialog" title={d.source} className={clsx(cols, 'w-full border-t border-line py-2 text-left text-ui first-of-type:border-t-0 hover:bg-elev-2')}>
              <span className="min-w-0 truncate" translate="no">
                {name(d)}
                {state && <span className={clsx('ml-2 text-caption', state === 'failed' ? 'text-danger-hi' : 'text-info')}>{state}</span>}
              </span>
              <span className="min-w-0 truncate text-dim mobile:hidden" translate="no">
                {s ? shortLabel(s) : ''}
              </span>
              <span className="text-right tabular-nums">{d.chunkCount}</span>
              <span className="text-dim mobile:hidden">{timeAgo(d.updatedAt)}</span>
              <span className="text-right tabular-nums text-dim mobile:hidden">{bytes(d.bytes)}</span>
            </button>
          )
        })}
        {docs && !matching.length && <p className="px-3.5 py-2.5 text-ui text-dim">No document matches.</p>}
        {matching.length > 200 && <p className="border-t border-line px-3.5 py-2 text-caption text-dim">Showing 200 of {matching.length}; filter to find the rest.</p>}
      </div>
    </div>
  )
}

/** The words of a query worth highlighting in a passage. */
const terms = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !['the', 'and', 'for', 'with', 'how', 'what', 'does', 'but', 'you', 'your', 'are', 'can', 'when', 'should'].includes(w))

function Highlight({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[3px] bg-warn/20 px-0.5 text-fg">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  )
}

function Passage({ hit, n, best, words, collection }: { hit: RagHit; n: number; best: number; words: string[]; collection?: string }) {
  const [more, setMore] = useState(false)
  const short = hit.text.length > 360 && !more
  return (
    <article id={`cite-${n}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 border-t border-line py-3 first:border-t-0">
      <div className="flex items-center gap-2.5">
        <span className="w-5 shrink-0 text-caption tabular-nums text-dim">{n}</span>
        <span className="min-w-0 truncate font-mono text-caption text-muted" title={`${hit.source}${hit.headingPath ? ` › ${hit.headingPath}` : ''}`} translate="no">
          {hit.title}
          {hit.headingPath && <span className="text-dim"> › {hit.headingPath}</span>}
        </span>
        {collection && <span className="shrink-0 text-caption text-dim">{collection}</span>}
        <span className="flex-1" />
        <span className="h-[5px] w-16 shrink-0 overflow-hidden rounded-full bg-line-strong" aria-hidden="true">
          <span className="block h-full rounded-full bg-ok" style={{ width: `${Math.max(6, (hit.score / best) * 100)}%` }} />
        </span>
        <span className="w-12 shrink-0 text-right text-caption tabular-nums text-dim" title="Relevance score (higher is closer)">
          {hit.score.toPrecision(2)}
        </span>
      </div>
      <p className="whitespace-pre-wrap pl-[30px] text-ui leading-relaxed text-muted [overflow-wrap:anywhere]">
        <Highlight text={short ? `${hit.text.slice(0, 360).trimEnd()}…` : hit.text} words={words} />
        {hit.text.length > 360 && (
          <button onClick={() => setMore(!more)} className="ml-1.5 text-caption text-dim underline underline-offset-2 hover:text-fg">
            {more ? 'Less' : 'More'}
          </button>
        )}
      </p>
    </article>
  )
}

/** Search the collections, or ask them a question and get an answer that cites the passages it used. */
function SearchPanel({ collections, placeholder, suggest, names }: { collections: Collection[]; placeholder: string; suggest?: boolean; names?: Record<string, string> }) {
  const settings = useApp((s) => s.settings)
  const [query, setQuery] = useState('')
  const [how, setHow] = useState<'search' | 'ask'>('search')
  const [mode, setMode] = useState<RagMode>('hybrid')
  const [k, setK] = useState(8)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [options, setOptions] = useState(false)
  const [result, setResult] = useState<RagAskResult | null>(null)
  const [asked, setAsked] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const hasModel = !!(model ?? settings?.defaultModel)
  const asking = how === 'ask' && hasModel

  const run = async (q = query) => {
    const text = q.trim()
    if (!text || loading) return
    setQuery(text)
    setLoading(true)
    setError(null)
    setAsked(text)
    const input = { query: text, collectionIds: collections.map((c) => c.id), mode, k, model: model ?? undefined }
    try {
      if (asking) setResult(await api.rag.ask(input))
      else {
        const search = await api.rag.search(input)
        setResult({ answer: null, model: null, search, error: null, tookMs: search.tookMs })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }
  const single = collections.length === 1 ? collections[0] : null
  const suggestions = !suggest || !single ? [] : single.name === 'Cloth examples' ? ['undo my last commit but keep the changes', 'When should an API return 409 vs 422?', 'cron for every weekday at 9'] : [`What does ${single.name} cover?`, `The main ideas in ${single.name}`]
  const askLabel = single ? `Ask ${single.name} a question` : 'Ask a question'
  const words = useMemo(() => terms(asked), [asked])
  const spread = !!names && new Set(result?.search.hits.map((h) => h.collectionId)).size > 1
  const best = Math.max(1e-9, ...(result?.search.hits.map((h) => h.score) ?? [1]))
  const status = loading
    ? asking
      ? 'Searching and writing an answer…'
      : 'Searching…'
    : result
      ? `${plural(result.search.hits.length, 'passage')} found${result.search.mode === 'hybrid' ? ' by keywords and meaning' : result.search.mode === 'keyword' ? ' by keywords' : result.search.mode === 'vector' ? ' by meaning' : ' by agentic search'} in ${result.search.tookMs} ms`
      : ''

  return (
    <section aria-label={placeholder} className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3">
      <form
        className="flex items-center gap-2 rounded-[12px] border border-crimson-line bg-elev px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <Search size={15} className="shrink-0 text-dim" aria-hidden="true" />
        <input
          className="h-8 min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-dim"
          placeholder={asking ? askLabel : placeholder}
          aria-label={asking ? askLabel : placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          value={how}
          onChange={setHow}
          items={[
            { value: 'search', label: 'Search', title: 'Show matching passages' },
            { value: 'ask', label: 'Ask', title: hasModel ? 'Answer with sources, as a chat would' : 'Set a default model to get answers' }
          ]}
        />
        <IconButton title="Search options" aria-label="Search options" aria-expanded={options} onClick={() => setOptions(!options)}>
          <SlidersHorizontal size={14} />
        </IconButton>
        <Button type="submit" variant="primary" size="sm" loading={loading} disabled={!query.trim()}>
          {asking ? 'Ask' : 'Search'}
        </Button>
      </form>
      {options && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-panel px-3 py-2 text-caption text-muted">
          <Segmented
            value={mode}
            onChange={setMode}
            items={[
              { value: 'hybrid', label: 'Keywords + meaning', title: 'BM25 and vectors, fused' },
              { value: 'keyword', label: 'Keywords', title: 'SQLite FTS5 BM25' },
              { value: 'vector', label: 'Meaning', title: 'Vectors only' },
              { value: 'agentic', label: 'Agentic', title: 'A model plans queries, reflects and reranks' }
            ]}
          />
          <label className="flex items-center gap-1.5">
            Results
            <Input type="number" className="h-7 w-14" min={1} max={50} value={k} onChange={(e) => setK(Number(e.target.value))} aria-label="Number of results" />
          </label>
          {(how === 'ask' || mode === 'agentic') && (
            <div className="w-60">
              <ModelPicker value={model} onChange={setModel} allowNone noneLabel={settings?.defaultModel ? `Default (${settings.defaultModel.modelId})` : 'Default model (none set)'} />
            </div>
          )}
        </div>
      )}
      {how === 'ask' && !hasModel && <p className="text-caption text-warn">Set a default model under Models to get answers; until then Ask shows passages only.</p>}
      <div aria-live="polite" className="min-h-[18px] text-caption text-dim">
        {loading && <Spinner size={12} className="mr-1.5 inline text-muted" />}
        {status}
      </div>

      {error && (
        <div role="alert" className="rounded-[10px] border border-danger-line bg-danger-soft px-3.5 py-2.5 text-ui text-danger-hi">
          {error}
        </div>
      )}

      {!loading && !result && !error && suggestions.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-caption font-medium text-dim">Try</span>
          {suggestions.map((s) => (
            <button key={s} onClick={() => void run(s)} className="rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-left text-ui text-muted hover:border-crimson-line hover:text-fg">
              {s}
            </button>
          ))}
        </div>
      )}

      {!loading && result && (
        <>
          {result.search.hits.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-line-strong px-4 py-5 text-center text-ui text-dim">
              Nothing{single ? ` in ${single.name}` : ''} matched “{asked}”.
              <div className="mt-1">{collections.every((c) => c.docCount === 0) ?'Add sources first, then search again.' : 'Try other words, or Keywords + meaning under the options.'}</div>
            </div>
          ) : (
            <>
              {result.answer && (
                <div className="min-w-0 rounded-[12px] border border-line-strong bg-elev p-4 [&_pre]:max-w-full [&_pre]:overflow-x-auto">
                  <div className="mb-2 text-caption text-dim">
                    Answer{result.model ? ` from ${result.model}` : ''} in {(result.tookMs / 1000).toFixed(1)} s, citing the passages below
                  </div>
                  <Markdown text={result.answer} references={result.search.hits} />
                </div>
              )}
              {result.error && <div className="rounded-[10px] border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-caption text-warn">{result.error}</div>}
              {result.search.queries.length > 1 && <p className="text-caption text-dim">Searched for: {result.search.queries.join('; ')}</p>}
              <div>
                {result.search.hits.map((h, i) => (
                  <Passage key={h.chunkId} hit={h} n={i + 1} best={best} words={words} collection={spread ? names?.[h.collectionId] : undefined} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

function DocView({ doc, onClose, reload }: { doc?: RagDocument; onClose(): void; reload(): Promise<void> }) {
  const [chunks, setChunks] = useState<Awaited<ReturnType<typeof api.rag.chunks>>>([])
  useEffect(() => {
    if (doc) void api.rag.chunks(doc.id).then(setChunks)
  }, [doc?.id, doc?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!doc) return <InspectorHead title="Document removed" onClose={onClose} />
  return (
    <>
      <InspectorHead
        title={doc.title}
        sub={`${plural(doc.chunkCount, 'passage')}, ${bytes(doc.bytes)}, updated ${timeAgo(doc.updatedAt)}${doc.embedded ? ', embedded' : ''}`}
        onClose={onClose}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void attempt(() => api.rag.reindexDocument(doc.id)).then(reload)}>
              Re-index
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={12} />}
              onClick={async () => {
                if (!(await confirmAction(`“${doc.title}” is removed from the collection. The file itself stays.`, { title: 'Remove document?', confirmLabel: 'Remove', danger: true }))) return
                await attempt(() => api.rag.deleteDocument(doc.id))
                await reload()
                onClose()
              }}
            >
              Remove
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-3 truncate font-mono text-caption text-dim" title={doc.source} translate="no">
          {doc.source}
        </p>
        {doc.error && <p className="mb-3 rounded-[10px] border border-warn/30 bg-warn/10 px-3 py-2 text-caption text-warn">{doc.error}</p>}
        <div className="grid gap-2">
          {chunks.map((c) => (
            <div key={c.id} className="rounded-[10px] border border-line bg-panel p-3">
              <div className="mb-1 flex items-center gap-2 text-caption text-dim">
                <span className="tabular-nums">#{c.ord}</span>
                {c.headingPath && <span className="truncate">{c.headingPath}</span>}
                <span className="flex-1" />
                {c.embedded && <span className="text-ok">embedded</span>}
              </div>
              <pre className="selectable whitespace-pre-wrap font-mono text-caption leading-relaxed text-muted">{c.text}</pre>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function CollectionSettings({ collection, docs, onClose, onDeleted }: { collection: Collection; docs: RagDocument[]; onClose(): void; onDeleted(): void }) {
  const [description, setDescription] = useState(collection.description)
  useEffect(() => setDescription(collection.description), [collection.description])
  const missing = collection.embedding ? docs.filter((d) => d.status === 'ready' && !d.embedded).length : 0
  return (
    <>
      <InspectorHead title={collection.name} sub="Collection settings" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="grid gap-5">
          <Field label="Description">
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => description !== collection.description && void attempt(() => api.rag.updateCollection(collection.id, { description })).then(() => useApp.getState().loadCollections())}
            />
          </Field>
          <Field label="Embedding model">
            <ModelPicker
              kind="embedding"
              value={collection.embedding}
              allowNone
              noneLabel="None: keyword search only"
              onChange={async (embedding) => {
                if (collection.chunkCount && !(await confirmAction('Existing vectors are dropped. Embed the documents again afterwards.', { title: 'Change the embedding model?', confirmLabel: 'Change model' }))) return
                await attempt(() => api.rag.updateCollection(collection.id, { embedding }))
                await useApp.getState().loadCollections()
              }}
            />
          </Field>
          {missing > 0 && (
            <div>
              <Button icon={<Zap size={13} />} onClick={() => void attempt(() => api.rag.embedMissing(collection.id), 'Embedding complete')}>
                Embed {plural(missing, 'document')}
              </Button>
            </div>
          )}
          <div className="border-t border-line pt-4">
            <Button
              variant="ghost"
              icon={<Trash2 size={13} />}
              onClick={async () => {
                if (!(await confirmAction(`“${collection.name}” and all of its indexed documents will be deleted. Your files stay where they are.`, { title: `Delete ${collection.name}?`, confirmLabel: 'Delete', danger: true }))) return
                await attempt(() => api.rag.deleteCollection(collection.id))
                await useApp.getState().loadCollections()
                onDeleted()
              }}
            >
              Delete collection
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

function NewCollection({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(c: Collection): void }) {
  const settings = useApp((s) => s.settings)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [embedding, setEmbedding] = useState<ModelRef | null>(null)
  useEffect(() => {
    if (open) {
      setName('')
      setDescription('')
      setEmbedding(settings?.embeddingModel ?? null)
    }
  }, [open, settings])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New collection"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              const c = await attempt(() => api.rag.createCollection({ name, description, embedding }))
              if (c) {
                await useApp.getState().loadCollections()
                onCreated(c)
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
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="nestjs-docs" />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Official NestJS documentation" />
        </Field>
        <Field label="Embedding model" hint="Optional. Without one, search is keyword-only.">
          <ModelPicker kind="embedding" value={embedding} onChange={setEmbedding} allowNone noneLabel="None — keyword only" />
        </Field>
      </div>
    </Modal>
  )
}

function AddSources({ collection, log }: { collection: Collection; log: IngestProgress[] }) {
  const [url, setUrl] = useState('')
  const [crawl, setCrawl] = useState(false)
  const [maxPages, setMaxPages] = useState(25)
  const [sameOrigin, setSameOrigin] = useState(true)
  const [render, setRender] = useState<'auto' | 'always' | 'never'>('auto')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')

  const pick = async (directory: boolean) => {
    const paths = await api.app.pickPaths({ directory, multiple: true, title: directory ? 'Index folders' : 'Index files' })
    if (paths.length) await attempt(() => api.rag.ingestPaths(collection.id, paths))
  }

  return (
    <div className="grid gap-4 p-5">
      <div className="space-y-4">
        <section className="rounded-[12px] border border-line bg-elev p-4">
          <div className="mb-1 flex items-center gap-2 text-ui font-semibold">
            <FolderPlus size={14} className="text-muted" /> Files & folders
          </div>
          <div className="mb-3 text-caption text-dim">Markdown, text, code, PDF, DOCX and HTML.</div>
          <div className="flex gap-2">
            <Button icon={<FilePlus2 size={13} />} onClick={() => void pick(false)}>
              Add files
            </Button>
            <Button icon={<FolderPlus size={13} />} onClick={() => void pick(true)}>
              Add folder
            </Button>
          </div>
        </section>

        <section className="rounded-[12px] border border-line bg-elev p-4">
          <div className="mb-1 flex items-center gap-2 text-ui font-semibold">
            <Globe size={14} className="text-muted" /> Web page / docs site
          </div>
          <div className="mb-3 text-caption text-dim">
            Readability extraction to Markdown. JavaScript-rendered sites (React/Angular docs) are rendered with the bundled Obscura browser automatically. Crawl follows links under the same path prefix.
          </div>
          <div className="flex gap-2">
            <Input placeholder="https://docs.example.com/guide/" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Button
              variant="primary"
              disabled={!/^https?:\/\//.test(url)}
              onClick={async () => {
                const r = await attempt(() => api.rag.ingestUrl({ collectionId: collection.id, url, crawl, maxPages, sameOrigin, render }))
                if (r) setUrl('')
              }}
            >
              Index
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-caption text-muted">
              JS rendering
              <Segmented
                value={render}
                onChange={setRender}
                items={[
                  { value: 'auto', label: 'Auto', title: 'Plain fetch; render with Obscura only when the page is an empty JavaScript shell' },
                  { value: 'always', label: 'Always', title: 'Render every page with Obscura' },
                  { value: 'never', label: 'Off', title: 'Plain HTTP only' }
                ]}
              />
            </label>
            <Switch checked={crawl} onChange={setCrawl} label="Crawl linked pages" />
            {crawl && (
              <>
                <label className="flex items-center gap-2 text-caption text-muted">
                  max pages
                  <Input type="number" className="w-20" min={1} max={1000} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
                </label>
                <Switch checked={sameOrigin} onChange={setSameOrigin} label="Stay under this path" />
              </>
            )}
          </div>
        </section>

        <section className="rounded-[12px] border border-line bg-elev p-4">
          <div className="mb-3 flex items-center gap-2 text-ui font-semibold">
            <TypeIcon size={14} className="text-muted" /> Paste text
          </div>
          <Input className="mb-2" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea rows={6} placeholder="Markdown or plain text…" value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-caption" />
          <div className="mt-2 flex justify-end">
            <Button
              variant="primary"
              disabled={!text.trim()}
              onClick={async () => {
                const d = await attempt(() => api.rag.ingestText(collection.id, title || 'Pasted text', text), 'Indexed')
                if (d) {
                  setText('')
                  setTitle('')
                }
              }}
            >
              Index text
            </Button>
          </div>
        </section>
      </div>

      <section className="flex max-h-[640px] flex-col rounded-[12px] border border-line bg-elev">
        <div className="border-b border-line px-3 py-2 text-caption font-semibold">Ingestion log</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-caption">
          {log.map((l, i) => (
            <div key={i} className={clsx('truncate px-1 py-0.5', l.error ? 'text-danger-hi' : l.done ? 'text-ok' : 'text-dim')} title={l.error ?? l.message}>
              {l.error ? `Failed: ${l.message}: ${l.error}` : l.message}
            </div>
          ))}
          {!log.length && <div className="p-2 text-dim">Nothing yet.</div>}
        </div>
      </section>
    </div>
  )
}

