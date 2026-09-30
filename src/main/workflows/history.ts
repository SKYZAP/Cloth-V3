import type { CustomTool, NodeRunTrace, Workflow, WorkflowNode, WorkflowRun, WorkflowSnapshot } from '@shared/types'
import { json } from '../core/db'
import { renderArgs, renderTemplate } from './engine'

// ─── Version summaries ────────────────────────────────────────────────────────

const comparable = (n: WorkflowNode) => JSON.stringify({ type: n.type, data: n.data })

/** What changed between two versions of a flow, in a few words ('' = nothing). */
export function describeChange(prev: WorkflowSnapshot, next: WorkflowSnapshot): string {
  const before = new Map(prev.nodes.map((n) => [n.data.key, n]))
  const after = new Map(next.nodes.map((n) => [n.data.key, n]))
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed: string[] = []
  let moved = false
  for (const [key, n] of after) {
    const old = before.get(key)
    if (!old) continue
    if (comparable(old) !== comparable(n)) {
      const fields = [...new Set([...Object.keys(old.data), ...Object.keys(n.data)])].filter((f) => f !== 'key' && JSON.stringify(old.data[f]) !== JSON.stringify(n.data[f]))
      changed.push(old.type !== n.type ? `${key} (type)` : `${key}${fields.length ? ` (${fields.slice(0, 3).join(', ')}${fields.length > 3 ? '…' : ''})` : ''}`)
    } else if (old.position.x !== n.position.x || old.position.y !== n.position.y) moved = true
  }
  const edgeSet = (s: WorkflowSnapshot) => {
    const keyOf = new Map(s.nodes.map((n) => [n.id, n.data.key]))
    return new Set(s.edges.map((e) => `${keyOf.get(e.source)}>${keyOf.get(e.target)}:${e.sourceHandle ?? ''}:${e.targetHandle ?? ''}`))
  }
  const eb = edgeSet(prev)
  const ea = edgeSet(next)
  const rewired = [...ea].filter((e) => !eb.has(e)).length + [...eb].filter((e) => !ea.has(e)).length

  const list = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more` : xs.join(', '))
  const parts: string[] = []
  if (prev.name !== next.name) parts.push(`Renamed to “${next.name}”`)
  if (added.length) parts.push(`Added ${list(added)}`)
  if (removed.length) parts.push(`Removed ${list(removed)}`)
  if (changed.length) parts.push(`Changed ${list(changed)}`)
  if (rewired) parts.push(`${rewired} connection${rewired === 1 ? '' : 's'} changed`)
  if ((prev.workspace ?? null) !== (next.workspace ?? null)) parts.push(next.workspace ? 'Workspace set' : 'Workspace removed')
  if (prev.description !== next.description) parts.push('Description edited')
  if (!parts.length && moved) parts.push('Moved nodes')
  return parts.join(' · ')
}

// ─── Failure report for "Fix with AI" ─────────────────────────────────────────

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s)
const pretty = (v: unknown, n: number) => clip(typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v), n)

/** A compact description of a value's structure, so the builder can write correct {{key.field}} paths. */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'string') return `string (${v.length} chars)${v.length ? `: ${JSON.stringify(clip(v, 80))}` : ''}`
  if (typeof v !== 'object') return `${typeof v} ${JSON.stringify(v)}`
  if (Array.isArray(v)) return `array of ${v.length}${v.length ? `, items like ${depth >= 2 ? (typeof v[0] === 'object' ? 'object' : typeof v[0]) : shapeOf(v[0], depth + 1)}` : ''}`
  const keys = Object.keys(v as Record<string, unknown>)
  if (depth >= 2) return `object {${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''}}`
  return `object { ${keys
    .slice(0, 12)
    .map((k) => `${k}: ${shapeOf((v as Record<string, unknown>)[k], depth + 1)}`)
    .join('; ')}${keys.length > 12 ? '; …' : ''} }`
}

export function failureReport(run: WorkflowRun, wf: Workflow, deps: { tools: CustomTool[] }): string {
  const byId = new Map(wf.nodes.map((n) => [n.id, n]))
  const failed = run.nodes.find((t) => t.status === 'error')
  const node = failed ? byId.get(failed.nodeId) : undefined
  const name = (t: NodeRunTrace) => {
    const n = byId.get(t.nodeId)
    return `"${n?.data.label || t.key}" (key ${t.key}, ${t.type})`
  }
  const out: string[] = ['## What failed']
  if (failed) out.push(`Step ${name(failed)} failed with: ${failed.error ?? run.error ?? 'unknown error'}`)
  else out.push(`The run failed before or between steps: ${run.error ?? 'unknown error'}`)
  if (wf.updatedAt > run.startedAt) out.push('Note: the flow was edited after this run. The settings below are the current ones; the recorded values are from the run.')

  if (failed && node) {
    const { key: _key, label: _label, ...data } = node.data
    out.push('', '## The failing step', `Settings: ${pretty(data, 3000)}`)
    if (failed.input !== undefined) out.push(`It received (output of the step before): ${pretty(failed.input, 1500)}`)
    if (node.type === 'tool') {
      const tool = deps.tools.find((t) => t.name === node.data.tool)
      if (!tool) out.push(`The custom tool "${node.data.tool}" does not exist (or is not enabled). Available: ${deps.tools.filter((t) => t.enabled).map((t) => t.name).join(', ') || 'none'}`)
      else {
        out.push(
          `Custom tool "${tool.name}" (${tool.kind}): ${tool.description}`,
          `Parameters: ${tool.params.map((p) => `${p.name} (${p.type}${p.required ? ', required' : ', optional'})${p.description ? ` — ${p.description}` : ''}`).join('; ') || 'none'}`
        )
        // Rebuild what the args template produced in this run, and name the missing arguments.
        const scope: Record<string, unknown> = { input: run.input }
        for (const t of run.nodes) if (t.output !== undefined) scope[t.key] = t.output
        scope.prev = failed.input
        const raw = node.data.args
        const isObject = !!raw && typeof raw === 'object'
        const text = isObject ? JSON.stringify(raw) : String(raw ?? '') || '{}'
        // JSON text must still parse once filled in; an object is filled in value by value.
        const validText = isObject || json<unknown>(renderTemplate(text, scope), null) !== null
        const args = renderArgs(raw, scope)
        out.push(`Its args ${isObject ? '(an object; each value is filled in)' : 'template'}: ${text}`, `…which gave the tool: ${clip(JSON.stringify(args), 1500)}`)
        if (!validText) out.push('That is not valid JSON once filled in — the args template must produce a JSON object.')
        else {
          const missing = tool.params.filter((p) => p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === ''))
          if (missing.length) out.push(`Missing required arguments: ${missing.map((p) => p.name).join(', ')}. Map them from earlier outputs (see below), e.g. "${missing[0].name}": {{some_key.field}}.`)
          const unknown = Object.keys(args).filter((k) => !tool.params.some((p) => p.name === k))
          if (unknown.length) out.push(`Arguments the tool does not declare: ${unknown.join(', ')}`)
        }
        if (tool.kind === 'javascript') out.push(`Tool code (for reference; the flow cannot change it): ${clip(String(tool.config.code ?? ''), 1500)}`)
      }
    }
  }

  out.push('', '## Run input', pretty(run.input, 1500))
  const before = run.nodes.filter((t) => t.status === 'ok')
  if (before.length) {
    out.push('', '## Steps that finished before it (use these outputs in templates as {{key}} or {{key.field}})')
    for (const t of before) out.push(`- ${name(t)}: ${shapeOf(t.output)}`)
  }
  const notRun = run.nodes.filter((t) => t.status === 'pending' || t.status === 'skipped')
  const neverStarted = wf.nodes.filter((n) => !run.nodes.some((t) => t.nodeId === n.id))
  if (notRun.length || neverStarted.length) out.push('', `## Not reached: ${[...notRun.map((t) => t.key), ...neverStarted.map((n) => n.data.key)].join(', ')}`)
  return out.join('\n')
}
