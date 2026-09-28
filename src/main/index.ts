import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClothApi } from '@shared/api'
import { createServices, type Services } from './services'
import { createApi } from './api'
import type { Secrets } from './core/context'
import { errorMessage } from './core/context'
import type { UsageService } from './core/usage'
import type { UsageSource } from '@shared/types'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Keep dev data out of the installed app's profile.
if (!app.isPackaged && !process.env.CLOTH_HOME) app.setPath('userData', join(app.getPath('appData'), 'Cloth-dev'))
if (process.env.CLOTH_HOME) app.setPath('userData', process.env.CLOTH_HOME)

let mainWindow: BrowserWindow | null = null
let services: Services | null = null

const secrets: Secrets = {
  encrypt: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.from(`plain:${plain}`)),
  decrypt: (data) => {
    const buf = Buffer.from(data)
    if (buf.subarray(0, 6).toString() === 'plain:') return buf.subarray(6).toString()
    return safeStorage.decryptString(buf)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0a0b',
    title: 'Cloth',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#0a0a0b', symbolColor: '#a1a1aa', height: 36 },
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Default attribution for work started from each part of the UI. */
const IPC_SOURCE: Record<string, UsageSource> = { chat: 'chat', rag: 'knowledge', skills: 'skills', workflows: 'workflow', tools: 'tools', web: 'tools', mcp: 'mcp' }

function registerIpc(api: ClothApi, usage: UsageService): void {
  ipcMain.handle('cloth:invoke', async (_e, path: string, args: unknown[]) => {
    const [ns, method] = path.split('.') as [keyof ClothApi, string]
    const fn = (api[ns] as Record<string, (...a: unknown[]) => Promise<unknown>> | undefined)?.[method]
    if (typeof fn !== 'function') throw new Error(`Unknown API ${path}`)
    try {
      return { ok: true, value: await usage.run({ source: IPC_SOURCE[ns] ?? 'other' }, () => fn(...(args ?? []))) }
    } catch (err) {
      console.error(`[ipc] ${path} failed`, err)
      return { ok: false, error: errorMessage(err) }
    }
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId('dev.cloth.app')
    // Packaged: sidecars + examples are extraResources. Dev: repo-local staging folders.
    const resources = app.isPackaged ? process.resourcesPath : null
    services = createServices({
      dataDir: app.getPath('userData'),
      sidecarsDir: resources ?? join(app.getAppPath(), 'sidecars'),
      examplesDir: resources ? join(resources, 'examples') : join(app.getAppPath(), 'resources', 'examples'),
      secrets,
      emit: (channel, payload) => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cloth:event', channel, payload)
      }
    })
    registerIpc(createApi(services), services.providers.usage)
    createWindow()
    services.workflows.startScheduler()
    await services.mcp.restart()
    services.web.warm()
    if (!process.env.CLOTH_SMOKE) void services.examples.seedIfNeeded()
    console.log(`[cloth] data dir ${app.getPath('userData')}; MCP ${services.mcp.status().url} running=${services.mcp.status().running}`)
    if (process.env.CLOTH_SMOKE && mainWindow) {
      const win = mainWindow
      const { runSmoke } = await import('./smoke')
      win.once('ready-to-show', () => void runSmoke(win, services!, process.env.CLOTH_SMOKE!))
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting || !services) return
    // Give sidecars (SearXNG's Python process tree) a chance to exit cleanly.
    e.preventDefault()
    quitting = true
    services.workflows.stopScheduler()
    void Promise.allSettled([services.mcp.stop(), services.web.stop()]).finally(() => app.quit())
  })
}
