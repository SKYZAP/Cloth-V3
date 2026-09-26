import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClothApi, EventMap } from '@shared/api'

/** Typed proxy over the single IPC channel: api.rag.search(...) → invoke('rag.search', [...]). */
export const api: ClothApi = new Proxy({} as ClothApi, {
  get(_t, ns: string) {
    return new Proxy(
      {},
      {
        get(_t2, method: string) {
          return async (...args: unknown[]) => {
            const res = await window.cloth.invoke(`${ns}.${method}`, args)
            if (!res.ok) throw new Error(res.error ?? 'Unknown error')
            return res.value
          }
        }
      }
    )
  }
})

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void
const handlers = new Map<string, Set<Handler<any>>>()
let unsubscribeBridge: (() => void) | null = null

function ensureBridge() {
  if (unsubscribeBridge) return
  unsubscribeBridge = window.cloth.onEvent((channel, payload) => {
    handlers.get(channel)?.forEach((h) => h(payload))
  })
}

export function onEvent<K extends keyof EventMap>(channel: K, handler: Handler<K>): () => void {
  ensureBridge()
  if (!handlers.has(channel)) handlers.set(channel, new Set())
  handlers.get(channel)!.add(handler)
  return () => handlers.get(channel)?.delete(handler)
}

export function useEvent<K extends keyof EventMap>(channel: K, handler: Handler<K>): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => onEvent(channel, (p) => ref.current(p)), [channel])
}

/** Minimal async-data hook: { data, error, loading, reload, setData }. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const reload = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    try {
      const value = await fn()
      if (id === seq.current) {
        setData(value)
        setError(null)
      }
    } catch (err) {
      if (id === seq.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === seq.current) setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, loading, reload, setData }
}
