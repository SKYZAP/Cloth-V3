import { useEffect, useState } from 'react'
import { api } from './api'

/** True inside the Android app, where every call travels to the desktop over the network. */
export const isMobile = !!window.cloth.remote

const blobs = new Map<string, Promise<string>>()

/** Where an <img> finds a generated image: the desktop's cloth-image: protocol, or bytes fetched from the PC on the phone. */
export function useImageSrc(id: string | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() => (id && !isMobile ? `cloth-image://image/${id}` : undefined))
  useEffect(() => {
    if (!id) return setSrc(undefined)
    if (!isMobile) return setSrc(`cloth-image://image/${id}`)
    let live = true
    if (!blobs.has(id)) {
      const p = api.remote.imageData(id).then((img) => {
        if (!img) throw new Error('Image not found')
        const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0))
        return URL.createObjectURL(new Blob([bytes], { type: img.mime }))
      })
      p.catch(() => blobs.delete(id))
      blobs.set(id, p)
    }
    blobs
      .get(id)!
      .then((url) => live && setSrc(url))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [id])
  return src
}
