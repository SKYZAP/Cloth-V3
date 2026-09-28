/**
 * Layered left→right layout for workflow graphs (a small Sugiyama-style pass):
 * longest-path layering, barycenter ordering to reduce crossings, then each node is placed
 * level with the nodes that feed it so straight chains stay straight.
 *
 * Loop-back edges (into a loop's `next` handle) are ignored so loops lay out like the rest.
 */
export interface LayoutNode {
  id: string
  width: number
  height: number
  /** Current position — used to keep the user's vertical order when there is no better signal. */
  position?: { x: number; y: number }
}

export interface LayoutEdge {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface LayoutOptions {
  gapX?: number
  gapY?: number
}

/** Branch handles that should sit above / below their siblings. */
const HANDLE_BIAS: Record<string, number> = { true: -1, body: -1, false: 1, done: 1 }

export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const gapX = opts.gapX ?? 90
  const gapY = opts.gapY ?? 44
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const forward = acyclic(
    nodes,
    edges.filter((e) => e.targetHandle !== 'next' && byId.has(e.source) && byId.has(e.target) && e.source !== e.target)
  )
  const preds = new Map<string, LayoutEdge[]>()
  const succs = new Map<string, LayoutEdge[]>()
  for (const e of forward) {
    preds.set(e.target, [...(preds.get(e.target) ?? []), e])
    succs.set(e.source, [...(succs.get(e.source) ?? []), e])
  }

  // 1. Longest-path layering.
  const layer = new Map<string, number>()
  const visit = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!
    layer.set(id, 0)
    const l = Math.max(0, ...(preds.get(id) ?? []).map((e) => visit(e.source) + 1))
    layer.set(id, l)
    return l
  }
  for (const n of nodes) visit(n.id)
  const layers: string[][] = []
  for (const n of nodes) (layers[layer.get(n.id)!] ??= []).push(n.id)
  for (const l of layers) l?.sort((a, b) => (byId.get(a)!.position?.y ?? 0) - (byId.get(b)!.position?.y ?? 0))

  // 2. Barycenter sweeps (down then up) to reduce crossings.
  const index = new Map<string, number>()
  const reindex = () => layers.forEach((l) => l?.forEach((id, i) => index.set(id, i)))
  reindex()
  const bary = (id: string, dir: 'down' | 'up'): number | null => {
    const links = dir === 'down' ? (preds.get(id) ?? []).map((e) => index.get(e.source)! + bias(e) * 0.3) : (succs.get(id) ?? []).map((e) => index.get(e.target)! - bias(e) * 0.3)
    return links.length ? links.reduce((a, b) => a + b, 0) / links.length : null
  }
  for (let pass = 0; pass < 6; pass++) {
    const dir = pass % 2 === 0 ? 'down' : 'up'
    const range = dir === 'down' ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1)
    for (const i of range) {
      const l = layers[i]
      if (!l) continue
      const keyed = l.map((id, pos) => ({ id, key: bary(id, dir) ?? pos }))
      keyed.sort((a, b) => a.key - b.key)
      layers[i] = keyed.map((k) => k.id)
      reindex()
    }
  }

  // 3. Coordinates. x by layer; y aligned to predecessors, then de-overlapped.
  const out = new Map<string, { x: number; y: number }>()
  const center = new Map<string, number>()
  let x = 0
  for (const l of layers) {
    if (!l) continue
    const width = Math.max(...l.map((id) => byId.get(id)!.width))
    const desired = l.map((id) => {
      const ps = preds.get(id) ?? []
      if (!ps.length) return null
      return ps.reduce((sum, e) => sum + center.get(e.source)! + bias(e) * (byId.get(id)!.height / 2 + gapY / 2), 0) / ps.length
    })
    // Nodes without predecessors are stacked around the layer's other nodes (or 0).
    const known = desired.filter((d): d is number => d !== null)
    let fallback = known.length ? Math.min(...known) : 0
    const ys: number[] = []
    l.forEach((id, i) => {
      const h = byId.get(id)!.height
      let want = desired[i] ?? fallback
      if (i > 0) want = Math.max(want, ys[i - 1] + byId.get(l[i - 1])!.height / 2 + gapY + h / 2)
      ys.push(want)
      fallback = want + h + gapY
    })
    // Shift the column so it sits, on average, where its nodes want to be.
    const drift = known.length ? l.reduce((sum, _, i) => sum + (desired[i] === null ? 0 : desired[i]! - ys[i]), 0) / known.length : -(ys[0] + ys[ys.length - 1]) / 2
    l.forEach((id, i) => {
      const n = byId.get(id)!
      const cy = ys[i] + drift
      center.set(id, cy)
      out.set(id, { x: Math.round(x + (width - n.width) / 2), y: Math.round(cy - n.height / 2) })
    })
    x += width + gapX
  }
  return out
}

function bias(e: LayoutEdge): number {
  return (e.sourceHandle && HANDLE_BIAS[e.sourceHandle]) || 0
}

/** Drop edges that close a cycle (DFS back-edges) so layering always terminates. */
function acyclic(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutEdge[] {
  const out = new Map<string, LayoutEdge[]>()
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e])
  const state = new Map<string, 1 | 2>()
  const keep: LayoutEdge[] = []
  const dfs = (id: string) => {
    state.set(id, 1)
    for (const e of out.get(id) ?? []) {
      if (state.get(e.target) === 1) continue
      keep.push(e)
      if (!state.has(e.target)) dfs(e.target)
    }
    state.set(id, 2)
  }
  for (const n of nodes) if (!state.has(n.id)) dfs(n.id)
  return keep
}
