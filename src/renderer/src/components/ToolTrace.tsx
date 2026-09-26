import { useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, Check, ChevronRight, FileText, Folder, Globe, Loader2, Regex, Search, Sparkles, Wrench } from 'lucide-react'
import type { RagHit, ToolTrace as Trace } from '@shared/types'
import { duration, pretty } from '@/lib/format'

const ICONS: Record<string, typeof Search> = {
  rag_search: Search,
  skill_list: Sparkles,
  skill_use: Sparkles,
  read_file: FileText,
  list_dir: Folder,
  grep: Regex
}

function summarize(t: Trace): string {
  const a = (t.args ?? {}) as Record<string, unknown>
  if (t.name === 'rag_search') return `“${a.query ?? ''}”${Array.isArray(a.collections) && a.collections.length ? ` in ${a.collections.join(', ')}` : ''}`
  if (t.name === 'skill_use') return `${a.name ?? ''}${a.file ? ` / ${a.file}` : ''}`
  if (t.name === 'read_file' || t.name === 'list_dir') return String(a.path ?? '.')
  if (t.name === 'grep') return `/${a.pattern ?? ''}/ ${a.path ?? ''}`
  const s = JSON.stringify(a)
  return s === '{}' ? '' : s.slice(0, 80)
}

export function ToolTraceCard({ trace }: { trace: Trace }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[trace.name] ?? Wrench
  return (
    <div className={clsx('my-2 overflow-hidden rounded-lg border bg-panel', trace.status === 'error' ? 'border-crimson-line' : 'border-line')}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-elev">
        <ChevronRight size={13} className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-90')} />
        <Icon size={13} className="shrink-0 text-crimson-hi" />
        <span className="font-mono text-[11.5px] font-medium text-fg">{trace.name}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-dim">{summarize(trace)}</span>
        {trace.references.length > 0 && <span className="shrink-0 text-[10.5px] text-muted">{trace.references.length} refs</span>}
        {trace.durationMs !== null && <span className="shrink-0 font-mono text-[10.5px] text-dim">{duration(trace.durationMs)}</span>}
        {trace.status === 'running' && <Loader2 size={13} className="shrink-0 animate-spin text-crimson" />}
        {trace.status === 'ok' && <Check size={13} className="shrink-0 text-ok" />}
        {trace.status === 'error' && <AlertTriangle size={13} className="shrink-0 text-crimson-hi" />}
      </button>
      {!open && trace.references.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto border-t border-line px-3 py-2">
          {trace.references.slice(0, 8).map((r, i) => (
            <span key={r.chunkId} className="flex shrink-0 items-center gap-1 rounded border border-line bg-elev px-1.5 py-0.5 text-[10.5px] text-muted" title={r.source}>
              <span className="font-semibold text-crimson-hi">{i + 1}</span>
              <span className="max-w-44 truncate">{r.title}</span>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-line bg-bg/40 p-3">
          <Section label="Arguments">
            <pre className="selectable max-h-48 overflow-auto rounded border border-line bg-bg p-2 font-mono text-[11px] text-muted">{pretty(trace.args)}</pre>
          </Section>
          {trace.references.length > 0 ? (
            <Section label={`References (${trace.references.length})`}>
              <div className="space-y-1.5">
                {trace.references.map((r, i) => (
                  <ReferenceCard key={r.chunkId} hit={r} n={i + 1} />
                ))}
              </div>
            </Section>
          ) : (
            <Section label={trace.status === 'error' ? 'Error' : 'Result'}>
              <pre className={clsx('selectable max-h-72 overflow-auto whitespace-pre-wrap rounded border border-line bg-bg p-2 font-mono text-[11px]', trace.status === 'error' ? 'text-crimson-hi' : 'text-muted')}>
                {trace.result || (trace.status === 'running' ? 'Running…' : '(empty)')}
              </pre>
            </Section>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-dim">{label}</div>
      {children}
    </div>
  )
}

export function ReferenceCard({ hit, n }: { hit: RagHit; n?: number }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="rounded-md border border-line bg-panel p-2.5">
      <div className="flex items-start gap-2">
        {n !== undefined && <span className="mt-px flex h-4 min-w-4 items-center justify-center rounded bg-crimson-soft px-1 text-[10px] font-semibold text-crimson-hi">{n}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {hit.sourceType === 'url' ? <Globe size={11} className="shrink-0 text-dim" /> : <FileText size={11} className="shrink-0 text-dim" />}
            <span className="truncate text-[12px] font-medium">{hit.title}</span>
          </div>
          {hit.headingPath && <div className="truncate text-[11px] text-dim">{hit.headingPath}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-dim">
          {hit.bm25Rank !== null && <span title="BM25 rank">kw#{hit.bm25Rank}</span>}
          {hit.vectorRank !== null && <span title="Vector rank">vec#{hit.vectorRank}</span>}
          <span className="text-muted">{hit.score.toFixed(2)}</span>
        </div>
      </div>
      <div className={clsx('selectable mt-1.5 whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted', !expanded && 'line-clamp-3')} onClick={() => setExpanded(!expanded)}>
        {hit.text}
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-dim" title={hit.source}>
        {hit.source}
      </div>
    </div>
  )
}
