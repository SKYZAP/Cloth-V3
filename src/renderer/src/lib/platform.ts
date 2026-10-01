import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from './api'

/** True inside the Android app, where every call travels to the desktop over the network. */
export const isMobile = !!window.cloth.remote

// An unfolded foldable or a tablet has room for a list beside its detail, like the desktop.
const wideQuery = window.matchMedia('(min-width: 700px)')
const subscribeWide = (cb: () => void) => {
  wideQuery.addEventListener('change', cb)
  return () => wideQuery.removeEventListener('change', cb)
}

/** True on a phone screen wide enough for desktop-style layouts (follows folding and rotation). */
export function useWideMobile(): boolean {
  const wide = useSyncExternalStore(subscribeWide, () => wideQuery.matches)
  return isMobile && wide
}

/** Lists show beside their detail (desktop, or a wide phone screen) rather than as separate screens. */
export function useSideBySide(): boolean {
  const wide = useWideMobile()
  return !isMobile || wide
}

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
