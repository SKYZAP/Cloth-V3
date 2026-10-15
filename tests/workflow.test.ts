import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type Context } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, Permissions, ToolTrace } from '../src/shared/types'
import { DOCS_ONLY_REFUSAL, docsOnly, isDocPath, nextStage, workflowSection } from '../src/main/agent/workflow'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const system = (ctx: Context) => JSON.stringify(ctx.messages.filter((m) => (m.role as string) === 'system'))

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

function setup(permissions: Permissions = 'manual') {
  const env = makeServices()
  const root = mkdtempSync(join(tmpdir(), 'cloth-flow-'))
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: root, permissions, knowledgeEnabled: false, skillsEnabled: false, customTools: false, subagents: false })
  return { ...env, root, session }
}

async function settle(env: ReturnType<typeof setup>) {
  for (let i = 0; i < 500; i++) {
    if (!env.services.chat.isRunning(env.session.id)) break
    await wait(10)
  }
  const msgs = env.services.chat.messages(env.session.id)
  const traces = msgs.flatMap((m) => m.blocks).filter((b) => b.type === 'tool').map((b) => (b as { trace: ToolTrace }).trace)
  return { msgs, traces }
}

describe('Spec → ship helpers', () => {
  it('allows only the glossary and docs/ before Build', () => {
    expect(isDocPath('GLOSSARY.md')).toBe(true)
    expect(isDocPath('docs/specs/x/spec.md')).toBe(true)
    expect(isDocPath('./docs/adr/0001-x.md')).toBe(true)
    expect(isDocPath('src/index.ts')).toBe(false)
    expect(isDocPath('docs/../src/x.ts')).toBe(false)
    expect(docsOnly({ kind: 'spec-ship', stage: 'grill', slug: null })).toBe(true)
    expect(docsOnly({ kind: 'spec-ship', stage: 'tickets', slug: 'x' })).toBe(true)
    expect(docsOnly({ kind: 'spec-ship', stage: 'build', slug: 'x' })).toBe(false)
    expect(docsOnly(null)).toBe(false)
  })

  it('walks the stages in order and ends at done', () => {
    expect(['grill', 'spec', 'tickets', 'build', 'review'].map((s) => nextStage(s as never))).toEqual(['spec', 'tickets', 'build', 'review', 'done'])
    expect(nextStage('done')).toBe('done')
    expect(workflowSection(null)).toBeNull()
    expect(workflowSection({ kind: 'spec-ship', stage: 'spec', slug: 'saved-searches' })).toContain('docs/specs/saved-searches')
    expect(workflowSection({ kind: 'spec-ship', stage: 'grill', slug: null })).toContain('Stage 1 of 5: Grill')
  })
})

describe('Spec → ship in a chat', () => {
  it('grills, gates, refuses code before Build, and moves stage by stage', async () => {
    const env = setup('plan')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    const push = (ctx: Context) => void seen.push(ctx)
    faux.setResponses([
      // Grill: a round of questions, then stop.
      (ctx) => (push(ctx), fauxAssistantMessage([fauxToolCall('ask_questions', { round: 1, questions: [{ title: 'Where do they appear?', recommendation: 'Beside the search box.' }], recorded: 'Glossary +1 term' }, { id: 'q' })], { stopReason: 'toolUse' })),
      // Answered: writes the glossary (allowed) and tries code (refused), then finishes the stage.
      (ctx) => (push(ctx), fauxAssistantMessage([fauxToolCall('write', { path: 'GLOSSARY.md', content: '# Search\n' }, { id: 'g' }), fauxToolCall('write', { path: 'src/x.ts', content: 'x' }, { id: 'c' })], { stopReason: 'toolUse' })),
      (ctx) => (push(ctx), fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['1 decision'], files: ['GLOSSARY.md'] }, { id: 'f1' })], { stopReason: 'toolUse' })),
      // Spec: writes it and names the slug.
      (ctx) => (push(ctx), fauxAssistantMessage([fauxToolCall('write', { path: 'docs/specs/saved-searches/spec.md', content: '# Spec\n' }, { id: 's' })], { stopReason: 'toolUse' })),
      (ctx) => (push(ctx), fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['3 stories'], slug: 'Saved Searches' }, { id: 'f2' })], { stopReason: 'toolUse' }))
    ])
    const started = await env.services.chat.startWorkflow(env.session.id, 'Add saved searches')
    // Plan mode is read-only; the workflow needs to write documents.
    expect(started).toMatchObject({ permissions: 'manual', workflow: { kind: 'spec-ship', stage: 'grill', slug: null } })
    const r1 = await settle(env)
    expect(seen).toHaveLength(1)
    expect(getCurrentSystemPrompt(seen[0].messages)).toContain('Stage 1 of 5: Grill')
    expect(system(seen[0])).toMatch(/"name":"ask_questions"/)
    expect(r1.traces.find((t) => t.id === 'q')?.questions).toEqual({ round: 1, questions: [{ title: 'Where do they appear?', recommendation: 'Beside the search box.' }], recorded: 'Glossary +1 term' })
    // The first user line shows the idea, marked as the grill stage.
    expect(r1.msgs[0]).toMatchObject({ role: 'user', workflowStage: 'grill', blocks: [{ type: 'text', text: 'Add saved searches' }] })

    await env.services.chat.send(env.session.id, 'Q1: yes')
    const r2 = await settle(env)
    expect(readFileSync(join(env.root, 'GLOSSARY.md'), 'utf8')).toBe('# Search\n')
    expect(existsSync(join(env.root, 'src/x.ts'))).toBe(false)
    expect(r2.traces.find((t) => t.id === 'c')).toMatchObject({ status: 'error' })
    expect(r2.traces.find((t) => t.id === 'c')?.result).toContain(DOCS_ONLY_REFUSAL)
    expect(r2.traces.find((t) => t.id === 'f1')?.stageGate).toEqual({ stage: 'grill', summary: ['1 decision'], files: ['GLOSSARY.md'] })

    const advanced = await env.services.chat.advanceWorkflow(env.session.id)
    expect(advanced.workflow?.stage).toBe('spec')
    const r3 = await settle(env)
    const specPrompt = getCurrentSystemPrompt(seen[3].messages)
    expect(specPrompt).toContain('Stage 2 of 5: Spec')
    expect(specPrompt).not.toContain('Stage 1 of 5: Grill')
    expect(system(seen[3])).toMatch(/"toolsRemoved":\[[^\]]*"name":"ask_questions"/)
    expect(readFileSync(join(env.root, 'docs/specs/saved-searches/spec.md'), 'utf8')).toBe('# Spec\n')
    // finish_stage records the slug, cleaned up.
    expect(env.services.chat.get(env.session.id).workflow).toEqual({ kind: 'spec-ship', stage: 'spec', slug: 'saved-searches' })
    const line = r3.msgs.filter((m) => m.role === 'user').at(-1)!
    expect(line).toMatchObject({ workflowStage: 'spec', blocks: [{ type: 'text', text: 'Approved the grilling' }] })

    // Leaving the mode drops the section on the next run.
    expect(env.services.chat.stopWorkflow(env.session.id).workflow).toBeNull()
  }, 30_000)

  it('needs a folder, and refuses to advance a chat that is not running it', async () => {
    const env = makeServices()
    const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const s = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: null })
    await expect(env.services.chat.startWorkflow(s.id)).rejects.toThrow(/needs a folder/)
    await expect(env.services.chat.advanceWorkflow(s.id)).rejects.toThrow(/not running/)
  })

  it('emits no approvals for documents before Build', async () => {
    const env = setup('manual')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([fauxAssistantMessage([fauxToolCall('write', { path: 'docs/adr/0001-x.md', content: 'x' }, { id: 'a' })], { stopReason: 'toolUse' }), fauxAssistantMessage('ok')])
    await env.services.chat.startWorkflow(env.session.id)
    await settle(env)
    expect(env.events.some((e) => e.channel === 'chat' && (e.payload as ChatEvent).type === 'approval')).toBe(false)
    expect(readFileSync(join(env.root, 'docs/adr/0001-x.md'), 'utf8')).toBe('x')
  }, 30_000)
})
