import { streamSimple } from '@earendil-works/pi-ai/compat'
import { Agent } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ModelRef, WorkflowBuildStep, WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeType } from '@shared/types'
import { NODE_SPEC, NODE_SPECS } from '@shared/workflow-nodes'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import type { RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { CustomToolService } from '../tools/custom'
import { LOOP_BACK, LOOP_BODY, LOOP_DONE, loopBodies, topoSort } from './engine'
import { layeredLayout } from '@shared/layout'

const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/
const MAX_TURNS = 40

export interface BuildDeps {
  providers: ProviderService
  rag: RagService
  skills: SkillService
  custom: CustomToolService
}

/** Mutable graph the builder agent edits through tools. Keys (not ids) are the agent-facing handles. */
export class DraftGraph {
  nodes: WorkflowNode[] = []
  edges: WorkflowEdge[] = []
  name = ''
  description = ''

  constructor(initial?: Pick<WorkflowGraph, 'nodes' | 'edges' | 'name' | 'description'>) {
    if (initial) {
      this.nodes = structuredClone(initial.nodes)
      this.edges = structuredClone(initial.edges)
      this.name = initial.name
      this.description = initial.description
    }
  }

  byKey(key: string): WorkflowNode {
    const n = this.nodes.find((x) => x.data.key === key)
    if (!n) throw new Error(`No node with key "${key}". Existing keys: ${this.nodes.map((x) => x.data.key).join(', ') || 'none'}`)
    return n
  }

  add(type: string, key: string, label: string | undefined, data: Record<string, unknown> = {}): string {
    const spec = NODE_SPEC[type as WorkflowNodeType]
    if (!spec) throw new Error(`Unknown node type "${type}". Valid: ${NODE_SPECS.map((s) => s.type).join(', ')}`)
    if (!KEY_RE.test(key)) throw new Error('Keys must be identifiers (letters, digits, underscore) — they are referenced as {{key}} in templates')
    if (['input', 'prev', 'nodes', 'args'].includes(key)) throw new Error(`"${key}" is reserved`)
    if (this.nodes.some((n) => n.data.key === key)) throw new Error(`Key "${key}" is already used`)
    if (type === 'trigger' && this.nodes.some((n) => n.type === 'trigger')) throw new Error('There is already a trigger node')
    this.nodes.push({ id: newId('n_'), type: spec.type, position: { x: 0, y: 0 }, data: { ...structuredClone(spec.defaults), ...data, key, label: label || spec.label } })
    return `Added ${type} "${key}"`
  }

  update(key: string, patch: { label?: string; data?: Record<string, unknown>; newKey?: string }): string {
    const n = this.byKey(key)
    if (patch.newKey && patch.newKey !== key) {
      if (!KEY_RE.test(patch.newKey) || this.nodes.some((x) => x.data.key === patch.newKey)) throw new Error(`Cannot rename to "${patch.newKey}"`)
      n.data.key = patch.newKey
    }
    if (patch.label) n.data.label = patch.label
    if (patch.data) Object.assign(n.data, patch.data, { key: n.data.key })
    return `Updated "${n.data.key}"`
  }

  remove(key: string): string {
    const n = this.byKey(key)
    this.nodes = this.nodes.filter((x) => x !== n)
    this.edges = this.edges.filter((e) => e.source !== n.id && e.target !== n.id)
    return `Removed "${key}" and its edges`
  }

  connect(from: string, to: string, branch?: string): string {
    const a = this.byKey(from)
    const b = this.byKey(to)
    if (b.type === 'trigger') throw new Error('Nothing can connect into the trigger')
    if (a.type === 'output') throw new Error('Output nodes have no outgoing connections')
    if (a.type === 'condition' && branch !== 'true' && branch !== 'false') throw new Error('Edges from a condition need branch "true" or "false"')
    // An edge from inside a loop's body back to the loop closes it (its "next" handle).
    if (b.type === 'loop' && loopBodies(this.nodes, this.edges).bodies.get(b.id)?.has(a.id)) {
      if (this.edges.some((e) => e.source === a.id && e.target === b.id && e.targetHandle === LOOP_BACK)) return 'Already connected'
      this.edges.push({ id: newId('e_'), source: a.id, target: b.id, sourceHandle: a.type === 'condition' ? branch! : null, targetHandle: LOOP_BACK })
      return `Connected ${from} → ${to} (loop back: this is the per-iteration result)`
    }
    if (a.type === 'loop' && branch !== LOOP_BODY && branch !== LOOP_DONE) throw new Error('Edges from a loop need branch "body" (steps to repeat) or "done" (steps after the loop)')
    const handle = a.type === 'condition' || a.type === 'loop' ? branch! : null
    if (this.edges.some((e) => e.source === a.id && e.target === b.id && (e.sourceHandle ?? null) === handle)) return 'Already connected'
    const edge: WorkflowEdge = { id: newId('e_'), source: a.id, target: b.id, sourceHandle: handle }
    this.edges.push(edge)
    try {
      topoSort(this.nodes, this.edges)
    } catch {
      this.edges.pop()
      throw new Error(`Connecting ${from} → ${to} would create a cycle`)
    }
    return `Connected ${from} → ${to}${handle ? ` (${handle})` : ''}`
  }

  disconnect(from: string, to: string): string {
    const a = this.byKey(from)
    const b = this.byKey(to)
    const before = this.edges.length
    this.edges = this.edges.filter((e) => !(e.source === a.id && e.target === b.id))
    return before === this.edges.length ? 'No such connection' : `Disconnected ${from} → ${to}`
  }

  view(): string {
    const byId = new Map(this.nodes.map((n) => [n.id, n.data.key]))
    return JSON.stringify(
      {
        nodes: this.nodes.map((n) => {
          const { key, label, ...data } = n.data
          return { key, type: n.type, label, data }
        }),
        edges: this.edges.map((e) => ({ from: byId.get(e.source), to: byId.get(e.target), ...(e.sourceHandle ? { branch: e.sourceHandle } : {}), ...(e.targetHandle === LOOP_BACK ? { loopBack: true } : {}) }))
      },
      null,
      1
    )
  }

  /** Structural + reference checks. Returns a list of problems (empty = valid). */
  validate(known: { collections: string[]; skills: string[]; tools: string[] }): string[] {
    const issues: string[] = []
    const triggers = this.nodes.filter((n) => n.type === 'trigger')
    if (triggers.length !== 1) issues.push(`Need exactly one trigger node (found ${triggers.length})`)
    if (!this.nodes.some((n) => n.type === 'output')) issues.push('Add at least one output node')
    try {
      topoSort(this.nodes, this.edges)
    } catch (err) {
      issues.push(errorMessage(err))
    }
    if (triggers.length === 1) {
      const reach = new Set([triggers[0].id])
      let grew = true
      while (grew) {
        grew = false
        for (const e of this.edges) if (reach.has(e.source) && !reach.has(e.target)) (reach.add(e.target), (grew = true))
      }
      for (const n of this.nodes) if (!reach.has(n.id)) issues.push(`Node "${n.data.key}" is not reachable from the trigger`)
    }
    const keys = new Set(['input', 'prev', 'nodes', ...(this.nodes.some((n) => n.type === 'loop') ? ['loop'] : []), ...this.nodes.map((n) => String(n.data.key))])
    for (const n of this.nodes) {
      const k = n.data.key
      if (n.type === 'condition' && !this.edges.some((e) => e.source === n.id)) issues.push(`Condition "${k}" has no outgoing branches`)
      if (n.type === 'loop' && !this.edges.some((e) => e.source === n.id && e.sourceHandle === LOOP_BODY)) issues.push(`Loop "${k}" has nothing connected to its "body" branch`)
      for (const [field, value] of Object.entries(n.data)) {
        if (typeof value !== 'string') continue
        for (const m of value.matchAll(/\{\{\s*([\w$]+)/g)) if (!keys.has(m[1])) issues.push(`"${k}".${field} references unknown {{${m[1]}}}`)
      }
      if (n.type === 'skill' && !known.skills.includes(String(n.data.skill))) issues.push(`"${k}" uses unknown skill "${n.data.skill}"`)
      if (n.type === 'tool' && !known.tools.includes(String(n.data.tool))) issues.push(`"${k}" uses unknown custom tool "${n.data.tool}"`)
      for (const id of (n.data.collectionIds as string[] | undefined) ?? []) if (!known.collections.includes(id)) issues.push(`"${k}" references unknown collection id "${id}"`)
      if (n.type === 'trigger') {
        try {
          JSON.parse(String(n.data.defaultInput || '{}'))
        } catch {
          issues.push('Trigger defaultInput must be valid JSON text')
        }
      }
    }
    return issues
  }

  /** Layered left→right layout from the topological order. */
  layout(): void {
    const pos = layeredLayout(
      this.nodes.map((n) => ({ id: n.id, width: 230, height: 70, position: n.position })),
      this.edges
    )
    for (const n of this.nodes) n.position = pos.get(n.id) ?? n.position
  }

  toGraph(): WorkflowGraph {
    return { name: this.name, description: this.description, nodes: this.nodes, edges: this.edges }
  }
}

function catalogText(): string {
  return NODE_SPECS.map(
    (s) => `### ${s.type} — ${s.label}\n${s.description}\nOutput: ${s.output}\nFields:\n${s.fields.map((f) => `- ${f.key}: ${f.description}`).join('\n')}`
  ).join('\n\n')
}

export async function buildWorkflow(
  ctx: Ctx,
  deps: BuildDeps,
  input: { description: string; model: ModelRef; existing?: WorkflowGraph; buildId: string; signal?: AbortSignal }
): Promise<WorkflowGraph> {
  const draft = new DraftGraph(input.existing)
  const collections = deps.rag.listCollections()
  const skills = await deps.skills.list().catch(() => [])
  const tools = deps.custom.list().filter((t) => t.enabled)
  const known = { collections: collections.map((c) => c.id), skills: skills.map((s) => s.name), tools: tools.map((t) => t.name) }
  let finished = false

  const emit = (step: WorkflowBuildStep) => ctx.emit('workflow', { type: 'build-step', buildId: input.buildId, step })
  const act = <T>(label: string, fn: (p: T) => string) => async (_id: string, raw: unknown) => {
    const params = raw as T
    try {
      const out = fn(params)
      emit({ tool: label, args: params, result: out, ok: true })
      return { content: [{ type: 'text' as const, text: out }], details: {} }
    } catch (err) {
      emit({ tool: label, args: params, result: errorMessage(err), ok: false })
      throw err
    }
  }

  const agentTools: AgentTool<any>[] = [
    {
      name: 'add_node',
      label: 'Add node',
      description: 'Add a node. `key` is its template handle ({{key}}); `data` sets fields from the catalog (unspecified fields get defaults).',
      parameters: Type.Object({ type: Type.String(), key: Type.String(), label: Type.Optional(Type.String()), data: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
      execute: act('add_node', (p: { type: string; key: string; label?: string; data?: Record<string, unknown> }) => draft.add(p.type, p.key, p.label, p.data))
    },
    {
      name: 'update_node',
      label: 'Update node',
      description: 'Merge fields into a node’s data, change its label, or rename its key.',
      parameters: Type.Object({ key: Type.String(), label: Type.Optional(Type.String()), newKey: Type.Optional(Type.String()), data: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
      execute: act('update_node', (p: { key: string; label?: string; newKey?: string; data?: Record<string, unknown> }) => draft.update(p.key, p))
    },
    {
      name: 'remove_node',
      label: 'Remove node',
      description: 'Delete a node and its edges.',
      parameters: Type.Object({ key: Type.String() }),
      execute: act('remove_node', (p: { key: string }) => draft.remove(p.key))
    },
    {
      name: 'connect',
      label: 'Connect',
      description: 'Connect two nodes by key. From a condition node, pass branch "true" or "false"; from a loop node, branch "body" (steps to repeat) or "done" (after the loop). Connecting a body step back to its loop closes the loop.',
      parameters: Type.Object({ from: Type.String(), to: Type.String(), branch: Type.Optional(Type.String()) }),
      execute: act('connect', (p: { from: string; to: string; branch?: string }) => draft.connect(p.from, p.to, p.branch))
    },
    {
      name: 'disconnect',
      label: 'Disconnect',
      description: 'Remove the edge(s) between two nodes.',
      parameters: Type.Object({ from: Type.String(), to: Type.String() }),
      execute: act('disconnect', (p: { from: string; to: string }) => draft.disconnect(p.from, p.to))
    },
    {
      name: 'view_graph',
      label: 'View graph',
      description: 'Show the current nodes and edges.',
      parameters: Type.Object({}),
      execute: act('view_graph', () => draft.view())
    },
    {
      name: 'finish',
      label: 'Finish',
      description: 'Validate and finish. Returns the remaining problems if the graph is not valid yet — fix them and call finish again.',
      parameters: Type.Object({ name: Type.String({ description: 'short workflow name' }), description: Type.String({ description: 'one-sentence summary' }) }),
      execute: async (_id, raw) => {
        const p = raw as { name: string; description: string }
        draft.name = p.name
        draft.description = p.description
        const issues = draft.validate(known)
        emit({ tool: 'finish', args: p, result: issues.length ? issues.join('\n') : 'Valid — done', ok: !issues.length })
        if (issues.length) return { content: [{ type: 'text', text: `Not valid yet:\n- ${issues.join('\n- ')}` }], details: {} }
        finished = true
        return { content: [{ type: 'text', text: 'Workflow is valid and complete.' }], details: {}, terminate: true }
      }
    }
  ]

  const systemPrompt = [
    'You assemble workflows for Cloth, a local developer hub, by calling graph-editing tools. Build the graph node by node, connect it, then call `finish`.',
    'Rules:',
    '- Exactly one `trigger` node; every other node must be reachable from it. At least one `output` node. No cycles except the loop-back edge into a loop node.',
    '- Templates: {{input.field}} reads the run input, {{prev}} the output of the node feeding in, {{key}} / {{key.field}} any earlier node by key.',
    '- Condition nodes branch: connect with branch "true" and/or "false".',
    '- To repeat steps use a `loop` node: connect it to the first repeated step with branch "body", to the step after the loop with branch "done", and connect the last repeated step back to the loop. Inside the body use {{loop.item}} / {{loop.index}} / {{loop.last}}. The only allowed cycle is that loop-back edge.',
    '- Leave `model` fields unset (null) so the default model is used, unless the user names one.',
    '- Give the trigger a realistic `defaultInput` JSON (as text) with the fields your templates use.',
    '- Prefer few, purposeful nodes. Use short snake_case keys.',
    '',
    '## Node catalog',
    catalogText(),
    '',
    '## Available resources',
    `Collections (use ids in collectionIds): ${collections.map((c) => `${c.id} = "${c.name}"${c.description ? ` (${c.description})` : ''}`).join('; ') || 'none'}`,
    `Skills: ${skills.map((s) => s.name).join(', ') || 'none'}`,
    `Custom tools: ${tools.map((t) => `${t.name}(${t.params.map((p) => p.name).join(', ')}) — ${t.description}`).join('; ') || 'none'}`
  ].join('\n')

  const task = input.existing?.nodes.length
    ? `Modify the existing workflow "${input.existing.name}" to satisfy this request. Current graph:\n${draft.view()}\n\nRequest: ${input.description}`
    : `Build a workflow for: ${input.description}`

  const { model } = deps.providers.resolve(input.model)
  const agent = new Agent({
    initialState: { systemPrompt, model, tools: agentTools, thinkingLevel: 'off' },
    streamFn: streamSimple,
    getApiKey: async (id) => deps.providers.apiKey(id) || 'cloth-local',
    toolExecution: 'sequential'
  })
  deps.providers.usage.track(agent)
  let turns = 0
  agent.subscribe((e) => {
    if (e.type === 'turn_end' && ++turns >= MAX_TURNS) agent.abort()
    if (e.type === 'message_end' && e.message.role === 'assistant') {
      const text = e.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim()
      if (text) ctx.emit('workflow', { type: 'build-text', buildId: input.buildId, text })
    }
  })
  input.signal?.addEventListener('abort', () => agent.abort(), { once: true })
  await agent.prompt(task)
  if (agent.state.errorMessage && !finished) throw new Error(agent.state.errorMessage)

  const issues = draft.validate(known)
  if (!finished && issues.length) throw new Error(`The builder stopped before the workflow was valid:\n- ${issues.join('\n- ')}`)
  if (!draft.name) draft.name = input.existing?.name || input.description.slice(0, 48)
  draft.layout()
  return draft.toGraph()
}
