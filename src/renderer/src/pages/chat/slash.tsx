import { Fragment } from 'react'
import clsx from 'clsx'
import { SKILL_TOKEN } from '@shared/slash'
import { AGENT_TOKEN } from '@shared/mention'
import { filePathIn } from '@shared/file-links'
import { useFileTarget } from '@/components/FileLink'
import { openWorkspaceFile } from './setupNav'

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
  }
  // `path` (as the Files tab inserts it): opens the file in the viewer when the chat has a folder.
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    if (!filePathIn(m[1])) continue
    tokens.push({ at: m.index!, length: m[0].length, node: (key) => <PathToken key={key} text={m[1]} /> })
  }
  tokens.sort((a, b) => a.at - b.at)
  const parts: React.ReactNode[] = []
  let last = 0
  for (const t of tokens) {
    if (t.at < last) continue
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

/** A `path` in a sent message: a button that opens the file, or the text as written when it can't. */
function PathToken({ text }: { text: string }) {
  const rel = useFileTarget(text)
  if (!rel) return <>{`\`${text}\``}</>
  return (
    <button type="button" onClick={() => openWorkspaceFile(rel)} title={`Open ${rel} in the file viewer`} className="file-link plain">
      <code className="rounded-[4px] border border-line bg-elev px-1">{text}</code>
    </button>
  )
}
