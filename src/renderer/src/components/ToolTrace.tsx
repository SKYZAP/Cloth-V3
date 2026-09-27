import { useState } from 'react'
import clsx from 'clsx'
import { AnimatePresence, motion } from 'motion/react'
import {
  Books,
  CaretRight,
  CheckCircle,
  CircleNotch,
  FileText,
  FolderSimple,
  GlobeHemisphereWest,
  ListMagnifyingGlass,
  Sparkle,
  WarningCircle,
  Wrench,
  type Icon
} from '@phosphor-icons/react'
import type { RagHit, ToolTrace as Trace } from '@shared/types'
import { duration, pretty } from '@/lib/format'
import { api } from '@/lib/api'

const ICONS: Record<string, Icon> = {
  rag_search: Books,
  web_search: GlobeHemisphereWest,
  web_fetch: GlobeHemisphereWest,
  skill_list: Sparkle,
  skill_use: Sparkle,
  read_file: FileText,
  list_dir: FolderSimple,
  grep: ListMagnifyingGlass
}

function summarize(t: Trace): string {
  const a = (t.args ?? {}) as Record<string, unknown>
  if (t.name === 'rag_search') return `“${a.query ?? ''}”${Array.isArray(a.collections) && a.collections.length ? ` · ${a.collections.join(', ')}` : ''}`
  if (t.name === 'web_search') return `“${a.query ?? ''}”`
  if (t.name === 'web_fetch') return String(a.url ?? '')
  if (t.name === 'skill_use') return `${a.name ?? ''}${a.file ? ` / ${a.file}` : ''}`
  if (t.name === 'read_file' || t.name === 'list_dir') return String(a.path ?? '.')
  if (t.name === 'grep') return `/${a.pattern ?? ''}/ ${a.path ?? ''}`
  const s = JSON.stringify(a)
  return s === '{}' ? '' : s.slice(0, 80)
}

const refLabel = (r: RagHit) => {
  if (/^https?:\/\//.test(r.source)) {
    try {
      return new URL(r.source).hostname.replace(/^www\./, '')
    } catch {
      /* fall through */
    }
  }
  return r.headingPath ? `${r.title} › ${r.headingPath.split(' › ').pop()}` : r.title
}

/** `fresh` animates the card in — only for traces that appear live, not when loading history. */
export function ToolTraceCard({ trace, fresh }: { trace: Trace; fresh?: boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = ICONS[trace.name] ?? Wrench
  const refs = trace.references
  return (
    <motion.div
      initial={fresh ? { opacity: 0, y: 8, scale: 0.98 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
      className={clsx('mb-4 overflow-hidden rounded-[14px] border bg-panel transition-colors', trace.status === 'error' ? 'border-crimson-line' : 'border-line hover:border-line-strong')}
    >
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-crimson-soft text-crimson-hi">
          <Icon size={14} />
        </span>
        <span className="shrink-0 font-mono text-[12px] font-medium text-fg">{trace.name}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-dim">{summarize(trace)}</span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-dim">
          {refs.length > 0 && <span>{refs.length} refs</span>}
          {trace.durationMs !== null && <span>{duration(trace.durationMs)}</span>}
          {trace.status === 'running' ? (
            <CircleNotch size={14} className="animate-spin text-crimson" />
          ) : trace.status === 'ok' ? (
            <motion.span key="ok" initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
              <CheckCircle size={15} weight="fill" className="text-ok" />
            </motion.span>
          ) : (
            <motion.span key="err" initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 600, damping: 14 }}>
              <WarningCircle size={15} weight="fill" className="text-crimson-hi" />
            </motion.span>
          )}
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }} className="flex shrink-0 text-dim">
          <CaretRight size={13} />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {!open && refs.length > 0 && (
          <motion.div
            key="refs"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="flex gap-1.5 overflow-x-auto pb-2.5 pl-12 pr-3 [scrollbar-width:none]">
              {refs.slice(0, 10).map((r, i) => (
                <motion.button
                  key={r.chunkId}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05, duration: 0.3 }}
                  title={r.source}
                  onClick={() => /^https?:\/\//.test(r.source) && void api.app.openExternal(r.source)}
                  className="flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-elev py-1 pl-1 pr-2.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-elev-2 text-[9px] text-dim">{i + 1}</span>
                  <span className="truncate">{refLabel(r)}</span>
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0 }}
            animate={{ height: 'auto', transition: { type: 'spring', stiffness: 260, damping: 24 } }}
            exit={{ height: 0, transition: { type: 'spring', stiffness: 260, damping: 32 } }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pb-3 pl-12 pr-3">
              <Section label="Arguments">
                <pre className="selectable max-h-48 overflow-auto rounded-lg border border-line bg-bg p-2.5 font-mono text-[11px] text-muted">{pretty(trace.args)}</pre>
              </Section>
              {refs.length > 0 ? (
                <Section label={`References (${refs.length})`}>
                  <div className="space-y-1.5">
                    {refs.map((r, i) => (
                      <ReferenceCard key={r.chunkId} hit={r} n={i + 1} />
                    ))}
                  </div>
                </Section>
              ) : (
                <Section label={trace.status === 'error' ? 'Error' : 'Result'}>
                  <pre className={clsx('selectable max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2.5 font-mono text-[11px]', trace.status === 'error' ? 'text-crimson-hi' : 'text-muted')}>
                    {trace.result || (trace.status === 'running' ? 'Running…' : '(empty)')}
                  </pre>
                </Section>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
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
  const isUrl = /^https?:\/\//.test(hit.source)
  return (
    <div className="rounded-[10px] border border-line bg-bg px-3 py-2.5">
      <div className="flex items-start gap-2">
        {n !== undefined && <span className="mt-px flex h-4 min-w-4 items-center justify-center rounded-[5px] bg-crimson-soft px-1 text-[10px] font-semibold text-crimson-hi">{n}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isUrl ? <GlobeHemisphereWest size={12} className="shrink-0 text-dim" /> : <FileText size={12} className="shrink-0 text-dim" />}
            <span className="truncate text-[12.5px] font-medium">{hit.title}</span>
          </div>
          {hit.headingPath && <div className="truncate text-[11px] text-dim">{hit.headingPath}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-dim">
          {hit.bm25Rank !== null && <span title="BM25 rank">kw#{hit.bm25Rank}</span>}
          {hit.vectorRank !== null && <span title="Vector rank">vec#{hit.vectorRank}</span>}
          <span className="text-muted">{hit.score.toFixed(2)}</span>
        </div>
      </div>
      <div className={clsx('selectable mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-muted', !expanded && 'line-clamp-3')} onClick={() => setExpanded(!expanded)}>
        {hit.text}
      </div>
      {isUrl ? (
        <button className="mt-1 block max-w-full truncate text-left font-mono text-[10.5px] text-dim hover:text-crimson-hi" title={hit.source} onClick={() => void api.app.openExternal(hit.source)}>
          {hit.source}
        </button>
      ) : (
        <div className="mt-1 truncate font-mono text-[10.5px] text-dim" title={hit.source}>
          {hit.source}
        </div>
      )}
    </div>
  )
}
