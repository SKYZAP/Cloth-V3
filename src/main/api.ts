import { app, dialog, shell, BrowserWindow } from 'electron'
import type { ClothApi } from '@shared/api'
import type { Services } from './services'
import { validateCron } from './workflows/workflows'

export function createApi(s: Services): ClothApi {
  return {
    app: {
      info: async () => ({
        version: app.getVersion(),
        dataDir: s.ctx.dataDir,
        platform: process.platform,
        electron: process.versions.electron,
        node: process.versions.node
      }),
      pickPaths: async ({ directory, multiple, title }) => {
        const win = BrowserWindow.getFocusedWindow()
        const props: ('openFile' | 'openDirectory' | 'multiSelections')[] = [directory ? 'openDirectory' : 'openFile']
        if (multiple) props.push('multiSelections')
        const res = win ? await dialog.showOpenDialog(win, { title, properties: props }) : await dialog.showOpenDialog({ title, properties: props })
        return res.canceled ? [] : res.filePaths
      },
      openPath: async (path) => {
        await shell.openPath(path)
      },
      openExternal: async (url) => {
        if (/^https?:\/\//.test(url)) await shell.openExternal(url)
      }
    },
    settings: {
      get: async () => s.settings.get(),
      update: async (patch) => s.settings.update(patch)
    },
    providers: {
      presets: async () => s.providers.presets(),
      list: async () => s.providers.list(),
      create: async (input) => s.providers.create(input),
      update: async (id, input) => s.providers.update(id, input),
      remove: async (id) => s.providers.remove(id),
      test: (id) => s.providers.test(id),
      refreshModels: (id) => s.providers.refreshModels(id),
      setModels: async (id, models) => s.providers.setModels(id, models),
      ping: async (ref) => {
        const started = Date.now()
        try {
          const { text } = await s.providers.complete(ref, { prompt: 'Reply with the single word: pong', maxTokens: 64, temperature: 0 })
          return { ok: true, text: text.trim(), latencyMs: Date.now() - started }
        } catch (err) {
          return { ok: false, text: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started }
        }
      }
    },
    rag: {
      collections: async () => s.rag.listCollections(),
      createCollection: async (input) => s.rag.createCollection(input),
      updateCollection: async (id, patch) => s.rag.updateCollection(id, patch),
      deleteCollection: async (id) => s.rag.deleteCollection(id),
      documents: async (id) => s.rag.listDocuments(id),
      chunks: async (docId) => s.rag.getChunks(docId),
      deleteDocument: async (id) => s.rag.deleteDocument(id),
      reindexDocument: (id) => s.rag.reindexDocument(id),
      ingestPaths: (id, paths) => s.rag.ingestPaths(id, paths),
      ingestUrl: (input) => s.rag.ingestUrl(input),
      ingestText: (id, title, text) => s.rag.ingestText(id, title, text),
      embedMissing: (id) => s.rag.embedMissing(id),
      search: (input) => s.rag.search(input)
    },
    skills: {
      list: () => s.skills.list(),
      get: (name) => s.skills.get(name),
      create: (input) => s.skills.create(input),
      update: (name, input) => s.skills.update(name, input),
      remove: (name) => s.skills.remove(name),
      readFile: (name, path) => s.skills.readFile(name, path),
      writeFile: (name, path, content) => s.skills.writeFile(name, path, content),
      saveEvals: (name, cases) => s.skills.saveEvals(name, cases),
      draftEvals: (name, model) => s.skills.draftEvals(name, model),
      discover: (extra) => s.skills.discover(extra),
      importFrom: (path, overwrite) => s.skills.importFrom(path, overwrite),
      exportTo: (name, target) => s.skills.exportTo(name, target),
      knownSources: async () => s.skills.knownSources(),
      test: async (input) => s.skills.startTest(input),
      runs: async (name) => s.skills.runs(name),
      dir: async () => s.ctx.skillsDir
    },
    chat: {
      list: async () => s.chat.list(),
      create: async (config) => s.chat.create(config),
      update: async (id, patch) => s.chat.update(id, patch),
      remove: async (id) => s.chat.remove(id),
      messages: async (id) => s.chat.messages(id),
      send: (id, text) => s.chat.send(id, text),
      abort: async (id) => s.chat.abort(id),
      rewind: async (id, messageId) => s.chat.rewind(id, messageId),
      running: async () => s.chat.list().filter((c) => s.chat.isRunning(c.id)).map((c) => c.id)
    },
    workflows: {
      list: async () => s.workflows.list(),
      get: async (id) => s.workflows.get(id),
      create: async (input) => s.workflows.create(input),
      save: async (id, patch) => s.workflows.save(id, patch),
      remove: async (id) => s.workflows.remove(id),
      duplicate: async (id) => s.workflows.duplicate(id),
      run: async (id, input) => s.workflows.startRun(id, input, 'manual'),
      cancel: async (runId) => s.workflows.cancel(runId),
      runs: async (id) => s.workflows.runs(id),
      validateCron: async (expr) => validateCron(expr)
    },
    mcp: {
      status: async () => s.mcp.status(),
      restart: () => s.mcp.restart(),
      rotateToken: async () => s.mcp.rotateToken()
    }
  }
}
