import { describe, expect, it } from 'vitest'
import type { Skill } from '../src/shared/types'
import { buildShelves, movedOf } from '../src/renderer/src/pages/skills/shelves'

const skill = (name: string, description = name): Skill => ({ name, description, body: '', frontmatter: {}, dir: '', files: [], updatedAt: 0, source: null })

describe('skill library shelves', () => {
  const skills = ['a', 'b', 'c', 'solo', 'mine'].map((n) => skill(n))
  const groups = [
    { repo: 'leon/taste', url: 'https://github.com/leon/taste', skills: ['a', 'b', 'c'] },
    { repo: 'acme/one', url: 'https://github.com/acme/one', skills: ['solo'] }
  ]

  it('makes a set of each repository two or more skills came from, and one shelf of the rest', () => {
    const shelves = buildShelves(skills, groups, {})
    expect(shelves.map((s) => [s.title, s.skills.map((k) => k.name)])).toEqual([
      ['taste', ['a', 'b', 'c']],
      ['Single skills', ['mine', 'solo']]
    ])
  })

  it('puts the most used shelf and skill first', () => {
    const shelves = buildShelves(skills, groups, { solo: { total: 9, lastUsedAt: 1 }, c: { total: 2, lastUsedAt: 1 } })
    expect(shelves.map((s) => [s.title, s.uses])).toEqual([
      ['Single skills', 9],
      ['taste', 2]
    ])
    expect(shelves[1].skills[0].name).toBe('c')
  })

  it('treats a set filtered down to one skill as a single skill', () => {
    const shelves = buildShelves([skill('a'), skill('mine')], groups, {})
    expect(shelves.map((s) => s.title)).toEqual(['Single skills'])
  })

  it('spots a skill that moved upstream', () => {
    expect(movedOf(skill('brandkit', 'Moved to github.com/leon/imagegen-skills. Runs only when called by name.'))).toBe(true)
    expect(movedOf(skill('x', 'Removes moved files'))).toBe(false)
  })
})
