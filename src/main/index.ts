import { app, BrowserWindow, ipcMain, nativeImage, Notification, powerSaveBlocker, protocol, safeStorage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClothApi } from '@shared/api'
import { createServices, type Services } from './services'
import { createApi } from './api'
import type { Secrets } from './core/context'
import { errorMessage } from './core/context'
import type { UsageService } from './core/usage'
import type { UsageSource, WorkflowEvent } from '@shared/types'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// Keep dev data out of the installed app's profile.
if (!app.isPackaged && !process.env.CLOTH_HOME) app.setPath('userData', join(app.getPath('appData'), 'Cloth-dev'))
if (process.env.CLOTH_HOME) app.setPath('userData', process.env.CLOTH_HOME)

// Generated images load in the UI as cloth-image://image/<id> (files in the data folder).
protocol.registerSchemesAsPrivileged([{ scheme: 'cloth-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const firstExisting = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? null

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

/** Runs an API call by path — shared by the window's IPC and paired phones. */
function makeDispatch(api: ClothApi, usage: UsageService) {
  return async (path: string, args: unknown[]): Promise<unknown> => {
    const [ns, method] = path.split('.') as [keyof ClothApi, string]
    const fn = Object.hasOwn(api, ns) ? (api[ns] as Record<string, (...a: unknown[]) => Promise<unknown>>)[method] : undefined
    if (typeof fn !== 'function' || !Object.hasOwn(api[ns], method)) throw new Error(`Unknown API ${path}`)
    return usage.run({ source: IPC_SOURCE[ns] ?? 'other' }, () => fn(...(args ?? [])))
  }
}

function registerIpc(dispatch: (path: string, args: unknown[]) => Promise<unknown>): void {
  ipcMain.handle('cloth:invoke', async (_e, path: string, args: unknown[]) => {
    try {
      return { ok: true, value: await dispatch(path, args) }
    } catch (err) {
      console.error(`[ipc] ${path} failed`, err)
      return { ok: false, error: errorMessage(err) }
    }
  })
}

let awakeBlocker: number | null = null
function keepAwake(on: boolean): void {
  if (on && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
  if (!on && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker)
    awakeBlocker = null
  }
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
    // Runs from source get their own id, so Windows never mixes them (and Electron's icon) up with the installed Cloth on the taskbar.
    app.setAppUserModelId(app.isPackaged ? 'dev.cloth.app' : 'dev.cloth.app.source')
    // Packaged: sidecars + examples are extraResources. Dev: repo-local staging folders.
    const resources = app.isPackaged ? process.resourcesPath : null
    services = createServices({
      dataDir: app.getPath('userData'),
      sidecarsDir: resources ?? join(app.getAppPath(), 'sidecars'),
      examplesDir: resources ? join(resources, 'examples') : join(app.getAppPath(), 'resources', 'examples'),
      exportToolchain: {
        // Packaged: shipped as extraResources. Dev: produced by `npm run build:runner`.
        runnerDir: () => firstExisting(resources ? join(resources, 'flow-runner') : join(app.getAppPath(), 'build', 'runner-dist', 'win-unpacked')),
        nsisDir: () => firstExisting(resources ? join(resources, 'nsis') : join(app.getAppPath(), 'build', 'nsis')),
        iconPng: async () => nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')).resize({ width: 256, height: 256, quality: 'best' }).toPNG(),
        defaultOutputDir: () => process.env.CLOTH_EXPORT_DIR ?? app.getPath('downloads'),
        clothVersion: app.getVersion()
      },
      secrets,
      emit: (channel, payload) => {
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cloth:event', channel, payload)
        services?.remote.broadcast(channel, payload)
        if (channel === 'workflow') notifyAutomation(payload as WorkflowEvent)
      }
    })
    const images = services.images
    protocol.handle('cloth-image', async (req) => {
      const id = new URL(req.url).pathname.replace(/^\/+/, '')
      const found = await images.file(id)
      if (!found) return new Response('Not found', { status: 404 })
      return new Response(new Uint8Array(await readFile(found.file)), { headers: { 'content-type': found.mime, 'cache-control': 'max-age=31536000, immutable' } })
    })
    const dispatch = makeDispatch(createApi(services), services.providers.usage)
    registerIpc(dispatch)
    services.remote.attach({ dispatch, keepAwake, version: app.getVersion() })
    createWindow()
    services.workflows.startScheduler()
    await services.mcp.restart()
    await services.remote.restart()
    // Dev: pair a phone (or the mobile web build) without clicking through Settings.
    if (!app.isPackaged && process.env.CLOTH_PAIR_FILE) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(process.env.CLOTH_PAIR_FILE, (await services.remote.pair()).link)
    }
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
    services.lsp.disposeAll()
    services.panel.terminals.killAll()
    void Promise.allSettled([services.mcp.stop(), services.web.stop(), services.remote.stop(), services.containers.stopAll(), services.mcpClients.stopAll()]).finally(() => app.quit())
  })
}

/** A desktop notification when an automation asks for one, or fails. */
function notifyAutomation(e: WorkflowEvent): void {
  if (e.type !== 'automation' || !e.notify || !Notification.isSupported()) return
  const n = new Notification({ title: e.ok ? e.name : `${e.name} failed`, body: e.summary || (e.ok ? 'Finished.' : 'The run failed. Open Flows to see why.'), silent: e.ok })
  n.on('click', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.focus()
  })
  n.show()
}
