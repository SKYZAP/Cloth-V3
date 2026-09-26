import { createHash } from 'node:crypto'
import type {
  Collection,
  IngestProgress,
  IngestUrlInput,
  ModelRef,
  RagDocument,
  RagHit,
  RagMode,
  RagSearchInput,
  RagSearchResult,
  SourceType
} from '@shared/types'
import { json, tx } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import { parseJsonLoose } from '../core/llm-json'
import type { ProviderService } from '../providers/providers'
import type { SettingsService } from '../core/settings'
import { chunkText } from './chunker'
import { expandPaths, extractFile, fetchUrl, type Extracted } from './extract'

interface CollectionRow {
  id: string
  name: string
  description: string
  embedding: string | null
  embedding_dim: number | null
  created_at: number
}

interface DocRow {
  id: string
  collection_id: string
  source_type: SourceType
  source: string
  title: string
  status: RagDocument['status']
  error: string | null
  hash: string | null
  chunk_count: number
  bytes: number
  embedded: number
  updated_at: number
}

interface VectorIndex {
  chunkIds: string[]
  dim: number
  data: Float32Array
}

const RRF_K = 60
const CANDIDATES = 60
const MAX_PER_DOC = 3
const STOPWORDS = new Set('a an and are as at be by for from how i in is it of on or that the this to was what when where which who why with do does can you my me'.split(' '))

export class RagService {
  private vectorCache = new Map<string, VectorIndex>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private ctx: Ctx,
    private providers: ProviderService,
    private settings: SettingsService
  ) {}

  // ─── Collections ──────────────────────────────────────────────────────────

  listCollections(): Collection[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM documents d WHERE d.collection_id = c.id) AS doc_count,
                (SELECT COUNT(*) FROM chunks k WHERE k.collection_id = c.id) AS chunk_count
         FROM collections c ORDER BY c.created_at`
      )
      .all() as unknown as (CollectionRow & { doc_count: number; chunk_count: number })[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      embedding: json<ModelRef | null>(r.embedding, null),
      embeddingDim: r.embedding_dim,
      docCount: r.doc_count,
      chunkCount: r.chunk_count,
      createdAt: r.created_at
    }))
  }

  getCollection(id: string): Collection {
    const c = this.listCollections().find((c) => c.id === id)
    if (!c) throw new Error(`Unknown collection ${id}`)
    return c
  }

  findCollection(nameOrId: string): Collection | undefined {
    const all = this.listCollections()
    return all.find((c) => c.id === nameOrId) ?? all.find((c) => c.name.toLowerCase() === nameOrId.toLowerCase())
  }

  createCollection(input: { name: string; description?: string; embedding?: ModelRef | null }): Collection {
    const id = newId('col_')
    const embedding = input.embedding === undefined ? this.settings.get().embeddingModel : input.embedding
    this.ctx.db
      .prepare('INSERT INTO collections (id, name, description, embedding, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name.trim() || 'Untitled', input.description ?? '', embedding ? JSON.stringify(embedding) : null, Date.now())
    return this.getCollection(id)
  }

  updateCollection(id: string, patch: { name?: string; description?: string; embedding?: ModelRef | null }): Collection {
    const cur = this.getCollection(id)
    const embedding = patch.embedding === undefined ? cur.embedding : patch.embedding
    const embeddingChanged = JSON.stringify(embedding) !== JSON.stringify(cur.embedding)
    this.ctx.db
      .prepare('UPDATE collections SET name = ?, description = ?, embedding = ? WHERE id = ?')
      .run(patch.name ?? cur.name, patch.description ?? cur.description, embedding ? JSON.stringify(embedding) : null, id)
    if (embeddingChanged) {
      // Vectors from another model are meaningless — drop them; user can re-embed.
      tx(this.ctx.db, () => {
        this.ctx.db.prepare('UPDATE chunks SET embedding = NULL WHERE collection_id = ?').run(id)
        this.ctx.db.prepare('UPDATE documents SET embedded = 0 WHERE collection_id = ?').run(id)
        this.ctx.db.prepare('UPDATE collections SET embedding_dim = NULL WHERE id = ?').run(id)
      })
      this.vectorCache.delete(id)
    }
    return this.getCollection(id)
  }

  deleteCollection(id: string): void {
    tx(this.ctx.db, () => {
      this.ctx.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rid FROM chunks WHERE collection_id = ?)').run(id)
      this.ctx.db.prepare('DELETE FROM chunks WHERE collection_id = ?').run(id)
      this.ctx.db.prepare('DELETE FROM collections WHERE id = ?').run(id)
    })
    this.vectorCache.delete(id)
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  listDocuments(collectionId: string): RagDocument[] {
    const rows = this.ctx.db
      .prepare('SELECT * FROM documents WHERE collection_id = ? ORDER BY updated_at DESC')
      .all(collectionId) as unknown as DocRow[]
    return rows.map(toDoc)
  }

  getChunks(docId: string): { id: string; ord: number; headingPath: string; text: string; embedded: boolean }[] {
    const rows = this.ctx.db
      .prepare('SELECT id, ord, heading_path, text, embedding IS NOT NULL AS e FROM chunks WHERE doc_id = ? ORDER BY ord')
      .all(docId) as { id: string; ord: number; heading_path: string; text: string; e: number }[]
    return rows.map((r) => ({ id: r.id, ord: r.ord, headingPath: r.heading_path, text: r.text, embedded: !!r.e }))
  }

  deleteDocument(docId: string): void {
    const doc = this.ctx.db.prepare('SELECT collection_id FROM documents WHERE id = ?').get(docId) as { collection_id: string } | undefined
    tx(this.ctx.db, () => {
      this.ctx.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rid FROM chunks WHERE doc_id = ?)').run(docId)
      this.ctx.db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
      this.ctx.db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    })
    if (doc) this.vectorCache.delete(doc.collection_id)
  }

  // ─── Ingestion ────────────────────────────────────────────────────────────

  ingestText(collectionId: string, title: string, text: string): Promise<RagDocument> {
    const source = `text:${createHash('sha1').update(title + text).digest('hex').slice(0, 12)}`
    return this.enqueue(() => this.index(collectionId, 'text', source, async () => ({ title, text, code: false })))
  }

  async ingestPaths(collectionId: string, paths: string[]): Promise<{ queued: number }> {
    const files = await expandPaths(paths)
    this.progress({ collectionId, message: `Found ${files.length} indexable files`, done: false })
    let i = 0
    for (const file of files) {
      void this.enqueue(async () => {
        i++
        this.progress({ collectionId, message: `[${i}/${files.length}] ${file}`, done: false })
        await this.index(collectionId, 'file', file, () => extractFile(file)).catch(() => undefined)
        if (i === files.length) this.progress({ collectionId, message: `Indexed ${files.length} files`, done: true })
      })
    }
    if (!files.length) this.progress({ collectionId, message: 'No indexable files found', done: true })
    return { queued: files.length }
  }

  async ingestUrl(input: IngestUrlInput): Promise<{ queued: number }> {
    const { collectionId } = input
    const maxPages = input.crawl ? Math.max(1, Math.min(input.maxPages ?? 25, 500)) : 1
    const start = new URL(input.url)
    const prefix = start.origin + start.pathname.replace(/[^/]*$/, '')
    void this.enqueue(async () => {
      const seen = new Set<string>([start.toString()])
      const frontier = [start.toString()]
      let done = 0
      let failed = 0
      while (frontier.length && done < maxPages) {
        const url = frontier.shift()!
        done++
        this.progress({ collectionId, message: `[${done}/${maxPages}] ${url}`, done: false })
        try {
          let links: string[] = []
          await this.index(collectionId, 'url', url, async () => {
            const page = await fetchUrl(url)
            links = page.links ?? []
            return page
          })
          if (input.crawl) {
            for (const link of links) {
              if (seen.has(link)) continue
              if ((input.sameOrigin ?? true) && !link.startsWith(prefix)) continue
              if (/\.(png|jpe?g|gif|svg|zip|tar|gz|mp4|webp|ico|css|js)(\?|$)/i.test(link)) continue
              seen.add(link)
              frontier.push(link)
            }
          }
        } catch {
          failed++
        }
      }
      this.progress({ collectionId, message: `Crawl finished — ${done - failed} indexed, ${failed} failed`, done: true })
    })
    return { queued: maxPages }
  }

  reindexDocument(docId: string): Promise<RagDocument> {
    const doc = this.ctx.db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as DocRow | undefined
    if (!doc) throw new Error('Unknown document')
    this.ctx.db.prepare('UPDATE documents SET hash = NULL WHERE id = ?').run(docId)
    const loader =
      doc.source_type === 'file'
        ? () => extractFile(doc.source)
        : doc.source_type === 'url'
          ? () => fetchUrl(doc.source)
          : async () => ({ title: doc.title, text: this.getChunks(docId).map((c) => c.text).join('\n\n'), code: false })
    return this.enqueue(() => this.index(doc.collection_id, doc.source_type, doc.source, loader))
  }

  /** Embed any chunks that are missing vectors (e.g. after setting an embedding model). */
  embedMissing(collectionId: string): Promise<number> {
    return this.enqueue(async () => {
      const col = this.getCollection(collectionId)
      if (!col.embedding) throw new Error('Collection has no embedding model')
      const rows = this.ctx.db
        .prepare('SELECT id, heading_path, text FROM chunks WHERE collection_id = ? AND embedding IS NULL')
        .all(collectionId) as { id: string; heading_path: string; text: string }[]
      for (let i = 0; i < rows.length; i += 64) {
        const batch = rows.slice(i, i + 64)
        const vecs = await this.providers.embed(col.embedding, batch.map((r) => embedText(r.heading_path, r.text)))
        this.storeVectors(collectionId, batch.map((r) => r.id), vecs)
        this.progress({ collectionId, message: `Embedded ${Math.min(i + 64, rows.length)}/${rows.length} chunks`, done: false })
      }
      this.ctx.db
        .prepare(`UPDATE documents SET embedded = 1 WHERE collection_id = ? AND id NOT IN (SELECT doc_id FROM chunks WHERE embedding IS NULL)`)
        .run(collectionId)
      this.progress({ collectionId, message: `Embedding complete (${rows.length} chunks)`, done: true })
      return rows.length
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }

  private progress(p: IngestProgress): void {
    this.ctx.emit('ingest', p)
  }

  private async index(
    collectionId: string,
    sourceType: SourceType,
    source: string,
    load: () => Promise<Extracted>
  ): Promise<RagDocument> {
    const col = this.getCollection(collectionId)
    const db = this.ctx.db
    const existing = db.prepare('SELECT * FROM documents WHERE collection_id = ? AND source = ?').get(collectionId, source) as DocRow | undefined
    const docId = existing?.id ?? newId('doc_')
    const now = Date.now()
    if (existing) {
      db.prepare("UPDATE documents SET status = 'indexing', error = NULL, updated_at = ? WHERE id = ?").run(now, docId)
    } else {
      db.prepare(
        `INSERT INTO documents (id, collection_id, source_type, source, title, status, updated_at) VALUES (?, ?, ?, ?, ?, 'indexing', ?)`
      ).run(docId, collectionId, sourceType, source, source.split(/[\\/]/).pop() || source, now)
    }
    this.progress({ collectionId, docId, message: `Indexing ${source}`, done: false })

    try {
      const extracted = await load()
      const hash = createHash('sha1').update(extracted.text).digest('hex')
      if (existing && existing.hash === hash && existing.status === 'ready' && (existing.embedded || !col.embedding)) {
        db.prepare("UPDATE documents SET status = 'ready', updated_at = ? WHERE id = ?").run(Date.now(), docId)
        return this.doc(docId)
      }
      const { chunkSize, chunkOverlap } = this.settings.get()
      const chunks = chunkText(extracted.text, { size: chunkSize, overlap: chunkOverlap, code: extracted.code })
      const title = extracted.title.slice(0, 300)

      let vectors: Float32Array[] | null = null
      let embedError: string | null = null
      if (col.embedding && chunks.length) {
        try {
          vectors = await this.providers.embed(col.embedding, chunks.map((c) => embedText(c.headingPath, c.text)))
        } catch (err) {
          embedError = `Embedding failed (keyword search still works): ${errorMessage(err)}`
        }
      }

      tx(db, () => {
        db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rid FROM chunks WHERE doc_id = ?)').run(docId)
        db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId)
        const insChunk = db.prepare(
          'INSERT INTO chunks (id, doc_id, collection_id, ord, heading_path, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        const insFts = db.prepare('INSERT INTO chunks_fts (rowid, title, heading_path, text) VALUES (?, ?, ?, ?)')
        chunks.forEach((c, i) => {
          const v = vectors?.[i]
          const r = insChunk.run(newId('chk_'), docId, collectionId, i, c.headingPath, c.text, v ? toBlob(v) : null)
          insFts.run(r.lastInsertRowid, title, c.headingPath, c.text)
        })
        if (vectors?.[0] && !col.embeddingDim) {
          db.prepare('UPDATE collections SET embedding_dim = ? WHERE id = ?').run(vectors[0].length, collectionId)
        }
        db.prepare(
          `UPDATE documents SET title = ?, status = 'ready', error = ?, hash = ?, chunk_count = ?, bytes = ?, embedded = ?, updated_at = ? WHERE id = ?`
        ).run(title, embedError, hash, chunks.length, Buffer.byteLength(extracted.text), vectors ? 1 : 0, Date.now(), docId)
      })
      this.vectorCache.delete(collectionId)
      this.progress({ collectionId, docId, message: `Indexed ${title} (${chunks.length} chunks)`, done: false })
      return this.doc(docId)
    } catch (err) {
      db.prepare("UPDATE documents SET status = 'error', error = ?, updated_at = ? WHERE id = ?").run(errorMessage(err), Date.now(), docId)
      this.progress({ collectionId, docId, message: `Failed ${source}`, error: errorMessage(err), done: false })
      throw err
    }
  }

  private doc(id: string): RagDocument {
    return toDoc(this.ctx.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as DocRow)
  }

  private storeVectors(collectionId: string, chunkIds: string[], vecs: Float32Array[]): void {
    tx(this.ctx.db, () => {
      const upd = this.ctx.db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
      chunkIds.forEach((id, i) => upd.run(toBlob(vecs[i]), id))
      if (vecs[0]) this.ctx.db.prepare('UPDATE collections SET embedding_dim = ? WHERE id = ?').run(vecs[0].length, collectionId)
    })
    this.vectorCache.delete(collectionId)
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async search(input: RagSearchInput): Promise<RagSearchResult> {
    const started = Date.now()
    const mode: RagMode = input.mode ?? 'hybrid'
    const k = Math.max(1, Math.min(input.k ?? 8, 50))
    const collections = this.resolveCollections(input.collectionIds)
    if (!collections.length) return { hits: [], mode, queries: [input.query], notes: ['No collections to search'], tookMs: 0 }

    if (mode === 'agentic') return this.agenticSearch(input.query, collections, k, input.model, started)

    const notes: string[] = []
    const ranked = await this.rankedLists(input.query, collections, mode, notes)
    const hits = this.fuse(ranked, k)
    return { hits, mode, queries: [input.query], notes, tookMs: Date.now() - started }
  }

  private resolveCollections(ids?: string[]): Collection[] {
    const all = this.listCollections()
    if (!ids || !ids.length) return all
    return ids.map((id) => all.find((c) => c.id === id || c.name.toLowerCase() === id.toLowerCase())).filter((c): c is Collection => !!c)
  }

  /** Returns BM25 and vector rankings (chunk ids, best first). */
  private async rankedLists(query: string, collections: Collection[], mode: RagMode, notes: string[]): Promise<{ bm25: string[]; vector: string[] }> {
    const bm25 = mode === 'vector' ? [] : this.keywordSearch(query, collections.map((c) => c.id))
    let vector: string[] = []
    if (mode !== 'keyword') {
      const embeddable = collections.filter((c) => c.embedding && c.embeddingDim)
      if (!embeddable.length) {
        if (mode === 'vector') notes.push('No collection has embeddings — vector search unavailable')
        else notes.push('No embeddings configured — keyword-only results')
      }
      // Group collections by embedding model so each query is embedded once per model.
      const groups = new Map<string, Collection[]>()
      for (const c of embeddable) {
        const key = JSON.stringify(c.embedding)
        groups.set(key, [...(groups.get(key) ?? []), c])
      }
      const scored: { id: string; score: number }[] = []
      for (const [key, cols] of groups) {
        try {
          const [q] = await this.providers.embed(JSON.parse(key) as ModelRef, [query])
          for (const c of cols) scored.push(...this.vectorSearch(c.id, q))
        } catch (err) {
          notes.push(`Vector search skipped: ${errorMessage(err)}`)
        }
      }
      vector = scored.sort((a, b) => b.score - a.score).slice(0, CANDIDATES).map((s) => s.id)
    }
    return { bm25, vector }
  }

  keywordSearch(query: string, collectionIds: string[]): string[] {
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t)))]
    if (!terms.length || !collectionIds.length) return []
    const match = terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
    const placeholders = collectionIds.map(() => '?').join(',')
    const rows = this.ctx.db
      .prepare(
        `SELECT c.id FROM chunks_fts JOIN chunks c ON c.rid = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND c.collection_id IN (${placeholders})
         ORDER BY bm25(chunks_fts, 3.0, 2.0, 1.0) LIMIT ${CANDIDATES}`
      )
      .all(match, ...collectionIds) as { id: string }[]
    return rows.map((r) => r.id)
  }

  private vectorSearch(collectionId: string, q: Float32Array): { id: string; score: number }[] {
    const index = this.loadVectors(collectionId)
    if (!index || index.dim !== q.length) return []
    const { data, dim, chunkIds } = index
    const scores: { id: string; score: number }[] = []
    for (let i = 0; i < chunkIds.length; i++) {
      let dot = 0
      const off = i * dim
      for (let j = 0; j < dim; j++) dot += data[off + j] * q[j]
      scores.push({ id: chunkIds[i], score: dot })
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, CANDIDATES)
  }

  private loadVectors(collectionId: string): VectorIndex | null {
    const cached = this.vectorCache.get(collectionId)
    if (cached) return cached
    const rows = this.ctx.db
      .prepare('SELECT id, embedding FROM chunks WHERE collection_id = ? AND embedding IS NOT NULL')
      .all(collectionId) as { id: string; embedding: Uint8Array }[]
    if (!rows.length) return null
    const dim = rows[0].embedding.byteLength / 4
    const data = new Float32Array(rows.length * dim)
    const chunkIds: string[] = []
    rows.forEach((r, i) => {
      if (r.embedding.byteLength / 4 !== dim) return
      data.set(fromBlob(r.embedding), i * dim)
      chunkIds[i] = r.id
    })
    const index = { chunkIds, dim, data }
    this.vectorCache.set(collectionId, index)
    return index
  }

  /** Reciprocal-rank fusion over any number of rankings, with a per-document cap for diversity. */
  private fuse(ranked: { bm25: string[]; vector: string[] } | { bm25: string[]; vector: string[] }[], k: number): RagHit[] {
    const lists = Array.isArray(ranked) ? ranked : [ranked]
    const score = new Map<string, number>()
    const bm25Rank = new Map<string, number>()
    const vectorRank = new Map<string, number>()
    for (const l of lists) {
      l.bm25.forEach((id, i) => {
        score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1))
        if (!bm25Rank.has(id) || bm25Rank.get(id)! > i + 1) bm25Rank.set(id, i + 1)
      })
      l.vector.forEach((id, i) => {
        score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1))
        if (!vectorRank.has(id) || vectorRank.get(id)! > i + 1) vectorRank.set(id, i + 1)
      })
    }
    const ordered = [...score.entries()].sort((a, b) => b[1] - a[1])
    const hits = this.hydrate(ordered.slice(0, k * 4).map(([id]) => id))
    const perDoc = new Map<string, number>()
    const out: RagHit[] = []
    const max = ordered[0]?.[1] ?? 1
    for (const hit of hits) {
      const n = perDoc.get(hit.docId) ?? 0
      if (n >= MAX_PER_DOC) continue
      perDoc.set(hit.docId, n + 1)
      out.push({ ...hit, score: (score.get(hit.chunkId) ?? 0) / max, bm25Rank: bm25Rank.get(hit.chunkId) ?? null, vectorRank: vectorRank.get(hit.chunkId) ?? null })
      if (out.length >= k) break
    }
    return out
  }

  private hydrate(ids: string[]): RagHit[] {
    if (!ids.length) return []
    const rows = this.ctx.db
      .prepare(
        `SELECT c.id, c.doc_id, c.collection_id, c.heading_path, c.text, d.title, d.source, d.source_type
         FROM chunks c JOIN documents d ON d.id = c.doc_id WHERE c.id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as { id: string; doc_id: string; collection_id: string; heading_path: string; text: string; title: string; source: string; source_type: SourceType }[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        chunkId: r.id,
        docId: r.doc_id,
        collectionId: r.collection_id,
        title: r.title,
        source: r.source,
        sourceType: r.source_type,
        headingPath: r.heading_path,
        text: r.text,
        score: 0,
        bm25Rank: null,
        vectorRank: null
      }))
  }

  /**
   * Agentic retrieval: the model decomposes the question into focused sub-queries, we run
   * hybrid search for each, the model reflects on coverage and may issue follow-ups, and
   * finally it reranks the fused candidates by relevance.
   */
  private async agenticSearch(query: string, collections: Collection[], k: number, modelRef: ModelRef | undefined, started: number): Promise<RagSearchResult> {
    const model = modelRef ?? this.settings.get().defaultModel
    const notes: string[] = []
    if (!model) {
      notes.push('Agentic mode needs a default model — fell back to hybrid')
      const hits = this.fuse(await this.rankedLists(query, collections, 'hybrid', notes), k)
      return { hits, mode: 'hybrid', queries: [query], notes, tookMs: Date.now() - started }
    }
    const catalog = collections.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`).join('\n')

    const plan = await this.providers
      .complete(model, {
        system: 'You plan searches over a local knowledge base (BM25 + embeddings). Reply with JSON only.',
        prompt: `Collections:\n${catalog}\n\nQuestion: ${query}\n\nWrite 2-4 short, diverse search queries that together cover the question (keywords, synonyms, likely API names). JSON: {"queries": ["..."]}`,
        maxTokens: 400,
        temperature: 0.2
      })
      .then((r) => parseJsonLoose<{ queries: string[] }>(r.text)?.queries ?? [])
      .catch((err) => {
        notes.push(`Planner failed: ${errorMessage(err)}`)
        return [] as string[]
      })

    const queries = [query, ...plan.filter((q) => typeof q === 'string' && q.trim())].slice(0, 5)
    const lists = await Promise.all(queries.map((q) => this.rankedLists(q, collections, 'hybrid', notes)))
    let candidates = this.fuse(lists, 20)

    // Reflection: does the evidence cover the question? If not, one round of follow-up queries.
    if (candidates.length) {
      const reflect = await this.providers
        .complete(model, {
          system: 'You judge whether retrieved snippets answer a question. Reply with JSON only.',
          prompt: `Question: ${query}\n\nSnippets:\n${snippetList(candidates.slice(0, 10))}\n\nIf important aspects are missing, propose up to 2 new search queries. JSON: {"sufficient": true|false, "followups": ["..."]}`,
          maxTokens: 300,
          temperature: 0
        })
        .then((r) => parseJsonLoose<{ sufficient?: boolean; followups?: string[] }>(r.text))
        .catch(() => null)
      const followups = (reflect?.sufficient === false ? reflect.followups ?? [] : []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 2)
      if (followups.length) {
        queries.push(...followups)
        lists.push(...(await Promise.all(followups.map((q) => this.rankedLists(q, collections, 'hybrid', notes)))))
        candidates = this.fuse(lists, 20)
      }
    }

    // LLM rerank of the fused candidates.
    if (candidates.length > 1) {
      const ratings = await this.providers
        .complete(model, {
          system: 'You rate search results for relevance. Reply with JSON only.',
          prompt: `Question: ${query}\n\nRate each snippet 0 (irrelevant) to 3 (directly answers).\n${snippetList(candidates)}\n\nJSON: {"ratings": [{"i": 1, "r": 3}, ...]}`,
          maxTokens: 600,
          temperature: 0
        })
        .then((r) => parseJsonLoose<{ ratings: { i: number; r: number }[] }>(r.text)?.ratings ?? null)
        .catch(() => null)
      if (ratings) {
        const rating = new Map(ratings.map((x) => [x.i - 1, x.r]))
        candidates = candidates
          .map((h, i) => ({ h, r: rating.get(i) ?? 0, i }))
          .filter((x) => x.r > 0)
          .sort((a, b) => b.r - a.r || a.i - b.i)
          .map((x) => ({ ...x.h, score: x.r / 3 }))
        if (!candidates.length) notes.push('Reranker judged every candidate irrelevant')
      } else {
        notes.push('Rerank skipped (unparseable reply)')
      }
    }

    return { hits: candidates.slice(0, k), mode: 'agentic', queries, notes: [...new Set(notes)], tookMs: Date.now() - started }
  }
}

function snippetList(hits: RagHit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${h.title}${h.headingPath ? ` › ${h.headingPath}` : ''}\n${h.text.slice(0, 400).replace(/\s+/g, ' ')}`).join('\n\n')
}

function embedText(headingPath: string, text: string): string {
  return headingPath ? `${headingPath}\n\n${text}` : text
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

function fromBlob(b: Uint8Array): Float32Array {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}

function toDoc(r: DocRow): RagDocument {
  return {
    id: r.id,
    collectionId: r.collection_id,
    sourceType: r.source_type,
    source: r.source,
    title: r.title,
    status: r.status,
    error: r.error,
    chunkCount: r.chunk_count,
    bytes: r.bytes,
    embedded: !!r.embedded,
    updatedAt: r.updated_at
  }
}

export function formatHitsForModel(hits: RagHit[]): string {
  if (!hits.length) return 'No results.'
  return hits
    .map((h, i) => `[${i + 1}] ${h.title}${h.headingPath ? ` › ${h.headingPath}` : ''}\nsource: ${h.source}\n${h.text}`)
    .join('\n\n---\n\n')
}
