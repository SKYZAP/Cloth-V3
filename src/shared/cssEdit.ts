// Small, formatting-preserving edits to a component's CSS (the inspector's writes).
import postcss, { type Rule } from 'postcss'

export interface CssDecl {
  prop: string
  value: string
  important: boolean
}

export interface CssRule {
  /** Position among all rules in the sheet (stable while only declarations change). */
  index: number
  selector: string
  selectors: string[]
  /** Enclosing at-rules, e.g. "@media (max-width: 600px)"; empty at the top level. */
  context: string
  decls: CssDecl[]
}

function rules(css: string): { root: postcss.Root; list: Rule[] } {
  const root = postcss.parse(css)
  const list: Rule[] = []
  root.walkRules((r) => {
    // Keyframe steps (from, 50%) are not selectors.
    if (r.parent?.type === 'atrule' && /keyframes$/i.test((r.parent as postcss.AtRule).name)) return
    list.push(r)
  })
  return { root, list }
}

function contextOf(r: Rule): string {
  const parts: string[] = []
  let p = r.parent
  while (p && p.type === 'atrule') {
    const a = p as postcss.AtRule
    parts.unshift(`@${a.name} ${a.params}`.trim())
    p = a.parent
  }
  return parts.join(' ')
}

/** Every style rule, in order. Unparseable CSS gives an empty list. */
export function listRules(css: string): CssRule[] {
  try {
    return rules(css).list.map((r, index) => ({
      index,
      selector: r.selector,
      selectors: r.selectors,
      context: contextOf(r),
      decls: (r.nodes ?? []).filter((n): n is postcss.Declaration => n.type === 'decl').map((d) => ({ prop: d.prop, value: d.value, important: !!d.important }))
    }))
  } catch {
    return []
  }
}

/** Set (or with null, remove) a property in the rule at `index`. Other formatting is kept. */
export function setDeclaration(css: string, index: number, prop: string, value: string | null): string {
  const { root, list } = rules(css)
  const rule = list[index]
  if (!rule) throw new Error('That rule no longer exists')
  const existing = (rule.nodes ?? []).filter((n): n is postcss.Declaration => n.type === 'decl' && n.prop === prop)
  if (value === null || !value.trim()) {
    existing.forEach((d) => d.remove())
    return root.toString()
  }
  const clean = value.trim().replace(/;+$/, '')
  const important = /!important\s*$/i.test(clean)
  const v = clean.replace(/\s*!important\s*$/i, '')
  if (existing.length) {
    const last = existing.at(-1)!
    existing.slice(0, -1).forEach((d) => d.remove())
    last.value = v
    last.important = important
  } else {
    rule.append(postcss.decl({ prop, value: v, important }))
  }
  return root.toString()
}

/** Append an empty rule for `selector` (or reuse an identical top-level one); returns the CSS and its index. */
export function ensureRule(css: string, selector: string, context = ''): { css: string; index: number } {
  const found = listRules(css).find((r) => r.selector.trim() === selector.trim() && r.context === context)
  if (found) return { css, index: found.index }
  const sep = css.trim() ? '\n\n' : ''
  const next = `${css.trimEnd()}${sep}${selector} {\n}\n`
  return { css: next, index: listRules(next).length - 1 }
}

const PSEUDO_STATE = /::?(hover|focus-visible|focus-within|focus|active|visited|disabled|checked|placeholder|before|after|first-child|last-child|first-of-type|last-of-type|not\([^)]*\)|nth-child\([^)]*\)|is\([^)]*\)|where\([^)]*\))/g
const STATE_CLASS = /\.is-(hover|focus|active|disabled|loading|selected|open)\b/g

/** A selector made matchable against a resting element: pseudo-classes and state classes stripped, with the states found. */
export function restingSelector(selector: string): { base: string; states: string[] } {
  const states = [...selector.matchAll(PSEUDO_STATE)].map((m) => m[1].replace(/\(.*$/, '')).concat([...selector.matchAll(STATE_CLASS)].map((m) => m[1]))
  const base = selector.replace(PSEUDO_STATE, '').replace(STATE_CLASS, '').trim()
  return { base: base || '*', states: [...new Set(states)] }
}

/**
 * Merge `patch` into `base`: a rule whose selector (and enclosing @media/@supports) matches an existing
 * one replaces it; anything new is appended. Used for changes scoped to one part of a component.
 */
export function mergeRules(base: string, patch: string): string {
  const root = postcss.parse(base)
  const add = postcss.parse(patch)
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const into = (container: postcss.Root | postcss.AtRule, rule: Rule) => {
    const old = (container.nodes ?? []).find((n): n is Rule => n.type === 'rule' && norm(n.selector) === norm(rule.selector))
    if (old) old.replaceWith(rule.clone())
    else container.append(rule.clone())
  }
  add.each((node) => {
    if (node.type === 'rule') into(root, node)
    else if (node.type === 'atrule') {
      const match = root.nodes.find((n): n is postcss.AtRule => n.type === 'atrule' && n.name === node.name && n.params.replace(/\s+/g, '') === node.params.replace(/\s+/g, ''))
      if (!match || !node.nodes) root.append(node.clone())
      else
        node.each((child) => {
          if (child.type === 'rule') into(match, child)
          else match.append(child.clone())
        })
    }
  })
  return root.toString()
}
