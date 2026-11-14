import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundledOpenSpec, newOpenSpecRun, openspecSection, pausesBeforeApply, runOpenSpec, setOpenSpecHomes } from '../src/main/agent/openspec'
import { buildTools } from '../src/main/agent/tools'
import { chatMode, nextModePatch } from '../src/renderer/src/lib/permissions'
import type { OpenSpecRun } from '../src/shared/types'
import { makeServices } from './helpers'

describe('OpenSpec mode', () => {
  it('tells the agent every step with the CLI commands, and where the run is', () => {
    const text = openspecSection({ ...newOpenSpecRun(), step: 'apply', change: 'add-rate-limit', tasks: { done: 2, total: 5 } }, null) ?? ''
    expect(text).toContain('## Mode: OpenSpec')
    expect(text).toContain('Now: Apply (step 4 of 7), change `add-rate-limit`, tasks 2 of 5.')
    for (const cmd of ['openspec init --tools none', 'openspec new change', 'openspec validate <name> --strict --json', 'openspec archive <name> -y --json', 'gh pr create']) expect(text).toContain(cmd)
    expect(text).toContain('Never merge it')
    expect(text).toContain('Do not stop for the person between steps')
    expect(openspecSection(null, null)).toBeNull()
    expect(openspecSection({ ...newOpenSpecRun(), step: 'done' }, null)).toBeNull()
  })

  it('pauses before Apply only when asked, until the person has read the proposal', () => {
    expect(pausesBeforeApply(newOpenSpecRun(false))).toBe(false)
    expect(pausesBeforeApply(newOpenSpecRun(true))).toBe(true)
    expect(pausesBeforeApply({ ...newOpenSpecRun(true), proposalApproved: true })).toBe(false)
    expect(openspecSection(newOpenSpecRun(true), null)).toContain('read the proposal first')
  })

  it('is its own mode, left only from the menu', () => {
    const base = { permissions: 'auto' as const, access: 'auto' as const, workflow: null }
    expect(chatMode({ ...base, openspec: newOpenSpecRun() })).toBe('openspec')
    expect(chatMode({ ...base, openspec: { ...newOpenSpecRun(), step: 'done' } })).toBe('chat')
    expect(nextModePatch({ ...base, openspec: newOpenSpecRun() })).toBeNull()
  })

  it('records steps, pauses the run before Apply when asked, and resumes on the next message', async () => {
    const { services } = makeServices()
    let run: OpenSpecRun = newOpenSpecRun(true)
    const scope = { collectionIds: [], skillsEnabled: false, workspace: null, sessionId: 's1', openspec: () => run, setOpenSpec: (p: Partial<OpenSpecRun>) => (run = { ...run, ...p }) }
    const tools = buildTools({ rag: services.rag, skills: services.skills, web: services.web, custom: services.custom }, scope)
    const step = tools.find((t) => t.name === 'openspec_step')!
    // No folder: the CLI tool isn't offered, the step tool is.
    expect(tools.some((t) => t.name === 'openspec')).toBe(false)

    await step.execute('a', { step: 'propose', summary: 'Wrote the proposal.', change: 'add-rate-limit' })
    expect(run).toMatchObject({ step: 'propose', change: 'add-rate-limit' })

    const paused = await step.execute('b', { step: 'apply', summary: 'Starting the tasks.' })
    expect(paused.terminate).toBe(true)
    expect(run).toMatchObject({ step: 'validate', awaitingReview: true })
    expect((paused.details as { openspecStep?: { step: string } }).openspecStep?.step).toBe('validate')

    run = { ...run, awaitingReview: false, proposalApproved: true }
    const going = await step.execute('c', { step: 'apply', summary: 'Starting the tasks.', tasks: { done: 0, total: 5 } })
    expect(going.terminate).toBeUndefined()
    expect(run).toMatchObject({ step: 'apply', tasks: { done: 0, total: 5 } })
  })

  it('keeps the run through other changes to the chat', () => {
    const { services } = makeServices()
    const c = services.chat.create({})
    services.chat.update(c.id, { openspec: newOpenSpecRun() })
    expect(services.chat.update(c.id, { title: 'Rate limits' }).openspec).toMatchObject({ step: 'setup' })
    expect(services.chat.update(c.id, { openspec: null }).openspec).toBeNull()
  })
})

describe('the bundled openspec CLI', () => {
  const home = join(__dirname, '..', 'sidecars', 'openspec')
  it.skipIf(!existsSync(join(home, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js')))('runs the copy Cloth ships, not one on the PATH', async () => {
    setOpenSpecHomes([join(tmpdir(), 'no-such-openspec'), home])
    try {
      expect(bundledOpenSpec()).toMatchObject({ home, version: '2.0.0' })
      const out = await runOpenSpec(tmpdir(), ['--version'], undefined, 60_000)
      expect(out).toMatchObject({ code: 0 })
      expect(out.stdout.trim()).toBe('2.0.0')
      expect(openspecSection(newOpenSpecRun(), null)).not.toContain('npm install')
    } finally {
      setOpenSpecHomes([])
    }
  }, 60_000)
})
