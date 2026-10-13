import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { AgentTier, ChatEvent, ModelRef, ToolTrace } from '../src/shared/types'
import { parseOutcome, resolveDelegation, throttle } from '../src/main/agent/chat'
import { DEFAULT_TIER_INSTRUCTIONS } from '../src/main/core/settings'
import { makeServices } from './helpers'

const SHELL = process.platform === 'win32' ? 'powershell' : 'bash'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
  vi.useRealTimers()
})

function setup(opts: { fileAccess?: 'read' | 'write'; autoTiers?: boolean; autoApprove?: 'none' | 'edits' } = {}) {
  const env = makeServices()
  const root = mkdtempSync(join(tmpdir(), 'cloth-tier-'))
  writeFileSync(join(root, 'config.txt'), 'port=4242\n')
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const session = env.services.chat.create({
    model: { providerId: provider.id, modelId: 'faux-1' },
    workspace: root,
    fileAccess: opts.fileAccess ?? 'read',
    autoApprove: opts.autoApprove ?? 'edits',
    subagents: true,
    knowledgeEnabled: false,
    skillsEnabled: false,
    customTools: false,
    ...(opts.autoTiers === undefined ? {} : { autoTiers: opts.autoTiers })
  })
  return { ...env, root, session, provider }
}

async function send(env: ReturnType<typeof setup>, text: string) {
  await env.services.chat.send(env.session.id, text)
  for (let i = 0; i < 800 && env.services.chat.isRunning(env.session.id); i++) await wait(10)
  return traces(env)
}

function traces(env: ReturnType<typeof setup>): ToolTrace[] {
  return env.services.chat
    .messages(env.session.id)
    .flatMap((m) => m.blocks)
    .filter((b) => b.type === 'tool')
    .map((b) => (b as { trace: ToolTrace }).trace)
}

const isChild = (ctx: TranscriptContext) => JSON.stringify(ctx.messages[0] ?? '').includes('You are a subagent')
const taskTool = (ctx: TranscriptContext) =>
  (ctx.messages as unknown as { role: string; toolsAdded?: { name: string; parameters: { properties: Record<string, unknown> } }[] }[])
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.toolsAdded ?? [])
    .find((t) => t.name === 'task')

describe('agent tiers', () => {
  it('seeds the default tiers and gives new ones a tier_ id', () => {
    const env = setup()
    const tiers = env.services.settings.get().agentTiers
    expect(tiers.map((t) => [t.id, t.name, t.model, t.thinking])).toEqual([
      ['light', 'Light', null, 'low'],
      ['medium', 'Medium', null, 'medium'],
      ['careful', 'Careful', null, 'high'],
      ['heavy', 'Heavy', null, 'xhigh']
    ])
    expect(tiers.every((t) => t.purpose.length > 10)).toBe(true)
    const next = env.services.settings.update({ agentTiers: [{ ...tiers[0], name: 'Quick' }, { id: '', name: 'Mine', model: null, thinking: 'minimal', purpose: 'x', instructions: '' }] }).agentTiers
    expect(next[0]).toMatchObject({ id: 'light', name: 'Quick' })
    expect(next[1].id).toMatch(/^tier_/)
    // An old effort ('minimal') reads as Light.
    expect(next[1].thinking).toBe('low')
    expect(env.services.settings.get().agentTiers).toHaveLength(2)
    // Agents and chats carry their tier settings.
    const agent = env.services.agents.create({ name: 'Fixer', tier: 'light' })
    expect(agent.tier).toBe('light')
    expect(env.services.agents.update(agent.id, { tier: null }).tier).toBeNull()
    expect(env.session.autoTiers).toBe(true)
    expect(env.services.chat.update(env.session.id, { autoTiers: false }).autoTiers).toBe(false)
  })

  it('fills missing tier instructions from the defaults and keeps an explicit empty one', () => {
    const env = setup()
    const tiers = env.services.settings.get().agentTiers
    expect(tiers.map((t) => t.instructions)).toEqual(['light', 'medium', 'careful', 'heavy'].map((id) => DEFAULT_TIER_INSTRUCTIONS[id]))
    expect(DEFAULT_TIER_INSTRUCTIONS.careful).toContain('invariants')
    expect(DEFAULT_TIER_INSTRUCTIONS.heavy).toContain('reproduce first')
    const legacy = tiers.map(({ instructions: _, ...t }) => t) as AgentTier[]
    const saved = env.services.settings.update({ agentTiers: [legacy[0], { ...legacy[2], instructions: '' }, { ...legacy[3], instructions: '  Be brief.  ' }, { id: 'mine', name: 'Mine', model: null, thinking: null, purpose: '' } as unknown as AgentTier] }).agentTiers
    expect(saved.map((t) => t.instructions)).toEqual([DEFAULT_TIER_INSTRUCTIONS.light, '', 'Be brief.', ''])
    // Tiers saved on disk before instructions existed get the defaults when loaded.
    ;(env.services.settings as unknown as { ctx: { kv: { set(k: string, v: unknown): void } } }).ctx.kv.set('settings', { agentTiers: legacy })
    expect(env.services.settings.get().agentTiers.map((t) => t.instructions)).toEqual(tiers.map((t) => t.instructions))
  })

  it("reads efforts saved before the four levels ('off', 'minimal') as Light", () => {
    const env = setup()
    const kv = (env.services.settings as unknown as { ctx: { kv: { set(k: string, v: unknown): void } } }).ctx.kv
    const tiers = env.services.settings.get().agentTiers
    kv.set('settings', { subagents: { thinking: 'minimal' }, agentTiers: [{ ...tiers[0], thinking: 'off' }, { ...tiers[1], thinking: null }, { ...tiers[3], thinking: 'xhigh' }] })
    const s = env.services.settings.get()
    expect(s.subagents.thinking).toBe('low')
    expect(s.agentTiers.map((t) => t.thinking)).toEqual(['low', null, 'xhigh'])
    kv.set('settings', { subagents: { thinking: 'inherit' } })
    expect(env.services.settings.get().subagents.thinking).toBe('inherit')
    // Chats and saved agents too.
    expect(env.services.chat.update(env.session.id, { thinking: 'off' }).thinking).toBe('low')
    expect(env.services.chat.update(env.session.id, { thinking: 'xhigh' }).thinking).toBe('xhigh')
    const agent = env.services.agents.create({ name: 'Old', thinking: 'minimal' })
    expect(env.services.agents.get(agent.id).thinking).toBe('low')
    expect(env.services.agents.update(agent.id, { thinking: null }).thinking).toBeNull()
  })

  it('reads the Result line of a report', () => {
    expect(parseOutcome('Result: done\nFiles: a.ts')).toBe('done')
    expect(parseOutcome('**Result:** blocked\n...')).toBe('blocked')
    expect(parseOutcome('Some preamble\nResult: partially done')).toBe('partial')
    expect(parseOutcome('result: PARTLY DONE')).toBe('partial')
    expect(parseOutcome('RESULT: Done.')).toBe('done')
    expect(parseOutcome('All finished, nothing blocked.')).toBeUndefined()
    expect(parseOutcome('')).toBeUndefined()
  })

  describe('resolveDelegation', () => {
    const chat: ModelRef = { providerId: 'p', modelId: 'chat' }
    const big: ModelRef = { providerId: 'p', modelId: 'big' }
    const own: ModelRef = { providerId: 'p', modelId: 'own' }
    const gone: ModelRef = { providerId: 'gone', modelId: 'x' }
    const tiers: AgentTier[] = [
      { id: 'light', name: 'Light', model: null, thinking: 'low', purpose: '', instructions: '' },
      { id: 'heavy', name: 'Heavy', model: big, thinking: 'high', purpose: '', instructions: '' }
    ]
    const usable = (m: ModelRef | null | undefined): m is ModelRef => !!m && m.providerId === 'p'
    const base = { tiers, usable, chat: { model: chat, thinking: 'medium' as const }, fallback: { model: { providerId: 'p', modelId: 'settings' }, thinking: 'minimal' as const } }

    it('an explicit tier wins over the agent when the chat allows tiers', () => {
      const r = resolveDelegation({ ...base, autoTiers: true, tierArg: 'heavy', agent: { model: own, thinking: 'low', tier: 'light' } })
      expect(r).toMatchObject({ model: big, thinking: 'high', tier: { id: 'heavy' } })
      expect(r.note).toBeUndefined()
    })

    it('a tier with no model uses the chat model and its own effort', () => {
      expect(resolveDelegation({ ...base, autoTiers: true, tierArg: 'light', agent: null })).toMatchObject({ model: chat, thinking: 'low', tier: { id: 'light' } })
    })

    it('ignores the tier argument when the chat does not allow tiers', () => {
      const r = resolveDelegation({ ...base, autoTiers: false, tierArg: 'heavy', agent: null })
      expect(r).toMatchObject({ model: base.fallback.model, thinking: 'minimal' })
      expect(r.tier).toBeUndefined()
    })

    it('an unknown tier is ignored with a note', () => {
      const r = resolveDelegation({ ...base, autoTiers: true, tierArg: 'nope', agent: { model: own, thinking: 'low', tier: null } })
      expect(r).toMatchObject({ model: own, thinking: 'low' })
      expect(r.tier).toBeUndefined()
      expect(r.note).toContain('"nope"')
    })

    it("the agent's own model and effort, then its tier, then the fallback", () => {
      expect(resolveDelegation({ ...base, autoTiers: true, agent: { model: own, thinking: 'low', tier: 'heavy' } })).toEqual({ model: own, thinking: 'low' })
      expect(resolveDelegation({ ...base, autoTiers: true, agent: { model: own, thinking: null, tier: 'heavy' } })).toMatchObject({ model: own, thinking: 'high', tier: { id: 'heavy' } })
      expect(resolveDelegation({ ...base, autoTiers: true, agent: { model: null, thinking: null, tier: 'heavy' } })).toMatchObject({ model: big, thinking: 'high', tier: { id: 'heavy' } })
      expect(resolveDelegation({ ...base, autoTiers: true, agent: { model: gone, thinking: null, tier: 'light' } })).toMatchObject({ model: chat, thinking: 'low', tier: { id: 'light' } })
      // A tier the agent points at that was deleted: the fallback.
      expect(resolveDelegation({ ...base, autoTiers: true, agent: { model: null, thinking: null, tier: 'deleted' } })).toEqual({ model: base.fallback.model, thinking: 'minimal' })
      expect(resolveDelegation({ ...base, autoTiers: true, agent: null })).toEqual({ model: base.fallback.model, thinking: 'minimal' })
    })
  })

  it('throttles to one call per interval, keeping the latest value', () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const t = throttle((v: number) => seen.push(v), 250)
    t(1)
    t(2)
    t(3)
    expect(seen).toEqual([1])
    vi.advanceTimersByTime(249)
    expect(seen).toEqual([1])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([1, 3])
    t(4)
    t.cancel()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([1, 3])
  })

  it('offers tier and step on task, with the planning sentences, only when autoTiers is on', async () => {
    for (const autoTiers of [true, false]) {
      const env = setup({ autoTiers })
      faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
      let params: Record<string, unknown> = {}
      let prompt = ''
      faux.setResponses([
        (ctx) => {
          params = taskTool(ctx)!.parameters.properties
          prompt = JSON.stringify(ctx.messages[0])
          return fauxAssistantMessage('hi')
        }
      ])
      await send(env, 'hello')
      expect('step' in params).toBe(true)
      expect('tier' in params).toBe(autoTiers)
      if (autoTiers) expect(JSON.stringify(params.tier)).toContain('Mechanical edits')
      expect(prompt.includes('cheapest `tier`')).toBe(autoTiers)
      expect(prompt.includes('Treat each report as a claim')).toBe(autoTiers)
      faux.unregister()
      faux = null
    }
  })

  it('runs at the tier asked for and stores the step it was for', async () => {
    const env = setup()
    env.services.settings.update({ agentTiers: env.services.settings.get().agentTiers.map((t) => (t.id === 'heavy' ? { ...t, model: { providerId: env.provider.id, modelId: 'faux-big' } } : t)) })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let childModel = ''
    const child = (ctx: TranscriptContext, _o: unknown, _s: unknown, model: { id: string }) => {
      if (isChild(ctx) && JSON.stringify(ctx.messages).includes('Read config.txt')) childModel = model.id
      return fauxAssistantMessage('report')
    }
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('todo_write', { todos: [{ content: 'Find the port', status: 'completed' }, { content: 'Check the config', status: 'in_progress' }] }, { id: 'todo' })
        ],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage(
        [
          fauxToolCall('task', { description: 'Check config', prompt: 'Read config.txt.', tier: 'heavy', step: 2 }, { id: 't1' }),
          fauxToolCall('task', { description: 'Light job', prompt: 'Say hi.', tier: 'light', step: 9 }, { id: 't2' })
        ],
        { stopReason: 'toolUse' }
      ),
      child,
      child,
      fauxAssistantMessage('Done.')
    ])
    const all = await send(env, 'go')
    const t1 = all.find((t) => t.id === 't1')!
    expect(t1.subagent).toMatchObject({ tier: 'heavy', tierName: 'Heavy', model: 'faux-big', step: 2, stepText: 'Check the config' })
    expect(childModel).toBe('faux-big')
    const t2 = all.find((t) => t.id === 't2')!
    expect(t2.subagent).toMatchObject({ tier: 'light', tierName: 'Light', model: 'faux-1' })
    expect(t2.subagent?.step).toBeUndefined()
    expect(t2.subagent?.stepText).toBeUndefined()
  })

  it("adds the tier's rules to the subagent's prompt and records the report's outcome", async () => {
    const env = setup()
    env.services.settings.update({ agentTiers: env.services.settings.get().agentTiers.map((t) => (t.id === 'light' ? { ...t, instructions: '' } : t)) })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const prompts: Record<string, string> = {}
    const child = (ctx: TranscriptContext) => {
      const sys = JSON.stringify(ctx.messages[0])
      const job = JSON.stringify(ctx.messages).includes('Job A') ? 'a' : 'b'
      prompts[job] = sys
      return fauxAssistantMessage(job === 'a' ? '**Result:** partly done\nFiles: none' : 'All good.')
    }
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('task', { description: 'A', prompt: 'Job A.', tier: 'careful' }, { id: 'a' }),
          fauxToolCall('task', { description: 'B', prompt: 'Job B.', tier: 'light' }, { id: 'b' })
        ],
        { stopReason: 'toolUse' }
      ),
      child,
      child,
      fauxAssistantMessage('Done.')
    ])
    const all = await send(env, 'go')
    expect(prompts.a).toContain('Rules for this job (Careful tier):')
    expect(prompts.a).toContain('list the invariants')
    expect(prompts.a.indexOf('Result: done')).toBeLessThan(prompts.a.indexOf('Rules for this job'))
    expect(prompts.b).not.toContain('Rules for this job')
    expect(all.find((t) => t.id === 'a')!.subagent?.outcome).toBe('partial')
    expect(all.find((t) => t.id === 'b')!.subagent?.outcome).toBeUndefined()
  })

  it('reports what a running subagent is doing, its usage so far, and the files it changed', async () => {
    const env = setup({ fileAccess: 'write', autoApprove: 'none' })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('task', { description: 'Bump the port', prompt: 'Change port=4242 to port=8080 in config.txt.', role: 'worker' }, { id: 'task' })], { stopReason: 'toolUse' }),
      async () => (await wait(300), fauxAssistantMessage([fauxToolCall('read', { path: 'config.txt' }, { id: 'r1' })], { stopReason: 'toolUse' })),
      async () => (await wait(300), fauxAssistantMessage([fauxToolCall('edit', { path: 'config.txt', edits: [{ oldText: 'port=4242', newText: 'port=8080' }] }, { id: 'e1' })], { stopReason: 'toolUse' })),
      // A risky command (a push; the folder is no repository) waits for approval in Manual.
      async () => (await wait(300), fauxAssistantMessage([fauxToolCall(SHELL, { command: 'git push origin main' }, { id: 'c1' })], { stopReason: 'toolUse' })),
      fauxAssistantMessage('Changed config.txt.'),
      fauxAssistantMessage('Done.')
    ])
    const running = () =>
      env.events
        .filter((e) => e.channel === 'chat')
        .map((e) => e.payload as ChatEvent)
        .flatMap((e) => (e.type === 'message' ? e.message.blocks : []))
        .map((b) => (b.type === 'tool' && b.trace.id === 'task' ? b.trace.subagent : undefined))
        .filter((s) => s?.running)
    const done = send(env, 'bump it')
    // The push waits for approval: by then the subagent shows it as its current tool.
    let approvalId = ''
    for (let i = 0; i < 400 && !approvalId; i++) {
      const a = env.events.map((e) => e.payload as ChatEvent).find((e) => e.type === 'approval')
      if (a?.type === 'approval') approvalId = a.approval.id
      else await wait(10)
    }
    expect(approvalId).not.toBe('')
    await wait(400)
    const live = running()
    const last = live.at(-1)!
    expect(last.current).toEqual({ tool: SHELL, summary: '$ git push origin main' })
    const withUsage = live.filter((s) => s?.usage)
    expect(withUsage.length).toBeGreaterThan(1)
    expect(last.usage!.input).toBeGreaterThan(withUsage[0]!.usage!.input)
    env.services.chat.resolveApproval(approvalId, 'deny')
    await done
    const task = traces(env).find((t) => t.id === 'task')!
    expect(task.subagent).toMatchObject({ running: false, files: ['config.txt'] })
    expect(task.subagent?.current).toBeUndefined()
    expect(task.subagent?.usage?.input).toBeGreaterThan(0)
  })
})
