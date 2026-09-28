export {}

declare global {
  interface Window {
    cloth: {
      invoke(path: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }>
      onEvent(listener: (channel: string, payload: unknown) => void): () => void
      platform: string
      /** Set by the phone app's bridge (calls travel to the desktop over the network). */
      remote?: boolean
    }
  }
}
