import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../src/main/panel/git'
import { commitWorkflowDocs, createWorkerTree, finishWorkerTree, parkWorkerTree } from '../src/main/agent/worktrees'

async function repo() {
  const root = mkdtempSync(join(tmpdir(), 'cloth-wt-'))
  const g = (...args: string[]) => git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  await g('init', '-q', '-b', 'main')
  await g('config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'app.txt'), 'one\ntwo\nthree\n')
  await g('add', '-A')
  await g('commit', '-q', '-m', 'start')
  return { root, g, trees: mkdtempSync(join(tmpdir(), 'cloth-wt-trees-')) }
}
const log = async (root: string) => (await git(root, ['log', '--format=%s'])).stdout.trim().split('\n')
const branches = async (root: string) => (await git(root, ['branch', '--format=%(refname:short)'])).stdout.trim().split('\n')

describe('worker worktrees', () => {
  it('give each worker its own branch and merge its work back', async () => {
    const { root, trees } = await repo()
    const a = (await createWorkerTree(root, trees, { slug: 'feat', label: 'Ticket 01', id: 'call_aaaaaa111111' }))!
    const b = (await createWorkerTree(root, trees, { slug: 'feat', label: 'Ticket 02', id: 'call_bbbbbb222222' }))!
    expect(a.branch).toBe('cloth/feat/ticket-01-111111')
    expect(a.base).toBe('main')
    // Separate checkouts: neither sees the other's files, nor does the chat's folder.
    writeFileSync(join(a.workspace, 'a.txt'), 'A\n')
    writeFileSync(join(b.workspace, 'b.txt'), 'B\n')
    expect(existsSync(join(b.workspace, 'a.txt'))).toBe(false)
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
    expect(await finishWorkerTree(a, 'Ticket 01')).toEqual({ merged: true, files: ['a.txt'] })
    expect(await finishWorkerTree(b, 'Ticket 02')).toEqual({ merged: true, files: ['b.txt'] })
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('B\n')
    // Checkouts and merged branches are gone.
    expect(existsSync(a.dir)).toBe(false)
    expect(await branches(root)).toEqual(['main'])
    expect((await git(root, ['worktree', 'list'])).stdout.trim().split('\n')).toHaveLength(1)
  }, 60_000)

  it('aborts a conflicting merge and keeps the branch', async () => {
    const { root, trees } = await repo()
    const a = (await createWorkerTree(root, trees, { slug: 'feat', label: 'one', id: 'x1' }))!
    const b = (await createWorkerTree(root, trees, { slug: 'feat', label: 'two', id: 'x2' }))!
    writeFileSync(join(a.workspace, 'app.txt'), 'one\nTWO by a\nthree\n')
    writeFileSync(join(b.workspace, 'app.txt'), 'one\nTWO by b\nthree\n')
    expect((await finishWorkerTree(a, 'one')).merged).toBe(true)
    const r = await finishWorkerTree(b, 'two')
    expect(r).toMatchObject({ merged: false, files: ['app.txt'], conflicts: ['app.txt'] })
    expect(r.error).toContain(b.branch)
    // The chat's folder is left as it was after the first merge, not mid-merge.
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe('one\nTWO by a\nthree\n')
    expect((await git(root, ['status', '--porcelain'])).stdout.trim()).toBe('')
    expect(await branches(root)).toContain(b.branch)
  }, 60_000)

  it('commits only the workflow documents first, leaving other changes alone', async () => {
    const { root, trees } = await repo()
    writeFileSync(join(root, 'GLOSSARY.md'), '# G\n')
    mkdirSync(join(root, 'docs/specs/feat/tickets'), { recursive: true })
    writeFileSync(join(root, 'docs/specs/feat/spec.md'), '# Spec\n')
    writeFileSync(join(root, 'docs/specs/feat/tickets/01-x.md'), '# 01\n')
    writeFileSync(join(root, 'app.txt'), 'my own unfinished edit\n')
    const t = (await createWorkerTree(root, trees, { slug: 'feat', label: 'one', id: 'y1' }))!
    // The worker sees the spec; the person's own edit stays uncommitted in their folder only.
    expect(readFileSync(join(t.workspace, 'docs/specs/feat/spec.md'), 'utf8')).toBe('# Spec\n')
    expect(readFileSync(join(t.workspace, 'app.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect((await log(root))[0]).toBe('Spec: feat (glossary, decisions, spec and tickets)')
    expect((await git(root, ['status', '--porcelain'])).stdout.trim()).toBe('M app.txt')
    expect(await commitWorkflowDocs(root, root, 'feat')).toBe(false)
    await parkWorkerTree(t, 'one')
  }, 60_000)

  it('parks an unfinished worker on its branch without merging', async () => {
    const { root, trees } = await repo()
    const t = (await createWorkerTree(root, trees, { slug: null, label: 'half', id: 'z1' }))!
    writeFileSync(join(t.workspace, 'half.txt'), 'partial\n')
    expect(await parkWorkerTree(t, 'half')).toBe(t.branch)
    expect(existsSync(join(root, 'half.txt'))).toBe(false)
    expect(await branches(root)).toContain(t.branch)
    expect(existsSync(t.dir)).toBe(false)
  }, 60_000)

  it('carries on from a parked branch and cleans both up once merged', async () => {
    const { root, trees } = await repo()
    const first = (await createWorkerTree(root, trees, { slug: 'feat', label: 'half', id: 'p1' }))!
    writeFileSync(join(first.workspace, 'part1.txt'), 'one')
    const parked = (await parkWorkerTree(first, 'half'))!
    const next = (await createWorkerTree(root, trees, { slug: 'feat', label: 'rest', id: 'p2', from: parked }))!
    expect(readFileSync(join(next.workspace, 'part1.txt'), 'utf8')).toBe('one')
    writeFileSync(join(next.workspace, 'part2.txt'), 'two')
    expect((await finishWorkerTree(next, 'rest')).merged).toBe(true)
    expect(readFileSync(join(root, 'part1.txt'), 'utf8')).toBe('one')
    expect(readFileSync(join(root, 'part2.txt'), 'utf8')).toBe('two')
    expect(await branches(root)).toEqual(['main'])
    await expect(createWorkerTree(root, trees, { slug: 'feat', label: 'x', id: 'p3', from: 'main' })).rejects.toThrow(/no worker branch/)
  }, 60_000)

  it('merges commits the worker made itself', async () => {
    const { root, trees } = await repo()
    const t = (await createWorkerTree(root, trees, { slug: 'feat', label: 'self', id: 's1' }))!
    writeFileSync(join(t.workspace, 'own.txt'), 'mine')
    await git(t.dir, ['add', '-A'])
    await git(t.dir, ['-c', 'user.name=w', '-c', 'user.email=w@w', 'commit', '-q', '-m', 'worker commit'])
    expect(await finishWorkerTree(t, 'self')).toEqual({ merged: true, files: ['own.txt'] })
    expect(readFileSync(join(root, 'own.txt'), 'utf8')).toBe('mine')
  }, 60_000)

  it('links node_modules into the worker copy and never deletes the real one', async () => {
    const { root, trees } = await repo()
    writeFileSync(join(root, '.gitignore'), 'node_modules')
    await git(root, ['add', '.gitignore'])
    await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore'])
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1')
    const t = (await createWorkerTree(root, trees, { slug: 'feat', label: 'deps', id: 'd1' }))!
    expect(readFileSync(join(t.workspace, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1')
    writeFileSync(join(t.workspace, 'x.txt'), 'x')
    expect(await finishWorkerTree(t, 'deps')).toEqual({ merged: true, files: ['x.txt'] })
    expect(existsSync(t.dir)).toBe(false)
    expect(readFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1')
    const u = (await createWorkerTree(root, trees, { slug: 'feat', label: 'deps2', id: 'd2' }))!
    await parkWorkerTree(u, 'deps2')
    expect(readFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1')
  }, 60_000)

  it('catches continued work up with the base, marking conflicts to resolve', async () => {
    const NL = String.fromCharCode(10)
    const { root, trees, g } = await repo()
    const first = (await createWorkerTree(root, trees, { slug: 'feat', label: 'old', id: 'c1' }))!
    writeFileSync(join(first.workspace, 'app.txt'), ['one', 'TWO from old work', 'three', ''].join(NL))
    const parked = (await parkWorkerTree(first, 'old'))!
    // Meanwhile something else lands on main, changing the same line.
    writeFileSync(join(root, 'app.txt'), ['one', 'TWO on main', 'three', ''].join(NL))
    await g('commit', '-qam', 'main moves on')
    const next = (await createWorkerTree(root, trees, { slug: 'feat', label: 'new', id: 'c2', from: parked }))!
    expect(next.conflicts).toEqual(['app.txt'])
    expect(readFileSync(join(next.workspace, 'app.txt'), 'utf8')).toContain('<<<<<<<')
    // The worker resolves it; finishing concludes the merge and lands cleanly on main.
    writeFileSync(join(next.workspace, 'app.txt'), ['one', 'TWO on main, with old work', 'three', ''].join(NL))
    expect((await finishWorkerTree(next, 'new')).merged).toBe(true)
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe(['one', 'TWO on main, with old work', 'three', ''].join(NL))
    expect(await branches(root)).toEqual(['main'])
  }, 60_000)

  it('stays out of folders that are not git repositories', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cloth-plain-'))
    expect(await createWorkerTree(plain, join(plain, '.trees'), { slug: 'x', label: 'y', id: 'z' })).toBeNull()
  })
})
