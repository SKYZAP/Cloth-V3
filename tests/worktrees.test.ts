import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../src/main/panel/git'
import { appendFeatureLog, cleanupLogLine, cleanupWorkflow, commitWorkflowDocs, copyWorkingChanges, createWorkerTree, finishWorkerTree, parkWorkerTree, removeWorkerTree } from '../src/main/agent/worktrees'

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
  it("works out the subfolder when the chat's folder is reached through a link", async () => {
    // macOS's temp folder (/var) is a link to /private/var, and git reports the resolved path.
    const { root, g, trees } = await repo()
    mkdirSync(join(root, 'web'))
    writeFileSync(join(root, 'web', 'page.txt'), 'p\n')
    await g('add', '-A')
    await g('commit', '-q', '-m', 'web')
    const link = join(mkdtempSync(join(tmpdir(), 'cloth-wt-link-')), 'repo')
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    const t = (await createWorkerTree(join(link, 'web'), trees, { slug: null, label: 'linked', id: 'call_linked000001' }))!
    expect(t.workspace).toBe(join(t.dir, 'web'))
    writeFileSync(join(t.workspace, 'new.txt'), 'n\n')
    expect(existsSync(join(root, 'web', 'new.txt'))).toBe(false)
    expect(await finishWorkerTree(t, 'linked')).toEqual({ merged: true, files: ['web/new.txt'] })
  }, 60_000)

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

  it("gives a verifier the chat's uncommitted changes, and throws its copy away without touching the chat's folder", async () => {
    const { root, trees } = await repo()
    writeFileSync(join(root, 'app.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(root, 'new.txt'), 'fresh\n')
    const t = (await createWorkerTree(root, trees, { slug: 'feat', label: 'check spec', id: 'call_check0000001' }))!
    expect(await copyWorkingChanges(t)).toBe(2)
    expect(readFileSync(join(t.workspace, 'app.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(readFileSync(join(t.workspace, 'new.txt'), 'utf8')).toBe('fresh\n')
    writeFileSync(join(t.workspace, 'probe.txt'), 'scratch\n')
    await removeWorkerTree(t, true)
    expect(existsSync(t.dir)).toBe(false)
    expect(existsSync(join(root, 'probe.txt'))).toBe(false)
    expect(readFileSync(join(root, 'app.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(await branches(root)).toEqual(['main'])
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
    // A branch that isn't Cloth's, or is gone, starts fresh from the base in its own copy, saying so.
    const fresh = (await createWorkerTree(root, trees, { slug: 'feat', label: 'x', id: 'p3', from: 'main' }))!
    expect(fresh.missingFrom).toBe('main')
    expect(fresh.from).toBeUndefined()
    const gone = (await createWorkerTree(root, trees, { slug: 'feat', label: 'y', id: 'p4', from: 'cloth/feat/half-gone' }))!
    expect(gone.missingFrom).toBe('cloth/feat/half-gone')
    expect(readFileSync(join(gone.workspace, 'part2.txt'), 'utf8')).toBe('two')
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

describe('cleaning up when Spec → Ship is done', () => {
  it('removes every checkout and worker branch the feature left, and lists unmerged work', async () => {
    const { root, trees } = await repo()
    // One worker merged (its branch is gone already), one parked with unfinished work, one still checked out.
    const merged = (await createWorkerTree(root, trees, { slug: 'feat', label: 'Ticket 01', id: 'call_merged000001' }))!
    writeFileSync(join(merged.workspace, 'a.txt'), 'a\n')
    await finishWorkerTree(merged, 'Ticket 01')
    const parked = (await createWorkerTree(root, trees, { slug: 'feat', label: 'Ticket 02', id: 'call_parked000002' }))!
    writeFileSync(join(parked.workspace, 'b.txt'), 'b\n')
    const kept = await parkWorkerTree(parked, 'Ticket 02')
    const open = (await createWorkerTree(root, trees, { slug: 'feat', label: 'Check', id: 'call_open00000003' }))!
    // Another feature's branch and checkout stay.
    const other = (await createWorkerTree(root, trees, { slug: 'other', label: 'Ticket 01', id: 'call_other0000004' }))!
    // A folder git has forgotten but that is still on disk (Windows couldn't delete it).
    const stray = join(trees, 'stray-folder')
    mkdirSync(stray)
    writeFileSync(join(stray, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'stray-folder')}\n`)

    const c = (await cleanupWorkflow(root, 'feat', trees))!
    expect(existsSync(open.dir)).toBe(false)
    expect(existsSync(stray)).toBe(false)
    expect(existsSync(other.dir)).toBe(true)
    expect(c.left).toEqual([])
    expect(c.unmerged.map((u) => u.branch)).toEqual([kept])
    expect(c.merged).toEqual([open.branch])
    expect((await branches(root)).sort()).toEqual(['main', other.branch].sort())
    expect((await git(root, ['worktree', 'list'])).stdout).not.toContain('call_open')

    const line = cleanupLogLine(c)!
    expect(line).toContain(kept!)
    expect(line).toContain(c.unmerged[0].commit)
    mkdirSync(join(root, 'docs', 'specs', 'feat'), { recursive: true })
    writeFileSync(join(root, 'docs', 'specs', 'feat', 'log.md'), '| stage | decision | why | evidence |\n| --- | --- | --- | --- |')
    await appendFeatureLog(root, 'feat', line)
    expect(readFileSync(join(root, 'docs', 'specs', 'feat', 'log.md'), 'utf8').trimEnd().split('\n').at(-1)).toBe(line)
    expect(cleanupLogLine({ trees: 0, merged: [], unmerged: [], left: [] })).toBeNull()
  }, 60_000)
})
