import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { Type, type Static, type TSchema } from 'typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { RagHit, RagMode } from '@shared/types'
import { formatHitsForModel, type RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'

export interface ToolDetails {
  durationMs?: number
  references?: RagHit[]
  [key: string]: unknown
}

export interface ToolDeps {
  rag: RagService
  skills: SkillService
}

export interface ToolScope {
  collectionIds: string[]
  skillsEnabled: boolean
  workspace: string | null
}

function tool<P extends TSchema>(def: {
  name: string
  label: string
  description: string
  parameters: P
  run: (params: Static<P>, signal?: AbortSignal) => Promise<{ text: string; details?: ToolDetails }>
}): AgentTool<P, ToolDetails> {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_id, params, signal): Promise<AgentToolResult<ToolDetails>> {
      const started = performance.now()
      const out = await def.run(params, signal)
      return {
        content: [{ type: 'text', text: out.text }],
        details: { ...(out.details ?? {}), durationMs: Math.round(performance.now() - started) }
      }
    }
  }
}

export function buildTools(deps: ToolDeps, scope: ToolScope): AgentTool<any, ToolDetails>[] {
  const tools: AgentTool<any, ToolDetails>[] = []
  const collections = deps.rag.listCollections()
  const scoped = scope.collectionIds.length ? collections.filter((c) => scope.collectionIds.includes(c.id)) : collections

  if (scoped.length) {
    tools.push(
      tool({
        name: 'rag_search',
        label: 'Knowledge search',
        description: `Search the local knowledge base (hybrid BM25 + vector). Collections: ${scoped.map((c) => c.name).join(', ')}. Call it several times with different phrasings when the first results are thin. Cite results as [n].`,
        parameters: Type.Object({
          query: Type.String({ description: 'Focused search query' }),
          collections: Type.Optional(Type.Array(Type.String(), { description: 'Collection names to restrict to' })),
          k: Type.Optional(Type.Number({ description: 'Number of results (default 6)' })),
          mode: Type.Optional(Type.Union([Type.Literal('hybrid'), Type.Literal('keyword'), Type.Literal('vector')]))
        }),
        async run(p) {
          const allowed = scoped.map((c) => c.id)
          const requested = p.collections?.length
            ? p.collections.map((n) => deps.rag.findCollection(n)?.id).filter((id): id is string => !!id && allowed.includes(id))
            : allowed
          const res = await deps.rag.search({ query: p.query, collectionIds: requested.length ? requested : allowed, k: p.k ?? 6, mode: (p.mode ?? 'hybrid') as RagMode })
          const notes = res.notes.length ? `\n\nNotes: ${res.notes.join('; ')}` : ''
          return { text: formatHitsForModel(res.hits) + notes, details: { references: res.hits } }
        }
      })
    )
  }

  if (scope.skillsEnabled) {
    tools.push(
      tool({
        name: 'skill_list',
        label: 'List skills',
        description: 'List the skills available in the Cloth skill hub.',
        parameters: Type.Object({}),
        async run() {
          const skills = await deps.skills.list()
          return { text: skills.map((s) => `- ${s.name}: ${s.description}`).join('\n') || 'No skills installed.' }
        }
      }),
      tool({
        name: 'skill_use',
        label: 'Load skill',
        description: 'Load the full instructions of a skill by name (and optionally one of its bundled files). Load a skill before doing a task it covers.',
        parameters: Type.Object({
          name: Type.String(),
          file: Type.Optional(Type.String({ description: 'Relative path of a bundled file to read instead of SKILL.md' }))
        }),
        async run(p) {
          if (p.file) return { text: await deps.skills.readFile(p.name, p.file), details: { skill: p.name, file: p.file } }
          const s = await deps.skills.get(p.name)
          const extra = s.files.filter((f) => f !== 'SKILL.md' && f !== 'evals.json')
          return {
            text: `# Skill: ${s.name}\n${s.description}\n\n${s.body}${extra.length ? `\n\nBundled files (read with skill_use + file): ${extra.join(', ')}` : ''}`,
            details: { skill: s.name }
          }
        }
      })
    )
  }

  if (scope.workspace) tools.push(...workspaceTools(scope.workspace))
  return tools
}

function workspaceTools(root: string): AgentTool<any, ToolDetails>[] {
  const base = resolve(root)
  const inside = (p: string) => {
    const full = resolve(base, p || '.')
    if (full !== base && !full.startsWith(base + sep)) throw new Error('Path is outside the workspace')
    return full
  }
  return [
    tool({
      name: 'list_dir',
      label: 'List directory',
      description: `List files in the workspace (${base}). Paths are relative to the workspace root.`,
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      async run(p) {
        const dir = inside(p.path ?? '.')
        const entries = await readdir(dir, { withFileTypes: true })
        const lines = entries
          .filter((e) => !['node_modules', '.git'].includes(e.name))
          .slice(0, 400)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return { text: lines.join('\n') || '(empty)' }
      }
    }),
    tool({
      name: 'read_file',
      label: 'Read file',
      description: 'Read a text file from the workspace. Use offset/limit (lines) for large files.',
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number())
      }),
      async run(p) {
        const file = inside(p.path)
        const s = await stat(file)
        if (s.size > 5_000_000) throw new Error('File too large')
        const lines = (await readFile(file, 'utf8')).split('\n')
        const start = Math.max(0, (p.offset ?? 1) - 1)
        const slice = lines.slice(start, start + (p.limit ?? 400))
        const more = start + slice.length < lines.length ? `\n… (${lines.length} lines total)` : ''
        return { text: slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n') + more, details: { path: p.path } }
      }
    }),
    tool({
      name: 'grep',
      label: 'Search files',
      description: 'Regex search across text files in the workspace. Returns path:line: text.',
      parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), maxResults: Type.Optional(Type.Number()) }),
      async run(p, signal) {
        const re = new RegExp(p.pattern, 'i')
        const max = p.maxResults ?? 80
        const hits: string[] = []
        const walk = async (dir: string): Promise<void> => {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (hits.length >= max || signal?.aborted) return
            if (['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target'].includes(e.name)) continue
            const full = join(dir, e.name)
            if (e.isDirectory()) await walk(full)
            else {
              const s = await stat(full)
              if (s.size > 1_000_000) continue
              const text = await readFile(full, 'utf8').catch(() => '')
              if (text.includes('\u0000')) continue
              text.split('\n').forEach((line, i) => {
                if (hits.length < max && re.test(line)) hits.push(`${relative(base, full)}:${i + 1}: ${line.trim().slice(0, 200)}`)
              })
            }
          }
        }
        await walk(inside(p.path ?? '.'))
        return { text: hits.join('\n') || 'No matches.' }
      }
    })
  ]
}
