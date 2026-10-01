import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import cronstrue from 'cronstrue'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
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
import { ArrowLeft, ListChecks, MoreHorizontal, Eye, RotateCcw, Wand2, Check, Clock, Copy, ExternalLink, File, FileText, FolderOpen, History, LayoutDashboard, Maximize2, Package, Play, Plus, Save, Sparkles, Square, Trash2, Workflow as WorkflowIcon, X } from 'lucide-react'
import type { Workflow, WorkflowGraph, WorkflowNodeType, WorkflowRun, WorkflowVersion, WorkflowVersionSource } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { attempt, useApp } from '@/lib/store'
import { duration, preview, pretty, timeAgo } from '@/lib/format'
import { Badge, Button, Dot, Empty, IconButton, Input, ListItem, ListPane, Modal, Switch, Tabs, Textarea, confirmAction } from '@/components/ui'
import { Markdown } from '@/components/Markdown'
import { layeredLayout } from '@shared/layout'
import { Editor } from '@/components/Editor'
import { META, NODE_TYPES, nodeTypes, type FlowNodeData } from './workflow/nodes'
import { Inspector } from './workflow/Inspector'
import { AssembleModal } from './workflow/AssembleModal'
import { ExportModal } from './workflow/ExportModal'
import { SplitBack, SplitDetail, SplitRoot } from '@/components/SplitView'
import { BottomSheet } from '@/components/BottomSheet'
import { isMobile } from '@/lib/platform'

export function WorkflowsPage() {
  const [flows, setFlows] = useState<Workflow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [assembling, setAssembling] = useState(false)

  const load = async (select?: string) => {
    const list = await api.workflows.list()
    setFlows(list)
    setLoaded(true)
    if (select) {
      setActiveId(select)
      setOpen(true)
    }
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
    <SplitRoot open={open} onBack={() => setOpen(false)}>
      <ListPane
        width={248}
        header={
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold">Flows</div>
              <div className="text-[11px] text-dim">{flows.filter((f) => f.cronEnabled).length} scheduled</div>
            </div>
            <div className="flex gap-1">
              <Button size="sm" icon={<Sparkles size={12} />} onClick={() => setAssembling(true)} title="Describe a workflow and let an agent assemble it">
                AI
              </Button>
              <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setCreating(true)}>
                New
              </Button>
            </div>
          </div>
        }
      >
        {flows.map((f) => (
          <ListItem key={f.id} active={f.id === activeId} onClick={() => (setActiveId(f.id), setOpen(true))}>
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
        {loaded && !flows.length && <div className="p-4 text-center text-[12px] text-dim">No flows yet — tap New, or AI to describe one.</div>}
      </ListPane>
      <SplitDetail>
        {active ? (
          <ReactFlowProvider key={active.id}>
            <Editor2 workflow={active} onSaved={(w) => setFlows((fs) => fs.map((f) => (f.id === w.id ? w : f)))} onDeleted={() => (setOpen(false), void load())} onDuplicated={(id) => void load(id)} />
          </ReactFlowProvider>
        ) : (
          <Empty
            icon={<WorkflowIcon size={20} />}
            title="Automate with workflows"
            action={
              <div className="flex gap-2">
                <Button icon={<Sparkles size={13} />} onClick={() => setAssembling(true)}>
                  Assemble with AI
                </Button>
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New workflow
                </Button>
              </div>
            }
          >
            Wire LLM calls, agents, knowledge search, skills, HTTP and JS into a graph. Branch with conditions, run on demand or on a cron schedule.
          </Empty>
        )}
      </SplitDetail>
      <NewWorkflow open={creating} onClose={() => setCreating(false)} onCreated={(id) => void load(id)} />
      <AssembleModal
        open={assembling}
        mode="new"
        onClose={() => setAssembling(false)}
        onGraph={async (graph) => {
          const wf = await attempt(() => api.workflows.createFromGraph(graph), `Assembled “${graph.name}”`)
          if (wf) await load(wf.id)
        }}
      />
    </SplitRoot>
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
  const [workspace, setWorkspace] = useState<string | null>(workflow.workspace)
  const [selected, setSelected] = useState<string | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [runOpen, setRunOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  // History: the side panel, and a version shown read-only on the canvas.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [preview, setPreview] = useState<WorkflowVersion | null>(null)
  // Fix with AI: the failed run it works from.
  const [fixRun, setFixRun] = useState<WorkflowRun | null>(null)
  // Where unsaved changes came from, recorded with the next save.
  const [pendingSource, setPendingSource] = useState<{ source: WorkflowVersionSource; note?: string } | null>(null)
  // Phone: the palette and run history open as sheets over the canvas.
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [runsOpen, setRunsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot(workflow.nodes, workflow.edges, workflow.name, workflow.cron ?? '', workflow.cronEnabled, workflow.workspace))
  const flow = useReactFlow()
  const nodesReady = useNodesInitialized()
  // Phones: fitting a whole flow makes nodes unreadable, so frame its first two steps instead (pan for the rest).
  const fitOptions = (extra: { duration?: number } = {}) => {
    const all = flow.getNodes()
    if (isMobile && all.length > 2) return { padding: 0.2, maxZoom: 1, nodes: [...all].sort((a, b) => a.position.x - b.position.x).slice(0, 2).map((n) => ({ id: n.id })), ...extra }
    return { padding: 0.12, maxZoom: 1.1, minZoom: 0.2, ...extra }
  }
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => {
    if (nodesReady) void flow.fitView(fitOptions())
    // Only on first measurement — later edits shouldn't yank the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesReady])

  const current = snapshot(
    nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: stripRuntime(n.data) })),
    edges,
    name,
    cron,
    cronEnabled,
    workspace
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
  // Overlay the selected run's node statuses on the canvas (or show a version being previewed).
  const displayNodes = useMemo(() => {
    if (preview?.snapshot) return preview.snapshot.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData, draggable: false, selectable: false }))
    if (!activeRun) return nodes
    const byId = new Map(activeRun.nodes.map((t) => [t.nodeId, t]))
    return nodes.map((n) => {
      const t = byId.get(n.id)
      return t ? { ...n, data: { ...n.data, __status: t.status, __ms: t.durationMs, __iter: t.iterations } } : n
    })
  }, [nodes, activeRun, preview])
  const displayEdges = useMemo(() => {
    if (preview?.snapshot) return preview.snapshot.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined, style: e.targetHandle === 'next' ? LOOP_BACK_STYLE : e.sourceHandle === 'body' ? LOOP_BODY_STYLE : undefined }))
    const running = activeRun?.status === 'running' ? new Set(activeRun.nodes.filter((t) => t.status === 'running').map((t) => t.nodeId)) : null
    return edges.map((e) => {
      const loopBack = e.targetHandle === 'next'
      const body = e.sourceHandle === 'body'
      const style = loopBack ? LOOP_BACK_STYLE : body ? LOOP_BODY_STYLE : undefined
      return { ...e, ...(style ? { style } : {}), ...(loopBack ? { type: 'smoothstep' } : {}), animated: loopBack || !!running?.has(e.target) }
    })
  }, [edges, activeRun, preview])

  // Auto-arrange: layered layout from the measured node sizes, eased into place.
  const [arranging, setArranging] = useState(false)
  const arrange = () => {
    const target = layeredLayout(
      nodes.map((n) => ({ id: n.id, width: n.measured?.width ?? 230, height: n.measured?.height ?? 70, position: n.position })),
      edges,
      { gapX: 80, gapY: 40 }
    )
    const from = new Map(nodes.map((n) => [n.id, n.position]))
    const started = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    setArranging(true)
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / 420)
      const k = ease(t)
      setNodes((ns) =>
        ns.map((n) => {
          const a = from.get(n.id)
          const b = target.get(n.id)
          return a && b ? { ...n, position: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k } } : n
        })
      )
      if (t < 1) requestAnimationFrame(step)
      else {
        setArranging(false)
        void flow.fitView(fitOptions({ duration: 380 }))
      }
    }
    requestAnimationFrame(step)
  }

  /** Load an AI-made graph into the editor unsaved, so it can be reviewed (or discarded by switching away). */
  const loadDraft = (graph: WorkflowGraph) => {
    setPreview(null)
    setNodes(graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData })))
    setEdges(graph.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined })))
    if (graph.name) setName(graph.name)
    setSelected(null)
    setTimeout(() => void flow.fitView(fitOptions()), 80)
  }

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

  /** Put a saved workflow into the editor (after a restore). */
  const loadSaved = (w: Workflow) => {
    setNodes(w.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data as FlowNodeData })))
    setEdges(w.edges.map((e) => ({ ...e, sourceHandle: e.sourceHandle ?? undefined, targetHandle: e.targetHandle ?? undefined })))
    setName(w.name)
    setWorkspace(w.workspace)
    setSavedSnapshot(snapshot(w.nodes, w.edges, w.name, w.cron ?? '', w.cronEnabled, w.workspace))
    setPendingSource(null)
    setSelected(null)
    onSaved(w)
    setTimeout(() => void flow.fitView(fitOptions({ duration: 300 })), 60)
  }

  const restore = async (v: WorkflowVersion) => {
    if (dirty && !(await confirmAction('Your unsaved changes will be replaced by this version. The current saved state stays in the history.', { title: 'Restore this version?', confirmLabel: 'Restore', danger: true }))) return
    const w = await attempt(() => api.workflows.restore(workflow.id, v.id), 'Version restored')
    if (w) {
      setPreview(null)
      loadSaved(w)
    }
  }

  const save = async (): Promise<boolean> => {
    setSaving(true)
    const meta = pendingSource ?? undefined
    const w = await attempt(() =>
      api.workflows.save(workflow.id, {
        name,
        cron: cron.trim() || null,
        cronEnabled,
        workspace,
        nodes: nodes.map((n) => ({ id: n.id, type: n.type as WorkflowNodeType, position: n.position, data: stripRuntime(n.data) })),
        edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null }))
      }, meta)
    )
    setSaving(false)
    if (w) {
      setPendingSource(null)
      setSavedSnapshot(snapshot(w.nodes, w.edges, w.name, w.cron ?? '', w.cronEnabled, w.workspace))
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

  const duplicate = async () => {
    const w = await attempt(() => api.workflows.duplicate(workflow.id))
    if (w) onDuplicated(w.id)
  }
  const remove = async () => {
    if (!(await confirmAction(`“${workflow.name}”, its schedule and its run history will be deleted.`, { title: 'Delete flow?', confirmLabel: 'Delete', danger: true }))) return
    await attempt(() => api.workflows.remove(workflow.id))
    onDeleted()
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 mobile:flex-wrap mobile:gap-1.5 mobile:px-2">
        <SplitBack className="ml-0" />
        <input className="w-56 min-w-0 bg-transparent text-[14px] font-semibold tracking-tight outline-none mobile:w-auto mobile:flex-1" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex flex-1 items-center gap-2 mobile:order-last mobile:basis-full mobile:flex-wrap mobile:px-1 mobile:pb-0.5">
          <div className="flex items-center gap-1.5 rounded-md border border-line bg-panel pl-2">
            <Clock size={13} className={cronEnabled && cron ? 'text-crimson-hi' : 'text-dim'} />
            <input className="h-7 w-32 bg-transparent font-mono text-[12px] outline-none placeholder:text-dim" placeholder="*/30 * * * *" value={cron} onChange={(e) => setCron(e.target.value)} />
          </div>
          <span className={clsx('truncate text-[11.5px]', cronText === 'Invalid expression' ? 'text-crimson-hi' : 'text-dim')}>{cronText}</span>
          <Switch checked={cronEnabled} onChange={setCronEnabled} disabled={!cron.trim()} label="Scheduled" />
          {workflow.cronEnabled && workflow.nextRunAt && !dirty && <Badge tone="crimson">next {timeAgo(workflow.nextRunAt)}</Badge>}
          <div className="ml-auto flex min-w-0 items-center rounded-md border border-line bg-panel mobile:ml-0">
            <button
              className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[12px] text-muted hover:text-fg"
              title={workspace ? `Workspace: ${workspace}\nAgents and JavaScript tools can create files here. Click to change.` : 'Pick a folder the flow can create files in'}
              onClick={async () => {
                const [d] = await api.app.pickPaths({ directory: true, title: 'Workspace for this flow' })
                if (d) setWorkspace(d)
              }}
            >
              <FolderOpen size={13} className={workspace ? 'text-crimson-hi' : 'text-dim'} />
              <span className="max-w-40 truncate">{workspace ? baseName(workspace) : 'No workspace'}</span>
            </button>
            {workspace && (
              <button className="flex h-7 w-6 items-center justify-center text-dim hover:text-fg" title="Remove the workspace" aria-label="Remove the workspace" onClick={() => setWorkspace(null)}>
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <Button icon={<Sparkles size={13} />} onClick={() => setAiOpen(true)} title="Describe a change and let an agent apply it">
          <span className="mobile:hidden">AI edit</span>
        </Button>
        {!isMobile && (
          <IconButton title="Export as an app" onClick={() => setExportOpen(true)}>
            <Package size={14} />
          </IconButton>
        )}
        <IconButton
          title="Change history"
          aria-pressed={historyOpen}
          className={historyOpen ? '!text-crimson-hi' : undefined}
          onClick={() => {
            setHistoryOpen((o) => !o)
            setPreview(null)
            setSelected(null)
          }}
        >
          <History size={14} />
        </IconButton>
        {isMobile ? (
          <IconButton title="More actions" aria-label="More actions" onClick={() => setMoreOpen(true)}>
            <MoreHorizontal size={16} />
          </IconButton>
        ) : (
          <>
            <IconButton title="Duplicate" onClick={() => void duplicate()}>
              <Copy size={14} />
            </IconButton>
            <IconButton title="Delete flow" onClick={() => void remove()}>
              <Trash2 size={14} />
            </IconButton>
          </>
        )}
        <Button icon={<Save size={13} />} disabled={!dirty} loading={saving} onClick={() => void save()}>
          <span className="mobile:hidden">Save</span>
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
        {!isMobile && (
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
        )}

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
            onNodesChange={preview ? undefined : onNodesChange}
            onEdgesChange={preview ? undefined : onEdgesChange}
            onConnect={preview ? undefined : onConnect}
            nodesConnectable={!preview}
            deleteKeyCode={preview ? null : ['Delete', 'Backspace']}
            onNodeClick={(_, n) => !preview && setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            colorMode="dark"
            fitView
            minZoom={0.2}
            fitViewOptions={{ padding: 0.12, maxZoom: 1.1, minZoom: 0.2 }}
            defaultEdgeOptions={{ style: { strokeWidth: 1.6 } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#26262c" />
            <Controls showInteractive={false} />
            {preview && (
              <Panel position="top-center" className="!mt-3">
                <div className="flex items-center gap-2 rounded-xl border border-crimson-line bg-panel/95 py-1.5 pl-3 pr-1.5 shadow-lg shadow-black/40 backdrop-blur">
                  <Eye size={13} className="shrink-0 text-crimson-hi" />
                  <span className="text-[12px]">
                    Previewing the version from <b className="font-semibold">{timeAgo(preview.createdAt)}</b>
                  </span>
                  <Button size="sm" variant="ghost" icon={<ArrowLeft size={12} />} onClick={() => setPreview(null)}>
                    Back to current
                  </Button>
                  <Button size="sm" variant="primary" icon={<RotateCcw size={12} />} onClick={() => void restore(preview)}>
                    Restore
                  </Button>
                </div>
              </Panel>
            )}
            <Panel position="top-right">
              <Button size="sm" icon={<LayoutDashboard size={13} />} disabled={arranging || nodes.length < 2} onClick={arrange} title="Auto-arrange nodes left to right in run order">
                Arrange
              </Button>
            </Panel>
            {isMobile && (
              <Panel position="bottom-right" className="!m-3 flex flex-col gap-2">
                <button onClick={() => setRunsOpen(true)} aria-label="Runs" className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line-strong bg-elev text-muted shadow-lg shadow-black/50">
                  <ListChecks size={20} />
                </button>
                <button onClick={() => setPaletteOpen(true)} aria-label="Add node" className="flex h-12 w-12 items-center justify-center rounded-2xl bg-crimson text-white shadow-[0_8px_24px_-6px_rgb(220_38_69/0.7)]">
                  <Plus size={22} />
                </button>
              </Panel>
            )}
            {!isMobile && <MiniMap pannable zoomable nodeColor={(n) => META[n.type as WorkflowNodeType]?.color ?? '#555'} maskColor="rgb(9 9 10 / 0.7)" />}
          </ReactFlow>
        </div>

        {/* Inspector */}
        {!isMobile && (
        <div className="w-80 shrink-0 overflow-y-auto border-l border-line bg-panel">
          {historyOpen ? (
            <HistoryPanel
              workflowId={workflow.id}
              refreshKey={workflow.updatedAt}
              previewId={preview?.id ?? null}
              onPreview={async (v) => {
                if (!v) return setPreview(null)
                const full = await attempt(() => api.workflows.version(v.id))
                if (full) setPreview(full)
              }}
              onRestore={(v) => void restore(v)}
              onClose={() => (setHistoryOpen(false), setPreview(null))}
            />
          ) : sel ? (
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
            <RunPanel runs={runs} runId={runId} onSelect={setRunId} workflow={workflow} onFix={setFixRun} />
          )}
        </div>
        )}
      </div>

      {isMobile && (
        <>
          <BottomSheet open={paletteOpen} onClose={() => setPaletteOpen(false)} title="Add a node" description="Tap to drop it in the middle of the canvas." snapPoints={[0.7]}>
            <div className="grid grid-cols-2 gap-2 pb-4">
              {NODE_TYPES.map((m) => (
                <button
                  key={m.type}
                  onClick={() => {
                    addNode(m.type)
                    setPaletteOpen(false)
                  }}
                  className="flex items-start gap-2.5 rounded-2xl border border-line bg-elev px-3 py-3 text-left active:border-line-strong"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ background: `${m.color}22`, color: m.color }}>
                    <m.icon size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{m.label}</span>
                    <span className="line-clamp-2 block text-[11px] leading-snug text-dim">{m.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </BottomSheet>
          <BottomSheet open={!!sel} onClose={() => setSelected(null)} title={sel ? (META[sel.type as WorkflowNodeType]?.label ?? 'Node') : 'Node'} snapPoints={[0.55, 0.92]}>
            {sel && (
              <div className="-mx-4 -mt-2">
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
              </div>
            )}
          </BottomSheet>
          <BottomSheet open={runsOpen && !sel} onClose={() => setRunsOpen(false)} title="Runs" snapPoints={[0.6, 0.92]}>
            <div className="-mx-4 -mt-2 h-[70vh]">
              <RunPanel runs={runs} runId={runId} onSelect={setRunId} workflow={workflow} onFix={setFixRun} inSheet />
            </div>
          </BottomSheet>
          <BottomSheet open={moreOpen} onClose={() => setMoreOpen(false)} title={name || 'Flow'} snapPoints={[0.3]}>
            <div className="space-y-2 pb-4">
              <button onClick={() => (setMoreOpen(false), void duplicate())} className="flex h-12 w-full items-center gap-3 rounded-2xl border border-line bg-elev px-4 text-[13.5px] active:border-line-strong">
                <Copy size={17} className="text-muted" /> Duplicate
              </button>
              <button onClick={() => (setMoreOpen(false), void remove())} className="flex h-12 w-full items-center gap-3 rounded-2xl border border-crimson-line bg-crimson-soft px-4 text-[13.5px] text-crimson-hi">
                <Trash2 size={17} /> Delete flow
              </button>
            </div>
          </BottomSheet>
        </>
      )}

      <AssembleModal
        open={aiOpen}
        mode="modify"
        workflowId={workflow.id}
        workflowName={workflow.name}
        onClose={() => setAiOpen(false)}
        onGraph={(graph: WorkflowGraph, request) => {
          loadDraft(graph)
          setPendingSource({ source: 'ai-edit', note: request.slice(0, 300) })
          useApp.getState().toast('AI changes loaded — review them, then Save', 'info')
        }}
      />
      <AssembleModal
        open={!!fixRun}
        mode="fix"
        fixRun={fixRun ?? undefined}
        workflowId={workflow.id}
        workflowName={workflow.name}
        onClose={() => setFixRun(null)}
        onGraph={(graph: WorkflowGraph) => {
          loadDraft(graph)
          setPendingSource({ source: 'ai-fix', note: (fixRun?.error ?? '').slice(0, 300) })
          setHistoryOpen(false)
          useApp.getState().toast('Fix loaded — review it, then Save and run again', 'info')
        }}
      />
      <ExportModal open={exportOpen} workflow={workflow} onClose={() => setExportOpen(false)} beforeExport={async () => !dirty || (await save())} />
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
            if (isMobile) setRunsOpen(true)
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

/** `inSheet`: shown in the phone's Runs sheet, which has its own title. */
function RunPanel({ runs, runId, onSelect, workflow, onFix, inSheet }: { runs: WorkflowRun[]; runId: string | null; onSelect(id: string): void; workflow: Workflow; onFix(run: WorkflowRun): void; inSheet?: boolean }) {
  const run = runs.find((r) => r.id === runId)
  const [openNode, setOpenNode] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ title: string; value: unknown } | null>(null)
  return (
    <div className="flex h-full flex-col">
      {!inSheet && <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">Runs</div>}
      <div className="max-h-56 shrink-0 overflow-y-auto border-b border-line p-1.5">
        {!runs.length && <div className="p-3 text-[12px] text-dim">{inSheet ? 'No runs yet — tap Run to try the flow.' : 'No runs yet. Select a node to edit it.'}</div>}
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
          {run.error && (
            <div className="space-y-2 rounded-md border border-crimson-line bg-crimson-soft p-2.5">
              <div className="selectable text-[11.5px] text-crimson-hi">{run.error}</div>
              {run.status === 'error' && (
                <Button size="sm" variant="primary" icon={<Wand2 size={12} />} onClick={() => onFix(run)}>
                  Fix with AI
                </Button>
              )}
            </div>
          )}
          {!!run.files?.length && (
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Files ({run.files.length})</div>
              <div className="space-y-1">
                {run.files.map((f) => (
                  <div key={f} className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5" title={f}>
                    <File size={13} className="shrink-0 text-crimson-hi" />
                    <span className="min-w-0 flex-1 truncate text-[12px]">{run.workspace && f.startsWith(run.workspace) ? f.slice(run.workspace.length + 1) : baseName(f)}</span>
                    {!isMobile && (
                      <IconButton title="Open file" onClick={() => void attempt(() => api.app.openPath(f))}>
                        <ExternalLink size={12} />
                      </IconButton>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {run.status === 'ok' && (
            <div>
              <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Output</div>
              <button
                onClick={() => setViewing({ title: `${workflow.name} · output`, value: run.output })}
                className="group flex w-full items-center gap-2.5 rounded-md border border-line bg-bg px-2.5 py-2 text-left transition-colors hover:border-crimson-line hover:bg-crimson-soft"
              >
                <FileText size={15} className="shrink-0 text-crimson-hi" />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-fg">View output</div>
                  <div className="truncate font-mono text-[10.5px] text-dim">{outputSummary(run.output)}</div>
                </div>
                <Maximize2 size={13} className="shrink-0 text-dim group-hover:text-crimson-hi" />
              </button>
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
                  {t.iterations ? <span className="rounded bg-elev-2 px-1 font-mono text-[10px] text-[#fb923c]" title={t.type === 'loop' ? 'iterations' : 'runs across loop iterations'}>×{t.iterations}</span> : null}
                  <span className="font-mono text-[10px] text-dim">{t.status === 'skipped' ? 'skipped' : duration(t.durationMs)}</span>
                </button>
                {!open && t.output !== undefined && <div className="truncate px-2.5 pb-1.5 font-mono text-[10.5px] text-dim">{preview(t.output, 90)}</div>}
                {open && (
                  <div className="space-y-1.5 border-t border-line p-2">
                    {t.error && <div className="text-[11px] text-crimson-hi">{t.error}</div>}
                    <Textarea readOnly rows={4} className="font-mono text-[10.5px]" value={`input:\n${pretty(t.input)}`} />
                    <Textarea readOnly rows={6} className="font-mono text-[10.5px]" value={`output:\n${pretty(t.output)}`} />
                    {t.output !== undefined && (
                      <Button size="sm" variant="ghost" icon={<Maximize2 size={12} />} onClick={() => setViewing({ title: `${label} · output`, value: t.output })}>
                        Open output
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <OutputModal view={viewing} onClose={() => setViewing(null)} />
    </div>
  )
}

/** Text we can render as markdown: plain strings, or an object's single string field (e.g. { text }). */
function outputText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const strings = Object.values(value).filter((v): v is string => typeof v === 'string')
    if (strings.length === 1 && Object.keys(value).length === 1) return strings[0]
  }
  return null
}

function outputSummary(value: unknown): string {
  const text = outputText(value)
  if (text !== null) {
    const words = text.trim().split(/\s+/).filter(Boolean).length
    const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]
    return `${heading ? heading + ' · ' : ''}${words.toLocaleString()} words`
  }
  return preview(value, 60)
}

function OutputModal({ view, onClose }: { view: { title: string; value: unknown } | null; onClose(): void }) {
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setMode('rendered')
    setCopied(false)
  }, [view])
  if (!view) return null
  const text = outputText(view.value)
  const raw = pretty(view.value)
  const markdown = text ?? '```json\n' + raw + '\n```'
  return (
    <Modal
      open
      onClose={onClose}
      width={860}
      title={
        <span className="flex items-center gap-2">
          <FileText size={15} className="text-crimson-hi" />
          {view.title}
        </span>
      }
      footer={
        <Button
          size="sm"
          icon={copied ? <Check size={12} /> : <Copy size={12} />}
          onClick={() => {
            void navigator.clipboard.writeText(raw)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      }
    >
      <Tabs
        className="-mx-4 -mt-4 mb-4 px-3"
        value={mode}
        onChange={setMode}
        items={[
          { value: 'rendered', label: 'Rendered' },
          { value: 'raw', label: 'Raw' }
        ]}
      />
      {mode === 'rendered' ? (
        <div className="selectable min-h-[40vh] px-1">
          <Markdown text={markdown} />
        </div>
      ) : (
        <pre className="selectable min-h-[40vh] whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 font-mono text-[11.5px] text-fg">{raw}</pre>
      )}
    </Modal>
  )
}

const SOURCE_LABEL: Record<WorkflowVersionSource, { label: string; tone: 'crimson' | 'info' | 'ok' | 'dim' | 'warn' }> = {
  original: { label: 'Before history', tone: 'dim' },
  created: { label: 'Created', tone: 'dim' },
  edit: { label: 'Edited', tone: 'dim' },
  'ai-build': { label: 'Built with AI', tone: 'info' },
  'ai-edit': { label: 'AI edit', tone: 'info' },
  'ai-fix': { label: 'AI fix', tone: 'crimson' },
  restore: { label: 'Restored', tone: 'warn' }
}

/** Saved versions of the flow, newest first: preview any of them on the canvas, or restore it. */
function HistoryPanel({
  workflowId,
  refreshKey,
  previewId,
  onPreview,
  onRestore,
  onClose
}: {
  workflowId: string
  refreshKey: number
  previewId: string | null
  onPreview(v: WorkflowVersion | null): void
  onRestore(v: WorkflowVersion): void
  onClose(): void
}) {
  const [versions, setVersions] = useState<WorkflowVersion[] | null>(null)
  useEffect(() => {
    void api.workflows.versions(workflowId).then(setVersions)
  }, [workflowId, refreshKey])
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <History size={14} className="text-crimson-hi" />
        <span className="flex-1 text-[12.5px] font-semibold">Change history</span>
        <IconButton title="Close history" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {versions === null && <div className="p-3 text-[12px] text-dim">Loading…</div>}
        {versions?.length === 0 && <div className="p-3 text-[12px] leading-relaxed text-dim">No saved versions yet. Every save from now on is kept here, so you can go back to it.</div>}
        {versions?.map((v, i) => {
          const tag = SOURCE_LABEL[v.source] ?? SOURCE_LABEL.edit
          const current = i === 0
          const previewing = v.id === previewId
          return (
            <div
              key={v.id}
              className={clsx(
                'group relative mb-1 rounded-lg border px-2.5 py-2 transition-colors',
                previewing ? 'border-crimson-line bg-crimson-soft' : 'border-transparent hover:border-line hover:bg-elev'
              )}
            >
              {/* Timeline rail */}
              {i < versions.length - 1 && <span className="absolute bottom-[-6px] left-[15px] top-[26px] w-px bg-line" />}
              <div className="flex items-center gap-2">
                <span className={clsx('relative z-[1] h-2.5 w-2.5 shrink-0 rounded-full border-2', current ? 'border-crimson bg-crimson' : 'border-line-strong bg-panel')} />
                <span className="text-[12px] text-fg" title={new Date(v.createdAt).toLocaleString()}>
                  {timeAgo(v.createdAt)}
                </span>
                <Badge tone={tag.tone}>{tag.label}</Badge>
                {current && <span className="ml-auto text-[10.5px] text-dim">current</span>}
              </div>
              <div className="ml-[18px] mt-1 text-[11.5px] leading-snug text-muted">{v.summary || 'No visible changes'}</div>
              {v.note && <div className="ml-[18px] mt-0.5 line-clamp-2 text-[11px] text-dim" title={v.note}>{v.note}</div>}
              {!current && (
                <div className="ml-[18px] mt-1.5 flex gap-1.5">
                  <Button size="sm" variant="ghost" icon={<Eye size={12} />} onClick={() => onPreview(previewing ? null : v)}>
                    {previewing ? 'Hide preview' : 'Preview'}
                  </Button>
                  <Button size="sm" icon={<RotateCcw size={12} />} onClick={() => onRestore(v)}>
                    Restore
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const LOOP_BODY_STYLE = { stroke: '#fb923c', strokeWidth: 1.6 }
const LOOP_BACK_STYLE = { stroke: '#fb923c', strokeWidth: 1.6, strokeDasharray: '6 4' }

function stripRuntime(d: FlowNodeData): FlowNodeData & { key: string } {
  const { __status, __ms, __summary, __iter, ...rest } = d
  void __iter
  void __status
  void __ms
  void __summary
  return rest as FlowNodeData & { key: string }
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function snapshot(
  nodes: { id: string; type?: string; position: { x: number; y: number }; data: unknown }[],
  edges: { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
  name: string,
  cron: string,
  enabled: boolean,
  workspace: string | null
): string {
  return JSON.stringify({
    workspace,
    n: nodes.map((n) => [n.id, n.type, Math.round(n.position.x), Math.round(n.position.y), n.data]),
    e: edges.map((e) => [e.source, e.target, e.sourceHandle ?? null, e.targetHandle ?? null]),
    name,
    cron: cron.trim(),
    enabled
  })
}
