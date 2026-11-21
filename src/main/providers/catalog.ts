// Model facts (context size, output limit, prices) from pi-ai's built-in catalogue, for any provider Cloth talks to.
// A provider is matched to the catalogue by its host (openrouter.ai, api.z.ai, …) or, for OpenAI and Anthropic, by
// its kind; a model the host's catalogue doesn't list is matched by id against the model maker's own catalogue, so
// "claude-opus-5.5" behind a proxy still gets Opus 5.5's limits and price. Servers on this PC are never priced.
import type { Api, Model } from '@earendil-works/pi-ai'
import { getModels, getProviders } from '@earendil-works/pi-ai/compat'
import type { ProviderKind } from '@shared/types'

export type CatalogModel = Model<Api>
export type Cost = CatalogModel['cost']

const FREE: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Catalogue providers that sell their own models, tried first when matching by id alone. */
const MAKERS = ['anthropic', 'openai', 'google', 'zai', 'deepseek', 'xai', 'mistral', 'moonshotai', 'minimax', 'xiaomi', 'meta', 'nvidia']

let built: { byProvider: Map<string, Map<string, CatalogModel>>; byHost: Map<string, string[]>; byKey: Map<string, CatalogModel> } | null = null

function catalogue() {
  if (built) return built
  const byProvider = new Map<string, Map<string, CatalogModel>>()
  const byHost = new Map<string, string[]>()
  const byKey = new Map<string, CatalogModel>()
  const providers = getProviders() as string[]
  const order = [...MAKERS.filter((p) => providers.includes(p)), ...providers.filter((p) => !MAKERS.includes(p))]
  for (const p of order) {
    const models = new Map<string, CatalogModel>()
    for (const m of getModels(p as never) as CatalogModel[]) {
      models.set(m.id.toLowerCase(), m)
      const host = hostOf(m.baseUrl)
      if (host) byHost.set(host, [...new Set([...(byHost.get(host) ?? []), p])])
      // The first (maker's own) entry wins; a free plan's zero price never stands in for a real one.
      const key = modelKey(m.id)
      const had = byKey.get(key)
      if (!had || (isFree(had.cost) && !isFree(m.cost))) byKey.set(key, m)
    }
    byProvider.set(p, models)
  }
  built = { byProvider, byHost, byKey }
  return built
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null
  } catch {
    return null
  }
}

const isFree = (c: Cost) => !(c.input > 0 || c.output > 0)

/** One spelling for a model across catalogues: no maker prefix or tag, lower case, dots and underscores as dashes. */
export function modelKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/:.*$/, '')
    .split('/')
    .pop()!
    .replace(/^(anthropic|openai|google|zai|z-ai|zai-org)[.-]/, '')
    .replace(/[._]/g, '-')
}

/** A server on this PC or the local network (LM Studio, Ollama, a runner): its models cost nothing. */
export function isLocalUrl(url: string): boolean {
  const host = hostOf(url)
  if (!host) return false
  return host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.lan') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/.test(host)
}

/** The catalogue entry for a model as served by this provider, or null when nothing fits. */
export function catalogModel(provider: { kind: ProviderKind; baseUrl: string }, id: string): CatalogModel | null {
  const { byProvider, byHost, byKey } = catalogue()
  const lower = id.toLowerCase()
  const own = [...(byHost.get(hostOf(provider.baseUrl) ?? '') ?? []), ...(provider.kind === 'openai' ? ['openai'] : provider.kind === 'anthropic' ? ['anthropic'] : [])]
  for (const p of own) {
    const m = byProvider.get(p)?.get(lower)
    if (m) return m
  }
  if (isLocalUrl(provider.baseUrl)) return null
  return byKey.get(modelKey(id)) ?? null
}

/** USD per 1M tokens for this model at this provider; all zero when local or unknown. */
export function catalogCost(provider: { kind: ProviderKind; baseUrl: string }, id: string): Cost {
  if (isLocalUrl(provider.baseUrl)) return FREE
  return catalogModel(provider, id)?.cost ?? FREE
}
