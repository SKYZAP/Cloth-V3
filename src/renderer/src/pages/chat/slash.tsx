import { Fragment } from 'react'
import clsx from 'clsx'
import { SKILL_TOKEN } from '@shared/slash'

export { invokedSkills, slashAt, unknownSkills } from '@shared/slash'

/** Text with each invoked skill's "/name" in the skill colour. */
export function SkillText({ text, known, className }: { text: string; known: ReadonlySet<string>; className?: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(SKILL_TOKEN)) {
    const name = m[2].toLowerCase()
    if (!known.has(name)) continue
    const at = m.index! + m[1].length
    parts.push(<Fragment key={`t${last}`}>{text.slice(last, at)}</Fragment>)
    parts.push(<SkillToken key={`s${at}`} name={m[2]} />)
    last = at + m[2].length + 1
  }
  parts.push(<Fragment key="end">{text.slice(last)}</Fragment>)
  return <span className={className}>{parts}</span>
}

export function SkillToken({ name, slash = true, className }: { name: string; slash?: boolean; className?: string }) {
  return (
    <span title={`Invokes the ${name} skill`} className={clsx('rounded-[4px] bg-skill-soft text-skill shadow-[0_0_0_2px_var(--color-skill-soft)]', className)}>
      {slash ? '/' : ''}
      {name}
    </span>
  )
}
