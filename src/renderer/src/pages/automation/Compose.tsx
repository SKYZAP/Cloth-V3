import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import type { Automation, Workflow } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button } from '@/components/ui'
import { SplitBack } from '@/components/SplitView'
import { FOCUS } from './AutomationDetail'

const IDEAS: { title: string; sub: string; text: string }[] = [
  { title: 'Keep a knowledge collection fresh', sub: 'every Monday, add what changed', text: 'Every Monday at 9:00, check the NestJS changelog and add anything new to my NestJS knowledge collection.' },
  { title: 'Watch a web page', sub: 'notify me only when something changes', text: 'Every hour, check this store page and notify me if the price drops below RM 4,200.' },
  { title: 'Morning repo check', sub: 'run the tests and explain failures', text: 'Every weekday at 8:30, run the tests in my project folder and explain any failures. Don’t change files.' }
]

const emptyAutomation = (prompt: string): Automation => ({ prompt, agentId: null, tools: [], servers: [], collectionIds: [], skills: [], watch: null, commands: null })

/** A new automation: say what should happen and when; Cloth drafts the rest and creates it paused. */
export function Compose({ onCancel, onCreated }: { onCancel?(): void; onCreated(w: Workflow, drafted: boolean): void }) {
  const [text, setText] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** "Draft it" was pressed with nothing in the box. */
  const [empty, setEmpty] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const settings = useApp((s) => s.settings)
  const setPage = useApp((s) => s.setPage)
  useEffect(() => ref.current?.focus(), [])

  const draft = async () => {
    const description = text.trim()
    if (drafting) return
    if (!description) {
      setEmpty(true)
      ref.current?.focus()
      return
    }
    setEmpty(false)
    setDrafting(true)
    setError(null)
    try {
      const d = await api.workflows.draftAutomation(description)
      const w = await api.workflows.createAutomation({ name: d.name, automation: d.automation, cron: d.cron, cronEnabled: false, workspace: d.workspace })
      onCreated(w, true)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
      setDrafting(false)
    }
  }
  const fromScratch = async () => {
    // The backend needs a prompt; an empty box starts from a placeholder to fill in.
    const description = text.trim() || 'Describe what this automation should do.'
    try {
      const w = await api.workflows.createAutomation({ name: 'New automation', automation: emptyAutomation(description), cron: null, cronEnabled: false, workspace: null })
      onCreated(w, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto mt-[8vh] max-w-[640px] px-6 pb-12 mobile:mt-4 mobile:px-4">
        <SplitBack />
        <h2 className="mb-1 text-[20px] font-semibold">New automation</h2>
        <div className="rounded-[16px] border border-line-strong bg-panel p-3 focus-within:border-crimson-line">
          <label htmlFor="automation-description" className="sr-only">
            Describe the automation
          </label>
          <textarea
            id="automation-description"
            ref={ref}
            value={text}
            disabled={drafting}
            onChange={(e) => {
              setText(e.target.value)
              if (e.target.value.trim()) setEmpty(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void draft()
              }
            }}
            placeholder="Every weekday at 8:30, run the tests in my Cloth folder and tell me what broke…"
            aria-invalid={empty || undefined}
            aria-describedby={empty ? 'draft-empty' : error ? 'draft-error' : undefined}
            className="min-h-[92px] w-full resize-none bg-transparent px-1 py-0.5 text-[14.5px] leading-relaxed text-fg outline-none placeholder:text-dim disabled:opacity-70"
          />
          <div className="flex justify-end gap-2">
            {onCancel && (
              <Button variant="ghost" className={FOCUS} disabled={drafting} onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button variant="primary" className={FOCUS} disabled={drafting} onClick={() => void draft()} title="Draft it (Ctrl+Enter)">
              Draft it
            </Button>
          </div>
        </div>
        {empty && (
          <p id="draft-empty" role="alert" className="mt-1.5 text-[12.5px] text-crimson-hi">
            Describe what the automation should do first.
          </p>
        )}

        {drafting ? (
          <p role="status" className="mt-3.5 flex items-center gap-2 text-[13px] text-muted">
            <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            Drafting the schedule, tools and access…
          </p>
        ) : error ? (
          <div id="draft-error" role="alert" className="mt-3.5 grid gap-2 text-[12.5px]">
            <p className="text-crimson-hi">Cloth couldn’t draft it: {error}</p>
            <p className="text-muted">{settings?.defaultModel ? 'Try again, or start from scratch and fill it in yourself.' : 'Set a default model in Settings to draft automations.'}</p>
            <div className="flex flex-wrap gap-2">
              {!settings?.defaultModel && (
                <Button className={FOCUS} onClick={() => setPage('settings')}>
                  Open Settings
                </Button>
              )}
              <Button variant="ghost" className={FOCUS} onClick={() => void fromScratch()}>
                Start from scratch
              </Button>
            </div>
          </div>
        ) : null}

        {!drafting && (
          <div className="mt-4 grid gap-1.5">
            {IDEAS.map((i) => (
              <button
                key={i.title}
                type="button"
                onClick={() => {
                  setText(i.text)
                  setError(null)
                  setEmpty(false)
                  ref.current?.focus()
                }}
                className={clsx('rounded-[11px] border border-line px-3 py-2.5 text-left text-[13px] text-muted hover:border-line-strong hover:bg-panel hover:text-fg', FOCUS)}
              >
                <span className="font-medium text-fg">{i.title}</span> · {i.sub}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
