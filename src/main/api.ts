import { app, dialog, shell, BrowserWindow } from 'electron'
import type { ClothApi } from '@shared/api'
import { copyFile } from 'node:fs/promises'
import type { Services } from './services'
import { validateCron } from './workflows/workflows'
import { describeBuiltins } from './agent/tools'

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
      showInFolder: async (path) => shell.showItemInFolder(path),
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
      search: (input) => s.rag.search(input),
      ask: (input) => s.rag.ask(input),
      loadExamples: () => s.examples.load()
    },
    tools: {
      builtins: async () => describeBuiltins(),
      list: async () => s.custom.list(),
      create: async (input) => s.custom.create(input),
      update: async (id, input) => s.custom.update(id, input),
      setEnabled: async (id, enabled) => s.custom.setEnabled(id, enabled),
      remove: async (id) => s.custom.remove(id),
      test: (tool, args) => s.custom.test(tool, args)
    },
    web: {
      status: async () => s.web.status(),
      search: (query, opts) => s.web.search(query, opts),
      startSearxng: async () => {
        await s.web.searxng.ensure(s.settings.get().webCaCertPath)
        return s.web.status()
      },
      stopSearxng: async () => {
        await s.web.searxng.stop()
        return s.web.status()
      }
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
      generate: (input) => s.skills.generate(input),
      discover: (extra) => s.skills.discover(extra),
      importFrom: (path, overwrite) => s.skills.importFrom(path, overwrite),
      exportTo: (name, target) => s.skills.exportTo(name, target),
      knownSources: async () => s.skills.knownSources(),
      test: async (input) => s.skills.startTest(input),
      runs: async (name) => s.skills.runs(name),
      registrySearch: (q) => s.registry.search(q),
      registryPreview: (id) => s.registry.preview(id),
      registryInstall: (id, overwrite) => s.registry.install(id, { overwrite }),
      registryCheckUpdate: (name) => s.registry.checkUpdate(name),
      dir: async () => s.ctx.skillsDir
    },
    chat: {
      list: async () => s.chat.list(),
      create: async (config) => s.chat.create(config),
      update: async (id, patch) => {
        const next = s.chat.update(id, patch)
        // A different model: fetch its current context size before the meter asks for it.
        if (patch.model) await s.providers.refreshModel(patch.model, { force: true }).catch(() => undefined)
        return next
      },
      remove: async (id) => s.chat.remove(id),
      messages: async (id) => s.chat.messages(id),
      send: (id, text, skills) => s.chat.send(id, text, skills ?? []),
      abort: async (id) => s.chat.abort(id),
      rewind: async (id, messageId) => s.chat.rewind(id, messageId),
      running: async () => s.chat.list().filter((c) => s.chat.isRunning(c.id)).map((c) => c.id),
      pendingApprovals: async (id) => s.chat.pendingApprovals(id),
      resolveApproval: async (approvalId, decision) => s.chat.resolveApproval(approvalId, decision),
      pendingQuestions: async (id) => s.chat.pendingQuestions(id),
      answerQuestion: async (questionId, answer) => s.chat.answerQuestion(questionId, answer),
      undoChange: (id, toolCallId, force) => s.chat.undoChange(id, toolCallId, force),
      retitle: (id) => s.chat.retitle(id, { force: true }),
      compact: (id, instructions) => s.chat.compact(id, { instructions }),
      contextUsage: (id) => s.chat.contextUsage(id)
    },
    workflows: {
      list: async () => s.workflows.list(),
      get: async (id) => s.workflows.get(id),
      create: async (input) => s.workflows.create(input),
      save: async (id, patch, meta) => s.workflows.save(id, patch, meta),
      versions: async (id) => s.workflows.versions(id),
      version: async (versionId) => s.workflows.version(versionId),
      restore: async (id, versionId) => s.workflows.restore(id, versionId),
      failureReport: async (runId) => s.workflows.failureReport(runId),
      remove: async (id) => s.workflows.remove(id),
      duplicate: async (id) => s.workflows.duplicate(id),
      run: async (id, input) => s.workflows.startRun(id, input, 'manual'),
      cancel: async (runId) => s.workflows.cancel(runId),
      runs: async (id) => s.workflows.runs(id),
      validateCron: async (expr) => validateCron(expr),
      build: (input) => s.providers.usage.run({ source: 'builder' }, () => s.workflows.build(input)),
      cancelBuild: async (buildId) => s.workflows.cancelBuild(buildId),
      exportPreview: (id) => s.exporter.preview(id),
      exportStart: async (input) => s.exporter.start(input),
      exportCancel: async (exportId) => s.exporter.cancel(exportId),
      createFromGraph: async (graph) => s.workflows.createFromGraph(graph)
    },
    dashboard: {
      stats: (range) => s.dashboard.stats(range),
      clearUsage: async () => {
        s.ctx.db.exec('DELETE FROM usage_events')
      }
    },
    images: {
      defaultModel: async () => s.images.defaultModel(),
      generate: async (input) => {
        const img = await s.providers.usage.run({ source: 'other' }, () => s.images.generate(input))
        return { id: img.id, status: 'complete', prompt: img.prompt, revisedPrompt: img.revisedPrompt, size: img.size, width: img.width, height: img.height, model: img.model }
      },
      open: async (id) => {
        const f = await s.images.file(id)
        if (f) await shell.openPath(f.file)
      },
      saveAs: async (id) => {
        const f = await s.images.file(id)
        if (!f) throw new Error('Image not found')
        const ext = f.file.split('.').pop() ?? 'png'
        const win = BrowserWindow.getFocusedWindow()
        const opts = { title: 'Save image', defaultPath: `cloth-image.${ext}`, filters: [{ name: 'Image', extensions: [ext] }] }
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (res.canceled || !res.filePath) return null
        await copyFile(f.file, res.filePath)
        return res.filePath
      }
    },
    mcp: {
      status: async () => s.mcp.status(),
      restart: () => s.mcp.restart(),
      rotateToken: async () => s.mcp.rotateToken()
    },
    remote: {
      status: async () => s.remote.status(),
      pair: () => s.remote.pair(),
      cancelPairing: async (id) => s.remote.cancelPairing(id),
      revoke: async (id) => s.remote.revoke(id),
      rename: async (id, name) => s.remote.rename(id, name),
      roots: () => s.remote.roots(),
      listDir: (path) => s.remote.listDir(path),
      imageData: async (id) => s.remote.imageData(await s.images.file(id))
    }
  }
}
