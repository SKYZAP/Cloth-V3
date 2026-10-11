import { Fragment } from 'react'
import clsx from 'clsx'
import { SKILL_TOKEN } from '@shared/slash'
import { AGENT_TOKEN } from '@shared/mention'

export { invokedSkills, slashAt, unknownSkills } from '@shared/slash'
export { agentSlug, mentionAt, mentionedAgents } from '@shared/mention'

/**
 * Text with each invoked skill's "/name" in the skill colour and each tagged agent's "@slug" in the
 * agent colour. `agents` maps the slugs it knows to agent names; any other "@word" stays plain text.
 */
export function SkillText({ text, known, agents, className }: { text: string; known: ReadonlySet<string>; agents?: ReadonlyMap<string, string>; className?: string }) {
  const tokens: { at: number; length: number; node: (key: string) => React.ReactNode }[] = []
  for (const m of text.matchAll(SKILL_TOKEN)) {
    if (!known.has(m[2].toLowerCase())) continue
    tokens.push({ at: m.index! + m[1].length, length: m[2].length + 1, node: (key) => <SkillToken key={key} name={m[2]} /> })
  }
  if (agents?.size) {
    for (const m of text.matchAll(AGENT_TOKEN)) {
      const name = agents.get(m[2].toLowerCase())
      if (!name) continue
      tokens.push({ at: m.index! + m[1].length, length: m[2].length + 1, node: (key) => <AgentToken key={key} slug={m[2]} name={name} /> })
    }
    tokens.sort((a, b) => a.at - b.at)
  }
  const parts: React.ReactNode[] = []
  let last = 0
  for (const t of tokens) {
    parts.push(<Fragment key={`t${last}`}>{text.slice(last, t.at)}</Fragment>)
    parts.push(t.node(`s${t.at}`))
    last = t.at + t.length
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

/** A tagged agent's "@slug", as written. */
export function AgentToken({ slug, name, className }: { slug: string; name: string; className?: string }) {
  return (
    <span title={`Hands this to the ${name} agent`} className={clsx('rounded-[4px] bg-agent-soft text-agent shadow-[0_0_0_2px_var(--color-agent-soft)]', className)}>
      @{slug}
    </span>
  )
}
