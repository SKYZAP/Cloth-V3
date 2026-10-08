import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { FilePlus2, FolderPlus, Globe, GraduationCap, Plus, RefreshCw, Search, Settings2, SlidersHorizontal, Trash2, Type as TypeIcon, Zap } from 'lucide-react'
import type { Collection, IngestProgress, ModelRef, RagAskResult, RagDocument, RagHit, RagMode } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { bytes, timeAgo } from '@/lib/format'
import { Button, Field, IconButton, Input, Modal, Segmented, Spinner, Switch, Textarea, confirmAction } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { Markdown } from '@/components/Markdown'
import { Inspector, InspectorHead, refocus } from '@/components/Inspector'

type Open = { kind: 'add' } | { kind: 'doc'; id: string } | { kind: 'settings' } | null

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
function sourcesOf(docs: RagDocument[]): { key: string; label: string; kind: 'folder' | 'site' | 'text'; docs: RagDocument[] }[] {
  const out = new Map<string, { key: string; label: string; kind: 'folder' | 'site' | 'text'; docs: RagDocument[] }>()
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

/**
 * What Cloth knows, and whether it finds the right passage: each collection opens on its search, with
 * its health, sources and documents beside it. Adding sources and reading a document happen in a panel.
 */
export function KnowledgePage() {
  const collections = useApp((s) => s.collections)
  const loadCollections = useApp((s) => s.loadCollections)
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem('cloth.knowledge'))
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
    if (!activeId || !collections.some((c) => c.id === activeId)) setActiveId(collections[0]?.id ?? null)
    void loadDocs(collections.map((c) => c.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections])
  useEffect(() => {
    try {
      if (activeId) localStorage.setItem('cloth.knowledge', activeId)
    } catch {
      /* storage unavailable */
    }
  }, [activeId])
  useEvent('ingest', (p) => {
    setLog((l) => [p, ...l].slice(0, 200))
    if (refreshTimer.current) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      void loadDocs([p.collectionId])
      void loadCollections()
    }, 600)
  })

  const active = collections.find((c) => c.id === activeId)
  const docs = active ? docsBy[active.id] : undefined
  const hasExamples = collections.some((c) => c.name === 'Cloth examples')
  const loadExamples = async () => {
    setLoadingExamples(true)
    const col = await attempt(() => api.rag.loadExamples())
    setLoadingExamples(false)
    await loadCollections()
    if (col) setActiveId(col.id)
    else if (col === null) useApp.getState().toast('No example documents are bundled with this build', 'info')
  }
  const openKey = open?.kind === 'doc' ? open.id : (open?.kind ?? null)
  const close = () => {
    const key = openKey
    setOpen(null)
    refocus(key)
  }
  const totalDocs = collections.reduce((n, c) => n + c.docCount, 0)
  const tabs = useRef<HTMLDivElement>(null)
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = collections.findIndex((c) => c.id === activeId)
    const next = collections[(i + (e.key === 'ArrowRight' ? 1 : -1) + collections.length) % collections.length]
    if (!next) return
    setActiveId(next.id)
    requestAnimationFrame(() => (tabs.current?.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus())
  }

  if (loaded && !collections.length)
    return (
      <div className="grid h-full place-items-center overflow-y-auto px-5">
        <div className="grid max-w-[520px] justify-items-center gap-3 py-10 text-center">
          <h1 className="text-[20px] font-semibold tracking-tight">Give Cloth something to know</h1>
          <p className="text-[13px] text-muted">A collection holds documents, folders and web pages. Chats search it and cite what they find. Start with the bundled examples to see how search works, or make your own.</p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <Button icon={<GraduationCap size={13} />} loading={loadingExamples} onClick={() => void loadExamples()}>
              Load the examples
            </Button>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
              New collection
            </Button>
          </div>
        </div>
        <NewCollection open={creating} onClose={() => setCreating(false)} onCreated={(c) => setActiveId(c.id)} />
      </div>
    )

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto grid w-[min(1180px,calc(100%-40px))] gap-4 py-6 mobile:w-[calc(100%-24px)] mobile:py-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <h1 className="text-[18px] font-semibold tracking-tight">Knowledge</h1>
              <p className="mt-0.5 text-[12.5px] text-dim">{loaded ? `${plural(collections.length, 'collection')}, ${plural(totalDocs, 'document')}` : '…'}</p>
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

          <div ref={tabs} role="tablist" aria-label="Collections" onKeyDown={onTabKey} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line">
            {collections.map((c) => {
              const on = c.id === activeId
              const need = attention(docsBy[c.id], c)
              return (
                <button
                  key={c.id}
                  data-tab={c.id}
                  role="tab"
                  aria-selected={on}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setActiveId(c.id)}
                  className={clsx('-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[13px]', on ? 'border-crimson text-fg' : 'border-transparent text-muted hover:text-fg')}
                >
                  {c.name}
                  <span className="text-[12px] tabular-nums text-dim">{c.docCount}</span>
                  {need && <span className="rounded-full border border-warn/35 px-2 py-px text-[11.5px] text-warn">{need}</span>}
                </button>
              )
            })}
          </div>

          {active && (
            <div role="tabpanel" aria-label={active.name} className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 max-[900px]:grid-cols-1">
              <SearchPanel key={active.id} collection={active} />
              <div className="grid content-start gap-4">
                <Health collection={active} docs={docs} onAdd={() => setOpen({ kind: 'add' })} onSettings={() => setOpen({ kind: 'settings' })} />
                <Documents docs={docs} onOpen={(id) => setOpen({ kind: 'doc', id })} />
              </div>
            </div>
          )}
        </div>
      </div>

      <Inspector open={!!open && !!active} label={open?.kind === 'add' ? 'Add sources' : open?.kind === 'settings' ? `${active?.name} settings` : 'Document'} onClose={close} width={760}>
        {active && open?.kind === 'add' && (
          <>
            <InspectorHead title={`Add to ${active.name}`} sub="Files, folders, web pages or text" onClose={close} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AddSources collection={active} log={log.filter((l) => l.collectionId === active.id)} />
            </div>
          </>
        )}
        {active && open?.kind === 'settings' && <CollectionSettings collection={active} docs={docs ?? []} onClose={close} onDeleted={() => setOpen(null)} />}
        {active && open?.kind === 'doc' && <DocView doc={docs?.find((d) => d.id === open.id)} onClose={close} reload={() => loadDocs([active.id]).then(() => loadCollections())} />}
      </Inspector>
      <NewCollection open={creating} onClose={() => setCreating(false)} onCreated={(c) => setActiveId(c.id)} />
    </div>
  )
}

function Health({ collection: c, docs, onAdd, onSettings }: { collection: Collection; docs?: RagDocument[]; onAdd(): void; onSettings(): void }) {
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
  return (
    <section aria-label="Health and sources" className="rounded-[12px] border border-line bg-elev">
      <h2 className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 text-[12.5px] font-semibold">
        Health
        <span className="flex-1" />
        <span className={clsx('rounded-full border px-2 py-px text-[11.5px] font-normal', need ? 'border-warn/35 text-warn' : 'border-ok/35 text-ok')}>{need ?? (c.embedding ? 'all embedded' : 'keyword search')}</span>
      </h2>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 px-3.5 py-3">
        <Fact label="documents" value={c.docCount} />
        <Fact label="passages" value={c.chunkCount} />
        <Fact label="embedding model" value={c.embedding?.modelId ?? 'none'} small />
        <Fact label="search" value={c.embeddingDim ? 'keywords + meaning' : 'keywords only'} small />
      </dl>
      {missing > 0 && (
        <div className="px-3.5 pb-3">
          <Button size="sm" icon={<Zap size={12} />} onClick={() => void attempt(() => api.rag.embedMissing(c.id), 'Embedding complete')}>
            Embed {plural(missing, 'document')}
          </Button>
        </div>
      )}
      {sources.length > 0 && (
        <div className="border-t border-line">
          <h3 className="px-3.5 pb-1 pt-2.5 text-[12px] font-medium text-dim">Sources</h3>
          {sources.map((s) => (
            <div key={s.key} className="flex items-center gap-2 px-3.5 py-1.5 text-[12.5px]">
              {s.kind === 'folder' ? <FolderPlus size={13} className="shrink-0 text-dim" aria-hidden="true" /> : s.kind === 'site' ? <Globe size={13} className="shrink-0 text-dim" aria-hidden="true" /> : <TypeIcon size={13} className="shrink-0 text-dim" aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate" title={s.label}>
                {s.kind === 'folder' ? s.label.split(/[\\/]/).slice(-2).join('/') : s.label}
              </span>
              <span className="shrink-0 text-[12px] tabular-nums text-dim">{s.docs.length}</span>
              {s.kind !== 'text' && (
                <Button size="sm" variant="ghost" icon={<RefreshCw size={11} />} loading={syncing === s.key} onClick={() => void sync(s.key)} title={`Re-index ${s.label}: new and changed ${s.kind === 'folder' ? 'files' : 'pages'} come in, missing ones go`}>
                  Sync
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line px-3.5 py-3">
        <Button size="sm" icon={<Plus size={12} />} onClick={onAdd} data-focus-key="add">
          Add sources
        </Button>
        <Button size="sm" variant="ghost" icon={<Settings2 size={12} />} onClick={onSettings} data-focus-key="settings">
          Settings
        </Button>
      </div>
    </section>
  )
}

function Fact({ label, value, small }: { label: string; value: ReactNode; small?: boolean }) {
  return (
    <div className="min-w-0">
      <dd className={clsx('truncate font-semibold tabular-nums', small ? 'text-[12.5px]' : 'text-[17px]')}>{value}</dd>
      <dt className="text-[12px] text-dim">{label}</dt>
    </div>
  )
}

function Documents({ docs, onOpen }: { docs?: RagDocument[]; onOpen(id: string): void }) {
  const [filter, setFilter] = useState('')
  if (!docs?.length) return null
  const max = Math.max(1, ...docs.map((d) => d.chunkCount))
  const shown = docs.filter((d) => !filter || `${d.title} ${d.source}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 200)
  return (
    <section aria-label="Documents" className="rounded-[12px] border border-line bg-elev">
      <h2 className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 text-[12.5px] font-semibold">
        Documents <span className="font-normal text-dim">passages</span>
      </h2>
      {docs.length > 8 && (
        <div className="px-3 pt-2.5">
          <Input placeholder="Filter documents" aria-label="Filter documents" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="max-h-[420px] overflow-y-auto py-1">
        {shown.map((d) => {
          const state = d.status === 'error' ? 'failed' : d.status !== 'ready' ? 'indexing' : null
          return (
            <button
              key={d.id}
              data-focus-key={d.id}
              onClick={() => onOpen(d.id)}
              aria-haspopup="dialog"
              title={d.source}
              className="grid w-full grid-cols-[minmax(0,1fr)_70px_28px] items-center gap-2 px-3.5 py-1.5 text-left text-[12.5px] hover:bg-elev-2"
            >
              <span className="min-w-0 truncate">
                {d.title}
                {state && <span className={clsx('ml-2 text-[11.5px]', state === 'failed' ? 'text-crimson-hi' : 'text-info')}>{state}</span>}
              </span>
              <span className="h-[5px] overflow-hidden rounded-full bg-line-strong" aria-hidden="true">
                <span className="block h-full rounded-full bg-info" style={{ width: `${(d.chunkCount / max) * 100}%` }} />
              </span>
              <span className="text-right text-[12px] tabular-nums text-dim">{d.chunkCount}</span>
            </button>
          )
        })}
        {docs.length > 200 && !filter && <p className="px-3.5 py-2 text-[12px] text-dim">Showing 200 of {docs.length}; filter to find the rest.</p>}
      </div>
    </section>
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

function Passage({ hit, n, best, words }: { hit: RagHit; n: number; best: number; words: string[] }) {
  const [more, setMore] = useState(false)
  const short = hit.text.length > 360 && !more
  return (
    <article id={`cite-${n}`} className="grid gap-1.5 border-t border-line py-3 first:border-t-0">
      <div className="flex items-center gap-2.5">
        <span className="w-5 shrink-0 text-[12px] tabular-nums text-dim">{n}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted" title={`${hit.source}${hit.headingPath ? ` › ${hit.headingPath}` : ''}`} translate="no">
          {hit.title}
          {hit.headingPath && <span className="text-dim"> › {hit.headingPath}</span>}
        </span>
        <span className="h-[5px] w-16 shrink-0 overflow-hidden rounded-full bg-line-strong" aria-hidden="true">
          <span className="block h-full rounded-full bg-ok" style={{ width: `${Math.max(6, (hit.score / best) * 100)}%` }} />
        </span>
        <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-dim" title="Relevance score (higher is closer)">
          {hit.score.toPrecision(2)}
        </span>
      </div>
      <p className="whitespace-pre-wrap pl-[30px] text-[12.5px] leading-relaxed text-muted">
        <Highlight text={short ? `${hit.text.slice(0, 360).trimEnd()}…` : hit.text} words={words} />
        {hit.text.length > 360 && (
          <button onClick={() => setMore(!more)} className="ml-1.5 text-[12px] text-dim underline underline-offset-2 hover:text-fg">
            {more ? 'Less' : 'More'}
          </button>
        )}
      </p>
    </article>
  )
}

/** Search the collection, or ask it a question and get an answer that cites the passages it used. */
function SearchPanel({ collection }: { collection: Collection }) {
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
    const input = { query: text, collectionIds: [collection.id], mode, k, model: model ?? undefined }
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
  const suggestions =
    collection.name === 'Cloth examples'
      ? ['undo my last commit but keep the changes', 'When should an API return 409 vs 422?', 'cron for every weekday at 9']
      : [`What does ${collection.name} cover?`, `The main ideas in ${collection.name}`]
  const words = useMemo(() => terms(asked), [asked])
  const best = Math.max(1e-9, ...(result?.search.hits.map((h) => h.score) ?? [1]))
  const status = loading
    ? asking
      ? 'Searching and writing an answer…'
      : 'Searching…'
    : result
      ? `${plural(result.search.hits.length, 'passage')} found${result.search.mode === 'hybrid' ? ' by keywords and meaning' : result.search.mode === 'keyword' ? ' by keywords' : result.search.mode === 'vector' ? ' by meaning' : ' by agentic search'} in ${result.search.tookMs} ms`
      : ''

  return (
    <section aria-label={`Search ${collection.name}`} className="grid min-w-0 content-start gap-3">
      <form
        className="flex items-center gap-2 rounded-[12px] border border-crimson-line bg-elev px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <Search size={15} className="shrink-0 text-dim" aria-hidden="true" />
        <input
          className="h-8 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-dim"
          placeholder={asking ? `Ask ${collection.name} a question` : `Search ${collection.name}`}
          aria-label={asking ? `Ask ${collection.name} a question` : `Search ${collection.name}`}
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
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-panel px-3 py-2 text-[12px] text-muted">
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
      {how === 'ask' && !hasModel && <p className="text-[12px] text-warn">Set a default model under Models to get answers; until then Ask shows passages only.</p>}
      <div aria-live="polite" className="min-h-[18px] text-[12px] text-dim">
        {loading && <Spinner size={12} className="mr-1.5 inline text-crimson" />}
        {status}
      </div>

      {error && (
        <div role="alert" className="rounded-[10px] border border-crimson-line bg-crimson-soft px-3.5 py-2.5 text-[12.5px] text-crimson-hi">
          {error}
        </div>
      )}

      {!loading && !result && !error && (
        <div className="grid gap-1.5">
          <span className="text-[12px] font-medium text-dim">Try</span>
          {suggestions.map((s) => (
            <button key={s} onClick={() => void run(s)} className="rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-left text-[12.5px] text-muted hover:border-crimson-line hover:text-fg">
              {s}
            </button>
          ))}
        </div>
      )}

      {!loading && result && (
        <>
          {result.search.hits.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-line-strong px-4 py-5 text-center text-[12.5px] text-dim">
              Nothing in {collection.name} matched “{asked}”.
              <div className="mt-1">{collection.docCount === 0 ? 'Add sources first, then search again.' : 'Try other words, or Keywords + meaning under the options.'}</div>
            </div>
          ) : (
            <>
              {result.answer && (
                <div className="rounded-[12px] border border-line-strong bg-elev p-4">
                  <div className="mb-2 text-[12px] text-dim">
                    Answer{result.model ? ` from ${result.model}` : ''} in {(result.tookMs / 1000).toFixed(1)} s, citing the passages below
                  </div>
                  <Markdown text={result.answer} references={result.search.hits} />
                </div>
              )}
              {result.error && <div className="rounded-[10px] border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-[12px] text-warn">{result.error}</div>}
              {result.search.queries.length > 1 && <p className="text-[12px] text-dim">Searched for: {result.search.queries.join('; ')}</p>}
              <div>
                {result.search.hits.map((h, i) => (
                  <Passage key={h.chunkId} hit={h} n={i + 1} best={best} words={words} />
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
        <p className="mb-3 truncate font-mono text-[11.5px] text-dim" title={doc.source} translate="no">
          {doc.source}
        </p>
        {doc.error && <p className="mb-3 rounded-[10px] border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">{doc.error}</p>}
        <div className="grid gap-2">
          {chunks.map((c) => (
            <div key={c.id} className="rounded-[10px] border border-line bg-panel p-3">
              <div className="mb-1 flex items-center gap-2 text-[11.5px] text-dim">
                <span className="tabular-nums">#{c.ord}</span>
                {c.headingPath && <span className="truncate">{c.headingPath}</span>}
                <span className="flex-1" />
                {c.embedded && <span className="text-ok">embedded</span>}
              </div>
              <pre className="selectable whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-muted">{c.text}</pre>
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
          <Field label="Description" hint="Chats read this to decide when to search the collection.">
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => description !== collection.description && void attempt(() => api.rag.updateCollection(collection.id, { description })).then(() => useApp.getState().loadCollections())}
            />
          </Field>
          <Field label="Embedding model" hint="Search by meaning as well as keywords. Changing it drops the existing vectors; embed again afterwards.">
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
        <Field label="Description" hint="Shown to the agent so it knows when to search this collection.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Official NestJS documentation" />
        </Field>
        <Field label="Embedding model" hint="Optional. Without one, search is keyword-only (BM25). Mark models as embedding models under Models.">
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
          <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
            <FolderPlus size={14} className="text-crimson-hi" /> Files & folders
          </div>
          <div className="mb-3 text-[12px] text-dim">Markdown, text, code (40+ languages), PDF, DOCX and HTML. Folders are walked recursively, skipping node_modules, .git and build output.</div>
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
          <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
            <Globe size={14} className="text-crimson-hi" /> Web page / docs site
          </div>
          <div className="mb-3 text-[12px] text-dim">
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
            <label className="flex items-center gap-2 text-[12px] text-muted">
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
                <label className="flex items-center gap-2 text-[12px] text-muted">
                  max pages
                  <Input type="number" className="w-20" min={1} max={1000} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
                </label>
                <Switch checked={sameOrigin} onChange={setSameOrigin} label="Stay under this path" />
              </>
            )}
          </div>
        </section>

        <section className="rounded-[12px] border border-line bg-elev p-4">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
            <TypeIcon size={14} className="text-crimson-hi" /> Paste text
          </div>
          <Input className="mb-2" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea rows={6} placeholder="Markdown or plain text…" value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[12px]" />
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
        <div className="border-b border-line px-3 py-2 text-[12px] font-semibold">Ingestion log</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px]">
          {log.map((l, i) => (
            <div key={i} className={clsx('truncate px-1 py-0.5', l.error ? 'text-crimson-hi' : l.done ? 'text-ok' : 'text-dim')} title={l.error ?? l.message}>
              {l.error ? `Failed: ${l.message}: ${l.error}` : l.message}
            </div>
          ))}
          {!log.length && <div className="p-2 text-dim">Nothing yet.</div>}
        </div>
      </section>
    </div>
  )
}

