import { runInNewContext } from 'node:vm'
import { Type, type TSchema } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { CustomTool, CustomToolInput, ModelRef, ToolOrigin, ToolParam, ToolRunResult } from '@shared/types'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'
import type { ProviderService } from '../providers/providers'
import type { SettingsService } from '../core/settings'
import { renderTemplate } from '../workflows/engine'
import { run } from '../web/process'

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/
const MAX_OUTPUT = 20_000
const DEFAULT_TIMEOUT_MS = 30_000

interface ToolRow {
  id: string
  name: string
  description: string
  kind: CustomTool['kind']
  params: string
  config: string
  enabled: number
  created_by?: string
  created_at: number
  updated_at: number
}

export class CustomToolService {
  constructor(
    private ctx: Ctx,
    private providers: ProviderService,
    private settings: SettingsService,
    private reserved: () => string[]
  ) {}

  list(): CustomTool[] {
    return (this.ctx.db.prepare('SELECT * FROM tools ORDER BY name').all() as unknown as ToolRow[]).map(toTool)
  }

  get(id: string): CustomTool {
    const row = this.ctx.db.prepare('SELECT * FROM tools WHERE id = ?').get(id) as ToolRow | undefined
    if (!row) throw new Error(`Unknown tool ${id}`)
    return toTool(row)
  }

  create(input: CustomToolInput, createdBy: ToolOrigin = 'user'): CustomTool {
    const clean = this.validate(input)
    const id = newId('tool_')
    const now = Date.now()
    this.ctx.db
      .prepare('INSERT INTO tools (id, name, description, kind, params, config, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, clean.name, clean.description, clean.kind, JSON.stringify(clean.params), JSON.stringify(clean.config), clean.enabled === false ? 0 : 1, createdBy, now, now)
    this.changed(id)
    return this.get(id)
  }

  findByName(name: string): CustomTool | undefined {
    const row = this.ctx.db.prepare('SELECT * FROM tools WHERE name = ?').get(name) as ToolRow | undefined
    return row ? toTool(row) : undefined
  }

  private changed(id: string): void {
    this.ctx.emit('tools', { type: 'changed', id })
  }

  update(id: string, input: CustomToolInput): CustomTool {
    this.get(id)
    const clean = this.validate(input, id)
    this.ctx.db
      .prepare('UPDATE tools SET name = ?, description = ?, kind = ?, params = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(clean.name, clean.description, clean.kind, JSON.stringify(clean.params), JSON.stringify(clean.config), clean.enabled === false ? 0 : 1, Date.now(), id)
    this.changed(id)
    return this.get(id)
  }

  setEnabled(id: string, enabled: boolean): CustomTool {
    this.ctx.db.prepare('UPDATE tools SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id)
    this.changed(id)
    return this.get(id)
  }

  remove(id: string): void {
    this.ctx.db.prepare('DELETE FROM tools WHERE id = ?').run(id)
    this.changed(id)
  }

  private validate(input: CustomToolInput, id?: string): CustomToolInput {
    const name = input.name.trim()
    if (!TOOL_NAME_RE.test(name)) throw new Error('Tool names must be snake_case: lowercase letters, digits and underscores, starting with a letter')
    if (this.reserved().includes(name)) throw new Error(`"${name}" is a built-in tool name`)
    const clash = this.ctx.db.prepare('SELECT id FROM tools WHERE name = ?').get(name) as { id: string } | undefined
    if (clash && clash.id !== id) throw new Error(`A tool named "${name}" already exists`)
    if (!input.description.trim()) throw new Error('Describe what the tool does — the model decides when to call it from this text')
    const seen = new Set<string>()
    for (const p of input.params) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.name)) throw new Error(`Invalid parameter name "${p.name}"`)
      if (seen.has(p.name)) throw new Error(`Duplicate parameter "${p.name}"`)
      seen.add(p.name)
    }
    const c = input.config ?? {}
    if (input.kind === 'http' && !String(c.url ?? '').trim()) throw new Error('HTTP tools need a URL')
    if (input.kind === 'javascript' && !String(c.code ?? '').trim()) throw new Error('JavaScript tools need code')
    if (input.kind === 'command' && !String(c.command ?? '').trim()) throw new Error('Command tools need an executable')
    if (input.kind === 'prompt' && !String(c.prompt ?? '').trim()) throw new Error('Prompt tools need a prompt template')
    return { ...input, name, description: input.description.trim() }
  }

  /** Execute a tool definition with arguments (used by the agent and the Tools page test runner). */
  async execute(tool: Pick<CustomTool, 'kind' | 'config' | 'params'>, rawArgs: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const args = coerceArgs(tool.params, rawArgs)
    const c = tool.config ?? {}
    const scope = { ...args, args }
    const t = (s: unknown) => renderTemplate(String(s ?? ''), scope)
    const timeoutMs = Number(c.timeoutMs) || DEFAULT_TIMEOUT_MS

    switch (tool.kind) {
      case 'http': {
        const method = String(c.method ?? 'GET').toUpperCase()
        const headers = json<Record<string, string>>(t(c.headers || '{}'), {})
        const body = method === 'GET' || method === 'HEAD' ? undefined : t(c.body) || JSON.stringify(args)
        const res = await fetch(t(c.url), {
          method,
          headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
          body,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        })
        const text = await res.text()
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
        return clip(prettyJson(text))
      }
      case 'javascript': {
        const logs: string[] = []
        const sandbox = {
          args,
          fetch,
          URL,
          URLSearchParams,
          TextEncoder,
          TextDecoder,
          JSON,
          Math,
          Date,
          console: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')), error: (...a: unknown[]) => logs.push(a.map(String).join(' ')) }
        }
        const promise = Promise.resolve(runInNewContext(`(async () => { ${c.code}\n})()`, sandbox, { timeout: 2000 }))
        const value = await Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)), timeoutMs))])
        const out = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)
        return clip([logs.length ? `console:\n${logs.join('\n')}\n` : '', out || '(no return value)'].join(''))
      }
      case 'command': {
        // execFile without a shell: each templated argument is exactly one argv entry, so
        // parameter values cannot inject extra flags or commands.
        const argv = String(c.args ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => t(line))
        const { stdout, stderr, code } = await run(t(c.command), argv, { timeoutMs, cwd: c.cwd ? t(c.cwd) : undefined, signal })
        const out = [stdout.trim(), stderr.trim() ? `stderr:\n${stderr.trim()}` : ''].filter(Boolean).join('\n\n')
        if (code !== 0) throw new Error(`Exit code ${code}\n${clip(out)}`)
        return clip(out || '(no output)')
      }
      case 'prompt': {
        const ref = (c.model?.providerId ? c.model : this.settings.get().defaultModel) as ModelRef | null
        if (!ref) throw new Error('No model configured for this tool (and no default model)')
        const { text } = await this.providers.complete(ref, { system: t(c.system) || undefined, prompt: t(c.prompt), signal, maxTokens: Number(c.maxTokens) || undefined })
        return clip(text)
      }
      default:
        throw new Error(`Unknown tool kind ${String(tool.kind)}`)
    }
  }

  async test(tool: Pick<CustomTool, 'kind' | 'config' | 'params'>, args: Record<string, unknown>): Promise<ToolRunResult> {
    const started = Date.now()
    try {
      const output = await this.execute(tool, args)
      return { ok: true, output, durationMs: Date.now() - started }
    } catch (err) {
      return { ok: false, output: '', error: errorMessage(err), durationMs: Date.now() - started }
    }
  }

  toAgentTool(tool: CustomTool): AgentTool<TSchema, { durationMs: number; custom: true }> {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: paramsSchema(tool.params),
      execute: async (_id, params, signal) => {
        const started = performance.now()
        const text = await this.execute(tool, params as Record<string, unknown>, signal)
        return { content: [{ type: 'text', text }], details: { durationMs: Math.round(performance.now() - started), custom: true } }
      }
    }
  }
}

export function paramsSchema(params: ToolParam[]): TSchema {
  const props: Record<string, TSchema> = {}
  for (const p of params) {
    const opts = { description: p.description || undefined }
    const base = p.type === 'number' ? Type.Number(opts) : p.type === 'boolean' ? Type.Boolean(opts) : p.type === 'json' ? Type.Any(opts) : Type.String(opts)
    props[p.name] = p.required ? base : Type.Optional(base)
  }
  return Type.Object(props)
}

function coerceArgs(params: ToolParam[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  for (const p of params) {
    const v = raw[p.name]
    if (v === undefined || v === null || v === '') {
      if (p.required) throw new Error(`Missing required argument "${p.name}"`)
      continue
    }
    if (p.type === 'number') out[p.name] = Number(v)
    else if (p.type === 'boolean') out[p.name] = v === true || v === 'true'
    else if (p.type === 'json' && typeof v === 'string') out[p.name] = json(v, v)
  }
  return out
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (truncated, ${s.length} chars)` : s
}

function toTool(r: ToolRow): CustomTool {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind,
    params: json(r.params, []),
    config: json(r.config, {}),
    enabled: !!r.enabled,
    createdBy: (r.created_by as ToolOrigin | undefined) ?? 'user',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}
