import { existsSync, readFileSync } from 'node:fs'
import { cp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BUNDLE_FILES, type BundledCollection, type BundledTool, type FlowBundleGraph, type FlowBundleManifest } from '@shared/flow-bundle'
import type { WorkflowNode } from '@shared/types'
import type { Services } from '../../main/services'
import type { RunnerField } from '../api'

/** What the runner remembers about the bundle it installed into its own data folder. */
interface Installed {
  stamp: string
  flowId: string
  collections: string[]
}

export function readManifest(bundleDir: string): FlowBundleManifest {
  return JSON.parse(readFileSync(join(bundleDir, BUNDLE_FILES.manifest), 'utf8')) as FlowBundleManifest
}

/**
 * Put the bundled flow, tools, skills and knowledge into the app's own services — once per exported
 * version (a newer install replaces them). Returns the flow's id.
 */
export async function installBundle(s: Services, bundleDir: string): Promise<{ manifest: FlowBundleManifest; flowId: string }> {
  const manifest = readManifest(bundleDir)
  const stamp = `${manifest.exportedAt}`
  const prev = s.ctx.kv.get<Installed | null>('runner.installed', null)
  if (prev?.stamp === stamp && s.workflows.list().some((w) => w.id === prev.flowId)) return { manifest, flowId: prev.flowId }

  const tools = JSON.parse(await readFile(join(bundleDir, BUNDLE_FILES.tools), 'utf8')) as BundledTool[]
  for (const t of tools) {
    const existing = s.custom.findByName(t.name)
    if (existing) s.custom.update(existing.id, t)
    else s.custom.create(t)
  }

  const skillsDir = join(bundleDir, BUNDLE_FILES.skills)
  if (existsSync(skillsDir)) {
    for (const e of await readdir(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const target = join(s.ctx.skillsDir, e.name)
      await rm(target, { recursive: true, force: true })
      await cp(join(skillsDir, e.name), target, { recursive: true })
    }
  }

  // Knowledge: replace what an earlier version installed; flow nodes refer to the ids it had in Cloth.
  for (const id of prev?.collections ?? []) {
    try {
      s.rag.deleteCollection(id)
    } catch {
      /* already gone */
    }
  }
  const ids = new Map<string, string>()
  const knowledgeDir = join(bundleDir, BUNDLE_FILES.knowledge)
  if (existsSync(knowledgeDir)) {
    for (const f of await readdir(knowledgeDir)) {
      const file = JSON.parse(await readFile(join(knowledgeDir, f), 'utf8')) as BundledCollection
      ids.set(file.id, s.rag.importSnapshot(file.snapshot).id)
    }
  }
  const remap = (n: WorkflowNode): WorkflowNode => {
    if (!Array.isArray(n.data.collectionIds) || !n.data.collectionIds.length) return n
    return { ...n, data: { ...n.data, collectionIds: (n.data.collectionIds as string[]).map((id) => ids.get(id)).filter((x): x is string => !!x) } }
  }

  const graph = JSON.parse(await readFile(join(bundleDir, BUNDLE_FILES.flow), 'utf8')) as FlowBundleGraph
  const existing = prev && s.workflows.list().find((w) => w.id === prev.flowId)
  const wf = existing ?? s.workflows.create({ name: graph.name, description: graph.description })
  s.workflows.save(wf.id, { name: graph.name, description: graph.description, nodes: graph.nodes.map(remap), edges: graph.edges, cron: null, cronEnabled: false })

  s.ctx.kv.set('runner.installed', { stamp, flowId: wf.id, collections: [...ids.values()] } satisfies Installed)
  return { manifest, flowId: wf.id }
}

export function inputFields(nodes: WorkflowNode[]): RunnerField[] {
  const trigger = nodes.find((n) => n.type === 'trigger')
  let input: unknown = {}
  try {
    input = JSON.parse(String(trigger?.data.defaultInput ?? '{}'))
  } catch {
    input = {}
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [{ key: '', label: 'Input', kind: 'json', value: input }]
  return Object.entries(input as Record<string, unknown>).map(([key, value]) => ({
    key,
    label: key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
    kind:
      typeof value === 'number'
        ? 'number'
        : typeof value === 'boolean'
          ? 'boolean'
          : typeof value === 'string'
            ? value.length > 60 || value.includes('\n') || /brief|prompt|description|text|content|notes|instructions|outline/i.test(key)
              ? 'long'
              : 'text'
            : 'json',
    value
  }))
}

/** OpenAI models that can drive a chat or agent (drops embeddings, audio, images and legacy completions). */
export function chatModels(ids: string[]): string[] {
  return ids.filter((id) => !/embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image|babbage|davinci|search-preview/i.test(id)).sort()
}
