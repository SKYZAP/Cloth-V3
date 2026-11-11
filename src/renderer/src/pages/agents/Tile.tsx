import clsx from 'clsx'
import { motion } from 'motion/react'

/** Two letters for an agent's tile. */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?'

const TILE: Record<string, string> = {
  designer: 'bg-skill-soft text-skill',
  researcher: 'bg-ok/15 text-ok',
  reviewer: 'bg-fg/10 text-fg'
}

const SIZE = {
  sm: 'h-9 w-9 rounded-[9px] text-[12px]',
  lg: 'h-10 w-10 rounded-[10px] text-[14px]'
}

/**
 * An agent's tile. With `layoutId` it is one object across views: the card, the Compare header and the
 * team map hand it to each other instead of swapping it out.
 */
export function Tile({ name, builtin, size = 'sm', layoutId, className }: { name: string; builtin?: string | null; size?: keyof typeof SIZE; layoutId?: string; className?: string }) {
  return (
    <motion.span
      layoutId={layoutId}
      aria-hidden="true"
      className={clsx('relative flex shrink-0 items-center justify-center font-semibold tracking-tight', SIZE[size], (builtin && TILE[builtin]) || 'bg-crimson-soft text-crimson-hi', className)}
    >
      {initials(name)}
    </motion.span>
  )
}
