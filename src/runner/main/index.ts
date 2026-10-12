import './require-shim'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Secrets } from '../../main/core/context'
import { errorMessage } from '../../main/core/context'
import { createServices, type Services } from '../../main/services'
import type { RunnerApi, RunnerState } from '../api'
import { chatModels, inputFields, installBundle, readManifest } from './install'

/**
 * Flow Runner: the app template every exported flow uses. Everything specific to a flow — its
 * graph, tools, skills, knowledge, name — comes from resources/bundle.
 */
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const resources = app.isPackaged ? process.resourcesPath : (process.env.CLOTH_RUNNER_RESOURCES ?? join(app.getAppPath(), 'build', 'runner-dev'))
const bundleDir = join(resources, 'bundle')
const manifest = readManifest(bundleDir)

// Each exported app keeps its own settings, key and history.
app.setName(manifest.name)
app.setPath('userData', process.env.CLOTH_RUNNER_HOME ?? join(app.getPath('appData'), manifest.appId))

const secrets: Secrets = {
  encrypt: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.from(`plain:${plain}`)),
  decrypt: (data) => {
    const buf = Buffer.from(data)
    if (buf.subarray(0, 6).toString() === 'plain:') return buf.subarray(6).toString()
    return safeStorage.decryptString(buf)
  }
}

let win: BrowserWindow | null = null
let services: Services
let flowId = ''

const OPENAI = 'OpenAI'
const openai = () => services.providers.list().find((p) => p.kind === 'openai' && p.name === OPENAI)

function state(): RunnerState {
  const wf = services.workflows.get(flowId)
  const provider = openai()
  const model = services.settings.get().defaultModel
  return {
    manifest,
    flow: { name: wf.name, description: wf.description, nodes: wf.nodes.map((n) => ({ id: n.id, label: String(n.data.label || n.data.key), type: n.type })) },
    fields: inputFields(wf.nodes),
    hasKey: !!provider && !!services.providers.apiKey(provider.id),
    model: provider && model?.providerId === provider.id ? model.modelId : null,
    models: provider ? chatModels(provider.models.map((m) => m.id)) : [],
    workspace: workspace()
  }
}

/** Where runs save files: the user's choice, else Documents/<app name> (created on the first run). */
function workspace(): string {
  const saved = services.ctx.kv.get<string>('runner.workspace', '')
  if (saved && existsSync(saved)) return saved
  return process.env.CLOTH_RUNNER_WORKSPACE ?? join(app.getPath('documents'), manifest.name)
}

function useModel(providerId: string, models: string[], preferred: string | null): void {
  const current = services.settings.get().defaultModel
  if (current?.providerId === providerId && models.includes(current.modelId)) return
  const pick = (preferred && models.includes(preferred) && preferred) || null
  services.settings.update({ defaultModel: pick ? { providerId, modelId: pick } : null })
}

const api: RunnerApi = {
  state: async () => state(),
  setKey: async (key) => {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('Paste your OpenAI API key')
    const existing = openai()
    const provider = existing
      ? services.providers.update(existing.id, { apiKey: trimmed })
      : services.providers.create({ name: OPENAI, kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: trimmed })
    try {
      const refreshed = await services.providers.refreshModels(provider.id)
      useModel(provider.id, chatModels(refreshed.models.map((m) => m.id)), manifest.model)
    } catch (err) {
      services.providers.update(provider.id, { apiKey: '' })
      throw new Error(`OpenAI did not accept the key: ${errorMessage(err)}`)
    }
    return state()
  },
  clearKey: async () => {
    const p = openai()
    if (p) services.providers.update(p.id, { apiKey: '' })
    return state()
  },
  setModel: async (id) => {
    const p = openai()
    if (!p) throw new Error('Add your OpenAI key first')
    services.settings.update({ defaultModel: { providerId: p.id, modelId: id } })
    return state()
  },
  pickWorkspace: async () => {
    const res = await dialog.showOpenDialog(win!, { title: 'Where should the app save its files?', defaultPath: workspace(), properties: ['openDirectory', 'createDirectory'] })
    if (!res.canceled && res.filePaths[0]) services.ctx.kv.set('runner.workspace', res.filePaths[0])
    return state()
  },
  run: async (input) => {
    if (!services.settings.get().defaultModel) throw new Error('Choose a model first')
    const dir = workspace()
    mkdirSync(dir, { recursive: true })
    return services.workflows.startRun(flowId, input, 'manual', { workspace: dir })
  },
  cancel: async (runId) => services.workflows.cancel(runId),
  runs: async () => services.workflows.runs(flowId, 20),
  openPath: async (p) => {
    const err = await shell.openPath(p)
    if (err) throw new Error(err)
  },
  showInFolder: async (p) => shell.showItemInFolder(p)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: '#09090a',
    title: manifest.name,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#09090a', symbolColor: '#a1a1aa', height: 36 },
    icon: existsSync(join(bundleDir, 'icon.png')) ? join(bundleDir, 'icon.png') : undefined,
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore()
    win?.focus()
  })
  void app.whenReady().then(async () => {
    app.setAppUserModelId(manifest.appId)
    services = createServices({
      dataDir: app.getPath('userData'),
      sidecarsDir: resources,
      examplesDir: join(resources, 'examples'),
      secrets,
      // The runner's one flow is the exported graph: it stays a graph.
      convertFlows: false,
      emit: (channel, payload) => {
        if (channel === 'workflow' && (payload as { type?: string }).type === 'run') win?.webContents.send('runner:event', payload)
      }
    })
    services.settings.update({ webEngine: 'obscura', mcpEnabled: false, remoteEnabled: false })
    ;({ flowId } = await installBundle(services, bundleDir))
    ipcMain.handle('runner:invoke', async (_e, method: keyof RunnerApi, args: unknown[]) => {
      try {
        const fn = api[method] as (...a: unknown[]) => Promise<unknown>
        if (typeof fn !== 'function') throw new Error(`Unknown call ${String(method)}`)
        return { ok: true, value: await fn(...(args ?? [])) }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    })
    createWindow()
    if (process.env.CLOTH_RUNNER_SMOKE) {
      const { runnerSmoke } = await import('./smoke')
      await runnerSmoke(win!, services, flowId, process.env.CLOTH_RUNNER_SMOKE)
    }
  })
  app.on('window-all-closed', () => app.quit())
}
