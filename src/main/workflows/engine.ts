import type { NodeRunTrace, Workflow, WorkflowEdge, WorkflowNode } from '@shared/types'
import { errorMessage } from '../core/context'

export interface ExecInput {
  /** Values addressable from templates: `input`, every executed node's key, and `prev`. */
  scope: Record<string, unknown>
  /** Output of the first active upstream node. */
  prev: unknown
  signal: AbortSignal
}

export interface ExecResult {
  output: unknown
  /** For branching nodes: the source handle that stays active. */
  branch?: string
}

export type Executor = (node: WorkflowNode, input: ExecInput) => Promise<ExecResult>

export interface EngineHooks {
  onUpdate?: (traces: NodeRunTrace[]) => void
}

export class WorkflowError extends Error {}

/** Topologically sort nodes; throws on cycles. */
export function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const out = new Map<string, string[]>()
  for (const e of edges) {
    if (!indeg.has(e.source) || !indeg.has(e.target)) continue
    indeg.set(e.target, indeg.get(e.target)! + 1)
    out.set(e.source, [...(out.get(e.source) ?? []), e.target])
  }
  // Stable: seed by canvas position (left→right, top→bottom).
  const byPos = (a: WorkflowNode, b: WorkflowNode) => a.position.x - b.position.x || a.position.y - b.position.y
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).sort(byPos)
  const order: WorkflowNode[] = []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  while (queue.length) {
    const n = queue.shift()!
    order.push(n)
    for (const t of out.get(n.id) ?? []) {
      indeg.set(t, indeg.get(t)! - 1)
      if (indeg.get(t) === 0) queue.push(byId.get(t)!)
    }
    queue.sort(byPos)
  }
  if (order.length !== nodes.length) throw new WorkflowError('The workflow contains a cycle — loops are not supported yet')
  return order
}

/**
 * Execute a workflow graph. A node runs when at least one incoming edge is active: its source
 * finished OK and, for branching sources, the edge leaves from the chosen handle. Nodes with
 * no active inputs are skipped, so condition nodes prune whole branches.
 */
export async function executeGraph(
  wf: Pick<Workflow, 'nodes' | 'edges'>,
  input: unknown,
  executor: Executor,
  signal: AbortSignal,
  hooks: EngineHooks = {}
): Promise<{ output: unknown; traces: NodeRunTrace[] }> {
  const order = topoSort(wf.nodes, wf.edges)
  const incoming = new Map<string, WorkflowEdge[]>()
  for (const e of wf.edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e])

  const traces: NodeRunTrace[] = order.map((n) => ({ nodeId: n.id, key: n.data.key, type: n.type, status: 'pending' }))
  const trace = (id: string) => traces.find((t) => t.nodeId === id)!
  const results = new Map<string, ExecResult>()
  const scope: Record<string, unknown> = { input }
  const emit = () => hooks.onUpdate?.(traces.map((t) => ({ ...t })))

  for (const node of order) {
    if (signal.aborted) throw new WorkflowError('Run cancelled')
    const edges = incoming.get(node.id) ?? []
    const active = edges.filter((e) => {
      const r = results.get(e.source)
      if (!r) return false
      return r.branch === undefined || !e.sourceHandle || e.sourceHandle === r.branch
    })
    const t = trace(node.id)
    if (edges.length && !active.length) {
      t.status = 'skipped'
      emit()
      continue
    }
    const prev = active.length ? results.get(active[0].source)!.output : input
    t.status = 'running'
    t.startedAt = Date.now()
    t.input = prev
    emit()
    try {
      const res = await executor(node, { scope: { ...scope, prev }, prev, signal })
      results.set(node.id, res)
      scope[node.data.key] = res.output
      t.status = 'ok'
      t.output = res.output
    } catch (err) {
      t.status = 'error'
      t.error = errorMessage(err)
      if (!node.data.continueOnError) {
        t.durationMs = Date.now() - t.startedAt
        emit()
        throw new WorkflowError(`${node.data.label || node.data.key}: ${t.error}`)
      }
      results.set(node.id, { output: null })
      scope[node.data.key] = null
    }
    t.durationMs = Date.now() - t.startedAt
    emit()
  }

  const outputs = order.filter((n) => n.type === 'output' && results.has(n.id))
  let output: unknown
  if (outputs.length === 1) output = results.get(outputs[0].id)!.output
  else if (outputs.length > 1) output = Object.fromEntries(outputs.map((n) => [n.data.key, results.get(n.id)!.output]))
  else {
    const last = [...order].reverse().find((n) => results.has(n.id))
    output = last ? results.get(last.id)!.output : null
  }
  return { output, traces }
}

/** `{{ path.to.value }}` interpolation. Objects render as JSON. Unknown paths render empty. */
export function renderTemplate(template: string, scope: Record<string, unknown>): string {
  return String(template ?? '').replace(/\{\{\s*([\w$.[\]-]+)\s*\}\}/g, (_, path: string) => {
    const value = lookup(scope, path)
    if (value === undefined || value === null) return ''
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  })
}

export function lookup(scope: unknown, path: string): unknown {
  let cur: unknown = scope
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur === 'string' && part !== 'length') {
      // Allow templating into JSON strings produced by earlier nodes.
      try {
        cur = JSON.parse(cur)
      } catch {
        return undefined
      }
    }
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
