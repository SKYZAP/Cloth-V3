import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, PendingApproval, ToolTrace } from '../src/shared/types'
import { buildWorkspaceTools, confine, makeDiff, type ApprovalService } from '../src/main/agent/workspace'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function setup(access: 'read' | 'write', opts: { shell?: boolean; autoApprove?: 'none' | 'edits' | 'all' } = {}) {
  const env = makeServices()
  const root = mkdtempSync(join(tmpdir(), 'cloth-ws-'))
  const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
  const session = env.services.chat.create({
    model: { providerId: provider.id, modelId: 'faux-1' },
    workspace: root,
    fileAccess: access,
    shell: opts.shell ?? false,
    autoApprove: opts.autoApprove ?? 'none',
    knowledgeEnabled: false,
    skillsEnabled: false,
    customTools: false
  })
  return { ...env, root, session }
}

async function runChat(env: ReturnType<typeof setup>, text: string, onApproval?: (a: PendingApproval) => void) {
  const seen = new Set<string>()
  await env.services.chat.send(env.session.id, text)
  for (let i = 0; i < 400; i++) {
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

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

describe('workspace file tools', () => {
  it('writes a file without asking (Manual), records the diff, and can undo it', async () => {
    const env = setup('write')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([fauxAssistantMessage([fauxToolCall('write', { path: 'notes/todo.md', content: '# Todo\n- ship it\n' }, { id: 'w1' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Created notes/todo.md.')])
    let asked: PendingApproval | null = null
    const { traces } = await runChat(env, 'make a todo file', (a) => {
      asked = a
      env.services.chat.resolveApproval(a.id, 'allow')
    })
    expect(asked).toBeNull()
    expect(readFileSync(join(env.root, 'notes/todo.md'), 'utf8')).toBe('# Todo\n- ship it\n')
    const t = traces.find((x) => x.id === 'w1')!
    expect(t.status).toBe('ok')
    expect(t.changes?.[0]).toMatchObject({ path: 'notes/todo.md', kind: 'create', added: 2 })

    const after = await env.services.chat.undoChange(env.session.id, 'w1')
    expect(existsSync(join(env.root, 'notes/todo.md'))).toBe(false)
    const undone = after.flatMap((m) => m.blocks).find((b) => b.type === 'tool' && b.trace.id === 'w1')
    expect(undone && undone.type === 'tool' && undone.trace.changes?.[0].undone).toBe(true)
  })

  it('edits in place without asking, recording each change', async () => {
    const env = setup('write')
    writeFileSync(join(env.root, 'app.ts'), 'const port = 3000\nexport default port\n')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('edit', { path: 'app.ts', edits: [{ oldText: 'const port = 3000', newText: 'const port = 8080' }] }, { id: 'e1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit', { path: 'app.ts', edits: [{ oldText: 'export default port', newText: 'export { port }' }] }, { id: 'e2' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.')
    ])
    let asks = 0
    const { traces } = await runChat(env, 'change the port', () => asks++)
    expect(asks).toBe(0)
    expect(readFileSync(join(env.root, 'app.ts'), 'utf8')).toBe('const port = 8080\nexport { port }\n')
    expect(traces.find((t) => t.id === 'e1')?.changes?.[0]).toMatchObject({ kind: 'modify', added: 1, removed: 1 })
    expect(traces.find((t) => t.id === 'e2')?.changes?.[0]).toMatchObject({ kind: 'modify', added: 1, removed: 1 })
  })

  it('a declined edit (where edits still ask) leaves the file untouched and tells the model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloth-ws-'))
    writeFileSync(join(root, 'app.ts'), 'const port = 3000\n')
    const asked: unknown[] = []
    const approvals = { request: async (input: unknown) => (asked.push(input), 'deny') } as unknown as ApprovalService
    const tools = buildWorkspaceTools({ root, sessionId: 's1', access: 'write', shell: false, approvals, checkpoints: null, autoApprove: () => 'none' })
    const edit = tools.find((t) => t.name === 'edit')!
    await expect(edit.execute('e1', { path: 'app.ts', edits: [{ oldText: 'const port = 3000', newText: 'const port = 8080' }] })).rejects.toThrow(/declined/)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'edit', path: 'app.ts', added: 1, removed: 1 })
    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('const port = 3000\n')
  })

  it('the old ask-for-everything switches land in Manual, which writes without asking', async () => {
    const env = setup('write')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'a.txt', content: 'a' }, { id: 'a' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('write', { path: 'b.txt', content: 'b' }, { id: 'b' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('ok')
    ])
    let asks = 0
    await runChat(env, 'two files', () => asks++)
    expect(asks).toBe(0)
    expect(env.services.chat.get(env.session.id)).toMatchObject({ permissions: 'manual', autoApprove: 'all' })
    expect(readFileSync(join(env.root, 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(env.root, 'b.txt'), 'utf8')).toBe('b')
  })

  it('read-only chats get no write tools, and paths cannot leave the workspace', async () => {
    const env = setup('read')
    writeFileSync(join(env.root, 'readme.md'), 'hello workspace')
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'readme.md' }, { id: 'r1' }), fauxToolCall('read', { path: '../outside.txt' }, { id: 'r2' }), fauxToolCall('write', { path: 'x.txt', content: 'x' }, { id: 'w' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('ok')
    ])
    const { traces } = await runChat(env, 'look around')
    expect(traces.find((t) => t.id === 'r1')?.result).toContain('hello workspace')
    expect(traces.find((t) => t.id === 'r2')?.result).toMatch(/outside the workspace/)
    expect(traces.find((t) => t.id === 'w')?.status).toBe('error')
    expect(existsSync(join(env.root, 'x.txt'))).toBe(false)
  })

  it('confine() resolves relative paths and rejects escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloth-conf-'))
    mkdirSync(join(root, 'src'))
    expect(await confine(root, 'src/new/file.ts')).toContain(join('src', 'new', 'file.ts'))
    await expect(confine(root, '../x')).rejects.toThrow(/outside/)
    await expect(confine(root, join(tmpdir(), 'elsewhere.txt'))).rejects.toThrow(/outside/)
  })

  it('makeDiff counts lines for new and modified files', () => {
    expect(makeDiff('a.txt', null, 'x\ny\n')).toMatchObject({ added: 2, removed: 0 })
    const d = makeDiff('a.txt', 'one\ntwo\n', 'one\nTWO\n')
    expect(d).toMatchObject({ added: 1, removed: 1 })
    expect(d.diff).toContain('-two')
    expect(d.diff).toContain('+TWO')
  })
})
