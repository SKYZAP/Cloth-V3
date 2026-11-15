import { create } from 'zustand'
import type { Collection, ModelRef, Provider, Settings } from '@shared/types'
import { api } from './api'
import type { OnboardingStep } from '@shared/onboarding'

export type Page = 'dashboard' | 'chat' | 'boards' | 'knowledge' | 'skills' | 'agents' | 'tools' | 'workflows' | 'providers' | 'run' | 'mcp' | 'design' | 'settings' | 'swatches'

interface Toast {
  id: number
  kind: 'ok' | 'error' | 'info'
  text: string
  /** A button on the toast (it stays until dismissed). */
  action?: { label: string; run(): void }
}

/** What the design page opens on: a project's design system, or the list with that project in mind. */
export interface DesignFocus {
  designId?: string
  projectId?: string
}

interface AppState {
  page: Page
  setPage(p: Page): void
  /** Set when the design page is opened for something; null opens it plainly (from Settings). */
  designFocus: DesignFocus | null
  openDesign(focus?: DesignFocus | null): void
  providers: Provider[]
  collections: Collection[]
  settings: Settings | null
  loadProviders(): Promise<void>
  loadCollections(): Promise<void>
  loadSettings(): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  /** First-run setup: open, and the step it shows (null = where it got to). */
  onboarding: { open: boolean; step: OnboardingStep | null }
  /** A chat another screen asked the Chat page to show (picked up even while the page is already open). */
  chatToOpen: string | null
  openChatById(id: string): void
  openOnboarding(step?: OnboardingStep | null): void
  closeOnboarding(): void
  toasts: Toast[]
  toast(text: string, kind?: Toast['kind'], action?: Toast['action']): void
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
  designFocus: null,
  openDesign: (focus = null) => {
    set({ designFocus: focus })
    get().setPage('design')
  },
  onboarding: { open: false, step: null },
  openOnboarding: (step = null) => set({ onboarding: { open: true, step } }),
  closeOnboarding: () => set({ onboarding: { open: false, step: null } }),
  chatToOpen: null,
  openChatById: (id) => {
    try {
      localStorage.setItem('cloth.chat', id)
    } catch {
      /* storage unavailable */
    }
    set({ chatToOpen: id })
    get().setPage('chat')
  },
  providers: [],
  collections: [],
  settings: null,
  loadProviders: async () => set({ providers: await api.providers.list() }),
  loadCollections: async () => set({ collections: await api.rag.collections() }),
  loadSettings: async () => set({ settings: await api.settings.get() }),
  updateSettings: async (patch) => set({ settings: await api.settings.update(patch) }),
  toasts: [],
  toast: (text, kind = 'info', action) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, kind, text, ...(action ? { action } : {}) }] })
    if (!action) setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500)
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
