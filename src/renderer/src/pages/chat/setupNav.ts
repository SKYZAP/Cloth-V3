import { create } from 'zustand'

/** The Setup tab's drill-in pages that can be opened from elsewhere (e.g. the message box). */
export type SetupSection = 'knowledge' | 'skills' | 'tools' | 'mcp' | 'agent' | 'instructions' | 'context'

interface SetupNav {
  /** Bumped on every request; the side panel opens (on `tab`) whenever it changes. */
  seq: number
  /** The tab the latest request opens. */
  tab: 'setup' | 'agents' | 'spec'
  /** The section the Setup tab should show next; cleared once it has. */
  pending: { section: SetupSection; seq: number } | null
  /** The agent run (its task trace's id) the Agents tab should show next; cleared once it has. */
  run: { id: string; seq: number } | null
}

export const useSetupNav = create<SetupNav>(() => ({ seq: 0, tab: 'setup', pending: null, run: null }))

/** Open the chat's side panel on Setup at a section, with its Filter box focused. */
export function openSetupSection(section: SetupSection): void {
  const seq = useSetupNav.getState().seq + 1
  useSetupNav.setState({ seq, tab: 'setup', pending: { section, seq } })
}

/** Mark a request as shown (only that one: a newer request stays pending). */
export function takeSetupSection(seq: number): void {
  if (useSetupNav.getState().pending?.seq === seq) useSetupNav.setState({ pending: null })
}

/** Open the chat's side panel on the Agents tab, scrolled to one run. */
export function openAgentRun(id: string): void {
  const seq = useSetupNav.getState().seq + 1
  useSetupNav.setState({ seq, tab: 'agents', run: { id, seq } })
}

/** Mark an Agents tab request as shown (only that one). */
export function takeAgentRun(seq: number): void {
  if (useSetupNav.getState().run?.seq === seq) useSetupNav.setState({ run: null })
}

/** Open the chat's side panel on the Spec tab (the Spec → ship documents). */
export function openSpecDocs(): void {
  useSetupNav.setState({ seq: useSetupNav.getState().seq + 1, tab: 'spec' })
}
