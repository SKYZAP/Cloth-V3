import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, BookOpen, Check, FolderOpen, Globe, Package, Sparkles, Wrench, XCircle } from 'lucide-react'
import type { ExportEvent, ExportPreview } from '@shared/flow-bundle'
import type { Workflow } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { Button, Field, Input, Modal, Spinner } from '@/components/ui'

type Phase = 'form' | 'running' | 'done' | 'failed'

/** Export a flow as a standalone Windows app: review what goes in, then watch the build log. */
export function ExportModal({ open, workflow, onClose, beforeExport }: { open: boolean; workflow: Workflow; onClose(): void; beforeExport(): Promise<boolean> }) {
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [name, setName] = useState(workflow.name)
  const [description, setDescription] = useState(workflow.description)
  const [version, setVersion] = useState('1.0.0')
  const [model, setModel] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [phase, setPhase] = useState<Phase>('form')
  const [exportId, setExportId] = useState<string | null>(null)
  const [events, setEvents] = useState<ExportEvent[]>([])
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setPhase('form')
    setExportId(null)
    setEvents([])
    setName(workflow.name)
    setDescription(workflow.description)
    setPreview(null)
    void attempt(() => api.workflows.exportPreview(workflow.id)).then((p) => {
      if (!p) return
      setPreview(p)
      setOutputDir((d) => d || p.defaultOutputDir)
    })
  }, [open, workflow.id, workflow.name, workflow.description])

  // Events can arrive before exportStart returns the id: keep them all, show this export's.
  useEvent('export', (e) => setEvents((es) => [...es, e]))
  const mine = exportId ? events.filter((e) => e.exportId === exportId) : []
  const step = [...mine].reverse().find((e) => e.type === 'step')
  const end = mine.find((e) => e.type === 'done' || e.type === 'failed')
  useEffect(() => {
    if (end?.type === 'done') setPhase('done')
    else if (end?.type === 'failed') setPhase('failed')
  }, [end])
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [mine.length])

  const plan = preview?.plan
  const blocked = !preview || !!plan?.errors.length || !!preview.missing.length
  const start = async () => {
    if (!(await beforeExport())) return
    setEvents([])
    setPhase('running')
    const id = await attempt(() => api.workflows.exportStart({ workflowId: workflow.id, name, description, version, model: model.trim() || null, outputDir }))
    if (id) setExportId(id)
    else setPhase('form')
  }
  const busy = phase === 'running'

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      width={680}
      title={
        <span className="flex items-center gap-2">
          <Package size={15} className="text-crimson-hi" /> Export as an app
        </span>
      }
      footer={
        phase === 'form' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon={<Package size={13} />} disabled={blocked || !name.trim() || !outputDir} onClick={() => void start()}>
              Build installer
            </Button>
          </>
        ) : phase === 'running' ? (
          <Button variant="ghost" onClick={() => exportId && void api.workflows.exportCancel(exportId)}>
            Cancel export
          </Button>
        ) : (
          <>
            {phase === 'failed' && (
              <Button variant="ghost" onClick={() => setPhase('form')}>
                Back
              </Button>
            )}
            {end?.type === 'done' && (
              <Button icon={<FolderOpen size={13} />} onClick={() => void api.app.showInFolder(end.file)}>
                Show in folder
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {phase === 'form' ? (
        !preview ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-[12.5px] leading-relaxed text-muted">
              Packages this flow as a Windows app anyone can install. It asks for their own OpenAI key and a folder to save files in, then runs the flow — no Cloth needed.
            </div>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <Field label="App name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Version">
                <Input className="font-mono" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
              </Field>
            </div>
            <Field label="Description" hint="Shown on the app's first screen.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Turns a brief into a finished slide deck" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="OpenAI model (optional)" hint="Preselected in the app; users can change it.">
                <Input className="font-mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. a GPT model id" />
              </Field>
              <Field label="Save the installer to">
                <button
                  onClick={async () => {
                    const [d] = await api.app.pickPaths({ directory: true, title: 'Save the installer to' })
                    if (d) setOutputDir(d)
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-left text-[12px] text-muted hover:border-line-strong hover:text-fg"
                  title={outputDir}
                >
                  <FolderOpen size={13} className="shrink-0 text-crimson-hi" />
                  <span className="min-w-0 flex-1 truncate">{outputDir}</span>
                </button>
              </Field>
            </div>

            <div>
              <div className="mb-1.5 text-[12px] font-medium text-dim">Included</div>
              <div className="flex flex-wrap gap-1.5">
                <Chip icon={<Wrench size={12} />} label={`${plan!.tools.length} tool${plan!.tools.length === 1 ? '' : 's'}`} title={plan!.tools.join(', ')} />
                <Chip icon={<Sparkles size={12} />} label={`${plan!.skills.length} skill${plan!.skills.length === 1 ? '' : 's'}`} title={plan!.skills.join(', ')} />
                <Chip icon={<BookOpen size={12} />} label={`${plan!.collections.length} knowledge collection${plan!.collections.length === 1 ? '' : 's'}`} title="Keyword search in the app" />
                {plan!.web && <Chip icon={<Globe size={12} />} label="Web browser (Obscura, ~120 MB)" />}
              </div>
            </div>
            {[...plan!.errors, ...preview.missing].map((m) => (
              <Notice key={m} tone="error" text={m} />
            ))}
            {plan!.warnings.map((m) => (
              <Notice key={m} tone="warn" text={m} />
            ))}
          </div>
        )
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            {phase === 'running' ? <Spinner /> : phase === 'done' ? <Check size={16} className="text-ok" /> : <XCircle size={16} className="text-crimson-hi" />}
            <div className="min-w-0 flex-1 text-[13px] font-medium">
              {phase === 'done' ? 'Installer ready' : phase === 'failed' ? (end?.type === 'failed' ? end.message : 'Export failed') : step?.type === 'step' ? step.title : 'Starting…'}
            </div>
            {step?.type === 'step' && phase === 'running' && (
              <span className="font-mono text-[11px] text-dim">
                {step.step}/{step.steps}
              </span>
            )}
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-elev-2">
            <div
              className={clsx('h-full rounded-full transition-[width] duration-500', phase === 'failed' ? 'bg-crimson-lo' : phase === 'done' ? 'bg-ok' : 'bg-crimson')}
              style={{ width: `${phase === 'done' ? 100 : step?.type === 'step' ? ((step.step - 0.5) / step.steps) * 100 : 3}%` }}
            />
          </div>
          <div className="h-72 overflow-y-auto rounded-lg border border-line bg-bg p-2.5 font-mono text-[11px] leading-relaxed" role="log" aria-live="polite">
            {mine.map((e, i) =>
              e.type === 'step' ? (
                <div key={i} className="mt-1.5 text-fg first:mt-0">
                  <span className="text-crimson-hi">{e.step}/{e.steps}</span> {e.title}
                </div>
              ) : e.type === 'log' ? (
                <div key={i} className={clsx('whitespace-pre-wrap break-words pl-4', e.level === 'error' ? 'text-crimson-hi' : e.level === 'warn' ? 'text-warn' : 'text-dim')}>
                  {e.message}
                </div>
              ) : e.type === 'done' ? (
                <div key={i} className="mt-1.5 text-ok">
                  Done in {(e.durationMs / 1000).toFixed(1)}s · {(e.bytes / 1024 / 1024).toFixed(1)} MB
                </div>
              ) : (
                <div key={i} className="mt-1.5 text-crimson-hi">
                  {e.message}
                </div>
              )
            )}
            <div ref={logEnd} />
          </div>
          {end?.type === 'done' && (
            <div className="rounded-lg border border-line bg-panel p-3 text-[12px] text-muted">
              <div className="selectable break-all font-mono text-[11.5px] text-fg">{end.file}</div>
              <div className="mt-1">Windows may warn about an unrecognised publisher the first time the installer runs, because it isn't code-signed.</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function Chip({ icon, label, title }: { icon: React.ReactNode; label: string; title?: string }) {
  return (
    <span title={title || undefined} className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-muted">
      <span className="text-crimson-hi">{icon}</span>
      {label}
    </span>
  )
}

function Notice({ tone, text }: { tone: 'error' | 'warn'; text: string }) {
  return (
    <div className={clsx('flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12px]', tone === 'error' ? 'border-crimson-line bg-crimson-soft text-crimson-hi' : 'border-warn/30 bg-warn/5 text-warn')}>
      {tone === 'error' ? <XCircle size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
      <span className="min-w-0">{text}</span>
    </div>
  )
}
