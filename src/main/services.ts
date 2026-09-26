import { join } from 'node:path'
import { openDb, Kv } from './core/db'
import type { Ctx, EventChannel, Secrets } from './core/context'
import { SettingsService } from './core/settings'
import { ProviderService } from './providers/providers'
import { RagService } from './rag/rag'
import { SkillService } from './skills/skills'
import { AgentRuntime, ChatService } from './agent/chat'
import { WorkflowService } from './workflows/workflows'
import { McpHost } from './mcp/server'

export interface Services {
  ctx: Ctx
  settings: SettingsService
  providers: ProviderService
  rag: RagService
  skills: SkillService
  runtime: AgentRuntime
  chat: ChatService
  workflows: WorkflowService
  mcp: McpHost
}

export function createServices(opts: {
  dataDir: string
  secrets: Secrets
  emit?: (channel: EventChannel, payload: unknown) => void
  dbFile?: string
}): Services {
  const db = openDb(opts.dbFile ?? join(opts.dataDir, 'cloth.db'))
  const ctx: Ctx = {
    db,
    kv: new Kv(db),
    dataDir: opts.dataDir,
    skillsDir: join(opts.dataDir, 'skills'),
    secrets: opts.secrets,
    emit: opts.emit ?? (() => {}),
    log: (scope, ...args) => console.log(`[${scope}]`, ...args)
  }
  const settings = new SettingsService(ctx)
  const providers = new ProviderService(ctx)
  const rag = new RagService(ctx, providers, settings)
  const skills = new SkillService(ctx, providers)
  const runtime = new AgentRuntime(providers, rag, skills)
  const chat = new ChatService(ctx, runtime, settings)
  const workflows = new WorkflowService(ctx, { providers, rag, skills, runtime, settings })
  const mcp = new McpHost(ctx, settings, { rag, skills })

  settings.onChange((next, prev) => {
    if (next.mcpEnabled !== prev.mcpEnabled || next.mcpPort !== prev.mcpPort) void mcp.restart()
  })

  return { ctx, settings, providers, rag, skills, runtime, chat, workflows, mcp }
}
