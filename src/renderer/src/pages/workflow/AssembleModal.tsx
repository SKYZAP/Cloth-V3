import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, Check, Loader2, Sparkles, Square } from 'lucide-react'
import type { ModelRef, WorkflowBuildStep, WorkflowGraph } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { useApp } from '@/lib/store'
import { preview } from '@/lib/format'
import { Button, Field, Modal, Textarea } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'

const IDEAS = [
  'Every weekday at 9:00, search the web for news about TypeScript releases, summarize the top 3 with links, and output a digest.',
  'Given a question in input.question, search my knowledge base; if nothing relevant is found, fall back to a web search; answer with citations.',
  'Take input.error (a stack trace), explain it with an LLM, then check if any of my skills is relevant and output a fix plan.'
]

type Entry = { kind: 'step'; step: WorkflowBuildStep } | { kind: 'text'; text: string }

export function AssembleModal({
  open,
  onClose,
  mode,
  workflowId,
  workflowName,
  onGraph
}: {
  open: boolean
  onClose(): void
  mode: 'new' | 'modify'
  workflowId?: string
  workflowName?: string
  onGraph(graph: WorkflowGraph): Promise<void> | void
}) {
  const settings = useApp((s) => s.settings)
  const [description, setDescription] = useState('')
  const [model, setModel] = useState<ModelRef | null>(null)
  const [log, setLog] = useState<Entry[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buildId = useRef<string>('')
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setLog([])
      setError(null)
      if (mode === 'new') setDescription('')
    }
  }, [open, mode])
  useEffect(() => logEnd.current?.scrollIntoView({ block: 'nearest' }), [log])

  useEvent('workflow', (e) => {
    if ((e.type === 'build-step' || e.type === 'build-text') && e.buildId === buildId.current) {
      setLog((l) => [...l, e.type === 'build-step' ? { kind: 'step', step: e.step } : { kind: 'text', text: e.text }])
    }
  })

  const start = async () => {
    buildId.current = `b_${Date.now().toString(36)}`
    setRunning(true)
    setError(null)
    setLog([])
    try {
      const graph = await api.workflows.build({ description, model, workflowId: mode === 'modify' ? workflowId : undefined, buildId: buildId.current })
      await onGraph(graph)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const steps = log.filter((l) => l.kind === 'step').length
  return (
    <Modal
      open={open}
      onClose={() => !running && onClose()}
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={15} className="text-crimson-hi" />
          {mode === 'new' ? 'Assemble a workflow with AI' : `Modify “${workflowName}” with AI`}
        </span>
      }
      width={720}
      footer={
        running ? (
          <Button variant="danger" icon={<Square size={11} fill="currentColor" />} onClick={() => void api.workflows.cancelBuild(buildId.current)}>
            Stop
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Sparkles size={13} />} disabled={!description.trim() || (!model && !settings?.defaultModel)} onClick={() => void start()}>
              {mode === 'new' ? 'Assemble' : 'Apply changes'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        <Field label={mode === 'new' ? 'Describe the workflow' : 'Describe the change'} hint="An agent builds the graph with add_node / connect / finish tools, validating as it goes. You review the result before saving.">
          <Textarea
            rows={4}
            autoFocus
            disabled={running}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={mode === 'new' ? 'Every morning, search my docs for… and send the summary to…' : 'Add a web search fallback when the knowledge search finds nothing'}
          />
        </Field>
        {mode === 'new' && !description && (
          <div className="flex flex-col gap-1.5">
            {IDEAS.map((idea) => (
              <button key={idea} onClick={() => setDescription(idea)} className="rounded-md border border-line px-3 py-1.5 text-left text-[11.5px] text-muted hover:border-crimson-line hover:text-fg">
                {idea}
              </button>
            ))}
          </div>
        )}
        <Field label="Builder model" hint="Needs a model with reliable tool calling.">
          <ModelPicker value={model} onChange={setModel} allowNone noneLabel={settings?.defaultModel ? `Default (${settings.defaultModel.modelId})` : 'Default model (none set)'} />
        </Field>
        {(running || log.length > 0 || error) && (
          <div className="rounded-lg border border-line bg-bg">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11.5px] text-dim">
              {running ? <Loader2 size={12} className="animate-spin text-crimson" /> : error ? <AlertTriangle size={12} className="text-crimson-hi" /> : <Check size={12} className="text-ok" />}
              {running ? 'Assembling…' : error ? 'Stopped' : 'Done'} · {steps} tool calls
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto p-2 font-mono text-[11px]">
              {log.map((entry, i) =>
                entry.kind === 'text' ? (
                  <div key={i} className="whitespace-pre-wrap px-1 font-sans text-[12px] text-muted">
                    {entry.text}
                  </div>
                ) : (
                  <div key={i} className="flex gap-2 px-1">
                    <span className={clsx('shrink-0', entry.step.ok ? 'text-ok' : 'text-crimson-hi')}>{entry.step.ok ? '✓' : '✗'}</span>
                    <span className="shrink-0 text-crimson-hi">{entry.step.tool}</span>
                    <span className="min-w-0 flex-1 truncate text-dim" title={JSON.stringify(entry.step.args)}>
                      {preview(entry.step.args, 90)}
                    </span>
                    <span className={clsx('max-w-[40%] shrink-0 truncate', entry.step.ok ? 'text-muted' : 'text-crimson-hi')} title={entry.step.result}>
                      {entry.step.result.split('\n')[0]}
                    </span>
                  </div>
                )
              )}
              <div ref={logEnd} />
            </div>
            {error && <div className="selectable whitespace-pre-wrap border-t border-line px-3 py-2 text-[11.5px] text-crimson-hi">{error}</div>}
          </div>
        )}
      </div>
    </Modal>
  )
}
