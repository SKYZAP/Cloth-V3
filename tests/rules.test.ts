import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ToolTrace } from '../src/shared/types'
import { checkRules, folderNotes, globalRulesDir, loadRules, ruleNotes } from '../src/main/agent/rules'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const NO_DEFAULT_EXPORT = `id: no-default-export
language: TypeScript
severity: error
message: Use a named export.
rule:
  kind: export_statement
  regex: "^export default"
`

const NO_CONSOLE = `id: no-console
language: TypeScript
severity: warning
message: Use the logger.
ignores:
  - "scripts/**"
rule:
  pattern: console.log($$$ARGS)
---
id: switched-off
language: TypeScript
severity: off
rule:
  pattern: $X
`

const JAVA_NO_SYSTEM_OUT = `id: java-no-system-out
language: Java
severity: error
message: Use a logger.
rule:
  pattern: System.out.println($$$ARGS)
`

/** A workspace with its own sgconfig.yml rules, the way the coding-rules kit lays them out. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cloth-rules-'))
  mkdirSync(join(root, '.rules', 'ast-grep', 'rules'), { recursive: true })
  writeFileSync(join(root, '.rules', 'ast-grep', 'sgconfig.yml'), 'ruleDirs:\n  - rules\n')
  writeFileSync(join(root, '.rules', 'ast-grep', 'rules', 'no-console.yml'), NO_CONSOLE)
  writeFileSync(join(root, '.rules', 'ast-grep', 'rules', 'java.yml'), JAVA_NO_SYSTEM_OUT)
  return root
}

function globalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-global-rules-'))
  writeFileSync(join(dir, 'exports.yaml'), NO_DEFAULT_EXPORT)
  return dir
}

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

describe('coding rule checks', () => {
  it("loads the folder's sgconfig.yml rules and the global ones, skipping rules switched off", async () => {
    const rules = await loadRules(workspace(), globalDir())
    expect(rules.map((r) => r.id).sort()).toEqual(['java-no-system-out', 'no-console', 'no-default-export'])
  })

  it('reports each violation with its line, rule and message', async () => {
    const rules = await loadRules(workspace(), globalDir())
    const found = checkRules('src/app.ts', 'const a = 1\nconsole.log(a)\nexport default a\n', rules)
    expect(found).toEqual([
      { rule: 'no-console', severity: 'warning', message: 'Use the logger.', line: 2 },
      { rule: 'no-default-export', severity: 'error', message: 'Use a named export.', line: 3 }
    ])
  })

  it("respects a rule's ignores, its language, and files no rule covers", async () => {
    const rules = await loadRules(workspace(), null)
    expect(checkRules('scripts/build.ts', 'console.log("ok")\n', rules)).toEqual([])
    expect(checkRules('src/Main.java', 'class Main { void run() { System.out.println("hi"); } }\n', rules).map((v) => v.rule)).toEqual(['java-no-system-out'])
    expect(checkRules('README.md', 'console.log("not code")\n', rules)).toEqual([])
  })

  it('has nothing to say in a folder without rules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloth-norules-'))
    expect(await loadRules(root, null)).toEqual([])
    expect(await ruleNotes(root, null, [{ rel: 'a.ts', after: 'export default 1\n' }])).toEqual([])
  })

  it('a broken rule file is skipped, not fatal', async () => {
    const dir = globalDir()
    writeFileSync(join(dir, 'broken.yml'), 'id: [unclosed\n')
    writeFileSync(join(dir, 'unknown-language.yml'), 'id: x\nlanguage: Cobol\nrule:\n  pattern: $X\n')
    expect((await loadRules(mkdtempSync(join(tmpdir(), 'cloth-empty-')), dir)).map((r) => r.id)).toEqual(['no-default-export'])
  })
})

describe('folder notes', () => {
  it('uses AGENTS.md, falls back to CLAUDE.md, and has nothing for a folder without either', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'cloth-notes-'))
    expect(await folderNotes(folder)).toBe('')
    writeFileSync(join(folder, 'CLAUDE.md'), 'Use pnpm.')
    expect(await folderNotes(folder)).toBe('Project notes from CLAUDE.md:\n\nUse pnpm.')
    writeFileSync(join(folder, 'AGENTS.md'), 'Use npm.')
    expect(await folderNotes(folder)).toBe('Project notes from AGENTS.md:\n\nUse npm.')
  })
})

describe('coding rules in chats', () => {
  it("a chat in a folder (no project) gets the coding rules setting and the folder's AGENTS.md, and edits are checked", { timeout: 60_000 }, async () => {
    const env = makeServices()
    const root = workspace()
    writeFileSync(join(root, 'AGENTS.md'), '# Notes\nRun tests with npm test.')
    writeFileSync(join(root, 'app.ts'), 'export const a = 1\n')
    writeFileSync(join(globalRulesDir(env.dataDir), 'exports.yml'), NO_DEFAULT_EXPORT)
    env.services.settings.update({ codingRules: 'Prefer early returns.' })
    const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const session = env.services.chat.create({
      model: { providerId: provider.id, modelId: 'faux-1' },
      workspace: root,
      fileAccess: 'write',
      autoApprove: 'edits',
      knowledgeEnabled: false,
      skillsEnabled: false,
      customTools: false,
      codeIntel: false
    })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let seen = ''
    faux.setResponses([
      (ctx: TranscriptContext) => {
        seen = JSON.stringify(ctx)
        return fauxAssistantMessage([fauxToolCall('edit', { path: 'app.ts', edits: [{ oldText: 'export const a = 1', newText: 'console.log(1)\nexport default 1' }] }, { id: 'ed' })], { stopReason: 'toolUse' })
      },
      fauxAssistantMessage('done')
    ])
    await env.services.chat.send(session.id, 'change it')
    for (let i = 0; i < 400 && env.services.chat.isRunning(session.id); i++) await wait(25)

    expect(seen).toContain('## Coding rules')
    expect(seen).toContain('Prefer early returns.')
    expect(seen).toContain('Run tests with npm test.')
    expect(seen.indexOf('Prefer early returns.')).toBeLessThan(seen.indexOf('Run tests with npm test.'))
    expect(seen).toContain('Changed files are checked against the coding rules')

    const edit = env.services.chat
      .messages(session.id)
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool')
      .map((b) => (b as { trace: ToolTrace }).trace)
      .find((t) => t.id === 'ed')!
    expect(edit.status).toBe('ok')
    expect(edit.result).toMatch(/Coding rule violations after this change/)
    expect(edit.result).toContain('app.ts:1 [no-console, warning] Use the logger.')
    expect(edit.result).toContain('app.ts:2 [no-default-export, error] Use a named export.')
  })

  it('a chat without a folder gets no coding rules section', async () => {
    const env = makeServices()
    env.services.settings.update({ codingRules: 'Prefer early returns.' })
    const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const session = env.services.chat.create({ model: { providerId: provider.id, modelId: 'faux-1' }, knowledgeEnabled: false, skillsEnabled: false, customTools: false })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    let seen = ''
    faux.setResponses([
      (ctx: TranscriptContext) => {
        seen = JSON.stringify(ctx)
        return fauxAssistantMessage('ok')
      }
    ])
    await env.services.chat.send(session.id, 'hi')
    for (let i = 0; i < 200 && env.services.chat.isRunning(session.id); i++) await wait(10)
    expect(seen).not.toContain('Coding rules')
    expect(seen).not.toContain('Prefer early returns.')
  })
})
