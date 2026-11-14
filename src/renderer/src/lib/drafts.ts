/*
 * A message one page starts for a chat another page opens (Boards' "Open in chat"): it waits in local
 * storage until that chat shows, then lands in its message box for the user to edit and send.
 */

const key = (sessionId: string) => `cloth.draft.${sessionId}`

export function leaveDraft(sessionId: string, text: string): void {
  try {
    localStorage.setItem(key(sessionId), text)
  } catch {
    /* storage unavailable: the chat opens empty */
  }
}

export function takeDraft(sessionId: string): string | null {
  try {
    const text = localStorage.getItem(key(sessionId))
    if (text !== null) localStorage.removeItem(key(sessionId))
    return text
  } catch {
    return null
  }
}
