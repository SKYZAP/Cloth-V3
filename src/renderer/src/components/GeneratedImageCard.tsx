import { useEffect, useState } from 'react'
import { ArrowSquareOut, DownloadSimple } from '@phosphor-icons/react'
import type { GeneratedImage } from '@shared/types'
import { api } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { ImageGeneration, useRevealStatus } from './ImageGeneration'
import { Tooltip } from './Tooltip'
import { useImageSrc } from '@/lib/platform'

function ratio(img: GeneratedImage): string {
  if (img.width && img.height) return `${img.width} / ${img.height}`
  if (img.size === '1536x1024') return '3 / 2'
  if (img.size === '1024x1536') return '2 / 3'
  return '1 / 1'
}

function useElapsed(since: number | undefined, active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0
}

/** A generated image (or one in progress) in the beui ImageGeneration surface, with Open / Save. */
export function GeneratedImageCard({ image, onRetry, className }: { image: GeneratedImage; onRetry?: () => void; className?: string }) {
  const status = useRevealStatus(image.status)
  const src = useImageSrc(image.id)
  const active = status === 'queued' || status === 'generating' || status === 'refining'
  const secs = useElapsed(image.startedAt, active)
  const resolution = image.width && image.height ? `${image.width} × ${image.height}` : image.size === 'auto' ? 'auto' : image.size.replace('x', ' × ')
  const statusText = status === 'generating' ? `Generating image${secs >= 2 ? ` · ${secs}s` : ''}` : status === 'error' ? 'Generation failed' : undefined

  return (
    <div className={className}>
      <ImageGeneration
        size="fluid"
        status={status}
        prompt={image.prompt}
        resolution={resolution}
        aspectRatio={ratio(image)}
        statusText={statusText}
        onRetry={onRetry}
        actions={
          image.id && status === 'complete' ? (
            <>
              <Tooltip content="Open">
                <button onClick={() => void attempt(() => api.images.open(image.id!))} className="flex h-7 w-7 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev-2 hover:text-fg" aria-label="Open image">
                  <ArrowSquareOut size={15} />
                </button>
              </Tooltip>
              <Tooltip content="Save as…">
                <button
                  onClick={async () => {
                    const saved = await attempt(() => api.images.saveAs(image.id!))
                    if (saved) useApp.getState().toast(`Saved to ${saved}`, 'ok')
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-dim transition-colors hover:bg-elev-2 hover:text-fg"
                  aria-label="Save image"
                >
                  <DownloadSimple size={15} />
                </button>
              </Tooltip>
            </>
          ) : null
        }
      >
        {image.id && src ? <img src={src} alt={image.revisedPrompt ?? image.prompt} draggable={false} /> : null}
      </ImageGeneration>
      {status === 'error' && image.error && <div className="mt-2 rounded-lg border border-crimson-line bg-crimson-soft px-3 py-2 text-[12px] text-crimson-hi">{image.error.replace(/^Error:\s*/, '')}</div>}
      {status === 'complete' && image.revisedPrompt && image.revisedPrompt !== image.prompt && (
        <div className="mt-1.5 line-clamp-2 text-[11.5px] text-dim" title={image.revisedPrompt}>
          Revised prompt: {image.revisedPrompt}
        </div>
      )}
    </div>
  )
}
