import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type Context } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, Permissions, ToolTrace } from '../src/shared/types'
import { DOCS_ONLY_REFUSAL, docsOnly, isDocPath, nextStage, routeStages, stageNote, stageText, workflowSection } from '../src/main/agent/workflow'
import { makeServices } from './helpers'
import { git } from '../src/main/panel/git'

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

describe('Spec → Ship helpers', () => {
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
    // Spec writes the spec and its tickets; an older chat still at Tickets goes on to Build.
    expect(['grill', 'spec', 'build', 'review'].map((s) => nextStage(s as never))).toEqual(['spec', 'build', 'review', 'done'])
    expect(nextStage('tickets')).toBe('build')
    expect(workflowSection({ kind: 'spec-ship', stage: 'tickets', slug: 'x' })).toContain('### Stage: Spec')
    expect(nextStage('done')).toBe('done')
    expect(workflowSection(null)).toBeNull()
    expect(workflowSection({ kind: 'spec-ship', stage: 'spec', slug: 'saved-searches' })).toContain('docs/specs/saved-searches')
    expect(workflowSection({ kind: 'spec-ship', stage: 'grill', slug: null })).toContain('### Stage: Grill')
    // A feature with visible changes shows its UI as a one-page mockup before the spec, and the spec keeps to it.
    expect(workflowSection({ kind: 'spec-ship', stage: 'grill', slug: null })).toMatch(/docs\/specs\/<slug>\/mockup\.html/)
    expect(workflowSection({ kind: 'spec-ship', stage: 'spec', slug: 'x' })).toContain('the spec keeps to it')
    expect(isDocPath('docs/specs/x/mockup.html')).toBe(true)
  })

  it('sizes the stages to the route', () => {
    // Quick writes its spec while grilling and has no tickets; Standard and Preserve walk every stage.
    expect(routeStages('quick')).toEqual(['grill', 'build', 'review'])
    expect(routeStages('preserve')).toEqual(routeStages(undefined))
    expect(['grill', 'build', 'review'].map((s) => nextStage(s as never, 'quick'))).toEqual(['build', 'review', 'done'])
    expect(nextStage('grill', 'preserve')).toBe('spec')
    expect(stageText('build', 'quick')).toBe('Approved the spec')
    expect(stageText('build')).toBe('Approved the spec and tickets')
    expect(routeStages('standard')).toEqual(['grill', 'spec', 'build', 'review'])
    expect(stageNote('build', 'x', 'quick')).toContain('The grilling and spec are approved')
    expect(workflowSection({ kind: 'spec-ship', stage: 'build', slug: 'x', route: 'quick' })).toContain('Quick route')
  })

  it('asks for criteria, assumptions and a current spec', () => {
    const at = (stage: 'grill' | 'spec' | 'tickets' | 'build' | 'review') => workflowSection({ kind: 'spec-ship', stage, slug: 'x' }) ?? ''
    expect(at('grill')).toContain('A default you would pick yourself is still a decision')
    // The route is chosen, not asked: it comes with round 1, and only a real toss-up becomes a question.
    expect(at('grill')).toContain('Choose the route yourself before round 1')
    expect(at('grill')).toContain('do not ask about it')
    // A Quick bug fix settles the symptom while grilling and is diagnosed before it is changed.
    expect(at('grill')).toContain('settle the symptom, not the cause')
    expect(at('build')).toContain('Build a feedback loop first')
    expect(at('review')).toContain('undoes the fix in its copy and confirms the regression test then fails')
    expect(at('spec')).toMatch(/numbered AC-1/)
    expect(at('tickets')).toContain('never restate their text')
    // Preserve pins behaviour on a real running instance: an in-process stand-in missed a Spring Security error-dispatch change.
    expect(at('tickets')).toContain('not an in-process stand-in')
    expect(at('tickets')).toContain('normal test suite, not a side script')
    expect(at('build')).toContain('every new test appears in its output')
    expect(at('review')).toContain('whether it must be fixed before this ships')
    expect(at('review')).toContain('"Assumed: …"')
    expect(stageNote('done', 'x')).toContain('docs/specs/README.md')
    // Fix rounds are for behaviour; a test that covers a criterion without naming it is optional.
    expect(at('review')).toContain('naming, traceability and style gaps')
    // A Quick change rarely makes a decision worth recording, so Done only asks when one clearly does.
    expect(stageNote('done', 'x', 'quick')).toContain('Skip decision records unless one decision made here clearly meets the bar')
    expect(stageNote('done', 'x', 'standard')).toContain('one multiple-choice question listing them')
    // Token savings: Build checks workers without redoing their reading, Review reuses Build's results and gets the
    // change itself, the wrap-up doesn't explore, and a clear Quick change skips the questions.
    expect(at('build')).toContain("never to redo a worker's reading")
    expect(at('build')).toContain('the full suite runs once, at the end')
    // The board follows Build's progress: a todo item per ticket, boxes ticked as each one finishes.
    expect(at('build')).toContain('one item per ticket starting with its number ("Ticket 01: …")')
    expect(at('build')).toContain("tick a ticket's boxes when you finish that ticket, before starting the next")
    expect(at('review')).toContain("don't rerun them unless something changed since")
    expect(at('review')).toContain('Brief each with the change itself')
    expect(stageNote('done', 'x', 'standard')).toContain("don't explore the code")
    expect(at('grill')).toContain('ask no round at all')
    expect(at('spec')).toContain('approves the spec and its tickets together')
  })
})

describe('Spec → Ship in a chat', () => {
  it('grills, gates, refuses code before Build, and moves stage by stage', async () => {
    const env = setup('plan')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    const push = (ctx: Context) => void seen.push(ctx)
    faux.setResponses([
      // Grill: a round of questions, then stop.
      (ctx) => (push(ctx), fauxAssistantMessage([fauxToolCall('ask_questions', { round: 1, questions: [{ title: 'Where do they appear?', recommendation: 'Beside the search box.' }], recorded: 'Glossary +1 term', route: 'standard' }, { id: 'q' })], { stopReason: 'toolUse' })),
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
    // The person approves the spec, so it waits at the Spec gate rather than going into Build on its own: that step
    // runs just after the chat stops, and a fast machine would otherwise see Build before the checks below.
    env.services.chat.update(env.session.id, { workflow: { ...started.workflow!, approveSpec: true } })
    const r1 = await settle(env)
    expect(seen).toHaveLength(1)
    expect(getCurrentSystemPrompt(seen[0].messages)).toContain('### Stage: Grill')
    expect(system(seen[0])).toMatch(/"name":"ask_questions"/)
    expect(r1.traces.find((t) => t.id === 'q')?.questions).toEqual({ round: 1, questions: [{ title: 'Where do they appear?', recommendation: 'Beside the search box.' }], recorded: 'Glossary +1 term' })
    // The route chosen with round 1 shows straight away; finishing the stage keeps it.
    expect(env.services.chat.get(env.session.id).workflow?.route).toBe('standard')
    // The first user line shows the idea, marked as the grill stage.
    expect(r1.msgs[0]).toMatchObject({ role: 'user', workflowStage: 'grill', blocks: [{ type: 'text', text: 'Add saved searches' }] })

    await env.services.chat.send(env.session.id, 'Q1: yes')
    const r2 = await settle(env)
    expect(readFileSync(join(env.root, 'GLOSSARY.md'), 'utf8')).toBe('# Search\n')
    expect(existsSync(join(env.root, 'src/x.ts'))).toBe(false)
    expect(r2.traces.find((t) => t.id === 'c')).toMatchObject({ status: 'error' })
    expect(r2.traces.find((t) => t.id === 'c')?.result).toContain(DOCS_ONLY_REFUSAL)
    expect(r2.traces.find((t) => t.id === 'f1')?.stageGate).toEqual({ stage: 'grill', summary: ['1 decision'], files: ['GLOSSARY.md'], route: 'standard' })

    const advanced = await env.services.chat.advanceWorkflow(env.session.id)
    expect(advanced.workflow?.stage).toBe('spec')
    const r3 = await settle(env)
    const specPrompt = getCurrentSystemPrompt(seen[3].messages)
    expect(specPrompt).toContain('### Stage: Spec')
    expect(specPrompt).not.toContain('### Stage: Grill')
    // The stage starts from a handover, not the grilling: no ask_questions, and the earlier turns aren't sent.
    expect(system(seen[3])).not.toMatch(/"name":"ask_questions"/)
    const firstUser = JSON.stringify(seen[3].messages.find((m) => m.role === 'user'))
    expect(firstUser).toContain('Spec → Ship handover')
    expect(firstUser).toContain('1 decision')
    expect(firstUser).toContain('Q1: yes')
    // Everything the person said since the start, including their request.
    expect(firstUser).toContain('Add saved searches')
    expect(JSON.stringify(seen[3].messages)).not.toContain('Where do they appear?')
    // The person still sees the grilling.
    expect(env.services.chat.messages(env.session.id).some((m) => m.archived && m.blocks.some((b) => b.type === 'tool' && b.trace.id === 'q'))).toBe(true)
    expect(readFileSync(join(env.root, 'docs/specs/saved-searches/spec.md'), 'utf8')).toBe('# Spec\n')
    // finish_stage records the slug, cleaned up.
    expect(env.services.chat.get(env.session.id).workflow).toEqual({ kind: 'spec-ship', stage: 'spec', slug: 'saved-searches', route: 'standard', approveSpec: true })
    const line = r3.msgs.filter((m) => m.role === 'user').at(-1)!
    expect(line).toMatchObject({ workflowStage: 'spec', blocks: [{ type: 'text', text: 'Approved the grilling' }] })

    // Leaving the mode drops the section on the next run.
    expect(env.services.chat.stopWorkflow(env.session.id).workflow).toBeNull()
  }, 30_000)

  it('records the route while grilling, and the Quick route goes straight to Build', async () => {
    const env = setup('manual')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      // No route: refused. Quick without the spec's slug: refused. Then a proper finish.
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Fixed casing'] }, { id: 'a' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Fixed casing'], route: 'quick' }, { id: 'b' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Fixed casing', 'Assumed: nothing'], route: 'quick', slug: 'flag-casing' }, { id: 'c' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Building.')
    ])
    await env.services.chat.startWorkflow(env.session.id, 'Flag names should ignore case')
    const r = await settle(env)
    expect(r.traces.find((t) => t.id === 'a')?.result).toMatch(/which route/)
    expect(r.traces.find((t) => t.id === 'b')?.result).toMatch(/give its slug/)
    expect(r.traces.find((t) => t.id === 'c')?.stageGate).toMatchObject({ stage: 'grill', route: 'quick' })
    expect(env.services.chat.get(env.session.id).workflow).toEqual({ kind: 'spec-ship', stage: 'grill', slug: 'flag-casing', route: 'quick' })
    const advanced = await env.services.chat.advanceWorkflow(env.session.id)
    expect(advanced.workflow?.stage).toBe('build')
    const r2 = await settle(env)
    expect(r2.msgs.filter((m) => m.role === 'user').at(-1)).toMatchObject({ workflowStage: 'build', blocks: [{ type: 'text', text: 'Approved the spec' }] })
  }, 30_000)

  it('goes from Build to Review on its own unless switched off, and the review reports its findings', async () => {
    const env = setup('manual')
    env.services.chat.update(env.session.id, { workflow: { kind: 'spec-ship', stage: 'build', slug: 'x', route: 'quick' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Built AC-1–AC-4', 'Built here: a one-line change, because it was too small to brief', 'Unverified: nothing'] }, { id: 'b' })], { stopReason: 'toolUse' }),
      // The review starts by itself.
      (ctx) => (
        seen.push(ctx),
        fauxAssistantMessage(
          [
            fauxToolCall(
              'finish_stage',
              {
                summary: ['2 findings'],
                findings: [
                  { axis: 'spec', fix: true, title: 'AC-2 untested', where: 'AC-2' },
                  { axis: 'standards', fix: false, title: ' ' }
                ]
              },
              { id: 'r' }
            )
          ],
          { stopReason: 'toolUse' }
        )
      )
    ])
    await env.services.chat.send(env.session.id, 'build it')
    // Wait for the review's own result: the build's turn ends a moment before the review's starts.
    const reviewed = () => env.services.chat.messages(env.session.id).some((m) => m.blocks.some((b) => b.type === 'tool' && b.trace.id === 'r' && b.trace.stageGate))
    for (let i = 0; i < 1500 && !(reviewed() && !env.services.chat.isRunning(env.session.id)); i++) await wait(10)
    const r = await settle(env)
    expect(env.services.chat.get(env.session.id).workflow?.stage).toBe('review')
    expect(getCurrentSystemPrompt(seen[0].messages)).toContain('### Stage: Review')
    expect(r.msgs.filter((m) => m.role === 'user').at(-1)).toMatchObject({ workflowStage: 'review', blocks: [{ type: 'text', text: 'Approved the build' }] })
    // Blank findings are dropped.
    expect(r.traces.find((t) => t.id === 'r')?.stageGate?.findings).toEqual([{ axis: 'spec', fix: true, title: 'AC-2 untested', where: 'AC-2', status: 'open' }])

    // Switched off, a finished build waits for the person.
    env.services.chat.update(env.session.id, { workflow: { kind: 'spec-ship', stage: 'build', slug: 'x', route: 'quick' } })
    expect(env.services.chat.setWorkflowAutoContinue(env.session.id, false).workflow?.autoContinue).toBe(false)
    faux.setResponses([() => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Built', 'Built here: a one-line change, because it was too small to brief'] }, { id: 'b2' })], { stopReason: 'toolUse' })])
    await env.services.chat.send(env.session.id, 'build again')
    await settle(env)
    await wait(300)
    expect(env.services.chat.isRunning(env.session.id)).toBe(false)
    expect(env.services.chat.get(env.session.id).workflow?.stage).toBe('build')
  }, 30_000)

  it('needs a folder, and refuses to advance a chat that is not running it', async () => {
    const env = makeServices()
    const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const s = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: null })
    await expect(env.services.chat.startWorkflow(s.id)).rejects.toThrow(/needs a folder/)
    await expect(env.services.chat.advanceWorkflow(s.id)).rejects.toThrow(/not running/)
  })

  it('gives review-stage reviewers only the tools to read the change', async () => {
    const env = setup('manual')
    env.services.chat.update(env.session.id, { subagents: true, webEnabled: true, knowledgeEnabled: true, workflow: { kind: 'spec-ship', stage: 'review', slug: 'x' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('task', { description: 'Review spec', prompt: 'Check the diff against docs/specs/x/spec.md', role: 'scout' }, { id: 't' })], { stopReason: 'toolUse' })),
      (ctx) => (seen.push(ctx), fauxAssistantMessage('Result: done. No findings.')),
      () => fauxAssistantMessage('Reviewed.')
    ])
    await env.services.chat.send(env.session.id, 'review it')
    await settle(env)
    // The chat itself keeps web search; its reviewer doesn't.
    expect(system(seen[0])).toMatch(/"name":"web_search"/)
    expect(system(seen[1])).not.toMatch(/"name":"web_search"/)
    expect(system(seen[1])).not.toMatch(/"name":"rag_search"/)
    expect(system(seen[1])).toMatch(/"name":"read"/)
  }, 30_000)

  it('builds a worker in its own git copy and merges it back', async () => {
    const env = setup('manual')
    const g = (...args: string[]) => git(env.root, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    await g('init', '-q', '-b', 'main')
    await g('config', 'core.autocrlf', 'false')
    writeFileSync(join(env.root, 'README.md'), '# app')
    await g('add', '-A')
    await g('commit', '-q', '-m', 'start')
    env.services.chat.update(env.session.id, { subagents: true, workflow: { kind: 'spec-ship', stage: 'build', slug: 'feat' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('task', { description: 'Ticket 01', prompt: 'Build docs/specs/feat/tickets/01', role: 'worker' }, { id: 't' })], { stopReason: 'toolUse' })),
      // The worker writes in its checkout, then reports.
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('write', { path: 'feature.txt', content: 'built' }, { id: 'w' })], { stopReason: 'toolUse' })),
      () => fauxAssistantMessage('Result: done. Wrote feature.txt.'),
      () => fauxAssistantMessage('Merged.')
    ])
    await env.services.chat.send(env.session.id, 'build ticket 01')
    const { traces } = await settle(env)
    const task = traces.find((t) => t.id === 't')!
    expect(task.result).toContain('merged into main (1 file)')
    expect(task.subagent?.files).toEqual(['feature.txt'])
    // Merged into the chat's folder; the worker's branch and checkout are gone.
    expect(readFileSync(join(env.root, 'feature.txt'), 'utf8')).toBe('built')
    expect((await git(env.root, ['branch', '--format=%(refname:short)'])).stdout.trim()).toBe('main')
    expect((await git(env.root, ['log', '-1', '--format=%s'])).stdout.trim()).toMatch(/^Merge cloth\/feat\/ticket-01-/)
    // The worker's workspace was its checkout, not the chat's folder.
    expect(system(seen[1])).toContain('cloth-worktrees')
  }, 60_000)

  it('runs a check in a throwaway copy with the uncommitted change, and keeps only its verdict and proof', async () => {
    const env = setup('manual')
    const g = (...args: string[]) => git(env.root, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    await g('init', '-q', '-b', 'main')
    await g('config', 'core.autocrlf', 'false')
    writeFileSync(join(env.root, 'README.md'), '# app')
    await g('add', '-A')
    await g('commit', '-q', '-m', 'start')
    // The change under review isn't committed yet: the check must still see it.
    writeFileSync(join(env.root, 'feature.txt'), 'built')
    env.services.chat.update(env.session.id, { subagents: true, workflow: { kind: 'spec-ship', stage: 'review', slug: 'feat' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    const report = ['Result: issues', '### Finding: feature.txt says built, not done', 'Criterion: AC-1', 'Command: `cat feature.txt`', 'Observed: built', 'Expected: done', 'Fix before ship: yes'].join('\n')
    faux.setResponses([
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('task', { description: 'Spec AC-1', prompt: 'Check AC-1', role: 'verifier' }, { id: 't' })], { stopReason: 'toolUse' })),
      // The check reads the uncommitted file in its copy and leaves a probe there, without asking (Manual chat).
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('read', { path: 'feature.txt' }, { id: 'r' }), fauxToolCall('write', { path: 'probe.txt', content: 'scratch' }, { id: 'w' })], { stopReason: 'toolUse' })),
      () => fauxAssistantMessage(report),
      () => fauxAssistantMessage('Checked.')
    ])
    await env.services.chat.send(env.session.id, 'check AC-1')
    const { traces } = await settle(env)
    const task = traces.find((t) => t.id === 't')!
    expect(task.subagent).toMatchObject({ role: 'verifier', verdict: 'issues', proven: 1 })
    expect(task.result).toContain('Verdict: issues; 1 proven finding.')
    const inner = (task.subagent?.blocks ?? []).flatMap((b) => (b.type === 'tool' ? [b.trace] : []))
    expect(inner.find((t) => t.id === 'r')?.result).toContain('built')
    expect(inner.find((t) => t.id === 'w')?.status).not.toBe('error')
    expect(env.services.chat.pendingApprovals(env.session.id)).toEqual([])
    // Its copy and branch are gone, and nothing it wrote reached the chat's folder.
    expect(existsSync(join(env.root, 'probe.txt'))).toBe(false)
    expect((await git(env.root, ['branch', '--format=%(refname:short)'])).stdout.trim()).toBe('main')
    expect(system(seen[1])).toContain('throwaway copy')
    expect(system(seen[1])).toContain('Result: pass | issues | blocked')
  }, 60_000)

  it('runs a second feature in the same chat: fresh context, its own folder, the earlier one untouched', async () => {
    const env = setup('manual')
    mkdirSync(join(env.root, 'docs/specs/feat-a'), { recursive: true })
    writeFileSync(join(env.root, 'docs/specs/feat-a/spec.md'), '# Feature A\n')
    writeFileSync(join(env.root, 'docs/specs/README.md'), '# Specs\n\n- [feat-a](feat-a/spec.md): Feature A\n')
    env.services.chat.update(env.session.id, { workflow: { kind: 'spec-ship', stage: 'done', slug: 'feat-a', route: 'quick', autoContinue: false } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      () => fauxAssistantMessage('The secret first-feature detail.'),
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Settled'], route: 'quick', slug: 'feat-a' }, { id: 'same' })], { stopReason: 'toolUse' })),
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Settled'], route: 'quick', slug: 'feat-b' }, { id: 'own' })], { stopReason: 'toolUse' })
    ])
    await env.services.chat.send(env.session.id, 'Thanks, looks good')
    await settle(env)
    await env.services.chat.startWorkflow(env.session.id, 'Now add feature B')
    const { traces } = await settle(env)
    // Starts from a note on the earlier feature and what was said since, not that conversation.
    const first = JSON.stringify(seen[0].messages.find((m) => m.role === 'user'))
    expect(first).toContain('docs/specs/feat-a/')
    expect(first).toContain('Thanks, looks good')
    expect(JSON.stringify(seen[0].messages)).not.toContain('The secret first-feature detail.')
    // It can't take the finished spec's folder; its own is fine. The person's auto-continue choice carries over.
    expect(traces.find((t) => t.id === 'same')?.result).toMatch(/docs\/specs\/feat-a is an earlier, finished spec/)
    expect(env.services.chat.get(env.session.id).workflow).toMatchObject({ stage: 'grill', slug: 'feat-b', autoContinue: false })
    expect(readFileSync(join(env.root, 'docs/specs/feat-a/spec.md'), 'utf8')).toBe('# Feature A\n')
    // The earlier conversation is still in the chat, archived.
    expect(env.services.chat.messages(env.session.id).some((m) => m.archived && m.blocks.some((b) => b.type === 'text' && b.text === 'The secret first-feature detail.'))).toBe(true)
  }, 30_000)

  it('works through agents: on whatever the chat says, and Build finishes only after handing work to a worker', async () => {
    const env = setup('manual')
    // The chat has subagents off; Spec → Ship turns them on.
    env.services.chat.update(env.session.id, { subagents: false, workflow: { kind: 'spec-ship', stage: 'build', slug: 'x', route: 'quick', autoContinue: false } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      // Builds it itself and tries to finish: refused.
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Built'] }, { id: 'f1' })], { stopReason: 'toolUse' })),
      // Hands the change to a worker, which reports back.
      () => fauxAssistantMessage([fauxToolCall('task', { description: 'Quick change: flag casing', prompt: 'Make flag names ignore case, test first.', role: 'worker' }, { id: 'w' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('Result: done. Flag names ignore case; 2 tests added.'),
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Built by a worker'] }, { id: 'f2' })], { stopReason: 'toolUse' })
    ])
    await env.services.chat.send(env.session.id, 'build it')
    const { traces } = await settle(env)
    expect(system(seen[0])).toMatch(/"name":"task"/)
    expect(traces.find((t) => t.id === 'f1')?.result).toMatch(/Build hands its work to worker agents/)
    expect(traces.find((t) => t.id === 'f2')?.stageGate).toMatchObject({ stage: 'build' })
  }, 30_000)

  it('finishes Build only once every ticket is ticked off or named as unfinished', async () => {
    const env = setup('manual')
    const dir = join(env.root, 'docs/specs/feat/tickets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '01-a.md'), '# 01: A\n- [x] AC-1\n')
    writeFileSync(join(dir, '02-b.md'), '# 02: B\n- [x] AC-2\n- [ ] AC-3\n')
    env.services.chat.update(env.session.id, { workflow: { kind: 'spec-ship', stage: 'build', slug: 'feat', autoContinue: false } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Built', 'Built here: a one-line change, because it was too small to brief'] }, { id: 'a' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Built', 'Built here: a one-line change, because it was too small to brief', 'Partly done: 02 (AC-3)'], unfinished: ['2'] }, { id: 'b' })], { stopReason: 'toolUse' })
    ])
    await env.services.chat.send(env.session.id, 'build it')
    const { traces } = await settle(env)
    expect(traces.find((t) => t.id === 'a')?.result).toMatch(/Ticket 02 still has unticked criteria/)
    expect(traces.find((t) => t.id === 'b')?.stageGate).toMatchObject({ stage: 'build' })
  }, 30_000)

  it('commits what the wrap-up changed once the workflow is done', async () => {
    const env = setup('manual')
    const g = (...args: string[]) => git(env.root, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    await g('init', '-q', '-b', 'main')
    await g('config', 'core.autocrlf', 'false')
    writeFileSync(join(env.root, 'README.md'), '# app')
    writeFileSync(join(env.root, 'mine.txt'), 'the person’s own work')
    await g('add', 'README.md')
    await g('commit', '-q', '-m', 'start')
    env.services.chat.update(env.session.id, { workflow: { kind: 'spec-ship', stage: 'review', slug: 'feat' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall('write', { path: 'docs/specs/feat/spec.md', content: 'spec' }), fauxToolCall('write', { path: 'src/fix.ts', content: 'export {}' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage('The workflow is done.')
    ])
    await env.services.chat.advanceWorkflow(env.session.id)
    await settle(env)
    for (let i = 0; i < 300 && (await g('log', '-1', '--format=%s')).stdout.trim() === 'start'; i++) await wait(10)
    expect((await g('log', '-1', '--format=%s')).stdout.trim()).toBe('Spec → Ship: feat done (final changes)')
    // Cloth listed the spec in docs/specs/README.md itself.
    expect((await g('show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n').sort()).toEqual(['docs/specs/README.md', 'docs/specs/feat/spec.md', 'src/fix.ts'])
    expect(readFileSync(join(env.root, 'docs/specs/README.md'), 'utf8')).toBe('# Specs\n\n- [feat](feat/spec.md): feat\n')
    // The person's own uncommitted file is left alone.
    expect((await g('status', '--porcelain')).stdout.trim()).toBe('?? mine.txt')
  }, 30_000)

  it('finishes on its own after a review with nothing to fix, and hands the review the exact change', async () => {
    const env = setup('manual')
    const g = (...args: string[]) => git(env.root, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    await g('init', '-q', '-b', 'main')
    await g('config', 'core.autocrlf', 'false')
    writeFileSync(join(env.root, 'README.md'), '# app')
    await g('add', '-A')
    await g('commit', '-q', '-m', 'start')
    env.services.chat.update(env.session.id, { workflow: { kind: 'spec-ship', stage: 'spec', slug: 'feat', route: 'standard' } })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    const seen: Context[] = []
    faux.setResponses([
      // Build writes a file and finishes; the review starts by itself.
      () => fauxAssistantMessage([fauxToolCall('write', { path: 'src/a.ts', content: 'export {}' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['Built', 'Built here: a one-line change, because it was too small to brief', 'Tests: 3 passed'] }, { id: 'b' })], { stopReason: 'toolUse' }),
      // Only an optional finding: the workflow finishes without waiting.
      (ctx) => (seen.push(ctx), fauxAssistantMessage([fauxToolCall('finish_stage', { summary: ['1 finding'], findings: [{ axis: 'standards', fix: false, title: 'Name could be clearer' }] }, { id: 'r' })], { stopReason: 'toolUse' })),
      (ctx) => (seen.push(ctx), fauxAssistantMessage('Done: docs/specs/feat.'))
    ])
    await env.services.chat.advanceWorkflow(env.session.id)
    for (let i = 0; i < 1500 && !(env.services.chat.get(env.session.id).workflow?.stage === 'done' && !env.services.chat.isRunning(env.session.id) && seen.length === 2); i++) await wait(10)
    await settle(env)
    expect(env.services.chat.get(env.session.id).workflow?.stage).toBe('done')
    // The wrap-up started on its own still ends with the final commit, specs index included.
    for (let i = 0; i < 300 && (await g('log', '-1', '--format=%s')).stdout.trim() !== 'Spec → Ship: feat done (final changes)'; i++) await wait(10)
    expect((await g('log', '-1', '--format=%s')).stdout.trim()).toBe('Spec → Ship: feat done (final changes)')
    expect((await g('status', '--porcelain')).stdout.trim()).toBe('')
    const reviewStart = JSON.stringify(seen[0].messages.find((m) => m.role === 'user'))
    expect(reviewStart).toContain('Tests: 3 passed')
    expect(reviewStart).toMatch(/The change: `git diff [0-9a-f]+`, 1 file: src\/a\.ts \(new, uncommitted\)/)
    // The wrap-up gets the review's findings in its handover.
    expect(JSON.stringify(seen[1].messages.find((m) => m.role === 'user'))).toContain('Finding (standards, optional): Name could be clearer')
  }, 30_000)

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
