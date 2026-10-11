import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type Fetch = typeof fetch

export const USER_AGENT = 'Cloth'

/** Size in bytes from a HEAD request (following redirects), or 0 when the server doesn't say; null on 404. */
export async function remoteSize(url: string, fetchFn: Fetch = fetch, signal?: AbortSignal): Promise<number | null> {
  const res = await fetchFn(url, { method: 'HEAD', redirect: 'follow', signal: signal ?? AbortSignal.timeout(20_000), headers: { 'user-agent': USER_AGENT } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  // Hugging Face reports the real file size on LFS files as x-linked-size.
  const n = Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length') ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Download to `dest`, resuming from `dest + '.part'` when it exists (HTTP Range). The file only
 * appears under its real name once complete. `onProgress` gets bytes so far and the total (0 if unknown).
 */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { fetch?: Fetch; signal?: AbortSignal; onProgress?: (received: number, total: number) => void; expectedSize?: number } = {}
): Promise<string> {
  const fetchFn = opts.fetch ?? fetch
  const part = `${dest}.part`
  await mkdir(dirname(dest), { recursive: true })
  let have = existsSync(part) ? statSync(part).size : 0
  if (opts.expectedSize && have === opts.expectedSize) {
    await rename(part, dest)
    opts.onProgress?.(have, have)
    return dest
  }
  if (opts.expectedSize && have > opts.expectedSize) {
    await rm(part, { force: true })
    have = 0
  }
  const res = await fetchFn(url, { redirect: 'follow', signal: opts.signal, headers: { 'user-agent': USER_AGENT, ...(have ? { range: `bytes=${have}-` } : {}) } })
  if (res.status === 416 && have) {
    // Already have every byte the server has.
    await res.body?.cancel()
    await rename(part, dest)
    opts.onProgress?.(have, have)
    return dest
  }
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
  const resumed = res.status === 206 && have > 0
  if (!resumed) have = 0
  const length = Number(res.headers.get('content-length') ?? 0)
  const total = length ? have + length : opts.expectedSize ?? 0
  let received = have
  let last = 0
  opts.onProgress?.(received, total)
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (now - last >= 200) {
      last = now
      opts.onProgress?.(received, total)
    }
  })
  await pipeline(body, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal: opts.signal })
  if (total && received !== total) throw new Error(`Download incomplete: got ${received} of ${total} bytes`)
  await rename(part, dest)
  opts.onProgress?.(received, total || received)
  return dest
}
