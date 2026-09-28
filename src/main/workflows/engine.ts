import { runInNewContext } from 'node:vm'
import type { NodeRunTrace, Workflow, WorkflowEdge, WorkflowNode } from '@shared/types'
import { errorMessage } from '../core/context'

export interface ExecInput {
  /** Values addressable from templates: `input`, every executed node's key, `prev`, and `loop` inside a loop body. */
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

/** Loop node handles: `body` runs once per iteration, `done` continues after the loop, `next` (target) closes the loop. */
export const LOOP_BODY = 'body'
export const LOOP_DONE = 'done'
export const LOOP_BACK = 'next'
export const MAX_LOOP_ITEMS = 1000
export const MAX_LOOP_ITERATIONS = 100

/** Edges that close a loop (body → loop's `next` handle). They are not part of the forward DAG. */
export function isLoopBack(e: WorkflowEdge): boolean {
  return e.targetHandle === LOOP_BACK
}

/** Topologically sort nodes over forward edges; throws on cycles that don't go through a loop node. */
export function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]))
  const out = new Map<string, string[]>()
  for (const e of edges) {
    if (isLoopBack(e) || !indeg.has(e.source) || !indeg.has(e.target)) continue
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
  if (order.length !== nodes.length) throw new WorkflowError('The workflow contains a cycle — to repeat steps, use a Loop node and connect the last step back into its "next" handle')
  return order
}

/**
 * Loop bodies: every node reachable from a loop's `body` handle over forward edges. A node nested
 * in several loops belongs to the innermost one (the smallest body containing it).
 */
export function loopBodies(nodes: WorkflowNode[], edges: WorkflowEdge[]): { bodies: Map<string, Set<string>>; owner: Map<string, string | null> } {
  const out = new Map<string, WorkflowEdge[]>()
  for (const e of edges) if (!isLoopBack(e)) out.set(e.source, [...(out.get(e.source) ?? []), e])
  const bodies = new Map<string, Set<string>>()
  for (const loop of nodes.filter((n) => n.type === 'loop')) {
    const body = new Set<string>()
    const stack = (out.get(loop.id) ?? []).filter((e) => e.sourceHandle === LOOP_BODY).map((e) => e.target)
    while (stack.length) {
      const id = stack.pop()!
      if (id === loop.id || body.has(id)) continue
      body.add(id)
      for (const e of out.get(id) ?? []) stack.push(e.target)
    }
    bodies.set(loop.id, body)
  }
  const owner = new Map<string, string | null>()
  for (const n of nodes) {
    let best: string | null = null
    for (const [loopId, body] of bodies) if (body.has(n.id) && (!best || body.size < bodies.get(best)!.size)) best = loopId
    owner.set(n.id, best)
  }
  return { bodies, owner }
}

/** Resolve a loop's `items` field to an array: a lone {{path}} keeps its type; JSON text is parsed; other text splits into lines. */
export function resolveItems(template: string, scope: Record<string, unknown>): unknown[] {
  const src = String(template ?? '').trim() || '{{prev}}'
  const lone = src.match(/^\{\{\s*([\w$.[\]-]+)\s*\}\}$/)
  let value: unknown = lone ? lookup(scope, lone[1]) : renderTemplate(src, scope)
  if (typeof value === 'string') {
    const text = value.trim()
    try {
      value = JSON.parse(text)
    } catch {
      value = text ? text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []
    }
  }
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    // Common shapes from other nodes: { hits: [...] }, { results: [...] }, or a single array field.
    const arrays = Object.values(value).filter(Array.isArray)
    if (arrays.length === 1) return arrays[0] as unknown[]
    return Object.entries(value).map(([key, v]) => ({ key, value: v }))
  }
  return value === undefined || value === null || value === '' ? [] : [value]
}

interface LoopState {
  item: unknown
  index: number
  count: number | null
  results: unknown[]
  last: unknown
}

/**
 * Execute a workflow graph. A node runs when at least one incoming edge is active: its source
 * finished OK and, for branching sources, the edge leaves from the chosen handle. Nodes with
 * no active inputs are skipped, so condition nodes prune whole branches.
 *
 * Loop nodes run their body sub-graph once per item (`each`) or until an expression holds
 * (`until`), then activate their `done` handle with the collected results.
 */
export async function executeGraph(
  wf: Pick<Workflow, 'nodes' | 'edges'>,
  input: unknown,
  executor: Executor,
  signal: AbortSignal,
  hooks: EngineHooks = {}
): Promise<{ output: unknown; traces: NodeRunTrace[] }> {
  const order = topoSort(wf.nodes, wf.edges)
  const { bodies, owner } = loopBodies(wf.nodes, wf.edges)
  const incoming = new Map<string, WorkflowEdge[]>()
  const loopBack = new Map<string, WorkflowEdge[]>()
  for (const e of wf.edges) {
    const map = isLoopBack(e) ? loopBack : incoming
    map.set(e.target, [...(map.get(e.target) ?? []), e])
  }

  const traces: NodeRunTrace[] = order.map((n) => ({ nodeId: n.id, key: n.data.key, type: n.type, status: 'pending' }))
  const traceById = new Map(traces.map((t) => [t.nodeId, t]))
  const results = new Map<string, ExecResult>()
  const scope: Record<string, unknown> = { input }
  const emit = () => hooks.onUpdate?.(traces.map((t) => ({ ...t })))
  const check = () => {
    if (signal.aborted) throw new WorkflowError('Run cancelled')
  }

  const activeInputs = (node: WorkflowNode) =>
    (incoming.get(node.id) ?? []).filter((e) => {
      const r = results.get(e.source)
      if (!r) return false
      return r.branch === undefined || !e.sourceHandle || e.sourceHandle === r.branch
    })

  /** Run every node directly owned by `loopId` (null = top level) in topological order. */
  const runScope = async (loopId: string | null): Promise<void> => {
    for (const node of order) {
      if (owner.get(node.id) !== loopId) continue
      check()
      const edges = incoming.get(node.id) ?? []
      const active = activeInputs(node)
      const t = traceById.get(node.id)!
      if (edges.length && !active.length) {
        if (t.status === 'pending') t.status = 'skipped'
        emit()
        continue
      }
      const prev = active.length ? results.get(active[0].source)!.output : input
      t.status = 'running'
      t.startedAt = Date.now()
      t.input = prev
      t.error = undefined
      emit()
      try {
        const res = node.type === 'loop' ? await runLoop(node, prev) : await executor(node, { scope: { ...scope, prev }, prev, signal })
        results.set(node.id, res)
        scope[node.data.key] = res.output
        t.status = 'ok'
        t.output = res.output
      } catch (err) {
        if (err instanceof WorkflowError && node.type === 'loop') {
          t.status = 'error'
          t.error = err.message
          t.durationMs = Date.now() - t.startedAt
          emit()
          throw err
        }
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
  }

  const runLoop = async (loop: WorkflowNode, prev: unknown): Promise<ExecResult> => {
    const d = loop.data
    const body = bodies.get(loop.id) ?? new Set<string>()
    const mode = d.mode === 'until' ? 'until' : 'each'
    const items = mode === 'each' ? resolveItems(String(d.items ?? '{{prev}}'), { ...scope, prev }) : null
    if (items && items.length > MAX_LOOP_ITEMS) throw new WorkflowError(`${d.label || d.key}: ${items.length} items is more than the ${MAX_LOOP_ITEMS} a loop can take`)
    const max = Math.min(Math.max(Number(d.maxIterations) || 10, 1), MAX_LOOP_ITERATIONS)
    const count = items ? items.length : max
    const outerLoop = scope.loop
    const trace = traceById.get(loop.id)!
    const state: LoopState = { item: items ? items[0] : prev, index: 0, count: items ? items.length : null, results: [], last: undefined }

    for (let i = 0; i < count; i++) {
      check()
      state.index = i
      state.item = items ? items[i] : i === 0 ? prev : state.last
      // Fresh results for the body each iteration, so branching and skips are per-iteration.
      for (const id of body) results.delete(id)
      results.set(loop.id, { output: state.item, branch: LOOP_BODY })
      scope[loop.data.key] = { ...state }
      scope.loop = scope[loop.data.key]
      trace.iterations = i + 1
      emit()
      await runScope(loop.id)
      for (const id of body) {
        const t = traceById.get(id)
        if (t && results.has(id)) t.iterations = (t.iterations ?? 0) + 1
      }

      const result = iterationResult(loop, body)
      state.results.push(result)
      state.last = result
      if (mode === 'until') {
        const stop = evaluate(String(d.until || 'true'), { input: scope.input, prev: result, loop: { ...state }, nodes: scope })
        if (stop) break
      }
    }

    scope.loop = outerLoop
    for (const id of body) if (traceById.get(id)?.status === 'pending') traceById.get(id)!.status = 'skipped'
    const output = mode === 'each' ? state.results : state.last
    return { output, branch: LOOP_DONE }
  }

  /** What one iteration produced: whatever feeds the loop's `next` handle, else the last body node that ran. */
  const iterationResult = (loop: WorkflowNode, body: Set<string>): unknown => {
    for (const e of loopBack.get(loop.id) ?? []) {
      const r = results.get(e.source)
      if (r && (r.branch === undefined || !e.sourceHandle || e.sourceHandle === r.branch)) return r.output
    }
    const last = [...order].reverse().find((n) => body.has(n.id) && results.has(n.id))
    return last ? results.get(last.id)!.output : null
  }

  await runScope(null)
  for (const t of traces) if (t.status === 'pending') t.status = 'skipped'
  emit()

  const top = order.filter((n) => owner.get(n.id) === null)
  const outputs = top.filter((n) => n.type === 'output' && results.has(n.id))
  let output: unknown
  if (outputs.length === 1) output = results.get(outputs[0].id)!.output
  else if (outputs.length > 1) output = Object.fromEntries(outputs.map((n) => [n.data.key, results.get(n.id)!.output]))
  else {
    const last = [...top].reverse().find((n) => results.has(n.id))
    output = last ? results.get(last.id)!.output : null
  }
  return { output, traces }
}

function evaluate(expression: string, context: Record<string, unknown>): boolean {
  try {
    return Boolean(runInNewContext(`(function(){ return (${expression}) })()`, { ...context, JSON, Math, Date }, { timeout: 500 }))
  } catch (err) {
    throw new WorkflowError(`Loop "until" expression failed: ${errorMessage(err)}`)
  }
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
