import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClothApi } from '@shared/api'
import { createServices, type Services } from './services'
import { createApi } from './api'
import type { Secrets } from './core/context'
import { errorMessage } from './core/context'

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

function registerIpc(api: ClothApi): void {
  ipcMain.handle('cloth:invoke', async (_e, path: string, args: unknown[]) => {
    const [ns, method] = path.split('.') as [keyof ClothApi, string]
    const fn = (api[ns] as Record<string, (...a: unknown[]) => Promise<unknown>> | undefined)?.[method]
    if (typeof fn !== 'function') throw new Error(`Unknown API ${path}`)
    try {
      return { ok: true, value: await fn(...(args ?? [])) }
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
    services = createServices({
      dataDir: app.getPath('userData'),
      secrets,
      emit: (channel, payload) => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cloth:event', channel, payload)
      }
    })
    registerIpc(createApi(services))
    createWindow()
    services.workflows.startScheduler()
    await services.mcp.restart()
    console.log(`[cloth] data dir ${app.getPath('userData')}; MCP ${services.mcp.status().url} running=${services.mcp.status().running}`)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    services?.workflows.stopScheduler()
    void services?.mcp.stop()
  })
}
