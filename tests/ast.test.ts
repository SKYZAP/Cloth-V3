import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ChatEvent, PendingApproval, ToolTrace } from '../src/shared/types'
import { astRewrite, astSearch, resolveLanguage, supportedLanguages } from '../src/main/agent/ast'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function project() {
  const root = mkdtempSync(join(tmpdir(), 'cloth-ast-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export function a(x: number) {\n  console.log("a", x)\n  return x\n}\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'const b = () => {\n  console.log(\n    "b",\n    1,\n  )\n  console.log(console.log("nested"))\n}\n')
  writeFileSync(join(root, 'src', 'tool.py'), 'def greet(name):\n    print("hi", name)\n    return name\n')
  writeFileSync(join(root, 'node_modules', 'skip.ts'), 'console.log("ignored")\n')
  return root
}

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

describe('ast-grep tools', () => {
  it('finds calls structurally across formatting and skips ignored folders', async () => {
    const root = project()
    const { matches } = await astSearch(root, root, { pattern: 'console.log($$$A)', lang: resolveLanguage('ts'), max: 50 })
    expect(matches.map((m) => `${m.file}:${m.line}`)).toEqual(expect.arrayContaining(['src/a.ts:2', 'src/b.ts:2', 'src/b.ts:6']))
    expect(matches.some((m) => m.file.includes('node_modules'))).toBe(false)
  })

  it('supports Python through the bundled grammar', async () => {
    const root = project()
    expect(supportedLanguages()).toContain('python')
    const { matches } = await astSearch(root, root, { pattern: 'print($$$ARGS)', lang: resolveLanguage('python'), max: 10 })
    expect(matches).toEqual([{ file: 'src/tool.py', line: 2, text: 'print("hi", name)' }])
    await expect(async () => resolveLanguage('cobol')).rejects.toThrow(/Unsupported language/)
  })

  it('rewrites with captured metavariables, keeping only the outermost of nested matches', async () => {
    const root = project()
    const changes = await astRewrite(join(root, 'src'), { pattern: 'console.log($$$A)', rewrite: 'logger.debug($$$A)', lang: null })
    const a = changes.find((c) => c.abs.endsWith('a.ts'))!
    expect(a.after).toContain('logger.debug("a", x)')
    const b = changes.find((c) => c.abs.endsWith('b.ts'))!
    // $$$A keeps the captured arguments' original text, line breaks and trailing comma included.
    expect(b.after).toContain('logger.debug("b",\n    1,)')
    expect(b.after).toContain('logger.debug(console.log("nested"))')
  })

  it('ast_edit asks once for all files and one Undo restores them', async () => {
    const env = makeServices()
    const root = project()
    const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, workspace: root, fileAccess: 'write', knowledgeEnabled: false, skillsEnabled: false, customTools: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ast_edit', { pattern: 'console.log($$$A)', rewrite: 'logger.debug($$$A)', language: 'ts', path: 'src' }, { id: 'ae' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Replaced the logging calls.')
    ])
    const asked: PendingApproval[] = []
    await env.services.chat.send(session.id, 'switch to logger')
    for (let i = 0; i < 400 && env.services.chat.isRunning(session.id); i++) {
      for (const e of env.events.map((x) => x.payload as ChatEvent)) {
        if (e.type === 'approval' && !asked.some((a) => a.id === e.approval.id)) {
          asked.push(e.approval)
          env.services.chat.resolveApproval(e.approval.id, 'allow')
        }
      }
      await wait(10)
    }
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'edit', path: '2 files' })
    expect(asked[0].diff).toContain('+++ b/src/a.ts')
    expect(asked[0].diff).toContain('+++ b/src/b.ts')
    const trace = env.services.chat
      .messages(session.id)
      .flatMap((m) => m.blocks)
      .find((b) => b.type === 'tool') as { trace: ToolTrace }
    expect(trace.trace.result).toMatch(/Rewrote 3 matches in 2 files/)
    expect(trace.trace.changes?.map((c) => c.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('logger.debug')

    await env.services.chat.undoChange(session.id, 'ae')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('console.log("a", x)')
    expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).not.toContain('logger')
  })
})
