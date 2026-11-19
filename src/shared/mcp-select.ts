/**
 * Which external MCP servers a chat (or agent) uses, from its `mcpServers` field.
 *
 * - null: every server that is switched on (the MCP page's switch). Servers added later join on their own.
 * - ids prefixed with "!": every switched-on server except those (what Setup → MCP writes when a chat turns one off).
 * - plain ids: exactly those servers (older chats, agents and automations that picked a fixed set).
 * - []: none.
 */
export const MCP_OFF = '!'

export function pickedServers(list: readonly string[] | null | undefined, enabled: readonly string[]): string[] {
  if (!list) return [...enabled]
  if (!list.length) return []
  const off = new Set(list.filter((x) => x.startsWith(MCP_OFF)).map((x) => x.slice(MCP_OFF.length)))
  const on = list.filter((x) => !x.startsWith(MCP_OFF))
  return (on.length ? on.filter((id) => enabled.includes(id)) : [...enabled]).filter((id) => !off.has(id))
}

/** The list after switching one server on or off for a chat, kept in the "all except" form so new servers stay on. */
export function withServer(list: readonly string[] | null | undefined, enabled: readonly string[], id: string, on: boolean): string[] | null {
  const now = pickedServers(list, enabled)
  const next = on ? [...new Set([...now, id])] : now.filter((x) => x !== id)
  const off = enabled.filter((x) => !next.includes(x))
  if (!off.length) return null
  return off.length === enabled.length ? [] : off.map((x) => MCP_OFF + x)
}
