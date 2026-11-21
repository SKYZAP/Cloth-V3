import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildWorkspaceTools, numberLines, READ_MAX_PATHS } from '../src/main/agent/workspace'
import { earlierSpec } from '../src/main/agent/tools'

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')

describe('numberLines', () => {
  it('numbers from the offset and keeps pi\'s continuation note unnumbered', () => {
    expect(numberLines('a\nb', 1)).toBe('1\ta\n2\tb')
    expect(numberLines('x\ny\n\n[Showing lines 9-10 of 40. Use offset=11 to continue.]', 9)).toBe(' 9\tx\n10\ty\n\n[Showing lines 9-10 of 40. Use offset=11 to continue.]')
    expect(numberLines('p\n\n[3 more lines in file. Use offset=5 to continue.]', 4)).toBe('4\tp\n\n[3 more lines in file. Use offset=5 to continue.]')
    expect(numberLines('[Line 1 is 80KB, exceeds 50KB limit. Use bash: …]', 1)).toMatch(/^\[Line 1 is/)
  })
})

describe('read', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloth-read-'))
  writeFileSync(join(root, 'a.ts'), 'const a = 1\nexport { a }\n')
  writeFileSync(join(root, 'b.ts'), 'b1\nb2\nb3\n')
  const read = buildWorkspaceTools({ root, access: 'read' } as Parameters<typeof buildWorkspaceTools>[0]).find((t) => t.name === 'read')!

  it('reads one file with line numbers', async () => {
    expect(text(await read.execute('1', { path: 'a.ts' }))).toBe('1\tconst a = 1\n2\texport { a }\n3\t')
  })

  it('reads several files in one call, reporting a missing one in its place', async () => {
    const out = text(await read.execute('2', { paths: ['a.ts', 'missing.ts', 'b.ts'], offset: 2, limit: 1 }))
    expect(out).toContain('==> a.ts <==\n2\texport { a }')
    expect(out).toMatch(/==> missing\.ts <==\n\(could not read: /)
    expect(out).toContain('==> b.ts <==\n2\tb2')
  })

  it('refuses no path or too many', async () => {
    await expect(read.execute('3', {})).rejects.toThrow(/Give path/)
    await expect(read.execute('4', { paths: Array.from({ length: READ_MAX_PATHS + 1 }, (_, i) => `f${i}.ts`) })).rejects.toThrow(/at most/)
  })
})

describe('earlierSpec', () => {
  it('counts only a listed spec that is already committed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloth-spec-'))
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root })
    g('init', '-q')
    mkdirSync(join(root, 'docs/specs/old'), { recursive: true })
    writeFileSync(join(root, 'docs/specs/old/spec.md'), '# Old\n')
    writeFileSync(join(root, 'docs/specs/README.md'), '- [old](old/spec.md)\n')
    g('add', '-A')
    g('commit', '-qm', 'old')
    // The workflow's own spec, listed by the agent but not committed yet.
    mkdirSync(join(root, 'docs/specs/new'), { recursive: true })
    writeFileSync(join(root, 'docs/specs/new/spec.md'), '# New\n')
    writeFileSync(join(root, 'docs/specs/README.md'), '- [old](old/spec.md)\n- [new](new/spec.md)\n')
    expect(await earlierSpec(root, 'old')).toBe(true)
    expect(await earlierSpec(root, 'new')).toBe(false)
    expect(await earlierSpec(root, 'other')).toBe(false)
  })

  it('without git, a listed spec counts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloth-spec-'))
    mkdirSync(join(root, 'docs/specs'), { recursive: true })
    writeFileSync(join(root, 'docs/specs/README.md'), '- [old](old/spec.md)\n')
    expect(await earlierSpec(root, 'old')).toBe(true)
  })
})
