import { describe, expect, it } from 'vitest'
import type { ChatSession } from '../src/shared/types'
import { accessLevel, accessOf, chatMode, chatModeInfo, cyclesPermission, knowledgeCount, nextModePatch, planStatus } from '../src/renderer/src/lib/permissions'

const key = (over: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key: 'Tab', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...over })

describe('mode and access', () => {
  const chat = (permissions: 'auto' | 'manual' | 'plan', access?: 'auto' | 'manual', workflow: ChatSession['workflow'] = null) => ({ permissions, access, workflow })

  it('reads the mode apart from the access', () => {
    expect(chatMode(chat('auto'))).toBe('chat')
    expect(chatMode(chat('plan', 'auto'))).toBe('plan')
    expect(chatMode(chat('manual', 'manual', { kind: 'spec-ship', stage: 'build', slug: 'x' }))).toBe('spec')
    expect(chatMode(chat('manual', 'manual', { kind: 'spec-ship', stage: 'done', slug: 'x' }))).toBe('chat')
    expect(accessOf(chat('auto'))).toBe('auto')
    expect(accessOf(chat('plan', 'auto'))).toBe('auto')
    // Older chats in Plan mode have no access saved: Manual.
    expect(accessOf(chat('plan'))).toBe('manual')
  })

  it('switches Chat and Plan on Shift+Tab, keeping the access, and leaves Spec → ship alone', () => {
    expect(nextModePatch(chat('auto'))).toEqual({ permissions: 'plan' })
    expect(nextModePatch(chat('plan', 'auto'))).toEqual({ permissions: 'auto' })
    expect(nextModePatch(chat('plan'))).toEqual({ permissions: 'manual' })
    expect(nextModePatch(chat('manual', 'manual', { kind: 'spec-ship', stage: 'grill', slug: null }))).toBeNull()
  })

  it('names each mode and access level', () => {
    expect(accessLevel('manual').name).toBe('Manual')
    expect(chatModeInfo('plan').sub).toMatch(/after you approve/)
    expect(chatModeInfo('spec').name).toBe('Spec → ship')
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
