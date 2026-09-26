import { completeSimple, getModels, type Api, type AssistantMessage, type Context, type Model } from '@mariozechner/pi-ai'
import type {
  ModelInfo,
  ModelRef,
  Provider,
  ProviderInput,
  ProviderKind,
  ProviderPreset,
  ProviderTestResult,
  ThinkingLevel
} from '@shared/types'
import { json } from '../core/db'
import { errorMessage, newId, type Ctx } from '../core/context'

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, hint: 'Responses API' },
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true, hint: 'Messages API' },
  { id: 'lmstudio', label: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', needsKey: false, hint: 'Local server — start it from the Developer tab' },
  { id: 'ollama', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', needsKey: false, hint: 'Local server on :11434' },
  { id: 'llamacpp', label: 'llama.cpp server', kind: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', needsKey: false, hint: 'llama-server --port 8080' },
  { id: 'vllm', label: 'vLLM', kind: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', needsKey: false, hint: 'vllm serve' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, hint: 'Hosted router' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'openai-compatible', baseUrl: 'http://localhost:5000/v1', needsKey: false, hint: 'Any /v1/chat/completions endpoint' }
]

const API_FOR_KIND: Record<ProviderKind, Api> = {
  openai: 'openai-responses',
  anthropic: 'anthropic-messages',
  'openai-compatible': 'openai-completions'
}

interface ProviderRow {
  id: string
  name: string
  kind: ProviderKind
  base_url: string
  api_key: Uint8Array | null
  headers: string
  models: string
  enabled: number
  created_at: number
}

export interface CompleteInput {
  system?: string
  prompt?: string
  context?: Context
  maxTokens?: number
  temperature?: number
  thinking?: ThinkingLevel
  signal?: AbortSignal
}

export class ProviderService {
  constructor(private ctx: Ctx) {}

  presets(): ProviderPreset[] {
    return PROVIDER_PRESETS
  }

  list(): Provider[] {
    const rows = this.ctx.db.prepare('SELECT * FROM providers ORDER BY created_at').all() as unknown as ProviderRow[]
    return rows.map(toProvider)
  }

  get(id: string): Provider {
    const row = this.row(id)
    return toProvider(row)
  }

  create(input: ProviderInput): Provider {
    const id = newId('prv_')
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    this.ctx.db
      .prepare(
        `INSERT INTO providers (id, name, kind, base_url, api_key, headers, models, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`
      )
      .run(
        id,
        input.name.trim() || 'Provider',
        input.kind,
        baseUrl,
        input.apiKey ? this.ctx.secrets.encrypt(input.apiKey) : null,
        JSON.stringify(input.headers ?? {}),
        input.enabled === false ? 0 : 1,
        Date.now()
      )
    return this.get(id)
  }

  update(id: string, input: Partial<ProviderInput>): Provider {
    const cur = this.row(id)
    const apiKey =
      input.apiKey === undefined ? cur.api_key : input.apiKey === '' ? null : this.ctx.secrets.encrypt(input.apiKey)
    this.ctx.db
      .prepare('UPDATE providers SET name = ?, kind = ?, base_url = ?, api_key = ?, headers = ?, enabled = ? WHERE id = ?')
      .run(
        input.name ?? cur.name,
        input.kind ?? cur.kind,
        input.baseUrl ? normalizeBaseUrl(input.baseUrl) : cur.base_url,
        apiKey,
        JSON.stringify(input.headers ?? json(cur.headers, {})),
        input.enabled === undefined ? cur.enabled : input.enabled ? 1 : 0,
        id
      )
    return this.get(id)
  }

  remove(id: string): void {
    this.ctx.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
  }

  /** Save a model list edited by hand (e.g. flagging a model as embedding). */
  setModels(id: string, models: ModelInfo[]): Provider {
    this.row(id)
    this.ctx.db.prepare('UPDATE providers SET models = ? WHERE id = ?').run(JSON.stringify(models), id)
    return this.get(id)
  }

  async test(id: string): Promise<ProviderTestResult> {
    const started = Date.now()
    try {
      const models = await this.fetchModels(id)
      return { ok: true, latencyMs: Date.now() - started, message: `Reachable — ${models.length} models`, models }
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: errorMessage(err) }
    }
  }

  async refreshModels(id: string): Promise<Provider> {
    const fetched = await this.fetchModels(id)
    // Keep user overrides (e.g. embedding flag, context window) for models we already know.
    const previous = new Map(this.get(id).models.map((m) => [m.id, m]))
    const merged = fetched.map((m) => ({ ...m, ...(previous.get(m.id) ?? {}) , id: m.id }))
    return this.setModels(id, merged)
  }

  apiKey(id: string): string {
    const row = this.row(id)
    return row.api_key ? this.ctx.secrets.decrypt(row.api_key) : ''
  }

  /** Build a pi-ai Model for a registered provider + model id. */
  resolve(ref: ModelRef): { model: Model<Api>; apiKey: string } {
    const row = this.row(ref.providerId)
    if (!row.enabled) throw new Error(`Provider "${row.name}" is disabled`)
    const provider = toProvider(row)
    const info = provider.models.find((m) => m.id === ref.modelId) ?? guessModelInfo(provider.kind, ref.modelId)
    const api = API_FOR_KIND[provider.kind]
    const model: Model<Api> = {
      id: info.id,
      name: info.name,
      api,
      provider: provider.id,
      baseUrl: provider.baseUrl,
      reasoning: info.reasoning,
      input: info.vision ? ['text', 'image'] : ['text'],
      cost: knownCost(provider.kind, info.id),
      contextWindow: info.contextWindow,
      maxTokens: info.maxTokens,
      headers: Object.keys(provider.headers).length ? provider.headers : undefined
    }
    if (api === 'openai-completions') {
      ;(model as Model<'openai-completions'>).compat = {
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsReasoningEffort: info.reasoning,
        supportsStrictMode: false
      }
    }
    // Local servers accept any key; pi-ai still wants a non-empty one.
    return { model, apiKey: this.apiKey(provider.id) || 'cloth-local' }
  }

  describe(ref: ModelRef | null): string {
    if (!ref) return 'no model'
    try {
      return `${this.get(ref.providerId).name} · ${ref.modelId}`
    } catch {
      return ref.modelId
    }
  }

  /** One-shot completion that returns the assistant text. */
  async complete(ref: ModelRef, input: CompleteInput): Promise<{ text: string; message: AssistantMessage }> {
    const { model, apiKey } = this.resolve(ref)
    const context: Context = input.context ?? {
      systemPrompt: input.system,
      messages: [{ role: 'user', content: input.prompt ?? '', timestamp: Date.now() }]
    }
    const message = await completeSimple(model, context, {
      apiKey,
      maxTokens: input.maxTokens ?? Math.min(model.maxTokens, 8192),
      temperature: input.temperature,
      signal: input.signal,
      reasoning: input.thinking && input.thinking !== 'off' && model.reasoning ? input.thinking : undefined
    })
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw new Error(message.errorMessage || `Model call ${message.stopReason}`)
    }
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    return { text, message }
  }

  /** OpenAI-compatible /embeddings. Batches inputs; returns one vector per text. */
  async embed(ref: ModelRef, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const provider = this.get(ref.providerId)
    if (provider.kind === 'anthropic') throw new Error('Anthropic does not offer an embeddings endpoint')
    const key = this.apiKey(provider.id)
    const out: Float32Array[] = []
    const batchSize = 32
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const res = await fetch(`${provider.baseUrl}/embeddings`, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...provider.headers
        },
        body: JSON.stringify({ model: ref.modelId, input: batch })
      })
      if (!res.ok) throw new Error(`Embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] }
      const sorted = [...body.data].sort((a, b) => a.index - b.index)
      for (const d of sorted) out.push(normalize(Float32Array.from(d.embedding)))
    }
    return out
  }

  private async fetchModels(id: string): Promise<ModelInfo[]> {
    const provider = this.get(id)
    const key = this.apiKey(id)
    const signal = AbortSignal.timeout(10_000)
    if (provider.kind === 'anthropic') {
      const res = await fetch(`${provider.baseUrl}/v1/models?limit=100`, {
        signal,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...provider.headers }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const body = (await res.json()) as { data: { id: string; display_name?: string }[] }
      return body.data.map((m) => ({ ...guessModelInfo('anthropic', m.id), name: m.display_name ?? m.id }))
    }

    const res = await fetch(`${provider.baseUrl}/models`, {
      signal,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...provider.headers }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { data?: { id: string; context_length?: number }[] }
    const models = (body.data ?? []).map((m) => {
      const info = guessModelInfo(provider.kind, m.id)
      if (m.context_length) info.contextWindow = m.context_length
      return info
    })
    if (provider.kind === 'openai-compatible') await enrichFromLmStudio(provider.baseUrl, models)
    if (provider.kind === 'openai') {
      // The OpenAI list includes audio/image/moderation models that can't chat.
      return models.filter((m) => /^(gpt|o\d|chatgpt|codex|text-embedding)/.test(m.id) && !/(audio|realtime|tts|transcribe|image|search)/.test(m.id))
    }
    return models
  }

  private row(id: string): ProviderRow {
    const row = this.ctx.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
    if (!row) throw new Error(`Unknown provider ${id}`)
    return row
  }
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    hasApiKey: !!row.api_key && row.api_key.length > 0,
    headers: json(row.headers, {}),
    models: json(row.models, []),
    enabled: !!row.enabled,
    createdAt: row.created_at
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const n = Math.sqrt(sum) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

const knownModels = new Map<string, Model<Api>>()
for (const p of ['openai', 'anthropic'] as const) {
  for (const m of getModels(p)) knownModels.set(`${p}:${m.id}`, m as Model<Api>)
}

function knownCost(kind: ProviderKind, id: string): Model<Api>['cost'] {
  return knownModels.get(`${kind}:${id}`)?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function guessModelInfo(kind: ProviderKind, id: string): ModelInfo {
  const known = knownModels.get(`${kind}:${id}`)
  if (known) {
    return {
      id,
      name: known.name,
      contextWindow: known.contextWindow,
      maxTokens: known.maxTokens,
      reasoning: known.reasoning,
      vision: known.input.includes('image'),
      embedding: false
    }
  }
  const lower = id.toLowerCase()
  const embedding = /embed|bge|e5-|gte-|nomic|minilm/.test(lower)
  const reasoning = kind === 'anthropic' || /(^o\d|gpt-5|reason|think|r1|qwq|gpt-oss)/.test(lower)
  return {
    id,
    name: id,
    contextWindow: kind === 'anthropic' ? 200_000 : 32_768,
    maxTokens: kind === 'anthropic' ? 32_000 : 8_192,
    reasoning: !embedding && reasoning,
    vision: kind === 'anthropic' || /vision|vl|gpt-4o|gpt-5|llava|gemma-3/.test(lower),
    embedding
  }
}

/** LM Studio exposes richer metadata (model type, context length) on /api/v0/models. */
async function enrichFromLmStudio(baseUrl: string, models: ModelInfo[]): Promise<void> {
  try {
    const origin = new URL(baseUrl).origin
    const res = await fetch(`${origin}/api/v0/models`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return
    const body = (await res.json()) as { data: { id: string; type: string; max_context_length?: number; capabilities?: string[] }[] }
    const byId = new Map(body.data.map((m) => [m.id, m]))
    for (const m of models) {
      const meta = byId.get(m.id)
      if (!meta) continue
      m.embedding = meta.type === 'embeddings'
      if (meta.type === 'vlm') m.vision = true
      if (meta.max_context_length) m.contextWindow = meta.max_context_length
      if (meta.capabilities?.includes('tool_use') === false) m.name = `${m.id} (no tools)`
    }
  } catch {
    // Not LM Studio — ignore.
  }
}
