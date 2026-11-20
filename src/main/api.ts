import { certificateInfo, checkNetwork, saveSystemCertificate } from './web/trust'
import { runOpenSpec } from './agent/openspec'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, shell, BrowserWindow } from 'electron'
import { MCP_PRESETS, mcpToolName } from './mcp/client'
import { presetsWithTokens, readEnvFile } from './mcp/homelab'
import type { ClothApi } from '@shared/api'
import type { McpClientConfig, Provider, Settings, ToolRunResult } from '@shared/types'
import { mapClient, mapSecrets, masker, restoreClient } from './core/secret-fields'
import { scheduleReset } from './core/reset'
import { swatchFileName } from '@shared/swatches'
import { copyFile, writeFile } from 'node:fs/promises'
import type { Services } from './services'
import { validateCron } from './workflows/workflows'
import { describeBuiltins } from './agent/tools'
import { TRYABLE } from './agent/chat'
import { openPermissionPane } from './computer/host'
import { globalRulesDir } from './agent/rules'
import { languageServers, OnboardingService, scanFolder } from './onboarding'
import { findOnPath, PATH_SERVERS } from './agent/lsp'
import { installServer, uninstallServer, type InstallableServer } from './agent/lsp-install'

/*
 * Secrets in settings (MCP servers' tokens) and providers' headers never leave the main process: the app
 * and paired phones get masks, and masks sent back are swapped for what's saved (core/secret-fields.ts).
 */
const maskSettings = (st: Settings): Settings => ({ ...st, mcpClients: st.mcpClients.map((c) => mapClient(c, masker)) })
const maskProvider = (p: Provider): Provider => ({ ...p, headers: mapSecrets(p.headers, masker) })

function restoreSettings(s: Services, patch: Partial<Settings>): Partial<Settings> {
  if (!patch.mcpClients) return patch
  const saved = s.settings.get().mcpClients
  const presets = presetsWithTokens(MCP_PRESETS, readEnvFile())
  const known = (c: McpClientConfig) => [saved.find((x) => x.id === c.id), presets.find((p) => p.name === c.name)].filter((x): x is NonNullable<typeof x> => !!x)
  return { ...patch, mcpClients: patch.mcpClients.map((c) => restoreClient(c, known(c))) }
}

/** The installable server for a language (Go, Rust, C/C++ or Java), or an error for the rest. */
function serverFor(id: string): InstallableServer {
  const key = (Object.keys(PATH_SERVERS) as InstallableServer[]).find((k) => PATH_SERVERS[k].language === id)
  if (!key) throw new Error('Cloth installs language servers for Go, Rust, C/C++ and Java; this language’s server ships with Cloth or has none yet')
  return key
}

export function createApi(s: Services): ClothApi {
  const onboarding = new OnboardingService(s)
  return {
    app: {
      info: async () => ({
        version: app.getVersion(),
        dataDir: s.ctx.dataDir,
        rulesDir: globalRulesDir(s.ctx.dataDir),
        platform: process.platform,
        electron: process.versions.electron,
        node: process.versions.node
      }),
      pickPaths: async ({ directory, multiple, title, filters }) => {
        const win = BrowserWindow.getFocusedWindow()
        const props: ('openFile' | 'openDirectory' | 'multiSelections')[] = [directory ? 'openDirectory' : 'openFile']
        if (multiple) props.push('multiSelections')
        const opts = { title, properties: props, ...(filters?.length && !directory ? { filters } : {}) }
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        return res.canceled ? [] : res.filePaths
      },
      certificateInfo: async (path) => certificateInfo(path),
      showInFolder: async (path) => shell.showItemInFolder(path),
      openPath: async (path) => {
        await shell.openPath(path)
      },
      openExternal: async (url) => {
        if (/^https?:\/\//.test(url)) await shell.openExternal(url)
      },
      openPrivacySettings: async (kind) => openPermissionPane(kind === 'accessibility' ? 'accessibility' : 'screen'),
      reset: async (opts) => {
        scheduleReset(s.ctx.dataDir, { keepModels: opts?.keepModels === true })
        // After the reply reaches the window: quit (sidecars stop as usual) and start again, empty.
        setTimeout(() => {
          app.relaunch()
          app.quit()
        }, 300)
      }
    },
    settings: {
      get: async () => maskSettings(s.settings.get()),
      update: async (patch) => maskSettings(s.settings.update(restoreSettings(s, patch)))
    },
    network: {
      check: () => checkNetwork(),
      useSystemCertificate: async (fingerprint) => maskSettings(s.settings.update({ webCaCertPath: saveSystemCertificate(fingerprint, s.ctx.dataDir) }))
    },
    providers: {
      presets: async () => s.providers.presets(),
      list: async () => s.providers.list().map(maskProvider),
      create: async (input) => maskProvider(s.providers.create(input)),
      update: async (id, input) => maskProvider(s.providers.update(id, input)),
      remove: async (id) => s.providers.remove(id),
      test: (id) => s.providers.test(id),
      refreshModels: async (id) => maskProvider(await s.providers.refreshModels(id)),
      setModels: async (id, models) => maskProvider(s.providers.setModels(id, models)),
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
      syncSource: (id, source) => s.rag.syncSource(id, source),
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
      usage: async () => s.dashboard.toolUsage(),
      draft: async (description) => s.custom.draft(description),
      tryBuiltin: (name, args, folder) => timedRun(() => s.runtime.tryTool(name, args, folder)),
      tryable: async () => TRYABLE,
      usedBy: async () => toolUsers(s),
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
      generate: (input) => s.skills.generate(input),
      discover: (extra) => s.skills.discover(extra),
      importFrom: (path, overwrite) => s.skills.importFrom(path, overwrite),
      exportTo: (name, target) => s.skills.exportTo(name, target),
      knownSources: async () => s.skills.knownSources(),
      registrySearch: (q) => s.registry.search(q),
      registryPreview: (id) => s.registry.preview(id),
      registryInstall: (id, overwrite) => s.registry.install(id, { overwrite }),
      registryCheckUpdate: (name) => s.registry.checkUpdate(name),
      registryUpdateDiff: (name) => s.registry.updateDiff(name),
      registryStatus: (name) => s.registry.status(name),
      registryAudits: (name, refresh) => s.registry.audits(name, { refresh }),
      registryLinkCandidates: (name) => s.registry.linkCandidates(name),
      registryLink: (name, id) => s.registry.link(name, id),
      registryUnlink: (name) => s.registry.unlink(name),
      registryUpdate: (name) => s.registry.update(name),
      insight: (name) => s.skillInsights.insight(name),
      usageAll: async () => s.skillInsights.usageAll(),
      groups: () => s.registry.groups(),
      saveTriggers: async (name, triggers) => s.skillInsights.saveTriggers(name, triggers),
      draftTriggers: (name, model) => s.skillInsights.draftTriggers(name, model),
      runTriggers: (name, model) => s.skillInsights.runTriggers(name, model),
      markReviewed: (name, reviewed) => s.skillInsights.markReviewed(name, reviewed),
      tryInChat: async (name) => {
        await s.skills.get(name)
        const chat = s.chat.create({})
        return s.chat.update(chat.id, { title: `Try ${name}`, skillsAlways: [name] })
      },
      dir: async () => s.ctx.skillsDir
    },
    panel: {
      root: async (id) => s.panel.root(id),
      list: (id, dir) => s.panel.list(id, dir),
      read: (id, path) => s.panel.read(id, path),
      open: async (id, path) => {
        const err = await shell.openPath(s.panel.absolute(id, path))
        if (err) throw new Error(err)
      },
      reveal: async (id, path) => shell.showItemInFolder(s.panel.absolute(id, path)),
      terminals: async (id) => s.panel.terminals.list(id),
      openTerminal: (id, size) => s.panel.openTerminal(id, size),
      terminalBuffer: async (id) => s.panel.terminals.buffer(id),
      writeTerminal: async (id, data) => s.panel.terminals.write(id, data),
      resizeTerminal: async (id, cols, rows) => s.panel.terminals.resize(id, cols, rows),
      closeTerminal: async (id) => s.panel.terminals.kill(id),
      stopTerminal: async (id) => s.panel.terminals.stop(id),
      gitStatus: (id) => s.panel.gitStatus(id),
      openspec: async (id) => {
        const folder = s.chat.get(id).workspace
        if (!folder) return { initialised: false, changes: null, specs: null, error: 'This chat has no folder.' }
        if (!existsSync(join(folder, 'openspec'))) return { initialised: false, changes: null, specs: null, error: null }
        const [changes, specs] = await Promise.all([runOpenSpec(folder, ['list', '--json'], undefined, 30_000), runOpenSpec(folder, ['list', '--specs', '--json'], undefined, 30_000)])
        const parse = (r: { code: number | null; stdout: string }) => {
          try {
            return r.code === 0 ? JSON.parse(r.stdout) : null
          } catch {
            return null
          }
        }
        const failed = [changes, specs].find((r) => r.code !== 0)
        return { initialised: true, changes: parse(changes), specs: parse(specs), error: failed ? (failed.stderr || failed.stdout).trim().slice(0, 400) || 'openspec failed' : null }
      },
      gitInit: (id) => s.panel.gitInit(id),
      gitDiff: (id, path, staged) => s.panel.gitDiff(id, path, staged),
      gitStage: (id, paths) => s.panel.gitStage(id, paths),
      gitUnstage: (id, paths) => s.panel.gitUnstage(id, paths),
      gitDiscard: (id, paths) => s.panel.gitDiscard(id, paths),
      gitCommit: (id, message, all) => s.panel.gitCommit(id, message, all),
      gitLog: (id) => s.panel.gitLog(id),
      gitPush: (id) => s.panel.gitPush(id),
      gitPull: (id) => s.panel.gitPull(id),
      commitMessage: (id, all) => s.panel.commitMessage(id, all)
    },
    chat: {
      list: async () => s.chat.list(),
      create: async (config) => s.chat.create(config),
      sharedSkills: async () => s.chat.sharedSkills(),
      setSharedSkills: async (names, mode) => s.chat.setSharedSkills(names, mode),
      update: async (id, patch) => {
        // Changes made in a chat's Setup are the setup for every chat; its model, effort and mode carry over to new chats.
        const next = s.chat.update(id, s.chat.rememberPicks(id, patch), { share: true })
        // A different model: fetch its current context size before the meter asks for it.
        if (patch.model) await s.providers.refreshModel(patch.model, { force: true }).catch(() => undefined)
        return next
      },
      remove: async (id) => {
        s.panel.terminals.killSession(id)
        s.chat.remove(id)
      },
      messages: async (id) => s.chat.messages(id),
      send: (id, text, skills, attachments, agents) => s.chat.send(id, text, skills ?? [], attachments ?? [], agents ?? []),
      resend: (id, messageId) => s.chat.resend(id, messageId),
      abort: async (id) => s.chat.abort(id),
      nudge: (id, input) => s.chat.nudge(id, input),
      unnudge: async (id, nudgeId) => s.chat.unnudge(id, nudgeId),
      nudges: async (id) => s.chat.nudges(id),
      rewind: async (id, messageId) => s.chat.rewind(id, messageId),
      running: async () => s.chat.list().filter((c) => s.chat.isRunning(c.id)).map((c) => c.id),
      pendingApprovals: async (id) => s.chat.pendingApprovals(id),
      resolveApproval: async (approvalId, decision) => s.chat.resolveApproval(approvalId, decision),
      pendingQuestions: async (id) => s.chat.pendingQuestions(id),
      answerQuestion: async (questionId, answer) => s.chat.answerQuestion(questionId, answer),
      undoChange: (id, toolCallId, force) => s.chat.undoChange(id, toolCallId, force),
      retitle: (id) => s.chat.retitle(id, { force: true }),
      compact: (id, instructions) => s.chat.compact(id, { instructions, splitTurns: true }),
      stripToolResults: async (id) => s.chat.stripToolResults(id),
      contextUsage: (id) => s.chat.contextUsage(id),
      setup: (id) => s.chat.setup(id),
      useAgent: async (id, agentId) => s.chat.useAgent(id, agentId),
      approvePlan: (id, mode) => s.chat.approvePlan(id, mode),
      startWorkflow: (id, idea) => s.chat.startWorkflow(id, idea),
      advanceWorkflow: (id) => s.chat.advanceWorkflow(id),
      setWorkflowAutoContinue: async (id, on) => s.chat.setWorkflowAutoContinue(id, on),
      setWorkflowApproveSpec: async (id, on) => s.chat.setWorkflowApproveSpec(id, on),
      stopWorkflow: async (id) => s.chat.stopWorkflow(id)
    },
    agents: {
      activity: async () => s.agents.activity(),
      list: async () => s.agents.list(),
      create: async (input) => s.agents.create(input ?? {}),
      update: async (id, patch) => s.agents.update(id, patch),
      duplicate: async (id) => s.agents.duplicate(id),
      remove: async (id) => s.agents.remove(id),
      setup: (id) => s.chat.agentSetup(id),
      draft: (description, model, thinking) => s.agents.draft(description, model, thinking),
      generate: (input) => s.agents.generate(input),
      rewrite: (instructions, request, model, thinking) => s.agents.rewrite(instructions, request, model, thinking)
    },
    updates: {
      status: async () => s.updates.get(),
      setToken: (token) => s.updates.setToken(token),
      check: () => s.updates.check(),
      download: () => s.updates.download(),
      install: async () => s.updates.install()
    },
    deps: {
      list: () => s.deps.list(),
      refresh: () => s.deps.refresh()
    },
    onboarding: {
      scanFolder: (path) => scanFolder(path),
      languageServers: async (ids) => languageServers(ids, s.lsp.serversDir),
      installLanguageServer: async (id) => {
        const key = serverFor(id)
        // A running copy keeps its files locked (Windows): stop this language's servers first.
        await s.lsp.stopServer(key)
        await installServer(s.lsp.serversDir, key, {
          findOnPath,
          onProgress: (text, fraction) => s.ctx.emit('languageServers', { id, text, fraction })
        })
        return languageServers([id], s.lsp.serversDir)[0]
      },
      removeLanguageServer: async (id) => {
        const key = serverFor(id)
        await s.lsp.stopServer(key)
        await uninstallServer(s.lsp.serversDir, key)
        return languageServers([id], s.lsp.serversDir)[0]
      },
      importSources: () => onboarding.sources(),
      importItems: (sel) => onboarding.importItems(sel),
      bestPractices: (input) => onboarding.bestPractices(input)
    },
    boards: {
      overview: async () => s.boards.overview(),
      connect: (input) => s.boards.connect(input),
      disconnect: () => s.boards.disconnect(),
      selectProject: (id) => s.boards.selectProject(id),
      saveSettings: async (projectId, patch) => s.boards.saveSettings(projectId, patch),
      sync: async () => {
        await s.boards.sync()
        return s.boards.overview()
      },
      createTicket: (input) => s.boards.createTicket(input),
      handToAgents: async (id, agents) => s.boards.handToAgents(id, agents),
      pause: async (id) => s.boards.pause(id),
      resume: async (id) => s.boards.resume(id),
      stopAgents: async (id) => s.boards.stopAgents(id),
      fixChecks: async (id) => s.boards.fixChecks(id),
      createProject: (name) => s.boards.createProject(name),
      renameProject: (id, name) => s.boards.renameProject(id, name),
      deleteProject: (id) => s.boards.deleteProject(id),
      setGoal: (id, goal) => s.boards.setGoal(id, goal),
      applyChanges: (id) => s.boards.applyChanges(id),
      finish: (id) => s.boards.finish(id),
      closeTicket: (id) => s.boards.closeTicket(id),
      deleteTicket: (id) => s.boards.deleteTicket(id),
      links: async () => s.boards.links(),
      linkChatProject: (id) => s.boards.linkChatProject(id),
      unlinkChatProject: async (id) => s.boards.unlinkChatProject(id)
    },
    runs: {
      list: async () => s.runs.list(),
      status: async () => s.runs.status(),
      create: async (input) => s.runs.create(input),
      update: async (id, patch) => s.runs.update(id, patch),
      remove: (id) => s.runs.remove(id),
      start: (id) => s.runs.start(id),
      stop: (id) => s.runs.stop(id),
      logs: async (id) => s.runs.logsOf(id),
      devices: (id) => s.runs.devices(id),
      detect: async () => s.runs.detect(),
      runtimeOptions: () => s.runs.runtimeOptions(),
      downloadRuntime: (id, backend) => s.runs.downloadRuntime(id, backend),
      modelDownloadInfo: () => s.runs.modelDownloadInfo(),
      downloadModel: (id) => s.runs.downloadModel(id),
      cancelDownload: async (id) => s.runs.cancelDownload(id),
      modelMeta: async (id) => s.runs.modelMeta(id),
      hardware: (refresh) => s.runs.hardware(refresh),
      engines: async () => s.runs.engines(),
      checkEngines: () => s.runs.checkEngines(),
      installEngine: (flavour, backend) => s.runs.installEngine(flavour, backend),
      useEngine: async (flavour, backend) => s.runs.useEngine(flavour, backend),
      setEngineAutoCheck: async (on) => s.runs.setEngineAutoCheck(on),
      searchModels: (query) => s.runs.searchModels(query),
      hubFiles: (repo, params) => s.runs.hubFiles(repo, params),
      addHubModel: (input) => s.runs.addHubModel(input)
    },
    containers: {
      status: (force) => s.containers.status(force),
      // Against the chat's folder now: one picked or changed after the copy was made is where changes go.
      changes: async (sessionId) => s.containers.changes(sessionId, s.chat.get(sessionId).workspace),
      apply: async (sessionId, paths) => s.containers.apply(sessionId, paths, s.chat.get(sessionId).workspace),
      discard: async (sessionId, paths) => s.containers.discard(sessionId, paths, s.chat.get(sessionId).workspace),
      reset: (sessionId) => s.containers.reset(sessionId),
      ports: async (sessionId) => s.ports.list(sessionId)
    },
    design: {
      list: async () => s.designs.list(),
      create: async (draft) => s.designs.create(draft ?? {}),
      update: async (id, patch) => s.designs.update(id, patch),
      duplicate: async (id) => s.designs.duplicate(id),
      remove: async (id) => s.designs.remove(id),
      generate: (input) => s.designs.generate(input),
      looks: (input) => s.designs.looks(input),
      projects: (designId) => s.designs.projectSync(designId),
      projectDiff: (designId, projectId, path) => s.designs.projectDiff(designId, projectId, path),
      writeProject: (designId, projectId, paths) => s.designs.writeProject(designId, projectId, paths),
      export: (id, folder) => s.designs.export(id, folder)
    },
    projects: {
      list: async () => s.projects.list(),
      create: async (input) => s.projects.create(input),
      update: async (id, patch) => s.projects.update(id, patch),
      remove: async (id, opts) => s.projects.remove(id, opts ?? {})
    },
    workflows: {
      createAutomation: async (input) => s.workflows.createAutomation(input),
      draftAutomation: (description) => s.workflows.draftAutomation(description),
      saveAutomation: async (id, input) => s.workflows.saveAutomation(id, input),
      watchState: async (id) => s.workflows.watchState(id),
      checkNow: (id) => s.workflows.checkNow(id),
      overview: async () => s.workflows.overview(),
      list: async () => s.workflows.list(),
      get: async (id) => s.workflows.get(id),
      remove: async (id) => s.workflows.remove(id),
      run: async (id, input) => s.workflows.startRun(id, input, 'manual'),
      cancel: async (runId) => s.workflows.cancel(runId),
      runs: async (id) => s.workflows.runs(id),
      validateCron: async (expr) => validateCron(expr),
      exportPreview: (id) => s.exporter.preview(id),
      exportStart: async (input) => s.exporter.start(input),
      exportCancel: async (exportId) => s.exporter.cancel(exportId)
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
      callTool: (id, tool, args) => timedRun(() => s.mcpClients.call(id, tool, args)),
      restart: () => s.mcp.restart(),
      rotateToken: async () => s.mcp.rotateToken(),
      clients: async () => s.mcpClients.status(),
      clientPresets: async () => presetsWithTokens(MCP_PRESETS, readEnvFile()).map((p) => mapClient(p, masker)),
      startClient: (id) => s.mcpClients.start(id),
      stopClient: (id) => s.mcpClients.stop(id),
      signInClient: (id) => s.mcpClients.signIn(id),
      signOutClient: (id) => s.mcpClients.signOut(id),
      externalCalls: async () => s.mcpClients.calls()
    },
    swatches: {
      list: async () => s.swatches.list(),
      content: async (id) => s.swatches.content(id),
      links: async (id) => s.swatches.links(id),
      newLink: async (id) => s.swatches.newLink(id),
      rename: async (id, title) => s.swatches.rename(id, title),
      remove: async (id) => s.swatches.remove(id),
      status: async () => s.swatches.status(),
      saveAs: async (id) => {
        const sw = s.swatches.get(id)
        const win = BrowserWindow.getFocusedWindow()
        const opts = { title: 'Save swatch', defaultPath: swatchFileName(sw) }
        const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
        if (res.canceled || !res.filePath) return false
        await writeFile(res.filePath, s.swatches.content(id))
        return true
      }
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

/** Which agents and automations can call each tool. An agent counts with the folder access it really has. */
async function toolUsers(s: Services): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  const add = (tool: string, who: string) => {
    const list = (out[tool] ??= [])
    if (!list.includes(who)) list.push(who)
  }
  const writes = new Set(['write', 'edit', 'ast_edit'])
  const shells = new Set(['bash', 'powershell'])
  for (const a of s.agents.list()) {
    const setup = await s.chat.agentSetup(a.id).catch(() => null)
    for (const t of setup?.tools ?? []) {
      if (!t.on || (a.fileAccess === 'read' && writes.has(t.name)) || (!a.shell && shells.has(t.name))) continue
      add(t.name, a.name)
    }
  }
  const configs = s.settings.get().mcpClients
  const status = s.mcpClients.status()
  for (const wf of s.workflows.list()) {
    const a = wf.automation
    if (!a) continue
    for (const t of a.tools) add(t, wf.name)
    if (a.collectionIds.length) add('rag_search', wf.name)
    if (a.skills.length) add('skill_use', wf.name)
    for (const sv of a.servers) {
      const config = configs.find((c) => c.id === sv.id)
      if (!config) continue
      for (const n of sv.tools ?? status.find((x) => x.id === sv.id)?.tools.map((t) => t.name) ?? []) add(mcpToolName(config.name, n), wf.name)
    }
  }
  return out
}

/** Run a call and report it the way the Tools page's test panel shows results. */
async function timedRun(fn: () => Promise<string>): Promise<ToolRunResult> {
  const started = Date.now()
  try {
    return { ok: true, output: await fn(), durationMs: Date.now() - started }
  } catch (err) {
    return { ok: false, output: '', error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started }
  }
}
