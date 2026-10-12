import type { Automation, Workflow, WorkflowNode } from '@shared/types'
import { json } from '../core/db'
import { loopBodies, topoSort } from './engine'

/** Folder tools an agent step had when it worked in a folder, and the ones it had with write access. */
const READ_TOOLS = ['read', 'ls', 'find', 'grep']
const WRITE_TOOLS = ['write', 'edit']

/**
 * A graph flow as an automation: a prompt that walks through its steps in order, and the union of the tools,
 * knowledge and skills those steps used. Deterministic: the same flow always gives the same automation.
 */
export function flowToAutomation(wf: Pick<Workflow, 'name' | 'nodes' | 'edges' | 'workspace'>): Automation {
  let order: WorkflowNode[]
  try {
    order = topoSort(wf.nodes, wf.edges)
  } catch {
    order = [...wf.nodes].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)
  }
  const { bodies } = loopBodies(wf.nodes, wf.edges)
  // A loop's steps come right after it, so "do steps A–B" reads in order.
  const placed = new Set<string>()
  const steps: WorkflowNode[] = []
  const place = (n: WorkflowNode) => {
    if (placed.has(n.id)) return
    placed.add(n.id)
    if (n.type !== 'trigger') steps.push(n)
    const body = bodies.get(n.id)
    if (body) for (const m of order) if (body.has(m.id)) place(m)
  }
  for (const n of order) place(n)
  const stepOf = new Map(steps.map((n, i) => [n.id, i + 1]))
  const keyStep = new Map(steps.map((n, i) => [String(n.data.key), i + 1]))

  const tools = new Set<string>()
  const collectionIds = new Set<string>()
  const skills = new Set<string>()
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [])

  /** Template text in words: {{key}} becomes "the result of step N", {{input.x}} "the input's x". */
  const plain = (v: unknown) =>
    String(v ?? '')
      .replace(/\{\{\s*([\w$.[\]-]+)\s*\}\}/g, (_, path: string) => {
        const [head, ...rest] = path.replace(/\[(\d+)\]/g, '.$1').split('.')
        if (head === 'input') return rest.length ? `the input's ${rest.join('.')}` : 'the input'
        if (head === 'prev') return "the previous step's result"
        if (head === 'loop') return rest[0] === 'index' ? 'the current item number' : 'the current item'
        const n = keyStep.get(head)
        if (!n) return path
        const field = rest.join('.')
        return !field || ['text', 'body', 'output'].includes(field) ? `the result of step ${n}` : `the ${field} from step ${n}`
      })
      .replace(/\s+/g, ' ')
      .trim()
  const sentence = (s: string) => (/[.!?:;)`]["”]?$/.test(s) ? s : `${s}.`)
  const quote = (s: string) => `“${s}”`
  const stepsFor = (ids: Iterable<string>) => [...ids].map((id) => stepOf.get(id)).filter((n): n is number => !!n).sort((a, b) => a - b)
  const range = (ns: number[]) => (!ns.length ? 'nothing' : ns.length === 1 ? `step ${ns[0]}` : `steps ${ns[0]}–${ns[ns.length - 1]}`)
  const branch = (n: WorkflowNode, handle: string) => {
    const targets = stepsFor(wf.edges.filter((e) => e.source === n.id && e.sourceHandle === handle).map((e) => e.target))
    return targets.length ? `continue with step ${targets[0]}` : 'stop'
  }
  const argsSummary = (args: unknown) => {
    const obj = typeof args === 'string' ? json<unknown>(args.trim() || '{}', null) : args
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const parts = Object.entries(obj).map(([k, v]) => `${k} ${typeof v === 'string' ? quote(plain(v).slice(0, 200)) : JSON.stringify(v)}`)
      return parts.join(', ')
    }
    return typeof args === 'string' ? plain(args).slice(0, 300) : ''
  }
  const withSystem = (prompt: string, system: unknown) => {
    const s = plain(system)
    return s ? `${sentence(prompt)} (Instructions: ${s})` : prompt
  }

  const describe = (n: WorkflowNode): string => {
    const d = n.data
    const label = String(d.label ?? '').trim()
    switch (n.type) {
      case 'llm':
        return withSystem(plain(d.prompt) || "Write a response to the previous step's result", d.system)
      case 'agent': {
        for (const t of list(d.tools)) tools.add(t)
        for (const c of list(d.collectionIds)) collectionIds.add(c)
        for (const s of list(d.skills)) skills.add(s)
        if (d.webEnabled) for (const t of ['web_search', 'web_fetch']) tools.add(t)
        if (d.workspace || wf.workspace) {
          for (const t of READ_TOOLS) tools.add(t)
          if (d.fileAccess === 'write' || (!d.fileAccess && !d.workspace)) for (const t of WRITE_TOOLS) tools.add(t)
        }
        return withSystem(plain(d.prompt) || "Work on the previous step's result", d.system)
      }
      case 'rag':
        for (const c of list(d.collectionIds)) collectionIds.add(c)
        return `Search the knowledge base for ${quote(plain(d.query) || "the previous step's result")}`
      case 'web': {
        const top = Number(d.fetchTop) || 0
        tools.add('web_search')
        if (top > 0) tools.add('web_fetch')
        return `Search the web for ${quote(plain(d.query) || "the previous step's result")}${top > 0 ? ` and read the top ${top} result${top === 1 ? '' : 's'}` : ''}`
      }
      case 'skill': {
        const name = String(d.skill ?? '').trim()
        if (name) skills.add(name)
        if ((d.mode ?? 'content') === 'content') return `Follow the ${quote(name)} skill`
        return `Use the ${quote(name)} skill: ${plain(d.prompt) || "apply it to the previous step's result"}`
      }
      case 'tool': {
        const name = String(d.tool ?? '').trim()
        if (name) tools.add(name)
        const args = argsSummary(d.args)
        return args ? `Use ${name} with ${args}` : `Use ${name}`
      }
      case 'http': {
        const method = String(d.method ?? 'GET').toUpperCase()
        const url = plain(d.url)
        if (method === 'GET') {
          tools.add('web_fetch')
          return `Fetch ${url}`
        }
        const body = plain(d.body)
        return `Send a ${method} request to ${url}${body ? ` with the body ${body.slice(0, 300)}` : ''}`
      }
      case 'transform': {
        const code = String(d.code ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
        return `${label || 'Reshape the previous result'}: work it out from the previous result the way this JavaScript does: \`${code || 'return prev'}\``
      }
      case 'condition':
        return `If \`${String(d.expression || 'true').replace(/\s+/g, ' ').trim()}\`${label ? ` (${label})` : ''}, then ${branch(n, 'true')}; otherwise ${branch(n, 'false')}`
      case 'loop': {
        const body = range(stepsFor(bodies.get(n.id) ?? []))
        if (d.mode === 'until') return `Repeat ${body} until \`${String(d.until || 'true').replace(/\s+/g, ' ').trim()}\` (at most ${Math.max(1, Number(d.maxIterations) || 10)} times)`
        return `For each item in ${plain(d.items) || "the previous step's result"}, do ${body}`
      }
      case 'output': {
        const value = String(d.value ?? '').trim()
        return value && !value.includes('{{') ? `Report ${quote(value.replace(/\s+/g, ' '))}` : 'Report the result'
      }
      default:
        return `Step: ${label || String(n.type)}`
    }
  }

  const lines = steps.map((n, i) => `${i + 1}. ${sentence(describe(n))}`)
  const trigger = order.find((n) => n.type === 'trigger')
  const input = json<unknown>(String(trigger?.data.defaultInput ?? '{}') || '{}', {})
  const hasInput = input && typeof input === 'object' && Object.keys(input).length > 0
  const prompt = [
    `This automation was converted from the flow “${wf.name}”. Do these steps in order:`,
    lines.join('\n'),
    hasInput ? `The input: \`${JSON.stringify(input)}\`` : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    prompt,
    agentId: null,
    tools: [...tools],
    servers: [],
    collectionIds: [...collectionIds],
    skills: [...skills],
    watch: null,
    // Steps never ran shell commands themselves: command tools stay custom tools (in `tools`).
    commands: null
  }
}
