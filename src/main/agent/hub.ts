import type { CustomTool, CustomToolInput, CustomToolKind, ToolOrigin, ToolParam, ToolParamType } from '@shared/types'
import type { RagService } from '../rag/rag'
import type { SkillService } from '../skills/skills'
import type { CustomToolService } from '../tools/custom'

/**
 * Actions that let a model add to the hub itself: index knowledge, create custom tools and
 * write skills. Shared by the chat agent's built-in tools and the MCP server.
 */

// ─── rag_index ───────────────────────────────────────────────────────────────

export interface IndexKnowledgeInput {
  collection: string
  /** Create the collection when no collection has this name (default true). */
  create?: boolean
  description?: string
  title?: string
  text?: string
  urls?: string[]
  crawl?: boolean
  maxPages?: number
  paths?: string[]
}

export const RAG_INDEX_DESCRIPTION =
  'Index content into a Cloth knowledge collection so it can be found later with rag_search. Use it when the user asks to save, remember or index something into a collection they name. ' +
  'Give the collection by name (it is created when it does not exist, unless create is false) and one or more sources: text (with a title) for notes or content you have written, urls for web pages (crawl follows links on the same site, up to maxPages), or paths for local files and folders. ' +
  'Text is indexed right away; pages and files are indexed in the background.'

export async function indexKnowledge(rag: RagService, p: IndexKnowledgeInput, opts: { resolvePath?: (path: string) => Promise<string> } = {}): Promise<string> {
  const name = p.collection?.trim()
  if (!name) throw new Error('Name the collection to index into')
  const text = p.text?.trim() ?? ''
  const urls = (p.urls ?? []).map((u) => u.trim()).filter(Boolean)
  const paths = (p.paths ?? []).map((x) => x.trim()).filter(Boolean)
  if (!text && !urls.length && !paths.length) throw new Error('Give something to index: text, urls or paths')
  for (const u of urls) if (!/^https?:\/\//i.test(u)) throw new Error(`Not an http(s) URL: ${u}`)
  if (paths.length && !opts.resolvePath) throw new Error('Local paths cannot be indexed from here')

  let col = rag.findCollection(name)
  const lines: string[] = []
  if (!col) {
    if (p.create === false) throw new Error(`No collection named "${name}". Existing: ${rag.listCollections().map((c) => c.name).join(', ') || 'none'}`)
    col = rag.createCollection({ name, description: p.description?.trim() ?? '' })
    lines.push(`Created the collection "${col.name}".`)
  }
  // Resolve every path before indexing anything, so a bad one fails the whole call.
  const resolved = paths.length ? await Promise.all(paths.map((x) => opts.resolvePath!(x))) : []

  if (text) {
    const title = p.title?.trim() || text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'Note'
    const doc = await rag.ingestText(col.id, title, text)
    lines.push(`Indexed "${doc.title}" into "${col.name}" (${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'}).`)
  }
  for (const url of urls) {
    const { queued } = await rag.ingestUrl({ collectionId: col.id, url, crawl: !!p.crawl, maxPages: p.maxPages })
    lines.push(p.crawl ? `Crawling ${url} (up to ${queued} pages) into "${col.name}".` : `Fetching ${url} into "${col.name}".`)
  }
  if (resolved.length) {
    const { queued } = await rag.ingestPaths(col.id, resolved)
    lines.push(queued ? `Queued ${queued} file${queued === 1 ? '' : 's'} for "${col.name}".` : `No indexable files found in ${paths.join(', ')}.`)
  }
  if (urls.length || resolved.length) lines.push('Pages and files are indexed in the background; progress shows on the Knowledge page.')
  return lines.join('\n')
}

// ─── tool_create ─────────────────────────────────────────────────────────────

export interface CreateToolInput {
  name: string
  description: string
  kind: CustomToolKind
  params?: { name: string; type?: ToolParamType; description?: string; required?: boolean }[]
  config: Record<string, unknown>
  /** Replace a tool of the same name that a model created earlier. */
  replace?: boolean
}

export const TOOL_CREATE_DESCRIPTION =
  'Create a custom tool in Cloth. It is listed on the Tools page and becomes callable by Cloth chats and flows. Use it when the user asks for a new tool or capability. ' +
  'name is snake_case; description tells a model when and how to use the tool; params are the arguments, referenced in templates as {{name}}. ' +
  'kind and config: "http" {url, method?, headers? (JSON object), body? (template; default the args as JSON)}; ' +
  '"javascript" {code: async function body with args, fetch, URL, console, JSON, Math, Date in scope; return a value}; ' +
  '"command" {command: executable, args?: one argument per line (templates allowed), cwd?}; ' +
  '"prompt" {prompt: template sent to the default model, system?}. Optional timeoutMs for any kind. ' +
  'http and prompt tools are enabled right away; javascript and command tools run code, so they start disabled until the user reviews and enables them on the Tools page. ' +
  'Set replace to update a tool you created earlier.'

/** Kinds that run code on this machine: a person reviews them before they can be called. */
const NEEDS_REVIEW: CustomToolKind[] = ['javascript', 'command']

export function createTool(custom: CustomToolService, p: CreateToolInput, origin: Exclude<ToolOrigin, 'user'>): { tool: CustomTool; text: string } {
  const kind = p.kind
  if (!['http', 'javascript', 'command', 'prompt'].includes(kind)) throw new Error('kind must be http, javascript, command or prompt')
  const config: Record<string, unknown> = { ...(p.config ?? {}) }
  // Accept the natural JSON shapes and store them as the Tools page edits them.
  if (Array.isArray(config.args)) config.args = config.args.map(String).join('\n')
  if (config.headers && typeof config.headers === 'object') config.headers = JSON.stringify(config.headers, null, 2)
  if (kind === 'prompt' && config.model === undefined) config.model = null
  const params: ToolParam[] = (p.params ?? []).map((x) => ({
    name: String(x.name ?? '').trim(),
    type: (['string', 'number', 'boolean', 'json'] as const).includes(x.type as ToolParamType) ? (x.type as ToolParamType) : 'string',
    description: String(x.description ?? ''),
    required: x.required !== false
  }))
  const review = NEEDS_REVIEW.includes(kind)
  const input: CustomToolInput = { name: String(p.name ?? '').trim(), description: String(p.description ?? ''), kind, params, config, enabled: !review }

  const existing = custom.findByName(input.name)
  let tool: CustomTool
  if (existing) {
    if (!p.replace) throw new Error(`A tool named "${input.name}" already exists. Pick another name${existing.createdBy !== 'user' ? ', or set replace to update it' : ''}.`)
    if (existing.createdBy === 'user') throw new Error(`"${input.name}" was made by the user and cannot be replaced; pick another name`)
    tool = custom.update(existing.id, input)
  } else tool = custom.create(input, origin)

  const verb = existing ? 'Updated' : 'Created'
  const text = review
    ? `${verb} the ${kind} tool "${tool.name}". It runs code on the user's machine, so it is disabled until the user reviews and enables it on the Tools page — tell them.`
    : `${verb} the ${kind} tool "${tool.name}". It is enabled and listed on the Tools page${origin === 'chat' ? '; it can be called from the next message on' : ''}.`
  return { tool, text }
}

// ─── skill_create ────────────────────────────────────────────────────────────

export interface CreateSkillInput {
  name: string
  description: string
  instructions: string
  files?: { path: string; content: string }[]
}

export const SKILL_CREATE_DESCRIPTION =
  'Create a skill in the Cloth skill hub (a SKILL.md, compatible with Claude/Agent skills). Use it when the user asks you to make or save a skill. ' +
  'name is kebab-case; description says what the skill does AND when to use it (agents decide whether to load it from that line alone); ' +
  'instructions is the Markdown body: when to use, numbered steps, concrete commands and examples, pitfalls. ' +
  'files optionally adds supporting files (scripts, templates, references) by relative path.'

export async function createSkill(skills: SkillService, p: CreateSkillInput): Promise<string> {
  if (!p.description?.trim()) throw new Error('A skill needs a description of what it does and when to use it')
  if (!p.instructions?.trim()) throw new Error('A skill needs instructions')
  const skill = await skills.create({ name: p.name, description: p.description.trim(), body: p.instructions }, { files: p.files })
  const extra = skill.files.filter((f) => f !== 'SKILL.md')
  return `Created the skill "${skill.name}"${extra.length ? ` with ${extra.join(', ')}` : ''}. It is in the Skills page and available to agents through skill_list / skill_use.`
}
