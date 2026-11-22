// Real downloads from GitHub: run with CLOTH_NET_TESTS=1.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFormatter, installedFormatter, uninstallFormatter, type InstallableFormatter } from '../src/main/agent/formatter-install'
import { findOnPath } from '../src/main/agent/lsp'

const net = process.env.CLOTH_NET_TESTS === '1'

describe.skipIf(!net)('formatter installs (network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-formatters-'))
  const cases: [InstallableFormatter, string[], RegExp][] = [
    ['ruff', ['--version'], /^ruff \d/],
    ['biome', ['--version'], /Version: \d/],
    ['golangci-lint', ['version'], /golangci-lint has version \d/],
    ['google-java-format', ['--replace', 'A.java'], /^class A \{\r?\n  int x = 1;\r?\n\}\r?\n$/]
  ]
  for (const [id, args, expected] of cases) {
    it(`installs ${id} and runs it`, async () => {
      const steps: string[] = []
      const m = await installFormatter(dir, id, { onProgress: (t) => steps.push(t) })
      expect(steps.at(-1)).toBe('Installed')
      const program = installedFormatter(dir, id)!
      expect(program).toBeTruthy()
      let out: string
      if (program.endsWith('.jar')) {
        // Formats a file in place, the way Cloth runs it (java -jar … --replace).
        const work = mkdtempSync(join(tmpdir(), 'cloth-gjf-'))
        writeFileSync(join(work, 'A.java'), 'class A{int x=1;}')
        execFileSync(findOnPath('java')!, ['-jar', program, ...args], { cwd: work, stdio: 'pipe' })
        out = readFileSync(join(work, 'A.java'), 'utf8')
      } else out = execFileSync(program, args, { encoding: 'utf8' }).trim()
      expect(out).toMatch(expected)
      expect(m.version).toMatch(/^\d/)
      await uninstallFormatter(dir, id)
      expect(installedFormatter(dir, id)).toBeNull()
    }, 180_000)
  }
})
