import { useEffect, useState } from 'react'
import type { ChatSession, UiMessage } from '@shared/types'
import { Segmented } from '@/components/ui'
import { docsVersion, ticketProgress } from '@/lib/tickets'
import { SpecPanel } from './Workflow'
import { OpenSpecPanel } from './OpenSpec'

export type SpecMode = 'ship' | 'openspec'
const KEY = 'cloth.chat.specMode'

/** The mode the chat is running, if it's running one of them. */
function runningMode(session: Pick<ChatSession, 'workflow' | 'openspec'>): SpecMode | null {
  if (session.openspec && session.openspec.step !== 'done') return 'openspec'
  if (session.workflow && session.workflow.stage !== 'done') return 'ship'
  return null
}

function savedMode(): SpecMode {
  try {
    return localStorage.getItem(KEY) === 'openspec' ? 'openspec' : 'ship'
  } catch {
    return 'ship'
  }
}

/**
 * The side panel's Spec tab: Spec → Ship's documents or the folder's OpenSpec changes, with a toggle between them.
 * It follows the mode the chat is running; otherwise it shows the one picked last.
 */
export function SpecTab({ session, messages, visible }: { session: ChatSession; messages: UiMessage[]; visible: boolean }) {
  const running = runningMode(session)
  const [mode, setMode] = useState<SpecMode>(() => running ?? savedMode())
  // Starting (or switching to) a mode brings its view up.
  useEffect(() => {
    if (running) setMode(running)
  }, [running, session.id])
  const pick = (m: SpecMode) => {
    setMode(m)
    try {
      localStorage.setItem(KEY, m)
    } catch {
      /* storage unavailable */
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <Segmented
          value={mode}
          onChange={pick}
          items={[
            { value: 'ship', label: 'Spec → Ship', title: 'Questions, spec, tickets, build and review' },
            { value: 'openspec', label: 'OpenSpec', title: 'The folder’s OpenSpec changes and specs' }
          ]}
        />
        {running && (
          <span className="flex min-w-0 items-center gap-1.5 truncate text-caption text-dim">
            <span className={running === 'ship' ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-mode' : 'h-1.5 w-1.5 shrink-0 rounded-full bg-ospec'} />
            {running === 'ship' ? 'Spec → Ship' : 'OpenSpec'} is on in this chat
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          {mode === 'ship' ? (
            <SpecPanel sessionId={session.id} workflow={session.workflow} version={docsVersion(messages)} {...ticketProgress(messages)} />
          ) : (
            <OpenSpecPanel sessionId={session.id} visible={visible} />
          )}
        </div>
      </div>
    </div>
  )
}
