import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { BookOpen, FilePlus2, FileText, FolderPlus, Globe, GraduationCap, Layers, Plus, RefreshCw, Search, Trash2, Type as TypeIcon, Zap } from 'lucide-react'
import type { Collection, IngestProgress, ModelRef, RagAskResult, RagDocument, RagMode } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { bytes, timeAgo } from '@/lib/format'
import { Badge, Button, Card, Dot, Empty, Field, IconButton, Input, ListItem, ListPane, Modal, PageHeader, Segmented, Spinner, Switch, Tabs, Textarea, confirmAction } from '@/components/ui'
import { SplitDetail, SplitRoot } from '@/components/SplitView'
import { ModelPicker } from '@/components/ModelPicker'
import { ReferenceCard } from '@/components/ToolTrace'
import { Markdown } from '@/components/Markdown'

type Tab = 'documents' | 'add' | 'search'

export function KnowledgePage() {
  const collections = useApp((s) => s.collections)
  const loadCollections = useApp((s) => s.loadCollections)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void loadCollections().then(() => setLoaded(true))
  }, [loadCollections])
  useEffect(() => {
    if (!activeId || !collections.some((c) => c.id === activeId)) setActiveId(collections[0]?.id ?? null)
  }, [collections, activeId])

  const active = collections.find((c) => c.id === activeId)
  const [loadingExamples, setLoadingExamples] = useState(false)
  const loadExamples = async () => {
    setLoadingExamples(true)
    const col = await attempt(() => api.rag.loadExamples())
    setLoadingExamples(false)
    await loadCollections()
    if (col) setActiveId(col.id)
    else if (col === null) useApp.getState().toast('No example documents are bundled with this build', 'info')
  }
  return (
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        header={
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold">Knowledge</div>
              <div className="text-[11px] text-dim">{collections.length} collection{collections.length === 1 ? '' : 's'}</div>
            </div>
            <div className="flex gap-1">
              <Button size="sm" title="Load example knowledge (bundled docs)" icon={<GraduationCap size={13} />} onClick={() => void loadExamples()} disabled={loadingExamples}>
                Examples
              </Button>
              <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
                New
              </Button>
            </div>
          </div>
        }
      >
        {collections.map((c) => (
          <ListItem key={c.id} active={c.id === activeId} onClick={() => (setActiveId(c.id), setOpen(true))}>
            <Layers size={14} className="shrink-0 text-dim" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px]">{c.name}</div>
              <div className="text-[11px] text-dim">
                {c.docCount} docs · {c.chunkCount} chunks
              </div>
            </div>
            {c.embeddingDim ? <Badge tone="crimson">vec</Badge> : <Badge tone="dim">bm25</Badge>}
          </ListItem>
        ))}
        {loaded && !collections.length && <div className="p-4 text-center text-[12px] text-dim">No collections yet — tap New, or Examples for sample docs.</div>}
      </ListPane>
      <SplitDetail>
        {active ? (
          <CollectionView key={active.id} collection={active} />
        ) : (
          <Empty
            icon={<BookOpen size={20} />}
            title="No knowledge yet"
            action={
              <div className="flex gap-2">
                <Button icon={<GraduationCap size={13} />} loading={loadingExamples} onClick={() => void loadExamples()}>
                  Load example knowledge
                </Button>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  Create a collection
                </Button>
              </div>
            }
          >
            Collections hold documents, folders and web pages. Search is hybrid: SQLite FTS5 (BM25) fused with embeddings via reciprocal-rank fusion.
          </Empty>
        )}
      </SplitDetail>
      <NewCollection open={creating} onClose={() => setCreating(false)} onCreated={(c) => (setActiveId(c.id), setOpen(true))} />
    </SplitRoot>
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

function CollectionView({ collection }: { collection: Collection }) {
  const [tab, setTab] = useState<Tab>('documents')
  const [docs, setDocs] = useState<RagDocument[]>([])
  const [log, setLog] = useState<IngestProgress[]>([])
  const refreshTimer = useRef<number | null>(null)

  const loadDocs = async () => setDocs(await api.rag.documents(collection.id))
  useEffect(() => {
    void loadDocs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection.id])

  useEvent('ingest', (p) => {
    if (p.collectionId !== collection.id) return
    setLog((l) => [p, ...l].slice(0, 200))
    if (refreshTimer.current) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      void loadDocs()
      void useApp.getState().loadCollections()
    }, 600)
  })

  const busy = log[0] && !log[0].done && docs.some((d) => d.status === 'indexing' || d.status === 'pending')
  const missing = docs.filter((d) => d.status === 'ready' && !d.embedded).length

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {collection.name}
            {busy && <Spinner size={13} />}
          </span>
        }
        subtitle={collection.description || 'No description'}
        actions={
          <>
            <div className="w-64">
              <ModelPicker
                kind="embedding"
                value={collection.embedding}
                allowNone
                noneLabel="No embeddings (BM25 only)"
                onChange={async (embedding) => {
                  if (collection.chunkCount && !(await confirmAction('Existing vectors are dropped. Re-embed afterwards with “Embed missing”.', { title: 'Change the embedding model?', confirmLabel: 'Change model' }))) return
                  await attempt(() => api.rag.updateCollection(collection.id, { embedding }))
                  await useApp.getState().loadCollections()
                }}
              />
            </div>
            {collection.embedding && missing > 0 && (
              <Button icon={<Zap size={13} />} onClick={() => void attempt(() => api.rag.embedMissing(collection.id), 'Embedding complete')}>
                Embed {missing} missing
              </Button>
            )}
            <IconButton
              title="Delete collection"
              onClick={async () => {
                if (!(await confirmAction(`“${collection.name}” and all of its indexed documents will be deleted.`, { title: 'Delete collection?', confirmLabel: 'Delete', danger: true }))) return
                await attempt(() => api.rag.deleteCollection(collection.id))
                await useApp.getState().loadCollections()
              }}
            >
              <Trash2 size={14} />
            </IconButton>
          </>
        }
      />
      <div className="grid grid-cols-4 gap-3 border-b border-line px-5 py-3">
        <Stat label="Documents" value={collection.docCount} />
        <Stat label="Chunks" value={collection.chunkCount} />
        <Stat label="Vectors" value={collection.embeddingDim ? `${collection.embeddingDim}-d` : '—'} />
        <Stat label="Retrieval" value={collection.embeddingDim ? 'Hybrid RRF' : 'BM25'} />
      </div>
      <Tabs
        className="px-3"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'documents', label: `Documents (${docs.length})` },
          { value: 'add', label: 'Add sources' },
          { value: 'search', label: 'Search playground' }
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'documents' && <DocumentsTable docs={docs} reload={loadDocs} onAdd={() => setTab('add')} />}
        {tab === 'add' && <AddSources collection={collection} log={log} />}
        {tab === 'search' && <SearchPlayground collection={collection} />}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[12px] font-medium text-dim">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function DocumentsTable({ docs, reload, onAdd }: { docs: RagDocument[]; reload(): Promise<void>; onAdd(): void }) {
  const [viewing, setViewing] = useState<RagDocument | null>(null)
  const [filter, setFilter] = useState('')
  if (!docs.length)
    return (
      <Empty icon={<FilePlus2 size={20} />} title="Empty collection" action={<Button variant="primary" onClick={onAdd}>Add sources</Button>}>
        Index files, whole folders (code-aware), PDFs, Word documents, web pages or pasted text.
      </Empty>
    )
  const shown = docs.filter((d) => !filter || `${d.title} ${d.source}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <div className="p-4">
      <Input className="mb-3 max-w-sm" placeholder="Filter documents" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-[12px]">
          <thead className="bg-panel text-left text-[11.5px] font-medium text-dim">
            <tr>
              <th className="px-3 py-2 font-medium">Document</th>
              <th className="w-20 px-3 py-2 font-medium mobile:hidden">Chunks</th>
              <th className="w-20 px-3 py-2 font-medium mobile:hidden">Size</th>
              <th className="w-24 px-3 py-2 font-medium mobile:hidden">Vectors</th>
              <th className="w-24 px-3 py-2 font-medium mobile:hidden">Updated</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="group border-t border-line hover:bg-panel">
                <td className="max-w-0 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Dot tone={d.status === 'ready' ? (d.error ? 'warn' : 'ok') : d.status === 'error' ? 'crimson' : 'info'} pulse={d.status === 'indexing'} />
                    {d.sourceType === 'url' ? <Globe size={12} className="shrink-0 text-dim" /> : d.sourceType === 'text' ? <TypeIcon size={12} className="shrink-0 text-dim" /> : <FileText size={12} className="shrink-0 text-dim" />}
                    <button className="truncate text-left font-medium hover:text-crimson-hi" onClick={() => setViewing(d)}>
                      {d.title}
                    </button>
                  </div>
                  <div className="truncate pl-[26px] font-mono text-[10.5px] text-dim" title={d.source}>
                    {d.source}
                  </div>
                  {/* Phones: the columns don't fit, so the numbers go under the name. */}
                  <div className="hidden pl-[26px] text-[11px] tabular-nums text-dim mobile:block">
                    {d.chunkCount} chunks · {bytes(d.bytes)}{d.embedded ? ' · embedded' : ''} · {timeAgo(d.updatedAt)}
                  </div>
                  {d.error && <div className="truncate pl-[26px] text-[11px] text-warn" title={d.error}>{d.error}</div>}
                </td>
                <td className="px-3 py-2 tabular-nums text-muted mobile:hidden">{d.chunkCount}</td>
                <td className="px-3 py-2 tabular-nums text-muted mobile:hidden">{bytes(d.bytes)}</td>
                <td className="px-3 py-2 mobile:hidden">{d.embedded ? <Badge tone="ok">embedded</Badge> : <Badge tone="dim">none</Badge>}</td>
                <td className="px-3 py-2 text-dim mobile:hidden">{timeAgo(d.updatedAt)}</td>
                <td className="px-2 py-2">
                  <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 mobile:opacity-100">
                    <IconButton title="Re-index" onClick={() => void attempt(() => api.rag.reindexDocument(d.id)).then(reload)}>
                      <RefreshCw size={12} />
                    </IconButton>
                    <IconButton
                      title="Remove"
                      onClick={async () => {
                        await attempt(() => api.rag.deleteDocument(d.id))
                        await reload()
                        await useApp.getState().loadCollections()
                      }}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ChunksModal doc={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

function ChunksModal({ doc, onClose }: { doc: RagDocument | null; onClose(): void }) {
  const [chunks, setChunks] = useState<Awaited<ReturnType<typeof api.rag.chunks>>>([])
  useEffect(() => {
    if (doc) void api.rag.chunks(doc.id).then(setChunks)
  }, [doc])
  return (
    <Modal open={!!doc} onClose={onClose} title={doc?.title ?? ''} width={760}>
      <div className="space-y-2">
        {chunks.map((c) => (
          <Card key={c.id} className="p-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-dim">
              <span className="font-mono">#{c.ord}</span>
              {c.headingPath && <span className="truncate">{c.headingPath}</span>}
              <div className="flex-1" />
              {c.embedded && <Badge tone="ok">vector</Badge>}
              <span className="font-mono">{c.text.length} ch</span>
            </div>
            <pre className="selectable whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-muted">{c.text}</pre>
          </Card>
        ))}
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
    <div className="grid gap-4 p-5 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <Card className="p-4">
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
        </Card>

        <Card className="p-4">
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
        </Card>

        <Card className="p-4">
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
        </Card>
      </div>

      <Card className="flex max-h-[640px] flex-col">
        <div className="border-b border-line px-3 py-2 text-[12px] font-semibold">Ingestion log</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px]">
          {log.map((l, i) => (
            <div key={i} className={clsx('truncate px-1 py-0.5', l.error ? 'text-crimson-hi' : l.done ? 'text-ok' : 'text-dim')} title={l.error ?? l.message}>
              {l.error ? `✗ ${l.message}: ${l.error}` : l.message}
            </div>
          ))}
          {!log.length && <div className="p-2 text-dim">Nothing yet.</div>}
        </div>
      </Card>
    </div>
  )
}

function SearchPlayground({ collection }: { collection: Collection }) {
  const settings = useApp((s) => s.settings)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<RagMode>('hybrid')
  const [k, setK] = useState(8)
  const [model, setModel] = useState<ModelRef | null>(null)
  const [answerOn, setAnswerOn] = useState(true)
  const [result, setResult] = useState<RagAskResult | null>(null)
  const [asked, setAsked] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const hasModel = !!(model ?? settings?.defaultModel)
  const answering = answerOn && hasModel

  const run = async (q = query) => {
    const text = q.trim()
    if (!text || loading) return
    setQuery(text)
    setLoading(true)
    setError(null)
    setAsked(text)
    const input = { query: text, collectionIds: [collection.id], mode, k, model: model ?? undefined }
    try {
      if (answering) setResult(await api.rag.ask(input))
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
      ? ['How do I undo the last commit but keep my changes?', 'When should an API return 409 vs 422?', 'How does hybrid search work in Cloth?']
      : [`What does ${collection.name} cover?`, `Give me an overview of the main concepts in ${collection.name}`]

  return (
    <div className="mx-auto max-w-4xl p-5">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <div className="relative min-w-72 flex-1">
          <Search size={14} className="absolute left-3 top-[11px] text-dim" />
          <Input className="h-9 pl-8 text-[13px]" placeholder={answering ? 'Ask the collection a question…' : 'Search the collection…'} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" className="h-9" loading={loading} disabled={!query.trim()}>
          {answering ? 'Ask' : 'Search'}
        </Button>
      </form>
      <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[12px] text-dim">
        <Segmented
          value={mode}
          onChange={setMode}
          items={[
            { value: 'hybrid', label: 'Hybrid', title: 'BM25 + vectors, RRF fused' },
            { value: 'keyword', label: 'Keyword', title: 'SQLite FTS5 BM25' },
            { value: 'vector', label: 'Vector', title: 'Cosine similarity' },
            { value: 'agentic', label: 'Agentic', title: 'LLM query planning, reflection and rerank' }
          ]}
        />
        <label className="flex items-center gap-1.5">
          top
          <Input type="number" className="h-7 w-14" min={1} max={50} value={k} onChange={(e) => setK(Number(e.target.value))} />
        </label>
        <Switch checked={answerOn} onChange={setAnswerOn} label="Write an answer" disabled={!hasModel} />
        {(answerOn || mode === 'agentic') && (
          <div className="w-60">
            <ModelPicker value={model} onChange={setModel} allowNone noneLabel={settings?.defaultModel ? `Default (${settings.defaultModel.modelId})` : 'Default model (none set)'} />
          </div>
        )}
        {!hasModel && <span className="text-warn">No default model — results will be passages only.</span>}
      </div>

      {error && <div className="mt-4 rounded-[10px] border border-crimson-line bg-crimson-soft px-3.5 py-2.5 text-[12.5px] text-crimson-hi">{error}</div>}

      {loading && (
        <div className="mt-5 flex items-center gap-2 text-[12.5px] text-dim">
          <Spinner size={13} className="text-crimson" />
          <span className="shimmer-text">{answering ? 'Searching and writing an answer…' : 'Searching…'}</span>
        </div>
      )}

      {!loading && !result && !error && (
        <div className="mt-6">
          <div className="mb-2 text-[12px] font-medium text-dim">Try</div>
          <div className="grid gap-1.5">
            {suggestions.map((s) => (
              <button key={s} onClick={() => void run(s)} className="rounded-[10px] border border-line bg-panel px-3.5 py-2.5 text-left text-[12.5px] text-muted transition-colors hover:border-crimson-line hover:text-fg">
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {!loading && result && (
        <div className="mt-5 space-y-4">
          {result.search.hits.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-line-strong px-4 py-5 text-center text-[12.5px] text-dim">
              Nothing in <b className="text-muted">{collection.name}</b> matched “{asked}”.
              <div className="mt-1">{collection.docCount === 0 ? 'The collection has no documents yet — add some under Add sources.' : 'Try different wording, or another retrieval mode.'}</div>
            </div>
          ) : (
            <>
              {result.answer && (
                <div className="rounded-[14px] border border-line bg-panel p-4">
                  <div className="mb-2 flex items-center gap-2 text-[11px] text-dim">
                    <Badge tone="crimson">answer</Badge>
                    {result.model && <span className="font-mono">{result.model}</span>}
                    <span>· {(result.tookMs / 1000).toFixed(1)}s</span>
                  </div>
                  <Markdown text={result.answer} references={result.search.hits} />
                </div>
              )}
              {result.error && <div className="rounded-[10px] border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-[12px] text-warn">{result.error}</div>}
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px] text-dim">
                  <Badge tone="crimson">{result.search.mode}</Badge>
                  <span>
                    {result.search.hits.length} passages in {result.search.tookMs}ms
                  </span>
                  {result.search.queries.length > 1 && (
                    <span className="flex flex-wrap gap-1">
                      queries:
                      {result.search.queries.map((q) => (
                        <Badge key={q}>{q}</Badge>
                      ))}
                    </span>
                  )}
                  {result.search.notes.map((n) => (
                    <Badge key={n} tone="warn">
                      {n}
                    </Badge>
                  ))}
                </div>
                <div className="grid gap-2">
                  {result.search.hits.map((h, i) => (
                    <ReferenceCard key={h.chunkId} hit={h} n={i + 1} />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
