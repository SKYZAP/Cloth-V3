import { Agent, type AgentMessage } from '@mariozechner/pi-agent-core'
import type { AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai'
import type { ChatEvent, ChatSession, ModelRef, ThinkingLevel, ToolTrace, UiBlock, UiMessage } from '@shared/types'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import type { SettingsService } from '../core/settings'
import type { RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import { buildTools, type ToolDetails, type ToolScope } from './tools'

type SessionConfig = Omit<ChatSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>

interface SessionRow {
  id: string
  title: string
  config: string
  messages: string
  created_at: number
  updated_at: number
}

const DEFAULT_CONFIG: SessionConfig = {
  model: null,
  systemPrompt: '',
  collectionIds: [],
  skillsEnabled: true,
  workspace: null,
  thinking: 'off'
}

export interface AgentRunOptions {
  model: ModelRef
  prompt: string
  systemPrompt?: string
  scope: ToolScope
  thinking?: ThinkingLevel
  history?: AgentMessage[]
  signal?: AbortSignal
  maxTurns?: number
  onEvent?: (turn: UiMessage) => void
}

export class AgentRuntime {
  constructor(
    private providers: ProviderService,
    private rag: RagService,
    private skills: SkillService
  ) {}

  async systemPrompt(scope: ToolScope, extra: string): Promise<string> {
    const lines = [
      'You are Cloth, a local developer assistant running inside an offline developer hub.',
      `Today is ${new Date().toISOString().slice(0, 10)}.`,
      'Be precise and concise. Use Markdown. Prefer showing code over describing it.'
    ]
    const collections = this.rag.listCollections().filter((c) => !scope.collectionIds.length || scope.collectionIds.includes(c.id))
    if (collections.length) {
      lines.push(
        '',
        '## Knowledge base',
        'Use `rag_search` whenever the question may be answered by the local knowledge base. Search iteratively: refine queries if results are weak. Ground claims in results and cite them inline as [n] using the numbers from the most recent search. If the knowledge base has nothing relevant, say so.',
        ...collections.map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''} (${c.docCount} docs)`)
      )
    }
    if (scope.skillsEnabled) {
      const skills = await this.skills.list().catch(() => [])
      if (skills.length) {
        lines.push('', '## Skills', 'Load a skill with `skill_use` before doing a task it covers.', ...skills.map((s) => `- ${s.name}: ${s.description}`))
      }
    }
    if (scope.workspace) lines.push('', '## Workspace', `You can read files under ${scope.workspace} with list_dir, read_file and grep.`)
    if (extra.trim()) lines.push('', '## Instructions', extra.trim())
    return lines.join('\n')
  }

  createAgent(opts: Omit<AgentRunOptions, 'prompt'> & { systemPrompt: string }): Agent {
    const { model } = this.providers.resolve(opts.model)
    const agent = new Agent({
      initialState: {
        systemPrompt: opts.systemPrompt,
        model,
        thinkingLevel: model.reasoning ? (opts.thinking ?? 'off') : 'off',
        tools: buildTools({ rag: this.rag, skills: this.skills }, opts.scope),
        messages: opts.history ?? []
      },
      getApiKey: async (providerId) => this.providers.apiKey(providerId) || 'cloth-local',
      toolExecution: 'parallel'
    })
    return agent
  }

  /** Headless agent run (workflows, MCP). Returns the final assistant text and the turn trace. */
  async run(opts: AgentRunOptions): Promise<{ text: string; turn: UiMessage; messages: AgentMessage[] }> {
    const systemPrompt = await this.systemPrompt(opts.scope, opts.systemPrompt ?? '')
    const agent = this.createAgent({ ...opts, systemPrompt })
    const startIndex = agent.state.messages.length
    let turns = 0
    const maxTurns = opts.maxTurns ?? 12
    agent.subscribe((e) => {
      if (e.type === 'turn_end' && ++turns >= maxTurns) agent.abort()
      if (opts.onEvent && (e.type === 'message_end' || e.type === 'tool_execution_end')) {
        opts.onEvent(toUiMessages(agent.state.messages.slice(startIndex)).at(-1)!)
      }
    })
    opts.signal?.addEventListener('abort', () => agent.abort(), { once: true })
    await agent.prompt(opts.prompt)
    const messages = agent.state.messages
    const turn = toUiMessages(messages.slice(startIndex)).filter((m) => m.role === 'assistant').at(-1)
    if (!turn) throw new Error(agent.state.errorMessage || 'Agent produced no response')
    if (turn.error) throw new Error(turn.error)
    const text = turn.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim()
    return { text, turn, messages }
  }
}

export class ChatService {
  private active = new Map<string, Agent>()

  constructor(
    private ctx: Ctx,
    private runtime: AgentRuntime,
    private settings: SettingsService
  ) {}

  list(): ChatSession[] {
    const rows = this.ctx.db.prepare('SELECT id, title, config, created_at, updated_at FROM sessions ORDER BY updated_at DESC').all() as unknown as SessionRow[]
    return rows.map(toSession)
  }

  get(id: string): ChatSession {
    return toSession(this.row(id))
  }

  create(config: Partial<SessionConfig> = {}): ChatSession {
    const id = newId('ses_')
    const now = Date.now()
    const full: SessionConfig = { ...DEFAULT_CONFIG, model: this.settings.get().defaultModel, ...config }
    this.ctx.db.prepare('INSERT INTO sessions (id, title, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, 'New chat', JSON.stringify(full), now, now)
    return this.get(id)
  }

  update(id: string, patch: Partial<SessionConfig> & { title?: string }): ChatSession {
    const cur = this.get(id)
    const { title, ...config } = patch
    const next: SessionConfig = {
      model: cur.model,
      systemPrompt: cur.systemPrompt,
      collectionIds: cur.collectionIds,
      skillsEnabled: cur.skillsEnabled,
      workspace: cur.workspace,
      thinking: cur.thinking,
      ...config
    }
    this.ctx.db.prepare('UPDATE sessions SET title = ?, config = ?, updated_at = ? WHERE id = ?').run(title ?? cur.title, JSON.stringify(next), Date.now(), id)
    return this.get(id)
  }

  remove(id: string): void {
    this.abort(id)
    this.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  messages(id: string): UiMessage[] {
    return toUiMessages(this.rawMessages(id))
  }

  isRunning(id: string): boolean {
    return this.active.has(id)
  }

  abort(id: string): void {
    this.active.get(id)?.abort()
  }

  /** Truncate history to before the given UI message (for edit & resend / regenerate). */
  rewind(id: string, uiMessageId: string): UiMessage[] {
    const raw = this.rawMessages(id)
    const idx = raw.findIndex((m) => 'timestamp' in m && `m${m.timestamp}` === uiMessageId)
    if (idx >= 0) this.saveMessages(id, raw.slice(0, idx))
    return this.messages(id)
  }

  async send(id: string, text: string): Promise<void> {
    if (this.active.has(id)) throw new Error('This chat is already running')
    const session = this.get(id)
    if (!session.model) throw new Error('Pick a model for this chat first (Providers → add one, then choose it in the chat header)')
    const scope: ToolScope = { collectionIds: session.collectionIds, skillsEnabled: session.skillsEnabled, workspace: session.workspace }
    const history = this.rawMessages(id)
    const systemPrompt = await this.runtime.systemPrompt(scope, session.systemPrompt)
    const agent = this.runtime.createAgent({ model: session.model, scope, thinking: session.thinking, history, systemPrompt })
    this.active.set(id, agent)

    const emit = (e: ChatEvent) => this.ctx.emit('chat', e)
    const startIndex = history.length
    let timer: NodeJS.Timeout | null = null
    const pushTurn = () => {
      timer = null
      const msgs: AgentMessage[] = [...agent.state.messages.slice(startIndex)]
      const streaming = agent.state.streamingMessage
      if (streaming && !msgs.includes(streaming)) msgs.push(streaming)
      const ui = toUiMessages(msgs, agent.state.pendingToolCalls)
      const turn = ui.filter((m) => m.role === 'assistant').at(-1)
      if (turn) emit({ sessionId: id, type: 'message', message: turn })
    }
    const schedule = () => {
      if (!timer) timer = setTimeout(pushTurn, 40)
    }

    agent.subscribe((e) => {
      switch (e.type) {
        case 'message_update':
        case 'tool_execution_start':
        case 'tool_execution_update':
          schedule()
          break
        case 'message_end':
        case 'tool_execution_end':
          pushTurn()
          this.saveMessages(id, agent.state.messages)
          break
      }
    })

    if (session.title === 'New chat') {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat'
      this.update(id, { title })
      emit({ sessionId: id, type: 'title', title })
    }
    emit({ sessionId: id, type: 'start' })
    const userMsg = toUiMessages([{ role: 'user', content: text, timestamp: Date.now() }])[0]
    emit({ sessionId: id, type: 'message', message: userMsg })

    void (async () => {
      let error: string | undefined
      try {
        await agent.prompt(text)
        error = agent.state.errorMessage
      } catch (err) {
        error = errorMessage(err)
      } finally {
        if (timer) clearTimeout(timer)
        pushTurn()
        this.saveMessages(id, agent.state.messages)
        this.active.delete(id)
        emit({ sessionId: id, type: 'end', error })
      }
    })()
  }

  private rawMessages(id: string): AgentMessage[] {
    const row = this.ctx.db.prepare('SELECT messages FROM sessions WHERE id = ?').get(id) as { messages: string } | undefined
    return json<AgentMessage[]>(row?.messages, [])
  }

  private saveMessages(id: string, messages: AgentMessage[]): void {
    this.ctx.db.prepare('UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(messages), Date.now(), id)
  }

  private row(id: string): SessionRow {
    const row = this.ctx.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) throw new Error(`Unknown chat ${id}`)
    return row
  }
}

function toSession(row: SessionRow): ChatSession {
  const config = { ...DEFAULT_CONFIG, ...json<Partial<SessionConfig>>(row.config, {}) }
  return { id: row.id, title: row.title, ...config, createdAt: row.created_at, updatedAt: row.updated_at }
}

/**
 * Collapse pi agent messages into UI turns: each user message becomes one bubble, and every
 * assistant/toolResult message until the next user message is folded into a single assistant
 * turn with interleaved thinking, text and tool traces.
 */
export function toUiMessages(messages: AgentMessage[], pending?: ReadonlySet<string>): UiMessage[] {
  const out: UiMessage[] = []
  const results = new Map<string, ToolResultMessage<ToolDetails>>()
  for (const m of messages) if (m.role === 'toolResult') results.set(m.toolCallId, m as ToolResultMessage<ToolDetails>)

  let turn: UiMessage | null = null
  for (const m of messages) {
    if (m.role === 'user') {
      turn = null
      const text = typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n')
      out.push({ id: `m${m.timestamp}`, role: 'user', blocks: [{ type: 'text', text }], createdAt: m.timestamp })
      continue
    }
    if (m.role !== 'assistant') continue
    const a = m as AssistantMessage
    if (!turn) {
      turn = { id: `m${a.timestamp}`, role: 'assistant', blocks: [], createdAt: a.timestamp, model: a.model, usage: { input: 0, output: 0, cost: 0 } }
      out.push(turn)
    }
    for (const block of a.content) {
      if (block.type === 'text') {
        if (block.text) pushText(turn.blocks, 'text', block.text)
      } else if (block.type === 'thinking') {
        if (block.thinking && !block.redacted) pushText(turn.blocks, 'thinking', block.thinking)
      } else if (block.type === 'toolCall') {
        const r = results.get(block.id)
        const trace: ToolTrace = {
          id: block.id,
          name: block.name,
          args: block.arguments,
          status: r ? (r.isError ? 'error' : 'ok') : pending?.has(block.id) || a.stopReason === 'toolUse' ? 'running' : 'error',
          result: r ? r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n') : '',
          durationMs: r?.details?.durationMs ?? null,
          references: r?.details?.references ?? []
        }
        if (!r && a.stopReason !== 'toolUse' && !pending?.has(block.id)) trace.result = 'Interrupted before the tool ran'
        turn.blocks.push({ type: 'tool', trace })
      }
    }
    if (a.usage) {
      turn.usage!.input += a.usage.input
      turn.usage!.output += a.usage.output
      turn.usage!.cost += a.usage.cost?.total ?? 0
    }
    if (a.stopReason === 'error') turn.error = a.errorMessage || 'The model returned an error'
    if (a.stopReason === 'aborted') turn.error = 'Stopped'
  }
  return out
}

function pushText(blocks: UiBlock[], type: 'text' | 'thinking', text: string): void {
  const last = blocks.at(-1)
  if (last && last.type === type) last.text += `\n\n${text}`
  else blocks.push({ type, text })
}
