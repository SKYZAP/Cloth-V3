import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

interface Entry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

/**
 * Unpack a .zip into a folder (stored and deflated entries — what release zips use). Reads the
 * central directory, streams each entry from disk, and refuses entries that would land outside
 * the folder. Returns the extracted file paths.
 */
export async function unzip(file: string, dest: string, opts: { signal?: AbortSignal; onEntry?: (name: string, index: number, count: number) => void } = {}): Promise<string[]> {
  const entries = await readCentralDirectory(file)
  const root = resolve(dest)
  await mkdir(root, { recursive: true })
  const fh = await open(file, 'r')
  const out: string[] = []
  try {
    for (let i = 0; i < entries.length; i++) {
      opts.signal?.throwIfAborted()
      const e = entries[i]
      const target = safeJoin(root, e.name)
      opts.onEntry?.(e.name, i, entries.length)
      if (e.name.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      const header = Buffer.alloc(30)
      await fh.read(header, 0, 30, e.localOffset)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`Damaged zip: bad local header for ${e.name}`)
      const start = e.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      if (e.compressedSize === 0) {
        await (await open(target, 'w')).close()
      } else {
        const src = createReadStream(file, { start, end: start + e.compressedSize - 1 })
        if (e.method === 0) await pipeline(src, createWriteStream(target), { signal: opts.signal })
        else if (e.method === 8) await pipeline(src, createInflateRaw(), createWriteStream(target), { signal: opts.signal })
        else throw new Error(`Unsupported zip compression (method ${e.method}) for ${e.name}`)
      }
      out.push(target)
    }
  } finally {
    await fh.close()
  }
  return out
}

function safeJoin(root: string, name: string): string {
  const clean = name.replace(/\\/g, '/')
  if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) throw new Error(`Refusing zip entry with an absolute path: ${name}`)
  const target = resolve(join(root, clean))
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`Refusing zip entry outside the folder: ${name}`)
  return target
}

async function readCentralDirectory(file: string): Promise<Entry[]> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const tailLen = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    let eocd = -1
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end of central directory)')
    let count = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // ZIP64: the locator sits just before the classic record.
      const loc = eocd - 20
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('Damaged zip64 file')
      const z64Off = Number(tail.readBigUInt64LE(loc + 8))
      const z64 = Buffer.alloc(56)
      await fh.read(z64, 0, 56, z64Off)
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('Damaged zip64 file')
      count = Number(z64.readBigUInt64LE(32))
      cdSize = Number(z64.readBigUInt64LE(40))
      cdOffset = Number(z64.readBigUInt64LE(48))
    }
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    const entries: Entry[] = []
    let p = 0
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip central directory')
      const method = cd.readUInt16LE(p + 10)
      let compressedSize = cd.readUInt32LE(p + 20)
      let size = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      let localOffset = cd.readUInt32LE(p + 42)
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8')
      // ZIP64 extra field: the 64-bit values appear in this order, only for fields that overflowed.
      let x = p + 46 + nameLen
      const xEnd = x + extraLen
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x)
        const len = cd.readUInt16LE(x + 2)
        if (id === 0x0001) {
          let q = x + 4
          if (size === 0xffffffff) {
            size = Number(cd.readBigUInt64LE(q))
            q += 8
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(cd.readBigUInt64LE(q))
            q += 8
          }
          if (localOffset === 0xffffffff) localOffset = Number(cd.readBigUInt64LE(q))
        }
        x += 4 + len
      }
      entries.push({ name, method, compressedSize, size, localOffset })
      p += 46 + nameLen + extraLen + commentLen
    }
    return entries
  } finally {
    await fh.close()
  }
}
