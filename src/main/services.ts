import { join } from 'node:path'
import { openDb, Kv } from './core/db'
import type { Ctx, EventChannel, Secrets } from './core/context'
import { SettingsService } from './core/settings'
import { ProviderService } from './providers/providers'
import { RagService } from './rag/rag'
import { ExamplesService } from './rag/examples'
import { SkillService } from './skills/skills'
import { SkillRegistry } from './skills/registry'
import { AgentRuntime, ChatService } from './agent/chat'
import { ApprovalService, CheckpointStore } from './agent/workspace'
import { LspManager } from './agent/lsp'
import { BUILTIN_NAMES } from './agent/tools'
import { CustomToolService } from './tools/custom'
import { WebService } from './web/web'
import { WorkflowService } from './workflows/workflows'
import { McpHost } from './mcp/server'
import { DashboardService } from './dashboard'
import { ImageService } from './images'
import { RemoteHost } from './remote/server'

export interface Services {
  ctx: Ctx
  settings: SettingsService
  providers: ProviderService
  rag: RagService
  examples: ExamplesService
  skills: SkillService
  registry: SkillRegistry
  web: WebService
  custom: CustomToolService
  runtime: AgentRuntime
  chat: ChatService
  workflows: WorkflowService
  mcp: McpHost
  dashboard: DashboardService
  lsp: LspManager
  images: ImageService
  remote: RemoteHost
}

export function createServices(opts: {
  dataDir: string
  secrets: Secrets
  emit?: (channel: EventChannel, payload: unknown) => void
  dbFile?: string
  /** Where bundled sidecars live (resources/ in a packaged build, ./sidecars in dev). */
  sidecarsDir?: string
  examplesDir?: string
}): Services {
  const db = openDb(opts.dbFile ?? join(opts.dataDir, 'cloth.db'))
  const ctx: Ctx = {
    db,
    kv: new Kv(db),
    dataDir: opts.dataDir,
    skillsDir: join(opts.dataDir, 'skills'),
    sidecarsDir: opts.sidecarsDir ?? join(opts.dataDir, 'sidecars'),
    examplesDir: opts.examplesDir ?? join(opts.dataDir, 'examples'),
    secrets: opts.secrets,
    emit: opts.emit ?? (() => {}),
    log: (scope, ...args) => console.log(`[${scope}]`, ...args)
  }
  const settings = new SettingsService(ctx)
  const providers = new ProviderService(ctx)
  const web = new WebService(ctx, settings)
  const rag = new RagService(ctx, providers, settings, () => (web.obscura.path() ? (url, signal) => web.obscura.renderHtml(url, signal) : null))
  const examples = new ExamplesService(ctx, rag, settings)
  const skills = new SkillService(ctx, providers)
  const registry = new SkillRegistry(ctx, skills, undefined, () => settings.get().webCaCertPath)
  const custom = new CustomToolService(ctx, providers, settings, () => BUILTIN_NAMES)
  const approvals = new ApprovalService((e) => ctx.emit('chat', e))
  const checkpoints = new CheckpointStore(join(opts.dataDir, 'checkpoints'))
  const lsp = new LspManager()
  const images = new ImageService(ctx, providers, settings)
  const runtime = new AgentRuntime(providers, rag, skills, web, custom, { approvals, checkpoints, lsp, images, settings })
  const chat = new ChatService(ctx, runtime, settings, skills, providers.usage, approvals, checkpoints)
  const workflows = new WorkflowService(ctx, { providers, rag, skills, runtime, settings, web, custom })
  const mcp = new McpHost(ctx, settings, { rag, skills, web, custom, usage: providers.usage })
  const remote = new RemoteHost(ctx, settings)

  settings.onChange((next, prev) => {
    if (next.mcpEnabled !== prev.mcpEnabled || next.mcpPort !== prev.mcpPort) void mcp.restart()
    if (next.remoteEnabled !== prev.remoteEnabled || next.remotePort !== prev.remotePort) void remote.restart()
    if (next.webEngine !== prev.webEngine || next.searxngUrl !== prev.searxngUrl || next.obscuraPath !== prev.obscuraPath || next.webCaCertPath !== prev.webCaCertPath) {
      void web.searxng.stop()
      web.warm()
      ctx.emit('web', { type: 'status' })
    }
  })

  const dashboard = new DashboardService(ctx, { usage: providers.usage, providers, rag, skills, custom, workflows, chat })

  return { ctx, settings, providers, rag, examples, skills, registry, web, custom, runtime, chat, workflows, mcp, dashboard, lsp, images, remote }
}
