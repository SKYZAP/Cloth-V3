import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import cronstrue from 'cronstrue'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node
} from '@xyflow/react'
import { Clock, Copy, Play, Plus, Save, Square, Trash2, Workflow as WorkflowIcon } from 'lucide-react'
import type { Workflow, WorkflowNodeType, WorkflowRun } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt } from '@/lib/store'
import { duration, preview, pretty, timeAgo } from '@/lib/format'
import { Badge, Button, Dot, Empty, IconButton, Input, ListItem, ListPane, Modal, Switch, Textarea, confirmAction } from '@/components/ui'
import { Editor } from '@/components/Editor'
import { META, NODE_TYPES, nodeTypes, type FlowNodeData } from './workflow/nodes'
import { Inspector } from './workflow/Inspector'

export function WorkflowsPage() {
  const [flows, setFlows] = useState<Workflow[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = async (select?: string) => {
    const list = await api.workflows.list()
    setFlows(list)
    if (select) setActiveId(select)
    else if (!activeId || !list.some((f) => f.id === activeId)) setActiveId(list[0]?.id ?? null)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEvent('workflow', (e) => {
    if (e.type === 'schedule') setFlows((fs) => fs.map((f) => (f.id === e.workflowId ? { ...f, nextRunAt: e.nextRunAt } : f)))
  })

  const active = flows.find((f) => f.id === activeId)
  return (
    <div className="flex h-full">
      <ListPane
        width={248}
        header={
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold">Workflows</div>
              <div className="text-[11px] text-dim">{flows.filter((f) => f.cronEnabled).length} scheduled</div>
            </div>
            <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
              New
            </Button>
          </div>
        }
      >
        {flows.map((f) => (
          <ListItem key={f.id} active={f.id === activeId} onClick={() => setActiveId(f.id)}>
            <WorkflowIcon size={14} className="shrink-0 text-dim" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px]">{f.name}</div>
              <div className="truncate text-[11px] text-dim">
                {f.cronEnabled && f.cron ? (
                  <span className="flex items-center gap-1">
                    <Clock size={10} className="text-crimson-hi" /> next {timeAgo(f.nextRunAt)}
                  </span>
                ) : (
                  `${f.nodes.length} nodes · manual`
                )}
              </div>
            </div>
          </ListItem>
        ))}
      </ListPane>
      <div className="min-w-0 flex-1">
        {active ? (
          <ReactFlowProvider key={active.id}>
            <Editor2 workflow={active} onSaved={(w) => setFlows((fs) => fs.map((f) => (f.id === w.id ? w : f)))} onDeleted={() => void load()} onDuplicated={(id) => void load(id)} />
          </ReactFlowProvider>
        ) : (
          <Empty icon={<WorkflowIcon size={20} />} title="Automate with workflows" action={<Button variant="primary" onClick={() => setCreating(true)}>New workflow</Button>}>
            Wire LLM calls, agents, knowledge search, skills, HTTP and JS into a graph. Branch with conditions, run on demand or on a cron schedule.
          </Empty>
        )}
      </div>
      <NewWorkflow open={creating} onClose={() => setCreating(false)} onCreated={(id) => void load(id)} />
    </div>
  )
}

function NewWorkflow({ open, onClose, onCreated }: { open: boolean; onClose(): void; onCreated(id: string): void }) {
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<'blank' | 'rag-digest'>('blank')
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New workflow"
      footer={
        <Button
          variant="primary"
          disabled={!name.trim()}
          onClick={async () => {
            const w = await attempt(() => api.workflows.create({ name, template }))
            if (w) {
              onCreated(w.id)
              onClose()
              setName('')
            }
          }}
        >
          Create
        </Button>
      }
    >
      <div className="space-y-3">
        <Input autoFocus placeholder="Nightly docs digest" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['blank', 'Starter', 'Trigger → LLM → Output'],
              ['rag-digest', 'Knowledge digest', 'Search → branch on hits → summarize']
            ] as const
          ).map(([id, label, desc]) => (
            <button
              key={id}
              onClick={() => setTemplate(id)}
              className={clsx('rounded-lg border p-3 text-left', template === id ? 'border-crimson-line bg-crimson-soft' : 'border-line hover:border-line-strong')}
            >
              <div className="text-[12.5px] font-semibold">{label}</div>
              <div className="text-[11px] text-dim">{desc}</div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

type RFNode = Node<FlowNodeData>

function Editor2({ workflow, onSaved, onDeleted, onDuplicated }: { workflow: Workflow; onSaved(w: Workflow): void; onDeleted(): void; onDuplicated(id: string): void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(workflow.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData })))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(workflow.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined })))
  const [name, setName] = useState(workflow.name)
  const [cron, setCron] = useState(workflow.cron ?? '')
  const [cronEnabled, setCronEnabled] = useState(workflow.cronEnabled)
  const [selected, setSelected] = useState<string | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [runOpen, setRunOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot(workflow.nodes, workflow.edges, workflow.name, workflow.cron ?? '', workflow.cronEnabled))
  const flow = useReactFlow()
  const nodesReady = useNodesInitialized()
  useEffect(() => {
    if (nodesReady) void flow.fitView({ padding: 0.12, maxZoom: 1.1, minZoom: 0.2 })
    // Only on first measurement — later edits shouldn't yank the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesReady])

  const current = snapshot(
    nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: stripRuntime(n.data) })),
    edges,
    name,
    cron,
    cronEnabled
  )
  const dirty = current !== savedSnapshot

  useEffect(() => {
    void api.workflows.runs(workflow.id).then((r) => {
      setRuns(r)
      setRunId(r[0]?.id ?? null)
    })
  }, [workflow.id])

  useEvent('workflow', (e) => {
    if (e.type !== 'run' || e.run.workflowId !== workflow.id) return
    setRuns((rs) => {
      const i = rs.findIndex((r) => r.id === e.run.id)
      if (i < 0) return [e.run, ...rs]
      const next = rs.slice()
      next[i] = e.run
      return next
    })
  })

  const activeRun = runs.find((r) => r.id === runId) ?? null
  // Overlay the selected run's node statuses on the canvas.
  const displayNodes = useMemo(() => {
    if (!activeRun) return nodes
    const byId = new Map(activeRun.nodes.map((t) => [t.nodeId, t]))
    return nodes.map((n) => {
      const t = byId.get(n.id)
      return t ? { ...n, data: { ...n.data, __status: t.status, __ms: t.durationMs } } : n
    })
  }, [nodes, activeRun])
  const displayEdges = useMemo(() => {
    if (!activeRun || activeRun.status !== 'running') return edges
    const running = new Set(activeRun.nodes.filter((t) => t.status === 'running').map((t) => t.nodeId))
    return edges.map((e) => ({ ...e, animated: running.has(e.target) }))
  }, [edges, activeRun])

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, id: `e_${Date.now().toString(36)}` }, es)), [setEdges])

  const keys = nodes.map((n) => n.data.key)
  const addNode = (type: WorkflowNodeType, position?: { x: number; y: number }) => {
    if (type === 'trigger' && nodes.some((n) => n.type === 'trigger')) return
    const meta = META[type]
    let i = 1
    while (keys.includes(`${type}_${i}`)) i++
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    const id = `n_${Date.now().toString(36)}`
    setNodes((ns) => [
      ...ns,
      { id, type, position: position ?? { x: center.x - 115 + Math.random() * 40, y: center.y - 40 + Math.random() * 40 }, data: { key: `${type}_${i}`, label: meta.label, ...structuredClone(meta.defaults) } }
    ])
    setSelected(id)
  }

  const save = async (): Promise<boolean> => {
    setSaving(true)
    const w = await attempt(() =>
      api.workflows.save(workflow.id, {
        name,
        cron: cron.trim() || null,
        cronEnabled,
        nodes: nodes.map((n) => ({ id: n.id, type: n.type as WorkflowNodeType, position: n.position, data: stripRuntime(n.data) })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null }))
      })
    )
    setSaving(false)
    if (w) {
      setSavedSnapshot(snapshot(w.nodes, w.edges, w.name, w.cron ?? '', w.cronEnabled))
      onSaved(w)
    }
    return !!w
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const cronText = useMemo(() => {
    if (!cron.trim()) return 'Manual only'
    try {
      return cronstrue.toString(cron, { use24HourTimeFormat: true })
    } catch {
      return 'Invalid expression'
    }
  }, [cron])

  const sel = nodes.find((n) => n.id === selected)
  const running = activeRun?.status === 'running'

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <input className="w-56 min-w-0 bg-transparent text-[14px] font-semibold tracking-tight outline-none" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex flex-1 items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel pl-2">
            <Clock size={13} className={cronEnabled && cron ? 'text-crimson-hi' : 'text-dim'} />
            <input className="h-7 w-32 bg-transparent font-mono text-[12px] outline-none placeholder:text-dim" placeholder="*/30 * * * *" value={cron} onChange={(e) => setCron(e.target.value)} />
          </div>
          <span className={clsx('truncate text-[11.5px]', cronText === 'Invalid expression' ? 'text-crimson-hi' : 'text-dim')}>{cronText}</span>
          <Switch checked={cronEnabled} onChange={setCronEnabled} disabled={!cron.trim()} label="Scheduled" />
          {workflow.cronEnabled && workflow.nextRunAt && !dirty && <Badge tone="crimson">next {timeAgo(workflow.nextRunAt)}</Badge>}
        </div>
        <IconButton title="Duplicate" onClick={async () => {
          const w = await attempt(() => api.workflows.duplicate(workflow.id))
          if (w) onDuplicated(w.id)
        }}>
          <Copy size={14} />
        </IconButton>
        <IconButton
          title="Delete workflow"
          onClick={async () => {
            if (!confirmAction(`Delete workflow “${workflow.name}” and its run history?`)) return
            await attempt(() => api.workflows.remove(workflow.id))
            onDeleted()
          }}
        >
          <Trash2 size={14} />
        </IconButton>
        <Button icon={<Save size={13} />} disabled={!dirty} loading={saving} onClick={() => void save()}>
          Save
        </Button>
        {running ? (
          <Button variant="danger" icon={<Square size={11} fill="currentColor" />} onClick={() => activeRun && void api.workflows.cancel(activeRun.id)}>
            Cancel
          </Button>
        ) : (
          <Button variant="primary" icon={<Play size={12} fill="currentColor" />} onClick={() => setRunOpen(true)}>
            Run
          </Button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Palette */}
        <div className="w-44 shrink-0 space-y-1 overflow-y-auto border-r border-line bg-panel p-2">
          <div className="px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Nodes</div>
          {NODE_TYPES.map((m) => (
            <div
              key={m.type}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/cloth-node', m.type)}
              onClick={() => addNode(m.type)}
              title={m.description}
              className="flex cursor-grab items-center gap-2 rounded-md border border-line bg-elev px-2 py-1.5 text-[12px] hover:border-line-strong"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded" style={{ background: `${m.color}22`, color: m.color }}>
                <m.icon size={12} />
              </span>
              {m.label}
            </div>
          ))}
          <div className="px-1 pt-3 text-[10.5px] leading-relaxed text-dim">
            Drag or click to add. Reference outputs with <span className="font-mono text-muted">{'{{key}}'}</span>, <span className="font-mono text-muted">{'{{prev}}'}</span>, <span className="font-mono text-muted">{'{{input.x}}'}</span>.
          </div>
        </div>

        {/* Canvas */}
        <div
          className="relative min-w-0 flex-1"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(e) => {
            const type = e.dataTransfer.getData('application/cloth-node') as WorkflowNodeType
            if (!type) return
            e.preventDefault()
            const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
            addNode(type, { x: p.x - 115, y: p.y - 30 })
          }}
        >
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            deleteKeyCode={['Delete', 'Backspace']}
            colorMode="dark"
            fitView
            minZoom={0.2}
            fitViewOptions={{ padding: 0.12, maxZoom: 1.1, minZoom: 0.2 }}
            defaultEdgeOptions={{ style: { strokeWidth: 1.6 } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#26262c" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => META[n.type as WorkflowNodeType]?.color ?? '#555'} maskColor="rgb(9 9 10 / 0.7)" />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <div className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel">
          {sel ? (
            <Inspector
              key={sel.id}
              type={sel.type as WorkflowNodeType}
              data={sel.data}
              keys={keys}
              onChange={(patch) => setNodes((ns) => ns.map((n) => (n.id === sel.id ? { ...n, data: { ...n.data, ...patch } } : n)))}
              onDelete={() => {
                setNodes((ns) => ns.filter((n) => n.id !== sel.id))
                setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id))
                setSelected(null)
              }}
            />
          ) : (
            <RunPanel runs={runs} runId={runId} onSelect={setRunId} workflow={workflow} />
          )}
        </div>
      </div>

      <RunModal
        open={runOpen}
        onClose={() => setRunOpen(false)}
        defaultInput={String(nodes.find((n) => n.type === 'trigger')?.data.defaultInput ?? '{}')}
        onRun={async (input) => {
          if (dirty && !(await save())) return
          const r = await attempt(() => api.workflows.run(workflow.id, input))
          if (r) {
            setRunId(r.id)
            setSelected(null)
          }
          setRunOpen(false)
        }}
      />
    </div>
  )
}

function RunModal({ open, onClose, defaultInput, onRun }: { open: boolean; onClose(): void; defaultInput: string; onRun(input: unknown): Promise<void> }) {
  const [text, setText] = useState(defaultInput)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setText(defaultInput)
      setError(null)
    }
  }, [open, defaultInput])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Run workflow"
      footer={
        <Button
          variant="primary"
          icon={<Play size={12} fill="currentColor" />}
          onClick={() => {
            try {
              void onRun(text.trim() ? JSON.parse(text) : {})
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        >
          Run
        </Button>
      }
    >
      <div className="mb-1.5 text-[12px] text-dim">Input (JSON) — available as {'{{input}}'}</div>
      <div className="h-48 overflow-hidden rounded-md border border-line bg-bg">
        <Editor value={text} onChange={setText} lang="json" />
      </div>
      {error && <div className="mt-2 text-[12px] text-crimson-hi">{error}</div>}
    </Modal>
  )
}

function RunPanel({ runs, runId, onSelect, workflow }: { runs: WorkflowRun[]; runId: string | null; onSelect(id: string): void; workflow: Workflow }) {
  const run = runs.find((r) => r.id === runId)
  const [openNode, setOpenNode] = useState<string | null>(null)
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">Runs</div>
      <div className="max-h-56 shrink-0 overflow-y-auto border-b border-line p-1.5">
        {!runs.length && <div className="p-3 text-[12px] text-dim">No runs yet. Select a node to edit it.</div>}
        {runs.map((r) => (
          <ListItem key={r.id} active={r.id === runId} onClick={() => onSelect(r.id)}>
            <Dot tone={r.status === 'ok' ? 'ok' : r.status === 'error' ? 'crimson' : 'info'} pulse={r.status === 'running'} />
            <span className="flex-1 text-[12px]">{timeAgo(r.startedAt)}</span>
            <Badge tone="dim">{r.trigger}</Badge>
            <span className="font-mono text-[10.5px] text-dim">{r.finishedAt ? duration(r.finishedAt - r.startedAt) : '…'}</span>
          </ListItem>
        ))}
      </div>
      {run && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {run.error && <div className="rounded-md border border-crimson-line bg-crimson-soft p-2 text-[11.5px] text-crimson-hi">{run.error}</div>}
          {run.status === 'ok' && (
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Output</div>
              <pre className="selectable max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line bg-bg p-2 font-mono text-[11px] text-fg">{pretty(run.output)}</pre>
            </div>
          )}
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-dim">Node trace</div>
          {run.nodes.map((t) => {
            const label = workflow.nodes.find((n) => n.id === t.nodeId)?.data.label ?? t.key
            const open = openNode === t.nodeId
            return (
              <div key={t.nodeId} className="rounded-md border border-line bg-bg">
                <button onClick={() => setOpenNode(open ? null : t.nodeId)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
                  <Dot tone={t.status === 'ok' ? 'ok' : t.status === 'error' ? 'crimson' : t.status === 'running' ? 'info' : 'dim'} pulse={t.status === 'running'} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{label}</span>
                  <span className="font-mono text-[10px] text-dim">{t.status === 'skipped' ? 'skipped' : duration(t.durationMs)}</span>
                </button>
                {!open && t.output !== undefined && <div className="truncate px-2.5 pb-1.5 font-mono text-[10.5px] text-dim">{preview(t.output, 90)}</div>}
                {open && (
                  <div className="space-y-1.5 border-t border-line p-2">
                    {t.error && <div className="text-[11px] text-crimson-hi">{t.error}</div>}
                    <Textarea readOnly rows={4} className="font-mono text-[10.5px]" value={`input:\n${pretty(t.input)}`} />
                    <Textarea readOnly rows={6} className="font-mono text-[10.5px]" value={`output:\n${pretty(t.output)}`} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function stripRuntime(d: FlowNodeData): FlowNodeData & { key: string } {
  const { __status, __ms, __summary, ...rest } = d
  void __status
  void __ms
  void __summary
  return rest as FlowNodeData & { key: string }
}

function snapshot(nodes: { id: string; type?: string; position: { x: number; y: number }; data: unknown }[], edges: { id: string; source: string; target: string; sourceHandle?: string | null }[], name: string, cron: string, enabled: boolean): string {
  return JSON.stringify({
    n: nodes.map((n) => [n.id, n.type, Math.round(n.position.x), Math.round(n.position.y), n.data]),
    e: edges.map((e) => [e.source, e.target, e.sourceHandle ?? null]),
    name,
    cron: cron.trim(),
    enabled
  })
}
