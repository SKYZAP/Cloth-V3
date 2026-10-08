import { AGENT_TEMPLATES, DEFAULT_AGENT_SETUP, DESIGNER_SKILLS, type Agent, type AgentBuiltin, type AgentInput, type ModelRef, type ThinkingLevel } from '@shared/types'
import { json } from '../core/db'
import { newId, type Ctx } from '../core/context'
import { parseJsonLoose } from '../core/llm-json'
import type { ProviderService } from '../providers/providers'
import type { SettingsService } from '../core/settings'

interface AgentRow {
  id: string
  name: string
  builtin: string | null
  config: string
  created_at: number
  updated_at: number
}

type AgentConfig = Omit<Agent, 'id' | 'name' | 'builtin' | 'createdAt' | 'updatedAt'>

const DESIGNER_INSTRUCTIONS = `You design and build user interfaces: pages, screens, components and their visual polish.

Before you start:
- Read the project's design system if it has one (design/DESIGN.md, or DESIGN.md at the root) and build only from its tokens and components. Never invent colours, fonts or radii it already defines.
- Read the existing UI code near the change so new work matches its structure, naming and styling approach.

While you work:
- Follow your always-on skills: frontend-design for the visual direction, ui-ux-pro-max for UX, accessibility and layout rules, and web-design-guidelines as the checklist the result must pass.
- Make it work from phone width up, with visible keyboard focus, real labels, readable contrast and reduced motion respected.
- Write real, plain copy for the product, never placeholder text.

Before you finish, review your own change against web-design-guidelines and fix what fails. Report what you changed (files and why), anything you couldn't check, and any design decision the main agent should confirm with the user.`

/** Built-in agents: `fixed` holds what the user can't change; `seed` is where each starts. */
const BUILTINS: Record<AgentBuiltin, { name: string; purpose: string; fixed: Partial<AgentConfig>; seed?: Partial<AgentConfig> }> = {
  scout: {
    name: 'Scout',
    purpose: 'Explores code, files and the web for the main agent and reports back. Read-only.',
    fixed: { fileAccess: 'read', shell: false, asChat: false, asSubagent: true }
  },
  worker: {
    name: 'Worker',
    purpose: 'Makes changes the main agent hands over, keeping them minimal. Each edit follows the chat’s approvals.',
    fixed: { fileAccess: 'write', shell: false, asChat: false, asSubagent: true }
  },
  designer: {
    name: 'Designer',
    purpose: 'Designs and builds UI: pages, screens, components and visual polish, following the project’s design system. Hand it any job about how something looks or feels to use.',
    fixed: { asChat: false, asSubagent: true },
    seed: { fileAccess: 'write', shell: false, webEnabled: true, skillsEnabled: true, skillsAlways: DESIGNER_SKILLS, instructions: DESIGNER_INSTRUCTIONS }
  }
}

/** The built-ins behind the task tool's plain roles; other built-ins are handed work by name. */
export const ROLE_BUILTINS: AgentBuiltin[] = ['scout', 'worker']

const DEFAULTS: AgentConfig = {
  purpose: '',
  instructions: '',
  model: null,
  thinking: null,
  asChat: true,
  asSubagent: true,
  ...DEFAULT_AGENT_SETUP
}

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  builtin: (r.builtin as AgentBuiltin | null) ?? null,
  ...DEFAULTS,
  ...json<Partial<AgentConfig>>(r.config, {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const DRAFT_SYSTEM = `You set up AI agents for a developer tool. From the user's description, write a short name (1 to 3 words, Title Case, no quotes, no emoji, no word "Agent") and a purpose: one or two plain sentences saying what the agent does and when another agent should hand it work. Reply with JSON only: {"name": "...", "purpose": "..."}`

const INSTRUCTIONS_SYSTEM = `You write the instructions (system prompt) for an AI agent in a developer tool. The agent works in a chat with tools such as reading and editing files, running commands, searching the web and a knowledge base, skills and external MCP servers, depending on how it is set up.
Write in the second person ("You review…"). Be concrete: what to do first, how to work, what to check before finishing, what to report, and what never to do. Use short paragraphs or a few bullet lists, at most about 250 words. No title, no preamble, no closing remarks. Reply with the instructions only.`

const REWRITE_SYSTEM = `You edit the instructions (system prompt) of an AI agent. Apply the requested change and keep everything else as it is unless it contradicts the change. Keep the same voice and format. Reply with the full new instructions only, no preamble.`

/** Saved agents: a purpose, instructions, a model and what they may use; usable as a chat's agent or a subagent. */
export class AgentService {
  constructor(
    private ctx: Ctx,
    private providers: ProviderService,
    private settings: SettingsService
  ) {}

  list(): Agent[] {
    this.seed()
    const rows = this.ctx.db.prepare('SELECT * FROM agents ORDER BY builtin IS NOT NULL, name COLLATE NOCASE').all() as unknown as AgentRow[]
    return rows.map(toAgent)
  }

  get(id: string): Agent {
    this.seed()
    const row = this.ctx.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as AgentRow | undefined
    if (!row) throw new Error('Agent not found')
    return toAgent(row)
  }

  find(id: string | null | undefined): Agent | null {
    if (!id) return null
    try {
      return this.get(id)
    } catch {
      return null
    }
  }

  /** An agent by name, for delegation ("hand this to UI reviewer"). */
  byName(name: string): Agent | null {
    const n = name.trim().toLowerCase()
    return this.list().find((a) => a.name.toLowerCase() === n) ?? null
  }

  builtin(kind: AgentBuiltin): Agent {
    return this.list().find((a) => a.builtin === kind)!
  }

  create(input: AgentInput & { template?: string } = {}): Agent {
    const template = input.template ? AGENT_TEMPLATES.find((t) => t.id === input.template) : undefined
    const { template: _t, ...rest } = input
    const merged: AgentInput = { ...(template?.agent ?? {}), ...rest }
    const name = this.uniqueName(merged.name?.trim() || 'New agent')
    const id = newId('agt_')
    const now = Date.now()
    const config: AgentConfig = { ...DEFAULTS, ...pickConfig(merged) }
    this.ctx.db.prepare('INSERT INTO agents (id, name, builtin, config, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)').run(id, name, JSON.stringify(config), now, now)
    this.changed()
    return this.get(id)
  }

  update(id: string, patch: AgentInput): Agent {
    const cur = this.get(id)
    const name = patch.name === undefined ? cur.name : patch.name.trim()
    if (!name) throw new Error('Give the agent a name')
    if (name.toLowerCase() !== cur.name.toLowerCase() && this.list().some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already an agent called ${name}`)
    const { id: _i, name: _n, builtin: _b, createdAt: _c, updatedAt: _u, ...config } = { ...cur, ...pickConfig(patch) }
    // A built-in keeps its name and the access its role depends on.
    const fixed = cur.builtin ? { ...BUILTINS[cur.builtin].fixed, asChat: false } : {}
    this.ctx.db.prepare('UPDATE agents SET name = ?, config = ?, updated_at = ? WHERE id = ?').run(cur.builtin ? cur.name : name, JSON.stringify({ ...config, ...fixed }), Date.now(), id)
    this.changed()
    return this.get(id)
  }

  duplicate(id: string): Agent {
    const cur = this.get(id)
    const { id: _i, builtin: _b, createdAt: _c, updatedAt: _u, ...rest } = cur
    return this.create({ ...rest, name: `${cur.name} copy`, asChat: true })
  }

  remove(id: string): void {
    const cur = this.get(id)
    if (cur.builtin) throw new Error(`${cur.name} is built in; you can edit it but not delete it`)
    this.ctx.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    this.changed()
  }

  /** A name and purpose from a description, for the user to check before generating the agent. */
  async draft(description: string, model?: ModelRef | null, thinking: ThinkingLevel = 'off'): Promise<{ name: string; purpose: string }> {
    const ref = this.model(model)
    if (!description.trim()) throw new Error('Describe what the agent should do')
    const { text } = await this.providers.complete(ref, { system: DRAFT_SYSTEM, prompt: description.trim(), maxTokens: 400, temperature: 0.3, thinking })
    const parsed = parseJsonLoose<{ name?: string; purpose?: string }>(text)
    const name = (parsed?.name ?? '').replace(/["“”]/g, '').trim().slice(0, 40)
    const purpose = (parsed?.purpose ?? '').trim()
    if (!name || !purpose) throw new Error("The model's draft couldn't be read. Try again or another model.")
    return { name, purpose }
  }

  /** Write the agent's instructions from the description and the checked draft, and save it. */
  async generate(input: { description: string; name: string; purpose: string; model?: ModelRef | null; thinking?: ThinkingLevel }): Promise<Agent> {
    const ref = this.model(input.model)
    const prompt = [`Agent name: ${input.name}`, `Purpose: ${input.purpose}`, '', 'What the user asked for:', input.description.trim()].join('\n')
    const { text } = await this.providers.complete(ref, { system: INSTRUCTIONS_SYSTEM, prompt, maxTokens: 1200, temperature: 0.4, thinking: input.thinking ?? 'off' })
    const instructions = clean(text)
    if (!instructions) throw new Error('The model returned no instructions. Try again or another model.')
    return this.create({ name: input.name, purpose: input.purpose, instructions })
  }

  /** The instructions with a change applied ("be stricter about mobile layouts"). Not saved. */
  async rewrite(instructions: string, request: string, model?: ModelRef | null, thinking: ThinkingLevel = 'off'): Promise<string> {
    const ref = this.model(model)
    if (!request.trim()) throw new Error('Say what to change')
    const prompt = `Current instructions:\n\n${instructions.trim() || '(empty)'}\n\nChange to make: ${request.trim()}`
    const { text } = await this.providers.complete(ref, { system: REWRITE_SYSTEM, prompt, maxTokens: 1600, temperature: 0.3, thinking })
    const out = clean(text)
    if (!out) throw new Error('The model returned nothing. Try again.')
    return out
  }

  private model(ref?: ModelRef | null): ModelRef {
    const m = ref ?? this.settings.get().defaultModel
    if (!m) throw new Error('Pick a model to write with (or set a default model in Settings)')
    return m
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.list().map((a) => a.name.toLowerCase()))
    if (!taken.has(name.toLowerCase())) return name
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`
  }

  /** The built-ins (scout, worker, designer) exist as editable agents from the start. */
  private seeded = false
  private seed(): void {
    if (this.seeded) return
    this.seeded = true
    const have = new Set((this.ctx.db.prepare('SELECT builtin FROM agents WHERE builtin IS NOT NULL').all() as { builtin: string }[]).map((r) => r.builtin))
    const legacy = this.settings.get().subagents.instructions
    for (const kind of Object.keys(BUILTINS) as AgentBuiltin[]) {
      if (have.has(kind)) continue
      const b = BUILTINS[kind]
      const now = Date.now()
      // Instructions set for all subagents before agents existed carry over to scout and worker.
      const config: AgentConfig = { ...DEFAULTS, purpose: b.purpose, instructions: legacy, ...b.seed, ...b.fixed }
      this.ctx.db.prepare('INSERT INTO agents (id, name, builtin, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('agt_'), b.name, kind, JSON.stringify(config), now, now)
    }
  }

  private changed(): void {
    this.ctx.emit('agents', { type: 'changed' })
  }
}

const KEYS: (keyof AgentConfig)[] = ['purpose', 'instructions', 'model', 'thinking', 'asChat', 'asSubagent', ...(Object.keys(DEFAULT_AGENT_SETUP) as (keyof AgentConfig)[])]
function pickConfig(input: AgentInput): Partial<AgentConfig> {
  const out: Partial<AgentConfig> = {}
  for (const k of KEYS) if (input[k as keyof AgentInput] !== undefined) (out as Record<string, unknown>)[k] = input[k as keyof AgentInput]
  return out
}

function clean(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, '')
    .trim()
}
