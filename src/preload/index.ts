import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type Listener = (channel: string, payload: unknown) => void

const bridge = {
  invoke: (path: string, args: unknown[]) => ipcRenderer.invoke('cloth:invoke', path, args) as Promise<{ ok: boolean; value?: unknown; error?: string }>,
  onEvent: (listener: Listener) => {
    const handler = (_e: IpcRendererEvent, channel: string, payload: unknown) => listener(channel, payload)
    ipcRenderer.on('cloth:event', handler)
    return () => {
      ipcRenderer.removeListener('cloth:event', handler)
    }
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('cloth', bridge)

export type Bridge = typeof bridge
