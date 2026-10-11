import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inside, listDir, readWorkspaceFile } from '../src/main/panel/files'
import { gitInit, parseStatus } from '../src/main/panel/git'
import { makeServices } from './helpers'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cloth-panel-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, '.gitignore'), 'dist/\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  return dir
}

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

describe('chat side panel', () => {
  it.skipIf(!hasGit)('initialises a folder as a git repository without committing', async () => {
    const { services } = makeServices()
    const dir = mkdtempSync(join(tmpdir(), 'cloth-init-'))
    writeFileSync(join(dir, 'a.txt'), 'hi\n')
    const chat = services.chat.create({ workspace: dir })
    expect(await services.panel.gitStatus(chat.id)).toMatchObject({ repo: false })
    const status = await services.panel.gitInit(chat.id)
    expect(status).toMatchObject({ repo: true })
    expect(existsSync(join(dir, '.git'))).toBe(true)
    expect(existsSync(join(dir, '.gitignore'))).toBe(false)
    expect(status.files.map((f) => [f.path, f.untracked])).toEqual([['a.txt', true]])
    const head = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, stdio: 'pipe' }).toString().trim()
    const [maj, min] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version']).toString())!.slice(1).map(Number)
    if (maj > 2 || (maj === 2 && min >= 28)) expect(head).toBe('main')
    expect(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, stdio: 'pipe' })).toThrow()
  })

  it.skipIf(!hasGit)('leaves an existing repository alone when asked to initialise it', async () => {
    const dir = repo()
    const { services } = makeServices()
    const chat = services.chat.create({ workspace: dir })
    const status = await services.panel.gitInit(chat.id)
    expect(status).toMatchObject({ repo: true, branch: 'main', files: [] })
    expect((await services.panel.gitLog(chat.id)).map((c) => c.subject)).toEqual(['first'])
  })

  it('refuses to initialise without a folder', async () => {
    const { services } = makeServices()
    const none = services.chat.create({})
    await expect(services.panel.gitInit(none.id)).rejects.toThrow(/no folder/)
    const file = join(mkdtempSync(join(tmpdir(), 'cloth-init-')), 'file.txt')
    writeFileSync(file, 'x')
    await expect(gitInit(file)).rejects.toThrow(/is not a folder/)
    await expect(gitInit(join(tmpdir(), 'cloth-missing-' + Date.now()))).rejects.toThrow(/is not a folder/)
  })

  it('lists and reads workspace files without leaving the folder', async () => {
    const dir = repo()
    mkdirSync(join(dir, 'dist'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'x.ts'), 'export const x = 1\n')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    const top = await listDir(dir, '')
    expect(top.map((e) => [e.name, e.dir, e.ignored])).toEqual([
      ['.git', true, true],
      ['dist', true, true],
      ['src', true, false],
      ['.gitignore', false, false],
      ['a.txt', false, false],
      ['blob.bin', false, false],
      ['logo.png', false, false]
    ])
    expect((await listDir(dir, 'src'))[0]).toMatchObject({ path: 'src/x.ts', size: 19 })
    expect(await readWorkspaceFile(dir, 'src/x.ts')).toMatchObject({ kind: 'text', text: 'export const x = 1\n' })
    expect(await readWorkspaceFile(dir, 'logo.png')).toMatchObject({ kind: 'image', mimeType: 'image/png' })
    expect(await readWorkspaceFile(dir, 'blob.bin')).toMatchObject({ kind: 'binary' })
    expect(() => inside(dir, '../outside.txt')).toThrow(/outside the workspace/)
  })

  it('reads git status, diffs, stages, commits and discards', async () => {
    const dir = repo()
    const { services } = makeServices()
    const chat = services.chat.create({ workspace: dir })
    writeFileSync(join(dir, 'a.txt'), 'one\nTWO\n')
    writeFileSync(join(dir, 'new file.md'), '# hi\n')
    let status = await services.panel.gitStatus(chat.id)
    expect(status).toMatchObject({ repo: true, branch: 'main', ahead: 0 })
    expect(status.files.map((f) => [f.path, f.staged, f.unstaged, f.untracked])).toEqual([
      ['a.txt', false, true, false],
      ['new file.md', false, true, true]
    ])
    const diff = await services.panel.gitDiff(chat.id, 'a.txt', false)
    expect(diff).toContain('-two')
    expect(diff).toContain('+TWO')
    expect(await services.panel.gitDiff(chat.id, 'new file.md', false)).toContain('+# hi')

    status = await services.panel.gitStage(chat.id, ['a.txt'])
    expect(status.files.find((f) => f.path === 'a.txt')).toMatchObject({ staged: true, unstaged: false })
    status = await services.panel.gitUnstage(chat.id, ['a.txt'])
    expect(status.files.find((f) => f.path === 'a.txt')).toMatchObject({ staged: false, unstaged: true })

    await services.panel.gitStage(chat.id, ['a.txt'])
    const { hash, status: after } = await services.panel.gitCommit(chat.id, 'Shout the second line\n\nBody line.', false)
    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(after.files.map((f) => f.path)).toEqual(['new file.md'])
    const log = await services.panel.gitLog(chat.id)
    expect(log.map((c) => c.subject)).toEqual(['Shout the second line', 'first'])

    await services.panel.gitDiscard(chat.id, ['new file.md'])
    expect(existsSync(join(dir, 'new file.md'))).toBe(false)
    expect((await services.panel.gitStatus(chat.id)).files).toEqual([])
    await expect(services.panel.gitCommit(chat.id, '', true)).rejects.toThrow(/commit message/)
  })

  it('reports folders that are not repositories, and chats without a folder', async () => {
    const { services } = makeServices()
    const plain = services.chat.create({ workspace: mkdtempSync(join(tmpdir(), 'cloth-plain-')) })
    expect(await services.panel.gitStatus(plain.id)).toMatchObject({ repo: false, files: [] })
    const none = services.chat.create({})
    expect(services.panel.root(none.id)).toEqual({ path: null, container: false, folder: null })
    await expect(services.panel.list(none.id, '')).rejects.toThrow(/no folder/)
  })

  it('parses renames, conflicts and branch info from porcelain v2', () => {
    const out = ['# branch.oid abc', '# branch.head feature', '# branch.upstream origin/feature', '# branch.ab +2 -1', '2 R. N... 100644 100644 100644 h1 h2 R100 new name.ts', 'old.ts', 'u UU N... 100644 100644 100644 100644 h1 h2 h3 merge.ts', '1 .M N... 100644 100644 100644 h1 h2 b c.ts', '? notes.txt', ''].join('\0')
    expect(parseStatus(out)).toEqual({
      branch: 'feature',
      upstream: 'origin/feature',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'new name.ts', from: 'old.ts', index: 'R', worktree: '.', staged: true, unstaged: false, untracked: false, conflicted: false },
        { path: 'merge.ts', index: 'U', worktree: 'U', staged: false, unstaged: true, untracked: false, conflicted: true },
        { path: 'b c.ts', index: '.', worktree: 'M', staged: false, unstaged: true, untracked: false, conflicted: false },
        { path: 'notes.txt', index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflicted: false }
      ]
    })
  })

  it('runs a real shell in the chat folder and streams its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloth-term-'))
    const { services, events } = makeServices()
    const chat = services.chat.create({ workspace: dir })
    const t = await services.panel.openTerminal(chat.id, { cols: 100, rows: 30 })
    expect(t).toMatchObject({ sessionId: chat.id, running: true, container: false })
    services.panel.terminals.write(t.id, 'echo cloth-$((6*7))-ok\r'.replace('$((6*7))', process.platform === 'win32' ? '$(6*7)' : '$((6*7))'))
    for (let i = 0; i < 100 && !services.panel.terminals.buffer(t.id).includes('cloth-42-ok'); i++) await new Promise((r) => setTimeout(r, 100))
    expect(services.panel.terminals.buffer(t.id)).toContain('cloth-42-ok')
    expect(services.panel.terminals.list(chat.id)).toHaveLength(1)
    services.panel.terminals.kill(t.id)
    expect(services.panel.terminals.list(chat.id)).toEqual([])
    expect(events?.some((e) => e.channel === 'terminal')).toBe(true)
  }, 20_000)
})
