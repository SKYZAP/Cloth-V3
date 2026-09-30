import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowNode } from '@shared/types'
import {
  BUNDLE_FILES,
  BUNDLE_FORMAT,
  type BundledCollection,
  type BundledTool,
  type ExportEvent,
  type ExportInput,
  type ExportPreview,
  type FlowBundleGraph,
  type FlowBundleManifest
} from '@shared/flow-bundle'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { WorkflowService } from '../workflows/workflows'
import type { CustomToolService } from '../tools/custom'
import type { SkillService } from '../skills/skills'
import { slugify } from '../skills/skills'
import type { RagService } from '../rag/rag'
import { planExport } from './plan'
import { installerScript, pngToIco, safeFileName } from './nsis'

/** The runner template's executable (renamed to the app's name on export). */
export const RUNNER_EXE = 'FlowRunner.exe'

export interface ExportToolchain {
  /** Prebuilt Flow Runner (win-unpacked) folder. */
  runnerDir(): string | null
  /** NSIS folder containing makensis.exe. */
  nsisDir(): string | null
  /** Obscura sidecar folder. */
  obscuraDir(): string | null
  /** 256×256 PNG for the installer icon. */
  iconPng(): Promise<Buffer | null>
  /** Where installers go unless the user picks another folder. */
  defaultOutputDir?(): string
  clothVersion: string
}

class Cancelled extends Error {}

/** An export event without the fields every event gets (distributes over the union). */
type EventBody = ExportEvent extends infer E ? (E extends ExportEvent ? Omit<E, 'exportId' | 'at'> : never) : never

/** Packages a flow as a standalone Windows app: the prebuilt runner + a bundle of the flow and what it uses. */
export class FlowExporter {
  private active = new Map<string, AbortController>()

  constructor(
    private ctx: Ctx,
    private deps: { workflows: WorkflowService; custom: CustomToolService; skills: SkillService; rag: RagService },
    private toolchain: ExportToolchain
  ) {}

  async preview(workflowId: string): Promise<ExportPreview> {
    const wf = this.deps.workflows.get(workflowId)
    const plan = planExport(wf, { tools: this.deps.custom.list(), skills: await this.deps.skills.list(), collections: this.deps.rag.listCollections() })
    const missing: string[] = []
    if (process.platform !== 'win32') missing.push('Exporting apps is available on Windows for now')
    if (!this.toolchain.runnerDir()) missing.push('The Flow Runner template is not built — run `npm run build:runner`')
    if (!this.toolchain.nsisDir()) missing.push('The installer builder (NSIS) is missing — run `npm run build:runner`')
    if (plan.web && !this.toolchain.obscuraDir()) missing.push('The flow uses the web, but Obscura is not bundled — run `npm run sidecars`')
    return { plan, missing, defaultOutputDir: this.toolchain.defaultOutputDir?.() ?? join(homedir(), 'Downloads') }
  }

  /** Start an export; progress arrives as 'export' events. Returns the export id. */
  start(input: ExportInput): string {
    const id = newId('exp_')
    const controller = new AbortController()
    this.active.set(id, controller)
    void this.run(id, input, controller.signal).finally(() => this.active.delete(id))
    return id
  }

  cancel(id: string): void {
    this.active.get(id)?.abort()
  }

  /** Run an export to completion (tests, and start()). Resolves with the output path. */
  async run(id: string, input: ExportInput, signal: AbortSignal = new AbortController().signal): Promise<string> {
    const started = Date.now()
    const emit = (e: EventBody) => this.ctx.emit('export', { ...e, exportId: id, at: Date.now() } as ExportEvent)
    const log = (message: string, level: 'info' | 'warn' | 'error' = 'info') => emit({ type: 'log', level, message })
    const format = input.format ?? 'installer'
    const titles = ['Check the flow', 'Copy the app template', 'Bundle the flow, tools, skills and knowledge', 'Add the web browser (Obscura)', 'Name the app', format === 'installer' ? 'Build the installer' : 'Move the app into place']
    let step = 0
    const next = () => {
      if (signal.aborted) throw new Cancelled()
      emit({ type: 'step', step: ++step, steps: titles.length, title: titles[step - 1] })
    }
    const work = join(tmpdir(), `cloth-export-${id}`)
    // Inside Electron, fs treats *.asar files as folders; the runner's app.asar must be copied as a plain file.
    const proc = process as NodeJS.Process & { noAsar?: boolean }
    const noAsar = proc.noAsar
    proc.noAsar = true
    try {
      // 1 — what the flow needs
      next()
      const wf = this.deps.workflows.get(input.workflowId)
      const name = input.name.trim() || wf.name
      const version = /^\d+(\.\d+){0,3}$/.test(input.version.trim()) ? input.version.trim() : '1.0.0'
      const preview = await this.preview(wf.id)
      const { plan } = preview
      log(`${wf.nodes.length} nodes · ${plan.tools.length} tool${plan.tools.length === 1 ? '' : 's'} · ${plan.skills.length} skill${plan.skills.length === 1 ? '' : 's'} · ${plan.collections.length} knowledge collection${plan.collections.length === 1 ? '' : 's'} · web ${plan.web ? 'yes' : 'no'}`)
      if (plan.tools.length) log(`Tools: ${plan.tools.join(', ')}`)
      if (plan.skills.length) log(`Skills: ${plan.skills.join(', ')}`)
      for (const w of plan.warnings) log(w, 'warn')
      // A folder export needs no installer builder, and isn't tied to Windows.
      const toolchainGaps = format === 'folder' ? preview.missing.filter((m) => !/NSIS|available on Windows/.test(m)) : preview.missing
      if (plan.errors.length || toolchainGaps.length) {
        for (const e of [...plan.errors, ...toolchainGaps]) log(e, 'error')
        throw new Error(plan.errors[0] ?? toolchainGaps[0])
      }

      // 2 — the runner template
      next()
      const app = join(work, 'app')
      await rm(work, { recursive: true, force: true })
      await mkdir(work, { recursive: true })
      const runner = this.toolchain.runnerDir()!
      log(`Copying ${runner}`)
      await cp(runner, app, { recursive: true })
      log(`App template copied (${mb(await folderSize(app))})`)

      // 3 — the bundle
      next()
      const bundle = join(app, 'resources', 'bundle')
      await mkdir(bundle, { recursive: true })
      const manifest: FlowBundleManifest = {
        format: BUNDLE_FORMAT,
        name,
        appId: `cloth.flow.${slugify(name) || 'app'}`,
        description: input.description.trim() || wf.description,
        version,
        model: input.model?.trim() || null,
        web: plan.web,
        exportedAt: Date.now(),
        clothVersion: this.toolchain.clothVersion
      }
      const graph: FlowBundleGraph = { name: wf.name, description: wf.description, nodes: wf.nodes.map(portableNode), edges: wf.edges }
      const tools: BundledTool[] = plan.tools.map((n) => {
        const t = this.deps.custom.findByName(n)!
        const config = t.kind === 'prompt' ? { ...t.config, model: null } : t.config
        return { name: t.name, description: t.description, kind: t.kind, params: t.params, config, enabled: true }
      })
      await writeFile(join(bundle, BUNDLE_FILES.manifest), JSON.stringify(manifest, null, 2))
      await writeFile(join(bundle, BUNDLE_FILES.flow), JSON.stringify(graph, null, 2))
      await writeFile(join(bundle, BUNDLE_FILES.tools), JSON.stringify(tools, null, 2))
      log(`Flow "${wf.name}" and ${tools.length} tool${tools.length === 1 ? '' : 's'} written`)
      for (const s of plan.skills) {
        const skill = await this.deps.skills.get(s)
        await cp(skill.dir, join(bundle, BUNDLE_FILES.skills, s), { recursive: true, filter: (src) => !src.endsWith('.source.json') })
        log(`Skill ${s} (${skill.files.length} file${skill.files.length === 1 ? '' : 's'})`)
      }
      for (const colId of plan.collections) {
        const snapshot = this.deps.rag.snapshot(colId)
        const file: BundledCollection = { id: colId, snapshot }
        await mkdir(join(bundle, BUNDLE_FILES.knowledge), { recursive: true })
        await writeFile(join(bundle, BUNDLE_FILES.knowledge, `${colId}.json`), JSON.stringify(file))
        const chunks = snapshot.documents.reduce((n, d) => n + d.chunks.length, 0)
        log(`Knowledge "${snapshot.name}": ${snapshot.documents.length} documents, ${chunks} chunks (keyword search in the app)`)
      }

      // 4 — Obscura
      next()
      if (plan.web) {
        const obscura = this.toolchain.obscuraDir()!
        await cp(obscura, join(app, 'resources', 'obscura'), { recursive: true })
        log(`Obscura added (${mb(await folderSize(join(app, 'resources', 'obscura')))})`)
      } else log('Not needed: the flow does not use the web')

      // 5 — the app's name
      next()
      const exe = `${safeFileName(name)}.exe`
      if (existsSync(join(app, RUNNER_EXE))) await rename(join(app, RUNNER_EXE), join(app, exe))
      log(`${exe} · id ${manifest.appId} · version ${version}`)

      // 6 — installer (or folder)
      next()
      await mkdir(input.outputDir, { recursive: true })
      let out: string
      if (format === 'folder') {
        out = join(input.outputDir, safeFileName(name))
        await rm(out, { recursive: true, force: true })
        await cp(app, out, { recursive: true })
      } else {
        out = join(input.outputDir, `${safeFileName(name)} Setup ${version}.exe`)
        const icon = join(work, 'icon.ico')
        const png = await this.toolchain.iconPng()
        if (png) await writeFile(icon, pngToIco(png, 256))
        const script = join(work, 'installer.nsi')
        const nsisDir = this.toolchain.nsisDir()!
        await writeFile(
          script,
          '﻿' +
            installerScript({
              name,
              appId: manifest.appId,
              version,
              description: manifest.description,
              sourceDir: app,
              exe,
              icon: png ? icon : join(nsisDir, 'Contrib', 'Graphics', 'Icons', 'modern-install.ico'),
              outFile: out
            })
        )
        log(`Compressing ${mb(await folderSize(app))} into the installer — this usually takes a minute or two`)
        await this.makensis(nsisDir, script, signal, log)
      }
      const bytes = (await stat(out)).isDirectory() ? await folderSize(out) : (await stat(out)).size
      log(`${format === 'installer' ? 'Installer' : 'App'} ready: ${out} (${mb(bytes)})`)
      emit({ type: 'done', file: out, bytes, durationMs: Date.now() - started })
      return out
    } catch (err) {
      const cancelled = err instanceof Cancelled || signal.aborted
      const message = cancelled ? 'Export cancelled' : errorMessage(err)
      if (!cancelled && !/^The flow uses|is disabled|no longer exists|has no tool|has no skill|not built|missing|not bundled/.test(message)) log(message, 'error')
      emit({ type: 'failed', message, cancelled })
      throw err instanceof Cancelled ? new Error(message) : err
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
      proc.noAsar = noAsar
    }
  }

  /** Run makensis, streaming its warnings/errors into the log, with a heartbeat while it compresses. */
  private makensis(nsisDir: string, script: string, signal: AbortSignal, log: (m: string, level?: 'info' | 'warn' | 'error') => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const exe = existsSync(join(nsisDir, 'Bin', 'makensis.exe')) ? join(nsisDir, 'Bin', 'makensis.exe') : join(nsisDir, 'makensis.exe')
      const child = spawn(exe, ['/V2', '/INPUTCHARSET', 'UTF8', script], { windowsHide: true, env: { ...process.env, NSISDIR: nsisDir } })
      const started = Date.now()
      const heartbeat = setInterval(() => log(`Still compressing… ${Math.round((Date.now() - started) / 1000)}s`), 15_000)
      const lines = (buf: Buffer, level: 'info' | 'warn' | 'error') => {
        for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) log(`makensis: ${line.trim()}`, /error/i.test(line) ? 'error' : level)
      }
      child.stdout.on('data', (b: Buffer) => lines(b, 'info'))
      child.stderr.on('data', (b: Buffer) => lines(b, 'warn'))
      const onAbort = () => child.kill()
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (err) => {
        clearInterval(heartbeat)
        reject(err)
      })
      child.on('close', (code) => {
        clearInterval(heartbeat)
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(new Cancelled())
        else if (code === 0) resolve()
        else reject(new Error(`The installer build failed (makensis exited with ${code})`))
      })
    })
  }
}

/** Nodes as the exported app sees them: every model is the app's OpenAI model; own folders don't travel. */
function portableNode(n: WorkflowNode): WorkflowNode {
  const { model: _model, ...data } = n.data
  if (n.type === 'agent') delete data.workspace
  return { ...n, data: { ...data, key: n.data.key } }
}

async function folderSize(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += (await stat(join(e.parentPath, e.name))).size
  }
  return total
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
