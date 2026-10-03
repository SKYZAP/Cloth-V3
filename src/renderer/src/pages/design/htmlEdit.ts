// Edits to a component's markup, addressed by element path (child-element indices from <body>).
// The preview frame and these edits parse the same string, so a path means the same element in both.
import { componentSlug, sanitizeComponentHtml } from '@shared/design'

export type Path = number[]

const parse = (html: string) => new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${sanitizeComponentHtml(html)}</body></html>`, 'text/html')

export function pathOf(el: Element, body: Element): Path | null {
  const path: number[] = []
  let cur: Element | null = el
  while (cur && cur !== body) {
    const parent: Element | null = cur.parentElement
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.children, cur))
    cur = parent
  }
  return cur === body ? path : null
}

export function elementAt(body: Element, path: Path): Element | null {
  let cur: Element | undefined = body
  for (const i of path) {
    cur = cur?.children[i]
    if (!cur) return null
  }
  return cur ?? null
}

export const samePath = (a: Path | null | undefined, b: Path | null | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])

function edit(html: string, path: Path, fn: (el: Element, doc: Document) => void): string {
  const doc = parse(html)
  const el = elementAt(doc.body, path)
  if (!el) throw new Error('That element is no longer in the component')
  fn(el, doc)
  return doc.body.innerHTML
}

export const setInnerHtml = (html: string, path: Path, inner: string) => edit(html, path, (el) => (el.innerHTML = inner))
export const removeElement = (html: string, path: Path) => edit(html, path, (el) => el.remove())
export const duplicateElement = (html: string, path: Path) => edit(html, path, (el) => el.after(el.cloneNode(true)))
export const setClasses = (html: string, path: Path, classes: string[]) =>
  edit(html, path, (el) => (classes.length ? el.setAttribute('class', classes.join(' ')) : el.removeAttribute('class')))

/** Move an element one place up or down among its siblings; returns the new html and path. */
export function moveElement(html: string, path: Path, by: -1 | 1): { html: string; path: Path } {
  let next = path
  const out = edit(html, path, (el) => {
    const sib = by < 0 ? el.previousElementSibling : el.nextElementSibling
    if (!sib) return
    if (by < 0) sib.before(el)
    else sib.after(el)
    next = [...path.slice(0, -1), path[path.length - 1] + by]
  })
  return { html: out, path: next }
}

/** A short label for an element: tag plus its most telling class. */
export function describe(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const cls = [...el.classList].find((c) => !c.startsWith('is-') && !c.startsWith('specimen')) ?? [...el.classList][0]
  return cls ? `${tag}.${cls}` : tag
}

/** The element's own text (not its children's), trimmed, for layer labels. */
export function ownText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** describe(), without the component's own class prefix (c-portfolio-hero__name → .__name). */
export function shortLabel(el: Element, componentName: string): string {
  return stripBlock(describe(el), componentName)
}

/** Drop the component's block prefix from a label, but only where an element or modifier name follows. */
export function stripBlock(label: string, componentName: string): string {
  return label.replace(new RegExp(`\\.c-${componentSlug(componentName)}(?=__|--)`), '.')
}
