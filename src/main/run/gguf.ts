import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { ModelMeta, ReasoningKind } from '@shared/types'

/**
 * Reads a GGUF file's header (its key/value metadata) without loading the tensors: the trained
 * context, the layer shape the context cache depends on, and the chat template. Big arrays (the
 * tokenizer's vocabulary) are skipped, not kept.
 */
export function readGgufMeta(path: string): Record<string, unknown> {
  const fd = openSync(path, 'r')
  try {
    const r = new FileReader(fd)
    if (r.bytes(4).toString('latin1') !== 'GGUF') throw new Error("That isn't a GGUF file")
    const version = r.u32()
    if (version < 2) throw new Error(`GGUF version ${version} is too old`)
    r.u64() // tensor count
    const kvCount = Number(r.u64())
    const out: Record<string, unknown> = {}
    for (let i = 0; i < kvCount; i++) {
      const key = r.str()
      out[key] = r.value(r.u32(), key)
    }
    return out
  } finally {
    closeSync(fd)
  }
}

/** Arrays longer than this aren't kept (the vocabulary); per-layer arrays are short and kept. */
const KEEP_ARRAY = 1024

class FileReader {
  private buf = Buffer.alloc(0)
  private bufPos = 0
  private filePos = 0
  constructor(private fd: number) {}

  private need(n: number): void {
    if (this.buf.length - this.bufPos >= n) return
    const rest = this.buf.subarray(this.bufPos)
    const chunk = Buffer.alloc(Math.max(n, 1 << 20))
    const read = readSync(this.fd, chunk, 0, chunk.length, this.filePos)
    this.filePos += read
    this.buf = Buffer.concat([rest, chunk.subarray(0, read)])
    this.bufPos = 0
    if (this.buf.length < n) throw new Error('The GGUF header ends early')
  }
  bytes(n: number): Buffer {
    this.need(n)
    const b = this.buf.subarray(this.bufPos, this.bufPos + n)
    this.bufPos += n
    return b
  }
  skip(n: number): void {
    // Large skips (a long string) go straight past the buffer.
    const inBuf = this.buf.length - this.bufPos
    if (n <= inBuf) this.bufPos += n
    else {
      this.filePos += n - inBuf
      this.buf = Buffer.alloc(0)
      this.bufPos = 0
    }
  }
  u32(): number {
    return this.bytes(4).readUInt32LE(0)
  }
  u64(): bigint {
    return this.bytes(8).readBigUInt64LE(0)
  }
  str(): string {
    const len = Number(this.u64())
    if (len > 64 << 20) throw new Error('A GGUF string is implausibly long')
    return this.bytes(len).toString('utf8')
  }
  value(type: number, key: string): unknown {
    switch (type) {
      case 0: return this.bytes(1).readUInt8(0)
      case 1: return this.bytes(1).readInt8(0)
      case 2: return this.bytes(2).readUInt16LE(0)
      case 3: return this.bytes(2).readInt16LE(0)
      case 4: return this.u32()
      case 5: return this.bytes(4).readInt32LE(0)
      case 6: return this.bytes(4).readFloatLE(0)
      case 7: return this.bytes(1).readUInt8(0) !== 0
      case 8: return this.str()
      case 9: {
        const itemType = this.u32()
        const len = Number(this.u64())
        if (len > KEEP_ARRAY) {
          this.skipArray(itemType, len)
          return null
        }
        const items: unknown[] = []
        for (let i = 0; i < len; i++) items.push(this.value(itemType, key))
        return items
      }
      case 10: return Number(this.u64())
      case 11: return Number(this.bytes(8).readBigInt64LE(0))
      case 12: return this.bytes(8).readDoubleLE(0)
      default: throw new Error(`Unknown GGUF value type ${type} for ${key}`)
    }
  }
  private skipArray(itemType: number, len: number): void {
    const fixed: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
    if (fixed[itemType]) return this.skip(fixed[itemType] * len)
    if (itemType === 8) {
      for (let i = 0; i < len; i++) this.skip(Number(this.u64()))
      return
    }
    for (let i = 0; i < len; i++) this.value(itemType, '')
  }
}

/** What a chat template lets you set: an effort level (gpt-oss), thinking on/off (Qwen3), or nothing. */
export function reasoningKind(template: string | null | undefined): ReasoningKind {
  if (!template) return null
  if (/reasoning_effort/.test(template)) return 'levels'
  if (/enable_thinking|<think>|thinking_budget/.test(template)) return 'toggle'
  return null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) && typeof v[0] === 'number' ? Math.max(...(v as number[])) : null)

/**
 * The model's description from its header. The context cache per token, in f16:
 * attention layers × KV heads × (key + value head size) × 2 bytes. Hybrid models (Qwen3.5's linear
 * attention, for one) keep a cache only on every n-th layer.
 */
export function modelMeta(path: string, projectorPath?: string | null): ModelMeta {
  const fileBytes = shardBytes(path)
  const projectorBytes = projectorPath ? safeSize(projectorPath) : 0
  let meta: Record<string, unknown> = {}
  try {
    meta = readGgufMeta(path)
  } catch {
    return { architecture: null, name: null, trainedContext: null, kvBytesPerToken: null, fileBytes, projectorBytes, reasoning: null }
  }
  const arch = typeof meta['general.architecture'] === 'string' ? (meta['general.architecture'] as string) : null
  const k = (s: string) => (arch ? meta[`${arch}.${s}`] : undefined)
  const blocks = num(k('block_count'))
  const interval = num(k('full_attention_interval'))
  const layers = blocks && interval && interval > 1 ? Math.ceil(blocks / interval) : blocks
  const heads = num(k('attention.head_count'))
  const kvHeads = num(k('attention.head_count_kv')) ?? heads
  const embed = num(k('embedding_length'))
  const keyLen = num(k('attention.key_length')) ?? (embed && heads ? embed / heads : null)
  const valueLen = num(k('attention.value_length')) ?? keyLen
  const kvBytesPerToken = layers && kvHeads && keyLen && valueLen ? Math.round(layers * kvHeads * (keyLen + valueLen) * 2) : null
  return {
    architecture: arch,
    name: typeof meta['general.name'] === 'string' ? (meta['general.name'] as string) : null,
    trainedContext: num(k('context_length')),
    kvBytesPerToken,
    fileBytes,
    projectorBytes,
    reasoning: reasoningKind(meta['tokenizer.chat_template'] as string | undefined)
  }
}

/** A split model's total size: every `-0000N-of-0000M` shard next to the first. */
export function shardBytes(path: string): number {
  const m = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(path)
  if (!m) return safeSize(path)
  const count = Number(m[2])
  let total = 0
  for (let i = 1; i <= count; i++) total += safeSize(path.replace(/-\d{5}-of-(\d{5})\.gguf$/i, `-${String(i).padStart(5, '0')}-of-$1.gguf`))
  return total
}

function safeSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}
