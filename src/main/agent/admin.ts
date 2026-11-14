// What a chat's agent can do with Cloth itself: read other chats, and set up agents, automations,
// MCP servers and model providers the way the app's own pages do. Built once the services exist
// (services.ts) and handed to the runtime, so tools.ts stays free of the services graph.

import type { AgentInput, ChatSession, McpClientConfig, ProviderKind, UiMessage } from '@shared/types'
import { newId } from '../core/context'
import type { SettingsService } from '../core/settings'
import type { ProviderService } from '../providers/providers'
import type { WorkflowService } from '../workflows/workflows'
import type { AgentService } from './agents'
import type { ChatService } from './chat'
import type { ProjectService } from './projects'

export interface HubAdmin {
  /** Chats, newest first, matching a query on their title or last line. `self` is marked "(this chat)", or left out with `hideSelf`. */
  listChats(query: string, limit: number, self: string | null, hideSelf?: boolean): string
  /** One chat's conversation as plain text: messages, what tools were called, from `from` (0 = first message). */
  readChat(id: string, from: number, limit: number, tools: boolean): string
  createAgent(input: AgentInput): string
  createAutomation(input: { description: string; name?: string; cron?: string | null; workspace?: string | null }): Promise<string>
  addMcpServer(input: { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; approval?: 'ask' | 'auto'; defaultOn?: boolean }): string
  addProvider(input: { name: string; kind: ProviderKind; baseUrl: string; apiKey?: string }): Promise<string>
}

const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** One message as plain text: its words, and (optionally) a line per tool call. */
function messageText(m: UiMessage, tools: boolean): string {
  const parts: string[] = []
  for (const b of m.blocks) {
    if (b.type === 'text' && b.text.trim()) parts.push(b.text.trim())
    else if (b.type === 'tool' && tools) {
      const args = clip(JSON.stringify(b.trace.args ?? {}), 160)
      parts.push(`[tool ${b.trace.name} ${args} → ${b.trace.status}]`)
    }
  }
  if (m.attachments?.length) parts.push(`[attached: ${m.attachments.map((a) => (a.kind === 'file' ? a.name : 'an image')).join(', ')}]`)
  return parts.join('\n')
}

export function buildHubAdmin(s: { chat: ChatService; projects: ProjectService; agents: AgentService; workflows: WorkflowService; settings: SettingsService; providers: ProviderService }): HubAdmin {
  const projectName = (c: ChatSession) => (c.projectId ? (s.projects.list().find((p) => p.id === c.projectId)?.name ?? null) : null)
  return {
    listChats(query, limit, self, hideSelf) {
      const q = query.trim().toLowerCase()
      const chats = s.chat.list().filter((c) => !(hideSelf && c.id === self)).filter((c) => !q || c.title.toLowerCase().includes(q) || (c.preview ?? '').toLowerCase().includes(q) || (projectName(c) ?? '').toLowerCase().includes(q))
      if (!chats.length) return q ? `No chats match "${query}".` : 'There are no chats yet.'
      const shown = chats.slice(0, Math.max(1, Math.min(limit, 100)))
      const lines = shown.map((c) => {
        const project = projectName(c)
        return `- ${c.id}${c.id === self ? ' (this chat)' : ''}${c.archivedAt ? ' (archived)' : ''} · ${c.title}${project ? ` · project ${project}` : ''} · updated ${when(c.updatedAt)}${c.preview ? `\n  ${clip(c.preview.replace(/\s+/g, ' '), 140)}` : ''}`
      })
      return `${chats.length} chat${chats.length === 1 ? '' : 's'}${chats.length > shown.length ? `, showing the newest ${shown.length}` : ''}. Read one with session_read and its id.\n${lines.join('\n')}`
    },
    readChat(id, from, limit, tools) {
      const chat = s.chat.list().find((c) => c.id === id)
      if (!chat) throw new Error(`No chat has the id ${id}. List chats with session_list to find it.`)
      const messages = s.chat.messages(id)
      const start = Math.max(0, from)
      const slice = messages.slice(start, start + Math.max(1, Math.min(limit, 200)))
      const body = slice.map((m, i) => `### ${start + i} · ${m.role === 'user' ? 'User' : `Assistant${m.model ? ` (${m.model})` : ''}`} · ${when(m.createdAt)}${m.archived ? ' · summarised away' : ''}\n${messageText(m, tools) || '(no text)'}`)
      const more = start + slice.length < messages.length ? `\n\n${messages.length - start - slice.length} more message(s): call session_read again with from ${start + slice.length}.` : ''
      const project = projectName(chat)
      return `# ${chat.title}\nid ${chat.id}${project ? ` · project ${project}` : ''}${chat.workspace ? ` · folder ${chat.workspace}` : ''} · ${messages.length} messages\n\n${body.join('\n\n') || 'No messages in that range.'}${more}`
    },
    createAgent(input) {
      if (!input.name?.trim()) throw new Error('Give the agent a name')
      if (s.agents.list().some((a) => a.name.toLowerCase() === input.name!.trim().toLowerCase())) throw new Error(`An agent called "${input.name}" already exists`)
      const a = s.agents.create({ ...input, name: input.name.trim() })
      return `Created the agent "${a.name}" (${a.id}). It is on the Agents page, can be picked in any chat's Setup, and other agents can hand it work with task.`
    },
    async createAutomation(input) {
      if (!input.description.trim()) throw new Error('Describe what the automation should do')
      const draft = await s.workflows.draftAutomation(input.description)
      const cron = input.cron === undefined ? draft.cron : input.cron
      const wf = s.workflows.createAutomation({ name: input.name?.trim() || draft.name, automation: draft.automation, cron, cronEnabled: !!cron, workspace: input.workspace === undefined ? draft.workspace : input.workspace })
      return `Created the automation "${wf.name}" (${wf.id})${cron ? `, scheduled ${cron} (local time)` : ', run by hand or on changes'}. It uses: ${[...draft.automation.tools, ...draft.automation.skills.map((k) => `skill ${k}`)].join(', ') || 'no extra tools'}. It is on the Automations page, where it can be run or edited.`
    },
    addMcpServer(input) {
      const name = input.name.trim()
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error('Use a short name of letters, digits, - or _ (it prefixes the server’s tools)')
      const clients = s.settings.get().mcpClients
      if (clients.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error(`A server called "${name}" is already set up`)
      let config: McpClientConfig
      if (input.transport === 'http') {
        if (!input.url || !/^https?:\/\//.test(input.url)) throw new Error('An http server needs its address (http:// or https://)')
        config = { id: newId('mcp_'), name, transport: 'http', url: input.url, headers: input.headers ?? {}, command: '', args: [], env: {}, enabled: true, defaultOn: input.defaultOn ?? false, approval: input.approval ?? 'ask' }
      } else {
        if (!input.command?.trim()) throw new Error('A stdio server needs the program to start (e.g. npx)')
        config = { id: newId('mcp_'), name, transport: 'stdio', command: input.command.trim(), args: input.args ?? [], env: input.env ?? {}, enabled: true, defaultOn: input.defaultOn ?? false, approval: input.approval ?? 'ask' }
      }
      s.settings.update({ mcpClients: [...clients, config] })
      return `Added the MCP server "${name}" (${config.transport}${config.transport === 'http' ? ` at ${config.url}` : `: ${[config.command, ...config.args].join(' ')}`}). It starts when a chat uses it; ${config.defaultOn ? 'it is on for chats that haven’t picked their servers' : 'switch it on in a chat’s Setup → MCP'}. Calls ${config.approval === 'ask' ? 'ask first' : 'run without asking'}.`
    },
    async addProvider(input) {
      if (!input.name.trim() || !/^https?:\/\//.test(input.baseUrl)) throw new Error('A provider needs a name and its base URL (http:// or https://)')
      if (s.providers.list().some((p) => p.name.toLowerCase() === input.name.trim().toLowerCase())) throw new Error(`A provider called "${input.name}" already exists`)
      const p = s.providers.create({ name: input.name.trim(), kind: input.kind, baseUrl: input.baseUrl, ...(input.apiKey ? { apiKey: input.apiKey } : {}) })
      const listed = await s.providers.refreshModels(p.id).then(
        (r) => `It lists ${r.models.length} model${r.models.length === 1 ? '' : 's'}${r.models.length ? `: ${r.models.slice(0, 8).map((m) => m.id).join(', ')}${r.models.length > 8 ? '…' : ''}` : ''}.`,
        (err: unknown) => `Listing its models failed (${err instanceof Error ? err.message : String(err)}); check the address${input.apiKey ? '' : ' and add its API key'} on the Models page.`
      )
      return `Added the provider "${p.name}" (${p.id}). ${listed}${input.apiKey ? '' : ' No API key was set: add one on the Models page if it needs one.'}`
    }
  }
}
