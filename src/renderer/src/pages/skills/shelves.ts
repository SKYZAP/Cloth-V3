import type { Skill, SkillGroup } from '@shared/types'

export type Usage = Record<string, { total: number; lastUsedAt: number }>

/** A shelf of the library: the skills from one repository, or every skill that isn't part of a set. */
export interface Shelf {
  key: string
  title: string
  repo: string | null
  url: string | null
  skills: Skill[]
  uses: number
}

export const usesOf = (used: Usage, name: string) => used[name]?.total ?? 0
const byUse = (used: Usage) => (a: Skill, b: Skill) => usesOf(used, b.name) - usesOf(used, a.name) || a.name.localeCompare(b.name)

/** Repositories two or more skills came from are sets; everything else shares the single-skills shelf. Most used first. */
export function buildShelves(skills: Skill[], groups: SkillGroup[], used: Usage): Shelf[] {
  const named = new Map(skills.map((s) => [s.name, s]))
  const inSet = new Set<string>()
  const shelves: Shelf[] = []
  for (const g of groups) {
    const members = g.skills.map((n) => named.get(n)).filter((s): s is Skill => !!s)
    if (members.length < 2) continue
    members.forEach((s) => inSet.add(s.name))
    shelves.push({ key: g.repo, title: g.repo.split('/')[1], repo: g.repo, url: g.url, skills: members.sort(byUse(used)), uses: members.reduce((n, s) => n + usesOf(used, s.name), 0) })
  }
  const singles = skills.filter((s) => !inSet.has(s.name))
  if (singles.length) shelves.push({ key: 'singles', title: 'Single skills', repo: null, url: null, skills: singles.sort(byUse(used)), uses: singles.reduce((n, s) => n + usesOf(used, s.name), 0) })
  return shelves.sort((a, b) => b.uses - a.uses || Number(!a.repo) - Number(!b.repo) || a.title.localeCompare(b.title))
}

/** A skill whose upstream moved it elsewhere says so in its description. */
export const movedOf = (s: Skill) => /^moved to\b/i.test(s.description.trim())
