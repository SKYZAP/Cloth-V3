import { describe, expect, it } from 'vitest'
import { cyclesPermission, knowledgeCount, nextPermission, permissionMode, planStatus } from '../src/renderer/src/lib/permissions'

const key = (over: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key: 'Tab', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...over })

describe('permission mode cycling', () => {
  it('goes auto → manual → plan → auto', () => {
    expect(nextPermission('auto')).toBe('manual')
    expect(nextPermission('manual')).toBe('plan')
    expect(nextPermission('plan')).toBe('auto')
  })

  it('names each mode', () => {
    expect(permissionMode('manual').name).toBe('Manual')
    expect(permissionMode('plan').sub).toMatch(/Nothing changes until you approve it/)
  })

  it('cycles on Shift+Tab only in the composer or with nothing focused', () => {
    expect(cyclesPermission(key(), 'composer')).toBe(true)
    expect(cyclesPermission(key(), 'none')).toBe(true)
    expect(cyclesPermission(key(), 'other')).toBe(false)
    expect(cyclesPermission(key({ shiftKey: false }), 'composer')).toBe(false)
    expect(cyclesPermission(key({ ctrlKey: true }), 'composer')).toBe(false)
    expect(cyclesPermission(key({ key: 'Enter' }), 'composer')).toBe(false)
  })
})

describe('plan status', () => {
  const a = { role: 'assistant' as const }
  it('is open when the plan is the latest message and nothing runs', () => {
    expect(planStatus([{ role: 'user' }, a], 1, false)).toBe('open')
    expect(planStatus([{ role: 'user' }, a], 1, true)).toBe('closed')
  })
  it('is approved when the next message approved it, closed when the chat moved on', () => {
    expect(planStatus([a, { role: 'user', planApproval: 'auto' }], 0, true)).toBe('approved')
    expect(planStatus([a, { role: 'user' }], 0, false)).toBe('closed')
  })
})

describe('knowledge count', () => {
  it('counts every collection when none are picked, only known picks otherwise, none when off', () => {
    expect(knowledgeCount({ knowledgeEnabled: true, collectionIds: [] }, ['a', 'b'])).toBe(2)
    expect(knowledgeCount({ knowledgeEnabled: true, collectionIds: ['a', 'gone'] }, ['a', 'b'])).toBe(1)
    expect(knowledgeCount({ knowledgeEnabled: false, collectionIds: [] }, ['a', 'b'])).toBe(0)
  })
})
