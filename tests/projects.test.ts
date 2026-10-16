import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

describe('projects', () => {
  it('new chats start in the project folder with its settings; the folder can be left out', () => {
    const { services } = makeServices()
    const folder = mkdtempSync(join(tmpdir(), 'cloth-project-'))
    const model = { providerId: 'p1', modelId: 'm1' }
    const p = services.projects.create({ name: '  Billing  ', folder, defaults: { model, fileAccess: 'write', shell: true, webEnabled: true } })
    expect(p).toMatchObject({ name: 'Billing', folder })
    expect(p.color).toMatch(/^#/)

    const chat = services.chat.create({ projectId: p.id })
    // The project's old switches (edit + shell, asking first) become Manual mode.
    expect(chat).toMatchObject({ projectId: p.id, workspace: folder, model, permissions: 'manual', fileAccess: 'write', shell: true, webEnabled: true })
    // What the caller passes still wins over the project's defaults.
    expect(services.chat.create({ projectId: p.id, permissions: 'plan' })).toMatchObject({ permissions: 'plan', fileAccess: 'read', shell: false })

    const loose = services.projects.create({ name: 'Ideas' })
    expect(loose.folder).toBeNull()
    expect(services.chat.create({ projectId: loose.id }).workspace).toBeNull()
    expect(services.chat.create().projectId).toBeNull()
    expect(() => services.projects.create({ name: ' ' })).toThrow(/name/)
  })

  it('moving the folder takes its chats along; deleting keeps the chats unless asked', () => {
    const { services } = makeServices()
    const a = mkdtempSync(join(tmpdir(), 'cloth-project-'))
    const b = mkdtempSync(join(tmpdir(), 'cloth-project-'))
    const p = services.projects.create({ name: 'App', folder: a })
    const inFolder = services.chat.create({ projectId: p.id })
    const elsewhere = services.chat.create({ projectId: p.id, workspace: b })
    services.projects.update(p.id, { folder: b })
    expect(services.chat.get(inFolder.id).workspace).toBe(b)
    expect(services.chat.get(elsewhere.id).workspace).toBe(b)
    services.projects.update(p.id, { folder: null })
    expect(services.chat.get(inFolder.id).workspace).toBeNull()

    services.projects.remove(p.id)
    expect(services.projects.list()).toEqual([])
    expect(services.chat.get(inFolder.id).projectId).toBeNull()

    const q = services.projects.create({ name: 'Scratch' })
    const gone = services.chat.create({ projectId: q.id })
    services.projects.remove(q.id, { deleteChats: true })
    expect(services.chat.list().some((c) => c.id === gone.id)).toBe(false)
  })

  it('the Automation project is built in: it can be renamed but not deleted', () => {
    const { services } = makeServices()
    const auto = services.projects.automationProject()
    const mine = services.projects.create({ name: 'Mine' })
    expect(auto.builtin).toBe('automation')
    expect(mine.builtin).toBeUndefined()
    expect(services.projects.list().find((p) => p.id === auto.id)?.builtin).toBe('automation')
    expect(services.projects.update(auto.id, { name: 'Robots' })).toMatchObject({ name: 'Robots', builtin: 'automation' })
    expect(() => services.projects.remove(auto.id)).toThrow(/built in/)
    expect(services.projects.automationProject().id).toBe(auto.id)
  })

  it("the project's instructions and AGENTS.md reach the chat's system prompt", async () => {
    const { services } = makeServices()
    const folder = mkdtempSync(join(tmpdir(), 'cloth-project-'))
    writeFileSync(join(folder, 'AGENTS.md'), '# Notes\nRun tests with pnpm test.')
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const p = services.projects.create({ name: 'Billing', folder, instructions: 'Amounts are integer cents.', defaults: { model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false, skillsEnabled: false, customTools: false } })
    const chat = services.chat.create({ projectId: p.id, systemPrompt: 'Answer briefly.' })

    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let seen = ''
    faux.setResponses([
      (ctx: TranscriptContext) => {
        seen = JSON.stringify(ctx)
        return fauxAssistantMessage('ok')
      }
    ])
    await services.chat.send(chat.id, 'hi')
    for (let i = 0; i < 200 && services.chat.isRunning(chat.id); i++) await wait(10)
    expect(seen).toContain('This chat belongs to the project \\"Billing\\"')
    expect(seen).toContain('Amounts are integer cents.')
    expect(seen).toContain('Run tests with pnpm test.')
    expect(seen).toContain('Answer briefly.')
    expect(seen.indexOf('integer cents')).toBeLessThan(seen.indexOf('Answer briefly'))
  })
})
