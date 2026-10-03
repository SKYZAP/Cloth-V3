import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { FileText, X } from '@phosphor-icons/react'
import type { ChatAttachment, UiAttachment } from '@shared/types'
import { BottomSheet } from '@/components/BottomSheet'

export const MAX_ATTACHMENTS = 10
const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Long edge for images sent to a model: providers downscale anything bigger anyway. */
const MAX_EDGE = 2000
const KEEP_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** An attachment waiting in the composer. */
export interface Pending extends ChatAttachment {
  key: string
  size: number
  /** Object URL for an image thumbnail. */
  preview?: string
}

/** Read picked, dropped or pasted files: images are scaled to a model-friendly size, everything else is sent as-is. */
export async function readAttachments(files: File[]): Promise<{ ok: Pending[]; errors: string[] }> {
  const ok: Pending[] = []
  const errors: string[] = []
  for (const file of files) {
    try {
      const name = file.name || (file.type.startsWith('image/') ? `pasted-image.${file.type.split('/')[1] || 'png'}` : 'file')
      if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is larger than 25 MB`)
      const image = file.type.startsWith('image/') && file.type !== 'image/svg+xml'
      const blob = image ? await fitImage(file) : file
      const data = await toBase64(blob)
      ok.push({ key: `${Date.now()}-${Math.random()}`, name, mimeType: image ? blob.type : file.type || 'application/octet-stream', data, size: blob.size, ...(image ? { preview: URL.createObjectURL(blob) } : {}) })
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { ok, errors }
}

async function fitImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) throw new Error(`${file.name || 'The image'} couldn't be read`)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  // Small images in a format every provider reads go untouched (GIFs keep their frames).
  if (scale === 1 && KEEP_TYPES.has(file.type) && file.size <= 3.5 * 1024 * 1024) {
    bitmap.close()
    return file
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  // PNG keeps screenshots crisp; switch to JPEG when that would be too heavy.
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality))
  const png = file.type === 'image/png' ? await encode('image/png') : null
  const out = png && png.size <= 3.5 * 1024 * 1024 ? png : await encode('image/jpeg', 0.88)
  if (!out) throw new Error(`${file.name || 'The image'} couldn't be converted`)
  return out
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1))
    r.onerror = () => reject(new Error('Could not read the file'))
    r.readAsDataURL(blob)
  })
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Thumbnails and file chips above the composer's text box. */
export function PendingAttachments({ items, onRemove, noVision }: { items: Pending[]; onRemove(key: string): void; noVision: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && (
        <motion.div key="attachments" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 32 }} className="overflow-hidden">
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            <AnimatePresence initial={false}>
              {items.map((a) => (
                <motion.div
                  key={a.key}
                  layout
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className="group/att relative"
                >
                  {a.preview ? (
                    <img src={a.preview} alt={a.name} title={a.name} className="h-14 w-14 rounded-[12px] border border-line-strong object-cover" />
                  ) : (
                    <div className="flex h-14 max-w-[220px] items-center gap-2.5 rounded-[12px] border border-line-strong bg-elev py-2 pl-2.5 pr-3.5" title={a.name}>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-elev-2 text-muted">
                        <FileText size={18} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[12.5px] text-fg">{a.name}</span>
                        <span className="block text-[11px] text-dim">{fileSize(a.size)}</span>
                      </span>
                    </div>
                  )}
                  <button
                    onClick={() => onRemove(a.key)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line-strong bg-panel text-muted opacity-0 transition-opacity hover:text-fg group-hover/att:opacity-100 focus-visible:opacity-100 mobile:opacity-100"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X size={10} weight="bold" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
          {noVision && items.some((a) => a.preview) && <div className="px-4 pt-2 text-[11.5px] text-warn">This model can't see images — pick a vision model, or they'll be left out.</div>}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** What the user attached, shown above their message. */
export function SentAttachments({ items }: { items: UiAttachment[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const images = items.filter((a): a is Extract<UiAttachment, { kind: 'image' }> => a.kind === 'image')
  const files = items.filter((a): a is Extract<UiAttachment, { kind: 'file' }> => a.kind === 'file')
  return (
    <>
      {images.length > 0 && (
        <div className="flex max-w-[78%] flex-wrap justify-end gap-1.5 mobile:max-w-[86%]">
          {images.map((img, i) => {
            const src = `data:${img.mimeType};base64,${img.data}`
            return (
              <button key={i} onClick={() => setOpen(src)} className="overflow-hidden rounded-[14px] border border-line" aria-label="Open image">
                <img src={src} alt="" className={images.length === 1 ? 'max-h-60 max-w-[320px] object-contain' : 'h-24 w-24 object-cover'} />
              </button>
            )
          })}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex max-w-[78%] flex-wrap justify-end gap-1.5 mobile:max-w-[86%]">
          {files.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-full border border-line bg-elev px-2.5 py-1 text-[11.5px] text-muted" title={f.truncated ? 'Too long to include in full — only the start was sent' : undefined}>
              <FileText size={13} />
              <span className="max-w-[200px] truncate text-fg">{f.name}</span>
              <span className="text-dim">
                {f.chars.toLocaleString()} chars{f.truncated ? ' · truncated' : ''}
              </span>
            </span>
          ))}
        </div>
      )}
      <BottomSheet open={!!open} onClose={() => setOpen(null)} title="Image">
        {open && <img src={open} alt="" className="mx-auto max-h-[75vh] max-w-full rounded-[14px] object-contain" />}
      </BottomSheet>
    </>
  )
}
