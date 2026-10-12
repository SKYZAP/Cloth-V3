import { Type } from 'typebox'
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDetails } from '../agent/tools'
import type { RagService } from '../rag/rag'
import { newId } from '../core/context'

/** What an automation's run chose to report with its reporting tools. */
export interface RunReport {
  /** The chat its report goes to: picked when it first reports in a chat (up front for a container run). */
  chatId: string | null
  chat: { title: string; markdown: string }[]
  notes: { title: string; body: string }[]
  /** Notes it saved to Knowledge: the collection's name and the note's title. */
  saved: { collection: string; title: string }[]
}

/** Added to an automation's system prompt: it decides how (and whether) to report. */
export const REPORT_GUIDANCE =
  "Decide how to report: open a chat with the result when there's something to read or act on, notify for short alerts, save to knowledge for reference notes worth keeping; report nothing if there's nothing new."

const done = (text: string, details: ToolDetails = {}) => ({ content: [{ type: 'text' as const, text }], details })

/**
 * The tools an automation's agent reports with: a chat (one per run; later calls add to it), a desktop
 * notification, and a note in one of the automation's own Knowledge collections.
 */
export function reportTools(report: RunReport, deps: { rag: RagService; collectionIds: string[] }): AgentTool<any, ToolDetails>[] {
  const tools: AgentTool<any, ToolDetails>[] = [
    {
      name: 'report_in_chat',
      label: 'Report in a chat',
      description:
        'Open a chat with your result when there is something for the user to read or act on. The chat shows this run and your report, and the user can reply there. One chat per run: calling again adds to the same chat. Returns the chat id.',
      parameters: Type.Object({
        title: Type.String({ description: 'Short title for the chat' }),
        markdown: Type.String({ description: 'The report, in Markdown' })
      }),
      execute: async (_id, params) => {
        const p = params as { title: string; markdown: string }
        const markdown = String(p.markdown ?? '').trim()
        if (!markdown) throw new Error('Write the report in markdown')
        const added = !!report.chat.length
        report.chatId ??= newId('ses_')
        report.chat.push({ title: String(p.title ?? '').trim(), markdown })
        return done(added ? `Added to the chat ${report.chatId}.` : `Opened the chat ${report.chatId}; it will show this run and your report.`, { chatId: report.chatId })
      }
    },
    {
      name: 'notify',
      label: 'Notify',
      description: 'Show the user a desktop notification: for short alerts that need no reading. Keep the body to a sentence or two.',
      parameters: Type.Object({
        title: Type.String({ description: 'Notification title' }),
        body: Type.String({ description: 'One or two sentences' })
      }),
      execute: async (_id, params) => {
        const p = params as { title: string; body: string }
        const body = String(p.body ?? '').trim()
        if (!body) throw new Error('Say what the notification should tell the user')
        report.notes.push({ title: String(p.title ?? '').trim(), body })
        return done('The user will be notified when this run ends.')
      }
    }
  ]
  const collections = () => deps.rag.listCollections().filter((c) => deps.collectionIds.includes(c.id))
  if (deps.collectionIds.length) {
    tools.push({
      name: 'save_to_knowledge',
      label: 'Save to knowledge',
      description: `Save a reference note worth keeping to one of this automation's Knowledge collections: ${collections().map((c) => `"${c.name}"`).join(', ') || '(none)'}. Give the collection by name or id.`,
      parameters: Type.Object({
        collection: Type.String({ description: 'Collection name or id' }),
        title: Type.String({ description: 'Title of the note' }),
        text: Type.String({ description: 'The note, in Markdown' })
      }),
      execute: async (_id, params) => {
        const p = params as { collection: string; title: string; text: string }
        const want = String(p.collection ?? '').trim()
        const allowed = collections()
        const col = allowed.find((c) => c.id === want) ?? allowed.find((c) => c.name.toLowerCase() === want.toLowerCase())
        if (!col) throw new Error(`"${want}" is not one of this automation's collections. Use one of: ${allowed.map((c) => c.name).join(', ') || '(none)'}`)
        const doc = await deps.rag.ingestText(col.id, String(p.title ?? '').trim() || 'Note', String(p.text ?? ''))
        report.saved.push({ collection: col.name, title: doc.title })
        return done(`Saved "${doc.title}" to ${col.name}.`, { collection: col.name })
      }
    })
  }
  return tools
}

/** The run's transcript followed by what it reported, one assistant message per report: what its chat shows. */
export function reportTranscript(transcript: AgentMessage[], report: RunReport): AgentMessage[] {
  const last = [...transcript].reverse().find((m) => (m as { role?: string }).role === 'assistant') as { api?: string; provider?: string; model?: string } | undefined
  const now = Date.now()
  const added = report.chat.map(
    (r, i) =>
      ({
        role: 'assistant',
        content: [{ type: 'text', text: r.title ? `## ${r.title}\n\n${r.markdown}` : r.markdown }],
        stopReason: 'stop',
        api: last?.api ?? 'openai-completions',
        provider: last?.provider ?? 'cloth',
        model: last?.model ?? 'automation',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: now + i
      }) as unknown as AgentMessage
  )
  return [...transcript, ...added]
}
