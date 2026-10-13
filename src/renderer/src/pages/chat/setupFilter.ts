/** Pure helpers for the Setup tab's lists: search, On/Off chips and their counts. */

export type OnOff = 'all' | 'on' | 'off'

/** Whether any of the texts contains the query (case-insensitive); an empty query matches everything. */
export function matches(q: string, ...texts: (string | null | undefined)[]): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return texts.some((t) => !!t && t.toLowerCase().includes(needle))
}

/** The items that match the query (on any of their texts) and the chip (On, Off or All). */
export function filterOnOff<T>(items: readonly T[], q: string, chip: OnOff, isOn: (t: T) => boolean, texts: (t: T) => (string | null | undefined)[]): T[] {
  return items.filter((t) => (chip === 'all' || (chip === 'on') === isOn(t)) && matches(q, ...texts(t)))
}

/** How many items each On/Off chip shows. */
export function onOffCounts<T>(items: readonly T[], isOn: (t: T) => boolean): Record<OnOff, number> {
  let on = 0
  for (const t of items) if (isOn(t)) on++
  return { all: items.length, on, off: items.length - on }
}

/** A server matches when its name, description or any of its tools' names match. */
export function serverMatches(q: string, name: string, description: string, toolNames: readonly string[]): boolean {
  return matches(q, name, description) || (!!q.trim() && toolNames.some((n) => matches(q, n)))
}

/** What an emptied list says. */
export function nothingMatches(q: string): string {
  return q.trim() ? `Nothing matches “${q.trim()}”.` : 'Nothing to show.'
}

/** The first sentence of a description, for a one-line row. */
export function firstSentence(text: string): string {
  return text.split(/(?<=\.)\s/)[0] ?? ''
}
