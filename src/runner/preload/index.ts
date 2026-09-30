import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const bridge = {
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke('runner:invoke', method, args) as Promise<{ ok: boolean; value?: unknown; error?: string }>,
  onEvent: (listener: (payload: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on('runner:event', handler)
    return () => {
      ipcRenderer.removeListener('runner:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('runner', bridge)

export type RunnerBridge = typeof bridge
