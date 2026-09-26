export interface Chunk {
  headingPath: string
  text: string
}

export interface ChunkOptions {
  size: number
  overlap: number
  /** Treat input as source code: no heading detection. */
  code?: boolean
}

interface Section {
  path: string[]
  blocks: string[]
}

/**
 * Markdown-aware chunker. Splits on headings (tracking the heading path so every chunk
 * carries its context), keeps fenced code blocks intact where possible, and packs
 * paragraphs up to `size` characters with a paragraph-level `overlap`.
 */
export function chunkText(input: string, opts: ChunkOptions): Chunk[] {
  const text = input.replace(/\r\n?/g, '\n').trim()
  if (!text) return []
  const sections = opts.code ? [{ path: [], blocks: splitBlocks(text) }] : splitSections(text)
  const chunks: Chunk[] = []
  for (const section of sections) {
    const headingPath = section.path.join(' › ')
    for (const body of pack(section.blocks, opts)) {
      if (body.trim()) chunks.push({ headingPath, text: body.trim() })
    }
  }
  return chunks
}

function splitSections(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  const stack: { level: number; title: string }[] = []
  let current: string[] = []
  let inFence = false

  const flush = () => {
    const body = current.join('\n').trim()
    if (body) sections.push({ path: stack.map((s) => s.title), blocks: splitBlocks(body) })
    current = []
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, title: m[2].trim() })
      continue
    }
    current.push(line)
  }
  flush()
  return sections
}

/** Paragraph blocks; fenced code stays one block. */
function splitBlocks(text: string): string[] {
  const blocks: string[] = []
  let buf: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '') {
      if (buf.length) blocks.push(buf.join('\n'))
      buf = []
    } else {
      buf.push(line)
    }
  }
  if (buf.length) blocks.push(buf.join('\n'))
  return blocks
}

function pack(blocks: string[], { size, overlap }: ChunkOptions): string[] {
  const pieces = blocks.flatMap((b) => (b.length > size ? hardSplit(b, size) : [b]))
  const out: string[] = []
  let cur: string[] = []
  let len = 0
  for (const piece of pieces) {
    if (len + piece.length > size && cur.length) {
      out.push(cur.join('\n\n'))
      // Carry trailing blocks forward as overlap.
      const carry: string[] = []
      let carried = 0
      for (let i = cur.length - 1; i >= 0 && carried + cur[i].length <= overlap; i--) {
        carry.unshift(cur[i])
        carried += cur[i].length
      }
      cur = carry
      len = carried
    }
    cur.push(piece)
    len += piece.length + 2
  }
  if (cur.length) out.push(cur.join('\n\n'))
  return out
}

/** Split an oversized block on line boundaries, then sentences, then raw characters. */
function hardSplit(block: string, size: number): string[] {
  const units = block.includes('\n') ? block.split('\n') : block.split(/(?<=[.!?])\s+/)
  const out: string[] = []
  let cur = ''
  for (const unit of units) {
    if (unit.length > size) {
      if (cur) out.push(cur)
      cur = ''
      for (let i = 0; i < unit.length; i += size) out.push(unit.slice(i, i + size))
      continue
    }
    const joined = cur ? `${cur}${block.includes('\n') ? '\n' : ' '}${unit}` : unit
    if (joined.length > size) {
      out.push(cur)
      cur = unit
    } else {
      cur = joined
    }
  }
  if (cur) out.push(cur)
  return out
}
