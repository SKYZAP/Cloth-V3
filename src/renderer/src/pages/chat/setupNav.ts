import { create } from 'zustand'

/** The Setup tab's drill-in pages that can be opened from elsewhere (e.g. the message box). */
export type SetupSection = 'knowledge' | 'skills' | 'tools' | 'mcp' | 'agent' | 'instructions'

interface SetupNav {
  /** Bumped on every request; the side panel opens (on Setup) whenever it changes. */
  seq: number
  /** The section the Setup tab should show next; cleared once it has. */
  pending: { section: SetupSection; seq: number } | null
}

export const useSetupNav = create<SetupNav>(() => ({ seq: 0, pending: null }))

/** Open the chat's side panel on Setup at a section, with its Filter box focused. */
export function openSetupSection(section: SetupSection): void {
  const seq = useSetupNav.getState().seq + 1
  useSetupNav.setState({ seq, pending: { section, seq } })
}

/** Mark a request as shown (only that one: a newer request stays pending). */
export function takeSetupSection(seq: number): void {
  if (useSetupNav.getState().pending?.seq === seq) useSetupNav.setState({ pending: null })
}
