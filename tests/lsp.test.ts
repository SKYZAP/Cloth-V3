import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { registerFauxProvider } from '@earendil-works/pi-ai/compat'
import type { ToolTrace } from '../src/shared/types'
import { LspManager, findOnPath, findPosition, locations, describeLocations, hoverText, javaMajor, jdtlsDataDir, lspLanguage } from '../src/main/agent/lsp'
import { makeServices } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tsProject() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloth-lsp-')))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }))
  writeFileSync(join(root, 'src', 'greet.ts'), 'export function greet(name: string): string {\n  return `hi ${name}`\n}\n')
  writeFileSync(join(root, 'src', 'main.ts'), "import { greet } from './greet'\n\nconst n: number = greet('ada')\nconsole.log(greet('grace'), n)\n")
  return root
}

const manager = new LspManager()
afterAll(() => manager.disposeAll())

let faux: ReturnType<typeof registerFauxProvider> | null = null
afterEach(() => {
  faux?.unregister()
  faux = null
})

describe('language servers', () => {
  it('TypeScript: diagnostics, definition, references and hover', { timeout: 90_000 }, async () => {
    const root = tsProject()
    const main = join(root, 'src', 'main.ts')
    const server = await manager.server(root, main)
    // A cold TypeScript server takes a while on a slow machine (the Pi's CI runner).
    const diags = await server.diagnostics(main, 60_000)
    expect(diags.some((d) => d.severity === 1 && /not assignable to type 'number'/.test(d.message))).toBe(true)

    const uri = await server.sync(main)
    const text = readFileSync(main, 'utf8')
    const pos = findPosition(text, 'greet', 3)
    const def = await describeLocations(root, locations(await server.request('textDocument/definition', { textDocument: { uri }, position: pos })))
    expect(def).toMatch(/^src\/greet\.ts:1: export function greet/)
    const refs = await describeLocations(root, locations(await server.request('textDocument/references', { textDocument: { uri }, position: pos, context: { includeDeclaration: true } })))
    expect(refs.split('\n').length).toBeGreaterThanOrEqual(4)
    const hover = hoverText(await server.request('textDocument/hover', { textDocument: { uri }, position: pos }))
    expect(hover).toContain('greet(name: string): string')
  })

  it('Python (Pyright): diagnostics', { timeout: 90_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloth-py-')))
    writeFileSync(join(root, 'm.py'), 'def add(a: int, b: int) -> int:\n    return a + b\n\nx: str = add(1, 2)\n')
    const server = await manager.server(root, join(root, 'm.py'))
    // Pyright's first (cold) analysis can take well over the default 10s on a busy machine or CI runner.
    const diags = await server.diagnostics(join(root, 'm.py'), 60_000)
    expect(diags.some((d) => d.severity === 1 && /not assignable/.test(d.message))).toBe(true)
  })

  it('findPosition tolerates being a line or two off and matches whole words', () => {
    const text = 'const greeting = 1\nfunction greet() {}\n'
    expect(findPosition(text, 'greet', 2)).toEqual({ line: 1, character: 9 })
    expect(findPosition(text, 'greet', 1)).toEqual({ line: 1, character: 9 })
    expect(findPosition(text, 'greet', undefined)).toEqual({ line: 1, character: 9 })
    expect(() => findPosition(text, 'nope', 1)).toThrow(/not on line/)
  })

  it('chat: rename across files in one approval, and type errors reported right after an edit', { timeout: 120_000 }, async () => {
    const env = makeServices()
    const root = tsProject()
    const provider = env.services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const session = env.services.chat.create({
      model: { providerId: provider.id, modelId: 'faux-1' },
      workspace: root,
      fileAccess: 'write',
      autoApprove: 'edits',
      knowledgeEnabled: false,
      skillsEnabled: false,
      customTools: false
    })
    faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('lsp', { action: 'rename', path: 'src/greet.ts', symbol: 'greet', line: 1, newName: 'welcome' }, { id: 'rn' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('edit', { path: 'src/greet.ts', edits: [{ oldText: 'return `hi ${name}`', newText: 'return name.length' }] }, { id: 'ed' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('done')
    ])
    await env.services.chat.send(session.id, 'rename greet to welcome, then return the length')
    for (let i = 0; i < 1000 && env.services.chat.isRunning(session.id); i++) await wait(50)
    const traces = env.services.chat
      .messages(session.id)
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool')
      .map((b) => (b as { trace: ToolTrace }).trace)
    const rename = traces.find((t) => t.id === 'rn')!
    expect(rename.status).toBe('ok')
    expect(rename.result).toMatch(/Renamed greet → welcome in 2 files/)
    expect(readFileSync(join(root, 'src', 'main.ts'), 'utf8')).toContain("import { welcome } from './greet'")
    expect(readFileSync(join(root, 'src', 'main.ts'), 'utf8')).toContain("welcome('grace')")
    // The edit makes welcome() return a number while it is declared to return string.
    const edit = traces.find((t) => t.id === 'ed')!
    expect(edit.result).toMatch(/Type errors after this change/)
    expect(edit.result).toMatch(/not assignable to type 'string'/)
    env.services.lsp.disposeAll()
  })
})

describe('Java (jdtls)', () => {
  const saved = { PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME }
  afterEach(() => {
    process.env.PATH = saved.PATH
    if (saved.JAVA_HOME === undefined) delete process.env.JAVA_HOME
    else process.env.JAVA_HOME = saved.JAVA_HOME
  })
  const javaProject = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cloth-java-')))
    writeFileSync(join(root, 'Main.java'), 'public class Main {\n  public static void main(String[] args) {\n    int n = "text";\n  }\n}\n')
    return root
  }
  const emptyBin = () => realpathSync(mkdtempSync(join(tmpdir(), 'cloth-bin-')))

  it('maps .java files to jdtls', () => {
    expect(lspLanguage('src/Main.java')).toEqual({ server: 'java', languageId: 'java' })
    expect(lspLanguage('src/App.kt')).toBeNull()
  })

  it("only runs when Java is one of the user's languages", () => {
    const root = javaProject()
    expect(() => new LspManager(() => ['go']).server(root, join(root, 'Main.java'))).toThrow(/Code intelligence for \.java files is off/)
  })

  it('says so when jdtls is not installed', async () => {
    const root = javaProject()
    process.env.PATH = emptyBin()
    await expect(new LspManager(() => ['java']).server(root, join(root, 'Main.java'))).rejects.toThrow(/jdtls isn't installed/)
  })

  it('says so when Java itself is missing', async () => {
    const root = javaProject()
    const bin = emptyBin()
    writeFileSync(join(bin, process.platform === 'win32' ? 'jdtls.cmd' : 'jdtls'), '')
    process.env.PATH = bin
    delete process.env.JAVA_HOME
    await expect(new LspManager(() => ['java']).server(root, join(root, 'Main.java'))).rejects.toThrow(/jdtls needs Java 21 or newer, and no Java was found/)
  })

  it('reads Java versions and keeps its workspace out of the project', () => {
    expect(javaMajor('openjdk version "21.0.7" 2025-04-15 LTS')).toBe(21)
    expect(javaMajor('java version "1.8.0_402"')).toBe(8)
    expect(javaMajor('nonsense')).toBeNull()
    const root = javaProject()
    const base = join(tmpdir(), 'cloth-data', 'lsp')
    const dir = jdtlsDataDir(base, root)
    expect(dir.startsWith(join(base, 'jdtls'))).toBe(true)
    expect(dir.startsWith(root)).toBe(false)
    expect(jdtlsDataDir(base, root)).toBe(dir)
    expect(jdtlsDataDir(base, javaProject())).not.toBe(dir)
  })

  it.skipIf(!findOnPath('jdtls'))('diagnostics from a real jdtls after the project import', { timeout: 360_000 }, async () => {
    const root = javaProject()
    const java = new LspManager(() => ['java'], realpathSync(mkdtempSync(join(tmpdir(), 'cloth-lsp-data-'))))
    try {
      const server = await java.server(root, join(root, 'Main.java'))
      const diags = await server.diagnostics(join(root, 'Main.java'), 60_000)
      expect(diags.some((d) => d.severity === 1 && /String/.test(d.message))).toBe(true)
    } finally {
      java.disposeAll()
    }
  })
})
