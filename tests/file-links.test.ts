import { describe, expect, it } from 'vitest'
import { filePathIn, relativeTo } from '../src/shared/file-links'

describe('file links in chats', () => {
  it('finds file paths and drops line numbers', () => {
    expect(filePathIn('src/main/index.ts')).toBe('src/main/index.ts')
    expect(filePathIn('src/main/index.ts:42:7')).toBe('src/main/index.ts')
    expect(filePathIn('package.json')).toBe('package.json')
    expect(filePathIn('./notes')).toBe('./notes')
    expect(filePathIn('C:\\Users\\me\\app\\README.md')).toBe('C:\\Users\\me\\app\\README.md')
    expect(filePathIn('file:///E:/Code%20Projects/a.ts')).toBe('E:/Code Projects/a.ts')
    expect(filePathIn('.gitignore')).toBe('.gitignore')
  })

  it("leaves code, commands, versions and web links alone", () => {
    for (const s of ['console.log', 'npm install', 'a.b', '1.2.3', 'https://example.com/a.ts', 'mailto:x@y.com', 'foo()', '../', '', 'v2.0']) expect(filePathIn(s), s).toBeNull()
  })

  it('makes paths relative to the chat folder, refusing ones outside it', () => {
    expect(relativeTo('E:\\proj', 'E:\\proj\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('E:\\proj', 'e:/PROJ/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/home/me/proj', '/home/me/proj/a.md')).toBe('a.md')
    expect(relativeTo('/home/me/proj', '/home/me/other/a.md')).toBeNull()
    expect(relativeTo('/home/me/proj', '/home/me/project2/a.md')).toBeNull()
    expect(relativeTo('/home/me/proj', './src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/home/me/proj', '../a.ts')).toBeNull()
    expect(relativeTo(null, '/abs/a.ts')).toBeNull()
  })
})
