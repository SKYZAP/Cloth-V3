import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeServices } from './helpers'
import { AgentService, REVIEWER_INSTRUCTIONS, REVIEWER_INSTRUCTIONS_V1 } from '../src/main/agent/agents'
import { gitChanges } from '../src/main/agent/workspace'

const g = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-review-'))
  g(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  g(dir, 'add', '.')
  g(dir, 'commit', '-q', '-m', 'first')
  return dir
}

describe('the Code reviewer', () => {
  it('starts with instructions that find the change with git_diff and prove each finding', () => {
    const { services } = makeServices()
    const reviewer = services.agents.builtin('reviewer')
    expect(reviewer.instructions).toBe(REVIEWER_INSTRUCTIONS)
    expect(reviewer.instructions).toMatch(/git_diff/)
    expect(reviewer.instructions).toMatch(/How it fails/)
  })

  it('moves a reviewer still on the first instructions to the new ones, and leaves edited ones alone', () => {
    const { services } = makeServices()
    const id = services.agents.builtin('reviewer').id
    const setInstructions = (text: string) => {
      const row = services.ctx.db.prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string }
      services.ctx.db.prepare('UPDATE agents SET config = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.config), instructions: text }), id)
    }
    const fresh = () => new AgentService(services.ctx, services.providers, services.settings)
    setInstructions(REVIEWER_INSTRUCTIONS_V1)
    expect(fresh().builtin('reviewer').instructions).toBe(REVIEWER_INSTRUCTIONS)
    setInstructions('Only look at SQL.')
    expect(fresh().builtin('reviewer').instructions).toBe('Only look at SQL.')
  })
})

describe('git_diff', () => {
  it('shows uncommitted changes against HEAD, with new untracked files listed', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
    writeFileSync(join(dir, 'b.ts'), 'new\n')
    const out = await gitChanges(dir)
    expect(out).toContain('a.ts')
    expect(out).toContain('+export const a = 2')
    expect(out).toMatch(/New untracked files[^\n]*\n.*b\.ts/)
  })

  it('compares with a branch range and lists its commits, limited to a path', async () => {
    const dir = repo()
    g(dir, 'checkout', '-q', '-b', 'feature')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'c.ts'), 'export const c = 3\n')
    writeFileSync(join(dir, 'a.ts'), 'export const a = 9\n')
    g(dir, 'add', '.')
    g(dir, 'commit', '-q', '-m', 'add c')
    const out = await gitChanges(dir, { base: 'main...HEAD', path: join(dir, 'src') })
    expect(out).toMatch(/Commits in main\.\.\.HEAD:\n\w+ add c/)
    expect(out).toContain('+export const c = 3')
    expect(out).not.toContain('a.ts')
    const stat = await gitChanges(dir, { base: 'main...HEAD', statOnly: true })
    expect(stat).toContain('a.ts')
    expect(stat).not.toContain('@@')
  })

  it('says so when nothing changed, and refuses refs that would read as options', async () => {
    const dir = repo()
    expect(await gitChanges(dir)).toMatch(/^No changes/)
    await expect(gitChanges(dir, { base: '--output=x' })).rejects.toThrow(/not a branch/)
    await expect(gitChanges(dir, { base: 'main; rm -rf' })).rejects.toThrow(/not a branch/)
  })

  it('works in a repository with no commits yet, and outside any repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloth-review-'))
    expect(await gitChanges(dir)).toMatch(/not in a git repository/)
    g(dir, 'init', '-q')
    writeFileSync(join(dir, 'x.ts'), 'x\n')
    g(dir, 'add', '.')
    expect(await gitChanges(dir)).toContain('+x')
  })
})
