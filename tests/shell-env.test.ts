import { describe, expect, it } from 'vitest'
import { hostShellNote, loadLoginShellPath, mergePath, parseMarkedPath } from '../src/main/core/shell-env'

describe('login shell PATH', () => {
  it('reads the PATH between the markers, ignoring what startup files print', () => {
    expect(parseMarkedPath('Welcome!\n__CLOTH_PATH__/opt/homebrew/bin:/usr/bin__CLOTH_PATH__\nbye')).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parseMarkedPath('no markers here')).toBeNull()
    expect(parseMarkedPath('__CLOTH_PATH____CLOTH_PATH__')).toBeNull()
  })

  it("puts the shell's entries first, keeps the old ones and adds install folders that exist", () => {
    const exists = (p: string) => p === '/opt/homebrew/bin' || p === '/usr/bin'
    expect(mergePath('/Users/me/.nvm/bin:/usr/bin', '/usr/bin:/bin', exists)).toBe('/Users/me/.nvm/bin:/usr/bin:/bin:/opt/homebrew/bin')
    expect(mergePath(null, '/usr/bin:/bin', exists)).toBe('/usr/bin:/bin:/opt/homebrew/bin')
  })

  it.runIf(process.platform !== 'win32')('takes the PATH from the real login shell', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/usr/bin:/bin' }
    await loadLoginShellPath(env)
    const parts = env.PATH!.split(':')
    expect(parts).toContain('/usr/bin')
    expect(parts).toContain('/bin')
  })

  it('leaves Windows alone', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows' }
    await loadLoginShellPath(env, 'win32')
    expect(env.PATH).toBe('C:\\Windows')
  })

  it('tells the agent about BSD tools on macOS', () => {
    expect(hostShellNote('darwin')).toMatch(/sed -i ''/)
    expect(hostShellNote('win32')).toBeNull()
  })
})
