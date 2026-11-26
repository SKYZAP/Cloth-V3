import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS, seedBuiltinSkills } from '../src/main/skills/builtin'

function fakes(existing: string[] = [], seeded: string[] = []) {
  const store = new Map<string, unknown>([['builtin.skillsSeeded', seeded]])
  const created: string[] = []
  const skills = {
    list: async () => [...existing, ...created].map((name) => ({ name })) as any,
    create: async (s: { name: string }) => {
      created.push(s.name)
      return { name: s.name } as any
    }
  }
  const kv = { get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k: string, v: unknown) => void store.set(k, v) }
  return { skills, kv, created, seeded: () => store.get('builtin.skillsSeeded') }
}

describe('built-in skills', () => {
  it('adds each one once, and not again after the user deletes it', async () => {
    const f = fakes()
    expect(await seedBuiltinSkills(f.skills, f.kv)).toEqual(['verify-guide'])
    expect(f.seeded()).toEqual(['verify-guide'])
    const again = fakes([], ['verify-guide'])
    expect(await seedBuiltinSkills(again.skills, again.kv)).toEqual([])
  })

  it('leaves a skill of the same name the user already has', async () => {
    const f = fakes(['verify-guide'])
    expect(await seedBuiltinSkills(f.skills, f.kv)).toEqual([])
    expect(f.created).toEqual([])
    expect(f.seeded()).toEqual(['verify-guide'])
  })

  it('adds a skill shipped later to an install that already has the earlier ones', async () => {
    const f = fakes(['older'], ['older'])
    expect(await seedBuiltinSkills(f.skills, f.kv)).toEqual(['verify-guide'])
  })

  it('ships a verification guide skill with the sections the workflow relies on', () => {
    const guide = BUILTIN_SKILLS.find((s) => s.name === 'verify-guide')!
    expect(guide.description).toContain('docs/verify/README.md')
    for (const part of ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Gotchas', 'Prove it']) expect(guide.body).toContain(part)
  })
})
