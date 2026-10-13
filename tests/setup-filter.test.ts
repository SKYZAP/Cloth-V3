import { describe, expect, it } from 'vitest'
import { filterOnOff, firstSentence, matches, nothingMatches, onOffCounts, serverMatches } from '../src/renderer/src/pages/chat/setupFilter'
import { openSetupSection, takeSetupSection, useSetupNav } from '../src/renderer/src/pages/chat/setupNav'

interface Item {
  name: string
  desc?: string
  on: boolean
}
const items: Item[] = [
  { name: 'read', desc: 'Read a file.', on: true },
  { name: 'web_search', desc: 'Search the web.', on: false },
  { name: 'Subagents', desc: 'task', on: true },
  { name: 'lint_repo', on: false }
]
const isOn = (i: Item) => i.on
const texts = (i: Item) => [i.name, i.desc]

describe('matches', () => {
  it('matches everything on an empty or blank query', () => {
    expect(matches('', 'x')).toBe(true)
    expect(matches('   ', 'x')).toBe(true)
  })
  it('is case-insensitive, trims the query and skips missing texts', () => {
    expect(matches('  WEB ', undefined, 'web_search')).toBe(true)
    expect(matches('nope', null, 'web_search')).toBe(false)
  })
})

describe('filterOnOff', () => {
  it('filters by chip', () => {
    expect(filterOnOff(items, '', 'all', isOn, texts)).toHaveLength(4)
    expect(filterOnOff(items, '', 'on', isOn, texts).map((i) => i.name)).toEqual(['read', 'Subagents'])
    expect(filterOnOff(items, '', 'off', isOn, texts).map((i) => i.name)).toEqual(['web_search', 'lint_repo'])
  })
  it('combines the query with the chip, matching any text', () => {
    expect(filterOnOff(items, 'task', 'all', isOn, texts).map((i) => i.name)).toEqual(['Subagents'])
    expect(filterOnOff(items, 'task', 'off', isOn, texts)).toEqual([])
    expect(filterOnOff(items, 'file', 'on', isOn, texts).map((i) => i.name)).toEqual(['read'])
  })
})

describe('onOffCounts', () => {
  it('counts all, on and off', () => {
    expect(onOffCounts(items, isOn)).toEqual({ all: 4, on: 2, off: 2 })
    expect(onOffCounts([], isOn)).toEqual({ all: 0, on: 0, off: 0 })
  })
})

describe('serverMatches', () => {
  it('matches the server name, its description, or one of its tool names', () => {
    expect(serverMatches('play', 'playwright', '', [])).toBe(true)
    expect(serverMatches('asks', 'github', '3 tools · asks first', [])).toBe(true)
    expect(serverMatches('click', 'playwright', '', ['browser_click', 'browser_type'])).toBe(true)
    expect(serverMatches('query', 'playwright', '', ['browser_click'])).toBe(false)
    expect(serverMatches('', 'anything', '', [])).toBe(true)
  })
})

describe('nothingMatches and firstSentence', () => {
  it('quotes the trimmed query', () => {
    expect(nothingMatches(' zz ')).toBe('Nothing matches “zz”.')
    expect(nothingMatches('')).toBe('Nothing to show.')
  })
  it('keeps the first sentence', () => {
    expect(firstSentence('Read a file. Use offset for big ones.')).toBe('Read a file.')
    expect(firstSentence('No full stop')).toBe('No full stop')
  })
})

describe('openSetupSection', () => {
  it('bumps the open counter and leaves the section pending until taken', () => {
    const before = useSetupNav.getState().seq
    openSetupSection('mcp')
    const s = useSetupNav.getState()
    expect(s.seq).toBe(before + 1)
    expect(s.pending).toEqual({ section: 'mcp', seq: before + 1 })
    takeSetupSection(s.seq)
    expect(useSetupNav.getState().pending).toBeNull()
  })
  it('keeps a newer request when an older one is taken', () => {
    openSetupSection('skills')
    const old = useSetupNav.getState().seq
    openSetupSection('knowledge')
    takeSetupSection(old)
    expect(useSetupNav.getState().pending?.section).toBe('knowledge')
  })
})
