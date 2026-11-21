import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentInstruction, checkChanged, plan, type Runner } from '../src/main/agent/formatters'
import { biomeRelease, formatterAsset } from '../src/main/agent/formatter-install'
import { DEFAULT_CODE_CHECKS, type CodeChecks } from '../src/shared/formatters'

const folder = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'cloth-fmt-'))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true })
    writeFileSync(join(root, name), text)
  }
  return root
}
const checks = (p: Partial<CodeChecks> = {}): CodeChecks => ({ ...DEFAULT_CODE_CHECKS, ...p })
const ids = (r: ReturnType<typeof plan>) => r.runs.map((x) => x.tool.id)

describe('plan', () => {
  it('uses only what a folder is set up for, unless Cloth’s defaults are wanted', () => {
    const bare = folder({ 'a.ts': 'x', 'b.py': 'y' })
    expect(ids(plan(bare, ['a.ts', 'b.py'], checks(), null))).toEqual([])
    // Bundled Prettier stands in; ESLint never runs without the folder's config.
    expect(ids(plan(bare, ['a.ts'], checks({ noSetup: 'defaults' }), null))).toEqual(['prettier'])
  })

  it('runs Prettier where a folder has a config, and reports a configured tool that isn’t installed', () => {
    const root = folder({ '.prettierrc': '{}', 'eslint.config.js': '', 'src/a.ts': 'x', 'README.md': '# hi' })
    const r = plan(root, ['src/a.ts', 'README.md', 'notes.txt'], checks(), null)
    expect(ids(r)).toEqual(['prettier'])
    expect(r.runs[0].files).toEqual(['src/a.ts', 'README.md'])
    expect(r.runs[0].launch.from).toBe('cloth')
    expect(r.missing.map((m) => m.name)).toEqual(['ESLint'])
  })

  it('lets Biome stand in for Prettier and ESLint, and skips tools switched off', () => {
    const root = folder({ 'biome.json': '{}', '.prettierrc': '{}', 'a.ts': 'x' })
    const r = plan(root, ['a.ts'], checks(), null)
    expect(r.runs.map((x) => x.tool.id)).toEqual([])
    expect(r.missing.map((m) => m.name)).toEqual(['Biome'])
    expect(ids(plan(root, ['a.ts'], checks({ off: ['biome'] }), null))).toEqual(['prettier'])
  })

  it('checks instead of fixing when fixes are off', () => {
    const root = folder({ '.prettierrc': '{}', 'a.ts': 'x' })
    expect(plan(root, ['a.ts'], checks({ fix: false }), null).runs[0].runs).toEqual([['--check', '--ignore-unknown', 'a.ts']])
  })
})

describe('checkChanged', () => {
  it('runs only when Cloth runs them, and tells the agent to re-read what got fixed', async () => {
    const root = folder({ '.prettierrc': '{}', 'a.ts': 'const a=1' })
    const fake: Runner = async () => {
      writeFileSync(join(root, 'a.ts'), 'const a = 1\n')
      return { ok: true, output: '' }
    }
    expect(await checkChanged(root, [join(root, 'a.ts')], checks(), { toolsDir: null, run: fake })).toEqual([])
    const notes = await checkChanged(root, [join(root, 'a.ts')], checks({ when: 'cloth' }), { toolsDir: null, run: fake })
    expect(notes).toEqual(['Prettier fixed a.ts. Read it again before editing it further.'])
  })

  it('reports what is left, with paths relative to the folder', async () => {
    const root = folder({ '.prettierrc': '{}', 'a.ts': 'x' })
    const fake: Runner = async () => ({ ok: false, output: `${join(root, 'a.ts')}:1:1 error something` })
    const [note] = await checkChanged(root, [join(root, 'a.ts')], checks({ when: 'cloth', fix: false }), { toolsDir: null, run: fake })
    expect(note).toBe('Prettier found problems:\na.ts:1:1 error something')
  })

  it('formats for real with the bundled Prettier', async () => {
    const root = folder({ '.prettierrc': '{"semi":false}', 'a.ts': 'const a  =  1;\n' })
    const notes = await checkChanged(root, [join(root, 'a.ts')], checks({ when: 'cloth' }), { toolsDir: null })
    expect(notes).toEqual(['Prettier fixed a.ts. Read it again before editing it further.'])
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\n')
  }, 30_000)
})

describe('agentInstruction', () => {
  it('gives the folder’s commands, or a general rule when nothing applies', () => {
    const root = folder({ '.prettierrc': '{}', 'a.ts': 'x' })
    const text = agentInstruction(root, checks(), null)!
    expect(text).toMatch(/^Before you finish a code change, run these on the files you changed/)
    expect(text).toContain('`prettier --write --ignore-unknown <files>`')
    expect(agentInstruction(folder({}), checks(), null)).toMatch(/project’s own formatter and linter/)
    expect(agentInstruction(root, checks({ when: 'cloth' }), null)).toBeNull()
  })
})

describe('installs', () => {
  const release = (names: string[], tag = 'v1') => ({ tag_name: tag, assets: names.map((name) => ({ name, browser_download_url: `https://x/${name}` })) })
  it('picks the download for this computer', () => {
    expect(formatterAsset('ruff', release(['ruff-x86_64-pc-windows-msvc.zip', 'ruff-aarch64-apple-darwin.tar.gz']), 'win32', 'x64')?.name).toBe('ruff-x86_64-pc-windows-msvc.zip')
    expect(formatterAsset('ruff', release(['ruff-x86_64-pc-windows-msvc.zip', 'ruff-aarch64-apple-darwin.tar.gz']), 'darwin', 'arm64')?.name).toBe('ruff-aarch64-apple-darwin.tar.gz')
    expect(formatterAsset('biome', release(['biome-win32-x64.exe', 'biome-linux-x64']), 'win32', 'x64')?.name).toBe('biome-win32-x64.exe')
    expect(formatterAsset('golangci-lint', release(['golangci-lint-2.6.0-windows-amd64.zip', 'golangci-lint-2.6.0-linux-amd64.tar.gz']), 'linux', 'x64')?.name).toBe('golangci-lint-2.6.0-linux-amd64.tar.gz')
    expect(formatterAsset('google-java-format', release(['google-java-format-1.28.0.jar', 'google-java-format-1.28.0-all-deps.jar']))?.name).toBe('google-java-format-1.28.0-all-deps.jar')
    expect(formatterAsset('ruff', release(['ruff-x86_64-pc-windows-msvc.zip']), 'win32', 'ia32')).toBeNull()
  })
  it('finds Biome’s CLI among the repository’s releases', () => {
    expect(biomeRelease([release([], '@biomejs/js-api@1.0.0'), release([], '@biomejs/biome@2.3.4')])?.tag_name).toBe('@biomejs/biome@2.3.4')
  })
})
