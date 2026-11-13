import { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import { Check, Copy } from 'lucide-react'
import type { RagHit } from '@shared/types'
import { Diagram } from './Diagram'

/** Markdown renderer with code-copy buttons and [n] citation chips linked to RAG hits. */
export const Markdown = memo(function Markdown({ text, references, streaming, className }: { text: string; references?: RagHit[]; streaming?: boolean; className?: string }) {
  const withCites = references?.length ? text.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => (Number(n) <= references.length ? `[${n}](#cite-${n})` : m)) : text
  return (
    <div className={clsx('prose-cloth', streaming && 'streaming-caret', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (href?.startsWith('#cite-') && references) {
              const hit = references[Number(href.slice(6)) - 1]
              return <Citation n={Number(href.slice(6))} hit={hit} />
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          },
          // The wrapper draws the frame and scrolls sideways, so the table itself can fill the width.
          table({ children }) {
            return (
              <div className="table-wrap">
                <table>{children}</table>
              </div>
            )
          },
          pre({ children }) {
            // ```mermaid blocks are drawn as diagrams.
            const mermaid = mermaidSource(children)
            if (mermaid !== null) return <Diagram source={mermaid} streaming={streaming} />
            return <CodeBlock>{children}</CodeBlock>
          }
        }}
      >
        {withCites}
      </ReactMarkdown>
    </div>
  )
})

function Citation({ n, hit }: { n: number; hit?: RagHit }) {
  return (
    <span className="group/cite relative inline-block align-baseline">
      <span className="mx-px inline-flex h-4 min-w-4 cursor-default items-center justify-center rounded bg-elev-2 px-1 text-micro font-semibold text-muted no-underline">{n}</span>
      {hit && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-80 -translate-x-1/2 rounded-lg border border-line-strong bg-elev p-2.5 text-left text-caption leading-snug shadow-xl shadow-black/50 group-hover/cite:block">
          <span className="block font-semibold text-fg">{hit.title}</span>
          {hit.headingPath && <span className="block text-dim">{hit.headingPath}</span>}
          <span className="mt-1 block text-muted">{hit.text.slice(0, 260)}…</span>
          <span className="mt-1 block truncate font-mono text-micro text-dim">{hit.source}</span>
        </span>
      )}
    </span>
  )
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = extractText(children)
  return (
    <div className="group/code relative">
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
        className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded border border-line bg-elev text-dim hover:text-fg group-hover/code:flex"
        title="Copy"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

/** The text of a ```mermaid code block, or null for any other block. */
function mermaidSource(children: React.ReactNode): string | null {
  const code = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string; children?: React.ReactNode } } | null
  if (!code?.props || !/\blanguage-mermaid\b/.test(code.props.className ?? '')) return null
  return extractText(code.props.children).replace(/\n$/, '')
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) return extractText((node as { props: { children?: React.ReactNode } }).props.children)
  return ''
}
