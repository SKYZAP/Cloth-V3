import { describe, expect, it } from 'vitest'
import { pickedServers, withServer } from '../src/shared/mcp-select'

describe('which MCP servers a chat uses', () => {
  const enabled = ['a', 'b', 'c']
  it('uses every switched-on server unless the chat turned one off', () => {
    expect(pickedServers(null, enabled)).toEqual(['a', 'b', 'c'])
    expect(pickedServers(['!b'], enabled)).toEqual(['a', 'c'])
    // A server added later is on in a chat that only turned others off.
    expect(pickedServers(['!b'], [...enabled, 'd'])).toEqual(['a', 'c', 'd'])
    // Older chats that picked a fixed set keep it; servers switched off everywhere drop out.
    expect(pickedServers(['a', 'x'], enabled)).toEqual(['a'])
    expect(pickedServers([], enabled)).toEqual([])
  })
  it('stores a switch as the servers turned off, so new ones stay on', () => {
    expect(withServer(null, enabled, 'b', false)).toEqual(['!b'])
    expect(withServer(['!b'], enabled, 'b', true)).toBeNull()
    expect(withServer(['a'], enabled, 'b', true)).toEqual(['!c'])
    expect(withServer(['!a', '!b'], enabled, 'c', false)).toEqual([])
  })
})
