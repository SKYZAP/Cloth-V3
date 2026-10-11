import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { UsageSource } from '@shared/types'
import type { Ctx } from './context'

export interface UsageOrigin {
  source: UsageSource
  /** Chat session id, workflow id, skill name… */
  ref?: string | null
}

export type UsageKind = 'llm' | 'embed' | 'tool' | 'skill' | 'agent'

/** Price in USD per 1M tokens. */
export interface Pricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

const origin = new AsyncLocalStorage<UsageOrigin>()

/**
 * Append-only log of model calls, tool calls and skill uses, for the dashboard.
 * The origin (chat, workflow, MCP, …) is carried implicitly with AsyncLocalStorage so deep
 * call sites (provider calls inside a RAG search inside an agent tool) are attributed correctly.
 * Recording never throws — usage tracking must not break the feature being used.
 */
export class UsageService {
  /** Current price for a model, or null when unknown. Wired up by the provider service. */
  pricing: (providerId: string, modelId: string) => Pricing | null = () => null

  constructor(private ctx: Ctx) {}

  run<T>(o: UsageOrigin, fn: () => T): T {
    return origin.run(o, fn)
  }

  /** Run with this origin unless one is already set (outer attribution wins). */
  runDefault<T>(o: UsageOrigin, fn: () => T): T {
    return origin.getStore() ? fn() : origin.run(o, fn)
  }

  current(): UsageOrigin {
    return origin.getStore() ?? { source: 'other' }
  }

  /** Record one assistant message from pi (one-shot completion or an agent turn). */
  message(m: AssistantMessage, durationMs: number | null, ref?: { providerId: string; modelId: string }): void {
    const u = m.usage
    this.insert({
      kind: 'llm',
      providerId: ref?.providerId ?? m.provider,
      modelId: ref?.modelId ?? m.model,
      input: u?.input ?? 0,
      output: u?.output ?? 0,
      cacheRead: u?.cacheRead ?? 0,
      cacheWrite: u?.cacheWrite ?? 0,
      cost: u?.cost?.total ?? 0,
      durationMs,
      ok: m.stopReason !== 'error'
    })
  }

  embed(providerId: string, modelId: string, tokens: number, durationMs: number, ok: boolean): void {
    this.insert({ kind: 'embed', providerId, modelId, input: tokens, durationMs, ok })
  }

  tool(name: string, detail: string, durationMs: number, ok: boolean): void {
    this.insert({ kind: 'tool', name, detail, durationMs, ok })
  }

  /** A job a saved agent (or built-in scout/worker) ran as a subagent; `name` is the agent's id. */
  agentRun(agentId: string, role: string, durationMs: number, ok: boolean): void {
    this.insert({ kind: 'agent', name: agentId, detail: role, durationMs, ok })
  }

  skill(name: string, via: 'slash' | 'tool' | 'mcp' | 'workflow'): void {
    this.insert({ kind: 'skill', name, detail: via })
  }

  /** USD spent under one origin so far, e.g. a chat with everything it delegated. */
  costFor(source: UsageSource, ref: string): number {
    try {
      const row = this.ctx.db.prepare('SELECT COALESCE(SUM(cost), 0) AS cost FROM usage_events WHERE source = ? AND ref = ?').get(source, ref) as { cost: number }
      return row.cost
    } catch {
      return 0
    }
  }

  /** Record every assistant message an agent produces, with its latency. */
  track(agent: Agent): void {
    let started = 0
    agent.subscribe((e) => {
      if (e.type === 'message_start' && e.message.role === 'assistant') started = Date.now()
      if (e.type === 'message_end' && e.message.role === 'assistant') this.message(e.message as AssistantMessage, started ? Date.now() - started : null)
    })
  }

  private insert(e: {
    kind: UsageKind
    providerId?: string
    modelId?: string
    name?: string
    detail?: string
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    cost?: number
    durationMs?: number | null
    ok?: boolean
  }): void {
    try {
      const o = this.current()
      this.ctx.db
        .prepare(
          `INSERT INTO usage_events (at, kind, source, ref, provider_id, model_id, name, detail, input_tokens, output_tokens, cache_read, cache_write, cost, duration_ms, ok)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          Date.now(),
          e.kind,
          o.source,
          o.ref ?? null,
          e.providerId ?? null,
          e.modelId ?? null,
          e.name ?? null,
          e.detail ?? null,
          Math.round(e.input ?? 0),
          Math.round(e.output ?? 0),
          Math.round(e.cacheRead ?? 0),
          Math.round(e.cacheWrite ?? 0),
          e.cost ?? 0,
          e.durationMs ?? null,
          e.ok === false ? 0 : 1
        )
    } catch (err) {
      this.ctx.log('usage', 'failed to record usage', err)
    }
  }
}
