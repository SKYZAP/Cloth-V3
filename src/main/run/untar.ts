import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

const gunzipAsync = promisify(gunzip)

/**
 * Unpack a .tar.gz (the macOS llama.cpp builds) into `dest`, keeping executable bits and symlinks (the
 * builds link their libraries by version). Entries that would land outside `dest` are refused.
 * Returns the paths written, relative to `dest`.
 */
export async function untarGz(file: string, dest: string, opts: { signal?: AbortSignal } = {}): Promise<string[]> {
  const data = await gunzipAsync(await readFile(file))
  const root = resolve(dest)
  await mkdir(root, { recursive: true })
  const out: string[] = []
  let pos = 0
  let longName: string | null = null
  let paxPath: string | null = null
  while (pos + 512 <= data.length) {
    if (opts.signal?.aborted) throw new Error('Cancelled')
    const header = data.subarray(pos, pos + 512)
    if (header.every((b) => b === 0)) break
    const field = (start: number, len: number) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '')
    const octal = (start: number, len: number) => parseInt(field(start, len).trim() || '0', 8)
    const size = octal(124, 12)
    const type = String.fromCharCode(header[156] || 48)
    const body = data.subarray(pos + 512, pos + 512 + size)
    pos += 512 + Math.ceil(size / 512) * 512

    // GNU long names and pax headers name the entry that follows.
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      paxPath = m ? m[1] : null
      continue
    }
    if (type === 'g') continue

    const prefix = field(345, 155)
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = paxPath = null
    if (!name || name === './') continue
    const target = resolve(root, name)
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`The archive tries to write outside its folder: ${name}`)
    const mode = octal(100, 8) & 0o777

    if (type === '5') {
      await mkdir(target, { recursive: true })
    } else if (type === '2') {
      const link = field(157, 100)
      // Only links that stay inside the folder.
      if (isAbsolute(link) || !resolve(dirname(target), link).startsWith(root + sep)) continue
      await mkdir(dirname(target), { recursive: true })
      await rm(target, { force: true })
      await symlink(link, target).catch(() => undefined)
      out.push(name)
    } else if (type === '0' || type === '\0' || type === '7') {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body)
      if (mode) await chmod(target, mode).catch(() => undefined)
      out.push(name)
    }
  }
  return out
}

/** Whether a download is a .tar.gz (macOS builds) rather than a .zip. */
export const isTarGz = (name: string) => /\.(tar\.gz|tgz)$/i.test(name)

