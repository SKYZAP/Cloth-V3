import { join } from 'node:path'
import { MCP_PRESETS } from './mcp/client'
import { readEnvFile, serversToSeed } from './mcp/homelab'
import { openDb, Kv } from './core/db'
import { newId, type Ctx, type EventChannel, type Secrets } from './core/context'
import { SettingsService } from './core/settings'
import { ProviderService } from './providers/providers'
import { RagService } from './rag/rag'
import { ExamplesService } from './rag/examples'
import { SkillService } from './skills/skills'
import { SkillRegistry } from './skills/registry'
import { AgentRuntime, ChatService } from './agent/chat'
import { ProjectService } from './agent/projects'
import { AgentService } from './agent/agents'
import { SkillInsights } from './skills/insights'
import { DesignService } from './design/designs'
import { ContainerService, dockerCli, type DockerRun } from './agent/containers'
import { PortService, dockerSpawn, type DockerSpawn } from './agent/ports'
import { PanelService } from './panel/panel'
import { McpClientService } from './mcp/client'
import { TerminalService, type PtySpawn } from './panel/terminals'
import { ApprovalService, CheckpointStore } from './agent/workspace'
import { LspManager } from './agent/lsp'
import { globalRulesDir } from './agent/rules'
import { BUILTIN_NAMES } from './agent/tools'
import { CustomToolService } from './tools/custom'
import { WebService } from './web/web'
import { WorkflowService } from './workflows/workflows'
import { McpHost } from './mcp/server'
import { DashboardService } from './dashboard'
import { ImageService } from './images'
import { RemoteHost } from './remote/server'
import { FlowExporter, type ExportToolchain } from './export/exporter'
import { existsSync, mkdirSync } from 'node:fs'
import { RunService, type RunDeps } from './run/run'

export interface Services {
  ctx: Ctx
  settings: SettingsService
  providers: ProviderService
  rag: RagService
  examples: ExamplesService
  skills: SkillService
  skillInsights: SkillInsights
  registry: SkillRegistry
  web: WebService
  custom: CustomToolService
  runtime: AgentRuntime
  chat: ChatService
  agents: AgentService
  projects: ProjectService
  containers: ContainerService
  ports: PortService
  mcpClients: McpClientService
  panel: PanelService
  designs: DesignService
  workflows: WorkflowService
  mcp: McpHost
  dashboard: DashboardService
  lsp: LspManager
  images: ImageService
  remote: RemoteHost
  exporter: FlowExporter
  runs: RunService
  approvals: ApprovalService
}

export function createServices(opts: {
  dataDir: string
  secrets: Secrets
  emit?: (channel: EventChannel, payload: unknown) => void
  dbFile?: string
  /** Where bundled sidecars live (resources/ in a packaged build, ./sidecars in dev). */
  sidecarsDir?: string
  examplesDir?: string
  /** Flow app export: runner template, NSIS and icon locations (defaults: nothing available). */
  exportToolchain?: Partial<ExportToolchain>
  /** How the docker CLI is run (tests pass a stand-in). */
  docker?: DockerRun
  /** How `docker exec -i` streams are started for port forwarding (tests pass a stand-in). */
  dockerSpawn?: DockerSpawn
  /** How local model runners spawn, fetch and probe (tests pass stand-ins). */
  run?: Partial<RunDeps>
  /** How the side panel's terminals start their shells (tests pass a stand-in). */
  pty?: PtySpawn
  /** Turn leftover graph flows into automations at startup (default true; an exported app's runner keeps its graph). */
  convertFlows?: boolean
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
  const runs = new RunService(ctx, providers, opts.run)
  const web = new WebService(ctx, settings)
  const rag = new RagService(ctx, providers, settings, () => (web.obscura.path() ? (url, signal) => web.obscura.renderHtml(url, signal) : null))
  const examples = new ExamplesService(ctx, rag, settings)
  const skills = new SkillService(ctx, providers)
  const skillInsights = new SkillInsights(ctx, skills, providers)
  const registry = new SkillRegistry(ctx, skills, undefined, () => settings.get().webCaCertPath)
  const custom = new CustomToolService(ctx, providers, settings, () => BUILTIN_NAMES)
  const approvals = new ApprovalService((e) => ctx.emit('chat', e))
  const checkpoints = new CheckpointStore(join(opts.dataDir, 'checkpoints'))
  const lsp = new LspManager()
  const rulesDir = globalRulesDir(opts.dataDir)
  mkdirSync(rulesDir, { recursive: true })
  const images = new ImageService(ctx, providers, settings)
  const mcpClients = new McpClientService(ctx, settings, approvals)
  const agents = new AgentService(ctx, providers, settings)
  const runtime = new AgentRuntime(providers, rag, skills, web, custom, { approvals, checkpoints, lsp, rulesDir, images, settings, mcp: mcpClients, agents })
  const designs = new DesignService(ctx, providers)
  const projects: ProjectService = new ProjectService(ctx, () => chat, designs, () => settings.get().defaultDesignId)
  const containers = new ContainerService(ctx, opts.docker)
  const ports = new PortService(ctx, opts.docker ?? dockerCli(), opts.dockerSpawn ?? dockerSpawn())
  // A stand-in docker without a stand-in spawn (tests): no port forwarding.
  if (!opts.docker || opts.dockerSpawn) containers.watcher = ports
  const chat = new ChatService(ctx, runtime, settings, skills, providers.usage, approvals, checkpoints, projects, containers, agents)
  const panel = new PanelService(chat, providers, new TerminalService(ctx, containers, opts.pty), containers)
  const workflows = new WorkflowService(ctx, { providers, rag, skills, runtime, settings, web, custom, agents, containers })
  const mcp = new McpHost(ctx, settings, { rag, skills, web, custom, usage: providers.usage })
  const remote = new RemoteHost(ctx, settings)
  const tc = opts.exportToolchain ?? {}
  const exporter = new FlowExporter(
    ctx,
    { workflows, custom, skills, rag },
    {
      runnerDir: tc.runnerDir ?? (() => null),
      nsisDir: tc.nsisDir ?? (() => null),
      obscuraDir: tc.obscuraDir ?? (() => (existsSync(join(ctx.sidecarsDir, 'obscura')) ? join(ctx.sidecarsDir, 'obscura') : null)),
      iconPng: tc.iconPng ?? (async () => null),
      defaultOutputDir: tc.defaultOutputDir,
      clothVersion: tc.clothVersion ?? '0.0.0'
    }
  )

  settings.onChange((next, prev) => {
    if (next.mcpEnabled !== prev.mcpEnabled || next.mcpPort !== prev.mcpPort) void mcp.restart()
    if (next.remoteEnabled !== prev.remoteEnabled || next.remotePort !== prev.remotePort) void remote.restart()
    if (next.webEngine !== prev.webEngine || next.searxngUrl !== prev.searxngUrl || next.obscuraPath !== prev.obscuraPath || next.webCaCertPath !== prev.webCaCertPath) {
      void web.searxng.stop()
      web.warm()
      ctx.emit('web', { type: 'status' })
    }
  })

  // An automation that reports in a chat gets one you can reply to: its run, then what it reported.
  // Every such chat is filed under the Automation project; the automation's folder stays its workspace.
  workflows.deliver = async (wf, report) => {
    const a = wf.automation
    const container = a?.commands?.mode === 'container' ? { image: a.commands.image, network: a.commands.network } : null
    const projectId = projects.automationProject().id
    return chat.fromTranscript({ id: report.id, title: report.title, workspace: wf.workspace, agentId: a?.agentId ?? null, messages: report.messages, container, projectId, origin: { kind: 'automation', workflowId: wf.id } }).id
  }

  // Auto now never asks: chats (and defaults) saved as Auto move to Manual, which asks before risky actions as Auto did. Once.
  const toManual = chat.migrateAutoToManual()
  if (toManual) ctx.log('permissions', `Moved ${toManual} chat${toManual === 1 ? '' : 's'} from Auto to Manual`)

  // The homelab servers (deploy control, the notes vault, Penpot) are set up for you when their
  // tokens are in ~/.homelab/env: each once, so one you remove stays removed.
  seedHomelabServers(ctx, settings)

  // Chats automations made before the Automation project existed move into it, once.
  const moved = projects.migrateAutomationChats(workflows.reportedChatIds())
  if (moved) ctx.log('automation', `Filed ${moved} automation chat${moved === 1 ? '' : 's'} under the Automation project`)

  // Only automations remain: any graph flow left over becomes one (backed up first). Idempotent, so every startup.
  if (opts.convertFlows !== false) {
    const converted = workflows.convertFlows()
    if (converted.length) ctx.log('automation', `Converted ${converted.length} flow${converted.length === 1 ? '' : 's'} into automations`)
  }

  const dashboard = new DashboardService(ctx, { usage: providers.usage, providers, rag, skills, custom, workflows, chat })

  return { ctx, settings, providers, rag, examples, skills, skillInsights, registry, web, custom, runtime, chat, agents, projects, containers, ports, panel, mcpClients, designs, workflows, mcp, dashboard, lsp, images, remote, exporter, runs, approvals }
}

const SEEDED_KEY = 'mcp.homelabSeeded'

/** Adds the homelab MCP servers whose tokens are on file and that haven't been added before. */
function seedHomelabServers(ctx: Ctx, settings: SettingsService): void {
  const cur = settings.get().mcpClients
  const seeded = ctx.kv.get<string[]>(SEEDED_KEY, [])
  const add = serversToSeed(MCP_PRESETS, readEnvFile(), cur.map((c) => c.name), seeded)
  if (!add.length) return
  settings.update({ mcpClients: [...cur, ...add.map((c) => ({ ...c, id: newId('mcs_') }))] })
  ctx.kv.set(SEEDED_KEY, [...seeded, ...add.map((c) => c.name)])
  ctx.log('mcp', `Set up ${add.map((c) => c.name).join(', ')} from ~/.homelab/env`)
}
