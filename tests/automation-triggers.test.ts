import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { commandAllowed, type Automation } from '../src/shared/types'
import { planExport } from '../src/main/export/plan'
import { automationGraph } from '../src/main/workflows/workflows'
import { makeServices } from './helpers'

let faux: ReturnType<typeof registerFauxProvider> | null = null
let server: Server | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
  server?.close()
  server = null
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const base: Automation = { prompt: 'Report what changed.', agentId: null, tools: [], servers: [], collectionIds: [], skills: [], deliver: 'notify', collectionId: null, watch: null, commands: null }
const lastUser = (ctx: TranscriptContext) => JSON.stringify(ctx.messages.filter((m) => m.role === 'user').at(-1))
const toolResults = (ctx: TranscriptContext) => ctx.messages.filter((m) => (m.role as string) === 'toolResult').map((m) => JSON.stringify(m))

function setup() {
  const made = makeServices()
  const provider = made.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  made.services.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
  faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
  return made
}

describe('automation commands', () => {
  it('allows only listed commands, one at a time', () => {
    const allow = ['git log', 'npm test']
    expect(commandAllowed('git log --oneline -5', allow)).toBe(true)
    expect(commandAllowed('npm  test', allow)).toBe(true)
    expect(commandAllowed('git logx', allow)).toBe(false)
    expect(commandAllowed('git push', allow)).toBe(false)
    expect(commandAllowed('git log; rm -rf /', allow)).toBe(false)
    expect(commandAllowed('npm test && curl evil', allow)).toBe(false)
    expect(commandAllowed('git log $(whoami)', allow)).toBe(false)
    expect(commandAllowed('git log > out.txt', allow)).toBe(false)
  })

  it('runs allowed commands without asking and refuses the rest', async () => {
    const { services } = setup()
    const folder = mkdtempSync(join(tmpdir(), 'cloth-auto-'))
    const shell = process.platform === 'win32' ? 'powershell' : 'bash'
    let results: string[] = []
    faux!.setResponses([
      () => fauxAssistantMessage([fauxToolCall(shell, { command: 'echo allowed-ran' }, { id: 'c1' })], { stopReason: 'toolUse' }),
      () => fauxAssistantMessage([fauxToolCall(shell, { command: 'echo nope' }, { id: 'c2' })], { stopReason: 'toolUse' }),
      (ctx) => {
        results = toolResults(ctx)
        return fauxAssistantMessage('Done.')
      }
    ])
    const wf = services.workflows.createAutomation({ name: 'Cmd', automation: { ...base, commands: { mode: 'allowlist', allow: ['echo allowed-ran'] } }, workspace: folder })
    const run = await services.workflows.run(wf.id, undefined)
    expect(run.error).toBeNull()
    expect(results[0]).toContain('allowed-ran')
    expect(results[1]).toMatch(/may only run these commands/)
    expect(() => services.workflows.saveAutomation(wf.id, { automation: { ...base, commands: { mode: 'allowlist', allow: [] } } })).toThrow(/List the commands/)
    expect(() => services.workflows.saveAutomation(wf.id, { automation: { ...base, commands: { mode: 'allowlist', allow: ['ls'] } }, workspace: null })).toThrow(/folder/)
    services.workflows.stopScheduler()
  }, 30_000)

  it('sends container runs to a chat, which keeps the container copy', () => {
    const { services } = setup()
    const folder = mkdtempSync(join(tmpdir(), 'cloth-auto-'))
    const wf = services.workflows.createAutomation({ name: 'Box', automation: { ...base, deliver: 'notify', commands: { mode: 'container', image: '', network: false } }, workspace: folder })
    expect(wf.automation).toMatchObject({ deliver: 'chat', commands: { mode: 'container', image: 'node:22', network: false } })
    services.workflows.stopScheduler()
  })
})

describe('automation triggers', () => {
  it('runs when a file in its folder changes, and says which', async () => {
    const { services } = setup()
    const folder = mkdtempSync(join(tmpdir(), 'cloth-watch-'))
    services.workflows.watchTiming = { debounceMs: 150, quietMs: 300 }
    let asked = ''
    faux!.setResponses([
      (ctx) => {
        asked = lastUser(ctx)
        return fauxAssistantMessage('Noted.')
      }
    ])
    const wf = services.workflows.createAutomation({ name: 'Watch', automation: { ...base, watch: { kind: 'files' } }, workspace: folder })
    await wait(200)
    writeFileSync(join(folder, 'notes.md'), 'hello')
    for (let i = 0; i < 40 && !asked; i++) await wait(100)
    expect(asked).toContain('these files changed in its folder')
    expect(asked).toContain('notes.md')
    const runs = services.workflows.runs(wf.id)
    expect(runs[0]).toMatchObject({ trigger: 'change', input: { changed: ['notes.md'] } })
    expect(() => services.workflows.saveAutomation(wf.id, { automation: { ...base, watch: { kind: 'files' } }, workspace: null })).toThrow(/folder to watch/)
    services.workflows.stopScheduler()
  }, 20_000)

  it('checks a page and runs only when what it says changes', async () => {
    const { services } = setup()
    let page = '<html><body><h1>Price: $20</h1><script>Date.now()</script></body></html>'
    server = createServer((_req, res) => res.end(page))
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server!.address() as { port: number }).port}/`
    let asked = ''
    faux!.setResponses([
      (ctx) => {
        asked = lastUser(ctx)
        return fauxAssistantMessage('The price went up.')
      }
    ])
    const wf = services.workflows.createAutomation({ name: 'Price', automation: { ...base, watch: { kind: 'url', url, everyMinutes: 60 } } })
    // The first look only remembers the page.
    for (let i = 0; i < 30 && !services.workflows.watchState(wf.id).checkedAt; i++) await wait(50)
    expect(services.workflows.runs(wf.id)).toHaveLength(0)
    await services.workflows.checkNow(wf.id)
    expect(services.workflows.runs(wf.id)).toHaveLength(0)
    page = page.replace('$20', '$25')
    await services.workflows.checkNow(wf.id)
    for (let i = 0; i < 30 && !asked; i++) await wait(50)
    expect(asked).toContain(`the page at ${url} changed`)
    expect(asked).toContain('Price: $25')
    expect(asked).not.toContain('Date.now')
    expect(services.workflows.watchState(wf.id)).toMatchObject({ error: null })
    services.workflows.stopScheduler()
  }, 20_000)
})

describe('exporting an automation', () => {
  it('bundles only your own tools and warns about servers and commands', () => {
    const graph = automationGraph({ ...base, tools: ['web_search', 'read', 'weather'], servers: [{ id: 'gh', tools: null }], commands: { mode: 'allowlist', allow: ['git log'] } })
    const plan = planExport(graph, { tools: [{ name: 'weather', enabled: true, kind: 'http', config: { url: 'https://wttr.in' } } as never], skills: [], collections: [] })
    expect(plan.errors).toEqual([])
    expect(plan.tools).toEqual(['weather'])
    expect(plan.web).toBe(true)
    expect(plan.warnings.join(' ')).toMatch(/MCP servers/)
    expect(plan.warnings.join(' ')).toMatch(/runs commands/)
  })
})

describe('trying built-in and MCP tools', () => {
  it('runs read-only built-in tools outside a chat and refuses the rest', async () => {
    const { services } = makeServices()
    const folder = mkdtempSync(join(tmpdir(), 'cloth-try-'))
    writeFileSync(join(folder, 'hello.txt'), 'hi there')
    expect(await services.runtime.tryTool('read', { path: 'hello.txt' }, folder)).toContain('hi there')
    await expect(services.runtime.tryTool('read', { path: 'hello.txt' }, null)).rejects.toThrow(/Pick a folder/)
    await expect(services.runtime.tryTool('write', { path: 'x', content: 'y' }, folder)).rejects.toThrow(/can't be tried here/)
  })
})
