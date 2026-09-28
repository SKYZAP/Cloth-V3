import { create } from 'zustand'
import type { Collection, ModelRef, Provider, Settings } from '@shared/types'
import { api } from './api'

export type Page = 'dashboard' | 'chat' | 'knowledge' | 'skills' | 'tools' | 'workflows' | 'providers' | 'mcp' | 'settings'

interface Toast {
  id: number
  kind: 'ok' | 'error' | 'info'
  text: string
}

interface AppState {
  page: Page
  setPage(p: Page): void
  providers: Provider[]
  collections: Collection[]
  settings: Settings | null
  loadProviders(): Promise<void>
  loadCollections(): Promise<void>
  loadSettings(): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  toasts: Toast[]
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
}

let toastSeq = 0

export const useApp = create<AppState>((set, get) => ({
  page: (localStorage.getItem('cloth.page') as Page) || 'chat',
  setPage: (page) => {
    try {
      localStorage.setItem('cloth.page', page)
    } catch {
      /* storage unavailable */
    }
    set({ page })
  },
  providers: [],
  collections: [],
  settings: null,
  loadProviders: async () => set({ providers: await api.providers.list() }),
  loadCollections: async () => set({ collections: await api.rag.collections() }),
  loadSettings: async () => set({ settings: await api.settings.get() }),
  updateSettings: async (patch) => set({ settings: await api.settings.update(patch) }),
  toasts: [],
  toast: (text, kind = 'info') => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, kind, text }] })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

/** Run an async action and surface failures as a toast. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const out = await fn()
    if (success) useApp.getState().toast(success, 'ok')
    return out
  } catch (err) {
    useApp.getState().toast(err instanceof Error ? err.message : String(err), 'error')
    return undefined
  }
}

export function modelLabel(providers: Provider[], ref: ModelRef | null | undefined): string {
  if (!ref) return 'No model'
  const p = providers.find((x) => x.id === ref.providerId)
  return p ? `${ref.modelId}` : `${ref.modelId} (missing provider)`
}

export function sameRef(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId
}
