/**
 * A short, one-line summary of a tool call's arguments ("src/auth/refresh.ts", "$ npm test",
 * "“query”"), for showing what an agent is doing. The tool's name is not included.
 */
export function toolSummary(name: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s)
  if (name === 'rag_search' || name === 'web_search') return `“${clip(String(a.query ?? ''))}”`
  if (name === 'web_fetch') return String(a.url ?? '')
  if (name === 'skill_use') return `${a.name ?? ''}${a.file ? ` / ${a.file}` : ''}`
  if (['read_file', 'list_dir', 'read', 'ls', 'write', 'edit'].includes(name)) return String(a.path ?? '.')
  if (name === 'find') return `${a.pattern ?? ''}${a.path ? ` in ${a.path}` : ''}`
  if (name === 'bash' || name === 'powershell') return clip(`$ ${String(a.command ?? '').split('\n')[0]}`)
  if (name === 'task') return String(a.description ?? '')
  if (name === 'openspec') return clip(`$ openspec ${Array.isArray(a.args) ? a.args.join(' ') : ''}`)
  if (name === 'session_read') return String(a.id ?? '')
  if (name === 'session_list') return a.query ? `“${clip(String(a.query))}”` : 'all chats'
  if (['agent_create', 'mcp_server_add', 'provider_add'].includes(name)) return String(a.name ?? '')
  if (name === 'automation_create') return clip(String(a.name ?? a.description ?? ''))
  if (name === 'generate_image') return clip(String(a.prompt ?? ''))
  if (name === 'computer') return String(a.action ?? '').replace(/_/g, ' ')
  if (name === 'ask_user') return clip(String(a.question ?? ''))
  if (name === 'skill_create' || name === 'tool_create') return String(a.name ?? '')
  if (name === 'lsp') return [a.action, a.symbol ?? a.query, a.path ? `· ${a.path}${a.line ? `:${a.line}` : ''}` : ''].filter(Boolean).join(' ')
  if (name === 'ast_grep') return `${a.pattern ?? ''}${a.path ? ` in ${a.path}` : ''}`
  if (name === 'ast_edit') return clip(`${a.pattern ?? ''} → ${a.rewrite ?? ''}`)
  if (name === 'grep') return `/${a.pattern ?? ''}/ ${a.path ?? ''}`.trim()
  const s = JSON.stringify(a)
  return s === '{}' ? '' : s.slice(0, 80)
}
