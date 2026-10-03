import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { ChatAttachment, UiAttachment } from '@shared/types'
import { extractFile } from '../rag/extract'

export const FILE_OPEN = '<attached-file name="'
export const FILE_CLOSE = '</attached-file>'

export const MAX_ATTACHMENTS = 10
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
/** About 30k tokens: enough for a long document, without one file swallowing the context. */
const MAX_FILE_CHARS = 120_000
/** Image formats every vision provider accepts; the composer converts anything else before sending. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const RICH = new Set(['.pdf', '.docx', '.html', '.htm'])

/** Turn the composer's attachments into message content: files become tagged text, images stay images. */
export async function attachmentContent(attachments: ChatAttachment[]): Promise<(TextContent | ImageContent)[]> {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} files at a time`)
  const files: TextContent[] = []
  const images: ImageContent[] = []
  for (const a of attachments) {
    const name = basename(a.name || 'file').replace(/["<>\n\r]/g, '_')
    const bytes = Buffer.from(a.data, 'base64')
    if (IMAGE_TYPES.has(a.mimeType)) {
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${name} is too large (images up to 5 MB)`)
      images.push({ type: 'image', data: a.data, mimeType: a.mimeType })
      continue
    }
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${name} is too large (files up to 25 MB)`)
    let text = (await readText(name, bytes)).replace(/\r\n/g, '\n').trim()
    const truncated = text.length > MAX_FILE_CHARS
    if (truncated) text = `${text.slice(0, MAX_FILE_CHARS)}\n\n[… truncated: the file has ${text.length.toLocaleString('en-US')} characters; only the first ${MAX_FILE_CHARS.toLocaleString('en-US')} are included]`
    files.push({ type: 'text', text: `${FILE_OPEN}${name}" chars="${Math.min(text.length, MAX_FILE_CHARS)}"${truncated ? ' truncated="true"' : ''}>\n${text}\n${FILE_CLOSE}` })
  }
  return [...files, ...images]
}

async function readText(name: string, bytes: Buffer): Promise<string> {
  const ext = extname(name).toLowerCase()
  if (!RICH.has(ext)) {
    if (looksBinary(bytes)) throw new Error(`${name} isn't a text file Cloth can read (text, code, PDF, Word and HTML files work)`)
    return bytes.toString('utf8').replace(/^﻿/, '')
  }
  // The extractors read from disk: give them a private temporary copy.
  const dir = await mkdtemp(join(tmpdir(), 'cloth-attach-'))
  try {
    const path = join(dir, name)
    await writeFile(path, bytes)
    const { text } = await extractFile(path)
    if (!text.trim()) throw new Error(`No text found in ${name}${ext === '.pdf' ? ' (a scanned PDF? attach the pages as images instead)' : ''}`)
    return text
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return true
  let odd = 0
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) odd++
  return head.length > 0 && odd / head.length > 0.1
}

/** Read an attached-file block back for the chat view; null when the text isn't one. */
export function parseFileBlock(text: string): UiAttachment | null {
  if (!text.startsWith(FILE_OPEN)) return null
  const head = text.slice(0, text.indexOf('>') + 1)
  const name = /name="([^"]*)"/.exec(head)?.[1] ?? 'file'
  const chars = Number(/chars="(\d+)"/.exec(head)?.[1] ?? 0)
  return { kind: 'file', name, chars, ...(/truncated="true"/.test(head) ? { truncated: true } : {}) }
}
