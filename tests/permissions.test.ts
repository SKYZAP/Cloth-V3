import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type Context } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Automation, ChatEvent, PendingApproval, Permissions, ToolTrace } from '../src/shared/types'
import { asksBeforeRisky, legacyPermissions, permissionCaps } from '../src/shared/permissions'
import { buildWorkspaceTools, NEEDS_PERSON, PLAN_REFUSAL } from '../src/main/agent/workspace'
import { mcpReadOnly } from '../src/main/mcp/client'
import { RISK } from '../src/main/agent/risk'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** The system prompt and tool declarations a model call got. */
const system = (ctx: Context) => JSON.stringify(ctx.messages.filter((m) => (m.role as string) === 'system'))
const SHELL = process.platform === 'win32' ? 'powershell' : 'bash'

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup(permissions: Permissions) {
  const env = makeServices()
  const root = mkdtempSync(join(tmpdir(), 'cloth-perm-'))
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: root, permissions, knowledgeEnabled: false, skillsEnabled: false, customTools: false, subagents: false })
  return { ...env, root, session, provider }
}

/** Wait for the chat's run to end, answering approvals as they come. */
async function settle(env: ReturnType<typeof setup>, onApproval?: (a: PendingApproval) => void) {
  const seen = new Set<string>()
  for (let i = 0; i < 500; i++) {
    for (const e of env.events) {
      const ev = e.payload as ChatEvent
      if (e.channel === 'chat' && ev.type === 'approval' && !seen.has(ev.approval.id)) {
        seen.add(ev.approval.id)
        onApproval?.(ev.approval)
      }
    }
    if (!env.services.chat.isRunning(env.session.id)) break
    await wait(10)
  }
  const msgs = env.services.chat.messages(env.session.id)
  const traces = msgs.flatMap((m) => m.blocks).filter((b) => b.type === 'tool').map((b) => (b as { trace: ToolTrace }).trace)
  return { msgs, traces }
}

describe('permission modes', () => {
  it('turn into tool switches in one place', () => {
    expect(permissionCaps('auto')).toEqual({ fileAccess: 'write', shell: true, autoApprove: 'all' })
    expect(permissionCaps('manual')).toEqual({ fileAccess: 'write', shell: true, autoApprove: 'all' })
    expect(permissionCaps('plan')).toEqual({ fileAccess: 'read', shell: false, autoApprove: 'none' })
    // Only a chat (someone to ask) in Auto skips the risk checks; unattended runs never do.
    expect(asksBeforeRisky('auto', true)).toBe(false)
    expect(asksBeforeRisky('manual', true)).toBe(true)
    expect(asksBeforeRisky('auto', false)).toBe(true)
    expect(asksBeforeRisky(undefined, false)).toBe(true)
  })

  it('map the old switches (migration), never to the looser Auto', () => {
    const ws = { workspace: '/x', container: null }
    expect(legacyPermissions({ fileAccess: 'write', shell: true, autoApprove: 'none' }, ws)).toBe('manual')
    expect(legacyPermissions({ fileAccess: 'write', shell: false, autoApprove: 'none' }, ws)).toBe('manual')
    expect(legacyPermissions({ fileAccess: 'write', shell: false, autoApprove: 'edits' }, ws)).toBe('manual')
    expect(legacyPermissions({ fileAccess: 'write', shell: true, autoApprove: 'all' }, ws)).toBe('manual')
    expect(legacyPermissions({ fileAccess: 'read', shell: false, autoApprove: 'none' }, ws)).toBe('plan')
    expect(legacyPermissions({ fileAccess: 'read', shell: false, autoApprove: 'all' }, ws)).toBe('plan')
    expect(legacyPermissions({ fileAccess: 'read', shell: true, autoApprove: 'none' }, ws)).toBe('manual')
    expect(legacyPermissions({}, ws)).toBe('plan')
    // Container chats work on a copy: Auto.
    expect(legacyPermissions({ fileAccess: 'read', autoApprove: 'none' }, { workspace: '/x', container: { image: 'node:22', network: true } })).toBe('auto')
    // Without a folder there is nothing to plan against: approvals are kept as they were.
    expect(legacyPermissions({ fileAccess: 'read', autoApprove: 'none' }, { workspace: null })).toBe('manual')
    expect(legacyPermissions({ fileAccess: 'read', autoApprove: 'all' }, { workspace: null })).toBe('manual')
  })

  it('migrates saved chats and keeps the old fields readable', () => {
    const { services } = makeServices()
    const save = (config: object) => {
      const s = services.chat.create({})
      services.ctx.db.prepare('UPDATE sessions SET config = ? WHERE id = ?').run(JSON.stringify(config), s.id)
      return services.chat.get(s.id)
    }
    expect(save({ workspace: '/w', fileAccess: 'write', shell: true, autoApprove: 'none' })).toMatchObject({ permissions: 'manual', fileAccess: 'write', shell: true, autoApprove: 'all' })
    expect(save({ workspace: '/w', fileAccess: 'write', autoApprove: 'edits' })).toMatchObject({ permissions: 'manual', fileAccess: 'write', shell: true, autoApprove: 'all' })
    expect(save({ workspace: '/w', fileAccess: 'read', shell: false })).toMatchObject({ permissions: 'plan', fileAccess: 'read', shell: false })
    expect(save({ workspace: '/w', fileAccess: 'write', shell: true, autoApprove: 'none', container: { image: 'node:22', network: true } })).toMatchObject({ permissions: 'auto' })
    // Once saved the mode is stored, and the old switches are not.
    const s = save({ workspace: '/w', fileAccess: 'read' })
    services.chat.update(s.id, { title: 'x' })
    const stored = JSON.parse((services.ctx.db.prepare('SELECT config FROM sessions WHERE id = ?').get(s.id) as { config: string }).config)
    expect(stored.permissions).toBe('plan')
    expect(stored).not.toHaveProperty('fileAccess')
  })

  it('new chats start in the default mode; the old switches still set a mode', () => {
    const { services } = makeServices()
    expect(services.chat.create({}).permissions).toBe('manual')
    services.settings.update({ defaultPermissions: 'auto' })
    expect(services.chat.create({}).permissions).toBe('auto')
    expect(services.chat.create({ permissions: 'plan' }).permissions).toBe('plan')
    const s = services.chat.create({ workspace: '/w', fileAccess: 'write', autoApprove: 'edits' })
    expect(s.permissions).toBe('manual')
    expect(services.chat.update(s.id, { permissions: 'auto' }).permissions).toBe('auto')
    expect(services.chat.update(s.id, { autoApprove: 'none' }).permissions).toBe('manual')
    expect(services.chat.update(s.id, { fileAccess: 'read', shell: false }).permissions).toBe('plan')
    expect(services.chat.update(s.id, { permissions: 'auto' })).toMatchObject({ permissions: 'auto', fileAccess: 'write', shell: true, autoApprove: 'all' })
  })

  it('remembers the access while in Plan mode, apart from the mode', () => {
    const { services } = makeServices()
    const s = services.chat.create({ workspace: '/w', permissions: 'auto' })
    expect(s.access).toBe('auto')
    // Into Plan: read-only, but Auto is what it goes back to.
    expect(services.chat.update(s.id, { permissions: 'plan' })).toMatchObject({ permissions: 'plan', access: 'auto', fileAccess: 'read' })
    // Changing the access while planning leaves the chat in Plan.
    expect(services.chat.update(s.id, { access: 'manual' })).toMatchObject({ permissions: 'plan', access: 'manual' })
    expect(services.chat.update(s.id, { title: 'x' }).access).toBe('manual')
    // Outside Plan the access follows the mode.
    expect(services.chat.update(s.id, { permissions: 'auto' })).toMatchObject({ permissions: 'auto', access: 'auto' })
  })

  it('moves chats, project defaults and the default saved as Auto to Manual, once', () => {
    const { services } = makeServices()
    const db = services.ctx.db
    const raw = (id: string) => JSON.parse((db.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as { config: string }).config)
    const auto = services.chat.create({ workspace: '/w', permissions: 'auto' })
    const manual = services.chat.create({ workspace: '/w', permissions: 'manual' })
    const plan = services.chat.create({ workspace: '/w', permissions: 'plan' })
    const project = services.projects.create({ name: 'P', defaults: { permissions: 'auto' } })
    services.settings.update({ defaultPermissions: 'auto' })
    // As if this install predates the change.
    services.ctx.kv.set('permissions.autoToManual', false)
    expect(services.chat.migrateAutoToManual()).toBe(1)
    expect(raw(auto.id).permissions).toBe('manual')
    expect(raw(manual.id).permissions).toBe('manual')
    expect(raw(plan.id).permissions).toBe('plan')
    expect(services.projects.get(project.id).defaults.permissions).toBe('manual')
    expect(services.settings.get().defaultPermissions).toBe('manual')
    // A second run is a no-op: Auto chosen afterwards stays Auto.
    services.chat.update(auto.id, { permissions: 'auto' })
    services.settings.update({ defaultPermissions: 'auto' })
    expect(services.chat.migrateAutoToManual()).toBe(0)
    expect(raw(auto.id).permissions).toBe('auto')
    expect(services.settings.get().defaultPermissions).toBe('auto')
  })

  it('a fresh install defaults new chats to Manual', () => {
    const { services } = makeServices()
    expect(services.settings.get().defaultPermissions).toBe('manual')
    expect(services.chat.create({}).permissions).toBe('manual')
  })

  it('a chat set up from a read-only agent plans; a planning chat stays in Plan', () => {
    const { services } = makeServices()
    const reader = services.agents.create({ name: 'Reader', fileAccess: 'read' })
    const editor = services.agents.create({ name: 'Editor', fileAccess: 'write', shell: true, autoApprove: 'none' })
    const auto = services.chat.create({ workspace: '/w', permissions: 'auto' })
    expect(services.chat.useAgent(auto.id, reader.id).permissions).toBe('plan')
    expect(services.chat.useAgent(auto.id, editor.id).permissions).toBe('plan')
    const other = services.chat.create({ workspace: '/w', permissions: 'auto' })
    expect(services.chat.useAgent(other.id, editor.id).permissions).toBe('manual')
  })

  it('decide which tools a chat gets', async () => {
    const names = async (p: Permissions) => {
      const env = setup(p)
      return (await env.services.chat.setup(env.session.id)).tools.filter((t) => t.on).map((t) => t.name)
    }
    const auto = await names('auto')
    const manual = await names('manual')
    const plan = await names('plan')
    for (const t of ['read', 'grep', 'write', 'edit', 'ast_edit', SHELL]) {
      expect(auto).toContain(t)
      expect(manual).toContain(t)
    }
    for (const t of ['write', 'edit', 'ast_edit', 'bash', 'powershell']) expect(plan).not.toContain(t)
    expect(plan).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls', 'present_plan']))
    expect(auto).not.toContain('present_plan')
  })

  it('Plan mode takes only MCP tools that say they read (or trusted servers)', () => {
    expect(mcpReadOnly({ approval: 'ask' }, { annotations: { readOnlyHint: true } })).toBe(true)
    expect(mcpReadOnly({ approval: 'ask' }, {})).toBe(false)
    expect(mcpReadOnly({ approval: 'ask' }, { annotations: { readOnlyHint: false } })).toBe(false)
    expect(mcpReadOnly({ approval: 'auto' }, {})).toBe(true)
  })
})

describe('approvals by mode', () => {
  it('Auto runs changes, commands and risky commands without asking', async () => {
    const env = setup('auto')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'a.txt', content: 'a' }, { id: 'w' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(SHELL, { command: 'echo quiet-run' }, { id: 'c1' })], { stopReason: 'toolUse' }),
      // Risky (a push), but the folder is no repository, so it fails harmlessly once it runs.
      fauxAssistantMessage([fauxToolCall(SHELL, { command: 'git push origin main' }, { id: 'c2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('ok')
    ])
    await env.services.chat.send(env.session.id, 'go')
    const asked: PendingApproval[] = []
    const { traces } = await settle(env, (a) => {
      asked.push(a)
      env.services.chat.resolveApproval(a.id, 'deny')
    })
    expect(asked).toHaveLength(0)
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('a')
    expect(traces.find((t) => t.id === 'c1')?.result).toContain('quiet-run')
    const push = traces.find((t) => t.id === 'c2')
    expect(push).toBeDefined()
    expect(push?.result ?? '').not.toContain(NEEDS_PERSON)
    expect(push?.result ?? '').not.toContain('declined')
    expect(env.services.chat.get(env.session.id).permissions).toBe('auto')
  }, 30_000)

  it('Manual asks only before risky actions, never for plain changes, commands or reads', async () => {
    const env = setup('manual')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'a.txt', content: 'a' }, { id: 'w' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('read', { path: 'a.txt' }, { id: 'r' }), fauxToolCall('grep', { pattern: 'a' }, { id: 'g' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(SHELL, { command: 'echo manual-run' }, { id: 'c' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(SHELL, { command: 'git push origin main' }, { id: 'c2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('ok')
    ])
    await env.services.chat.send(env.session.id, 'go')
    const asked: PendingApproval[] = []
    const { traces } = await settle(env, (a) => {
      asked.push(a)
      env.services.chat.resolveApproval(a.id, 'deny')
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'command', command: 'git push origin main', risk: RISK.push })
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('a')
    expect(traces.find((t) => t.id === 'r')?.status).toBe('ok')
    expect(traces.find((t) => t.id === 'c')?.result).toContain('manual-run')
    expect(traces.find((t) => t.id === 'c2')).toMatchObject({ status: 'error' })
    // Declining keeps the mode.
    expect(env.services.chat.get(env.session.id).permissions).toBe('manual')
  }, 30_000)

  it('"Switch to Auto" on a Manual approval allows it and switches the chat to Auto', async () => {
    const env = setup('manual')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(SHELL, { command: 'git push origin main' }, { id: 'a' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(SHELL, { command: 'git push origin dev' }, { id: 'b' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('ok')
    ])
    await env.services.chat.send(env.session.id, 'go')
    let asks = 0
    const { traces } = await settle(env, (a) => {
      asks++
      env.services.chat.resolveApproval(a.id, 'always')
    })
    expect(asks).toBe(1)
    expect(env.services.chat.get(env.session.id).permissions).toBe('auto')
    expect(traces.find((t) => t.id === 'a')?.result ?? '').not.toContain('declined')
    expect(traces.find((t) => t.id === 'b')).toBeDefined()
  }, 30_000)

  it('a container skips the risk checks; nobody to ask refuses risky actions; Plan refuses changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloth-perm-'))
    const ran: string[] = []
    const tools = (o: Partial<Parameters<typeof buildWorkspaceTools>[0]>) =>
      buildWorkspaceTools({ root, sessionId: null, access: 'write', shell: true, approvals: null, checkpoints: null, autoApprove: () => 'all', checkRisk: true, ...o })
    const shellExec = async (command: string, _cwd: string, options: { onData: (b: Buffer) => void }) => {
      ran.push(command)
      options.onData(Buffer.from('ok'))
      return { exitCode: 0 }
    }
    const run = (list: AgentTool<any>[], name: string, args: unknown) => list.find((t) => t.name === name)!.execute('t1', args)
    // In a container: no question, it runs.
    await run(tools({ shellExec }), 'bash', { command: 'git push --force' })
    expect(ran).toEqual(['git push --force'])
    // On this PC with nobody to ask: refused with a note for the model, no waiting.
    await expect(run(tools({}), SHELL, { command: 'git push' })).rejects.toThrow(NEEDS_PERSON)
    await expect(run(tools({}), SHELL, { command: 'git push' })).rejects.toThrow(RISK.push)
    // Plan mode switched on mid-run: the tools are there but refuse.
    await expect(run(tools({ readOnly: () => true }), 'write', { path: 'x.txt', content: 'x' })).rejects.toThrow(PLAN_REFUSAL)
    expect(existsSync(join(root, 'x.txt'))).toBe(false)
  })
})

describe('Plan mode', () => {
  it('presents a plan and stops; approving switches the mode and carries on', async () => {
    const env = setup('plan')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage([fauxToolCall('present_plan', { title: 'Add a notes file', steps: ['Create notes.md', 'Write the summary'], notes: 'No tests needed' }, { id: 'p' })], { stopReason: 'toolUse' })
      },
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage([fauxToolCall('write', { path: 'notes.md', content: '# Notes\n' }, { id: 'w' })], { stopReason: 'toolUse' })
      },
      () => fauxAssistantMessage('Done.')
    ])
    await env.services.chat.send(env.session.id, 'add a notes file')
    const first = await settle(env)
    // The run stopped right after the plan: one model call.
    expect(seen).toHaveLength(1)
    expect(system(seen[0])).toContain('## Permissions: Plan mode')
    expect(system(seen[0])).toContain('present_plan')
    expect(system(seen[0])).not.toMatch(/"name":\s*"write"/)
    const plan = first.traces.find((t) => t.id === 'p')!
    expect(plan.status).toBe('ok')
    expect(plan.plan).toEqual({ title: 'Add a notes file', steps: ['Create notes.md', 'Write the summary'], notes: 'No tests needed' })

    const approved = await env.services.chat.approvePlan(env.session.id, 'auto')
    expect(approved).toMatchObject({ permissions: 'auto', fileAccess: 'write' })
    const asked: PendingApproval[] = []
    const after = await settle(env, (a) => asked.push(a))
    expect(asked).toHaveLength(0)
    expect(readFileSync(join(env.root, 'notes.md'), 'utf8')).toBe('# Notes\n')
    expect(system(seen[1])).toMatch(/"name":\s*"write"/)
    // The mode section was replaced: the current prompt says Auto.
    expect(getCurrentSystemPrompt(seen[1].messages)).toContain('## Permissions: Auto')
    expect(getCurrentSystemPrompt(seen[1].messages)).not.toContain('## Permissions: Plan mode')
    expect(JSON.stringify(seen[1].messages.at(-1))).toContain('Plan approved. Carry it out.')
    // The transcript shows a short user line, marked as the approval.
    const line = after.msgs.filter((m) => m.role === 'user').at(-1)!
    expect(line.blocks).toEqual([{ type: 'text', text: 'Approved the plan' }])
    expect(line.planApproval).toBe('auto')
    expect(after.msgs.at(-1)?.blocks.some((b) => b.type === 'text' && b.text === 'Done.')).toBe(true)
  }, 30_000)

  it('a chat switched to Plan later is told so, and loses its write tools', async () => {
    const env = setup('auto')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage('hi')
      },
      (ctx) => {
        seen.push(ctx)
        return fauxAssistantMessage('planning')
      }
    ])
    await env.services.chat.send(env.session.id, 'hello')
    await settle(env)
    expect(getCurrentSystemPrompt(seen[0].messages)).toContain('## Permissions: Auto')
    env.services.chat.update(env.session.id, { permissions: 'plan' })
    await env.services.chat.send(env.session.id, 'now plan something')
    await settle(env)
    const prompt = getCurrentSystemPrompt(seen[1].messages)
    expect(prompt).toContain('## Permissions: Plan mode')
    expect(prompt).not.toContain('## Permissions: Auto')
    expect(system(seen[1])).toMatch(/"toolsRemoved":\[[^\]]*"name":"write"/)
    expect(system(seen[1])).toMatch(/"name":"present_plan"/)
  }, 30_000)

  it('approving in Manual carries on without asking for plain changes', async () => {
    const env = setup('plan')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('present_plan', { title: 'x', steps: ['write x'] }, { id: 'p' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('write', { path: 'x.txt', content: 'x' }, { id: 'w' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.')
    ])
    await env.services.chat.send(env.session.id, 'plan it')
    await settle(env)
    expect((await env.services.chat.approvePlan(env.session.id, 'manual')).permissions).toBe('manual')
    const asked: PendingApproval[] = []
    await settle(env, (a) => {
      asked.push(a)
      env.services.chat.resolveApproval(a.id, 'allow')
    })
    expect(asked).toHaveLength(0)
    expect(existsSync(join(env.root, 'x.txt'))).toBe(true)
  }, 30_000)
})

describe('automations', () => {
  it('refuse a risky command instead of waiting for a person', async () => {
    const made = makeServices()
    const { services } = made
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const folder = mkdtempSync(join(tmpdir(), 'cloth-perm-auto-'))
    let results: string[] = []
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall(SHELL, { command: 'git push origin main' }, { id: 'c1' })], { stopReason: 'toolUse' }),
      (ctx) => {
        results = ctx.messages.filter((m) => (m.role as string) === 'toolResult').map((m) => JSON.stringify(m))
        return fauxAssistantMessage('Reported.')
      }
    ])
    const base: Automation = { prompt: 'Ship it.', agentId: null, tools: [], servers: [], collectionIds: [], skills: [], deliver: 'notify', collectionId: null, watch: null, commands: { mode: 'allowlist', allow: ['git'] } }
    const wf = services.workflows.createAutomation({ name: 'Pusher', automation: base, workspace: folder })
    const started = Date.now()
    const run = await services.workflows.run(wf.id, undefined)
    expect(run.error).toBeNull()
    expect(results[0]).toContain(RISK.push)
    expect(results[0]).toContain('nobody is here to give it')
    expect(Date.now() - started).toBeLessThan(20_000)
    services.workflows.stopScheduler()
  }, 30_000)
})
