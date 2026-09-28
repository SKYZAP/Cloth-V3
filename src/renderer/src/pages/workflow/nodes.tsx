import { memo } from 'react'
import clsx from 'clsx'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot, BrainCircuit, Code2, Flag, GitBranch, Globe, Link2, Play, Repeat, Search, Sparkles, Wrench, type LucideIcon } from 'lucide-react'
import { NODE_SPECS } from '@shared/workflow-nodes'
import type { NodeRunStatus, WorkflowNodeType } from '@shared/types'
import { Loader2 } from 'lucide-react'

export interface NodeMeta {
  type: WorkflowNodeType
  label: string
  icon: LucideIcon
  color: string
  description: string
  defaults: Record<string, unknown>
}

const VISUALS: Record<WorkflowNodeType, { icon: LucideIcon; color: string }> = {
  trigger: { icon: Play, color: '#dc2645' },
  llm: { icon: BrainCircuit, color: '#e07a5f' },
  agent: { icon: Bot, color: '#c084fc' },
  rag: { icon: Search, color: '#6b9cf0' },
  web: { icon: Globe, color: '#38bdf8' },
  skill: { icon: Sparkles, color: '#e0a43a' },
  tool: { icon: Wrench, color: '#a3e635' },
  http: { icon: Link2, color: '#3fb97a' },
  transform: { icon: Code2, color: '#8b8b95' },
  condition: { icon: GitBranch, color: '#f472b6' },
  loop: { icon: Repeat, color: '#fb923c' },
  output: { icon: Flag, color: '#ececef' }
}

export const NODE_TYPES: NodeMeta[] = NODE_SPECS.map((s) => ({ type: s.type, label: s.label, description: s.description, defaults: s.defaults, ...VISUALS[s.type] }))

export const META: Record<WorkflowNodeType, NodeMeta> = Object.fromEntries(NODE_TYPES.map((m) => [m.type, m])) as Record<WorkflowNodeType, NodeMeta>

export type FlowNodeData = Record<string, unknown> & { key: string; label?: string; __status?: NodeRunStatus; __ms?: number; __summary?: string; __iter?: number }

function summary(type: WorkflowNodeType, d: FlowNodeData): string {
  switch (type) {
    case 'llm':
    case 'agent':
      return String(d.prompt ?? '').slice(0, 80)
    case 'rag':
      return `${d.mode ?? 'hybrid'} · k=${d.k ?? 6} · ${String(d.query ?? '')}`
    case 'skill':
      return d.skill ? `${d.skill} (${d.mode})` : 'no skill selected'
    case 'web':
      return `k=${d.k ?? 6}${Number(d.fetchTop) ? ` · fetch ${d.fetchTop}` : ''} · ${String(d.query ?? '')}`
    case 'tool':
      return d.tool ? `${d.tool}(${String(d.args ?? '{}').replace(/\s+/g, ' ')})` : 'no tool selected'
    case 'http':
      return `${d.method} ${d.url}`
    case 'transform':
      return String(d.code ?? '').split('\n')[0]
    case 'condition':
      return String(d.expression ?? '')
    case 'loop':
      return d.mode === 'until' ? `until ${String(d.until ?? 'false')} · max ${d.maxIterations ?? 5}` : `each of ${String(d.items ?? '{{prev}}')}`
    case 'output':
      return String(d.value ?? '')
    case 'trigger':
      return 'input: ' + String(d.defaultInput ?? '{}').replace(/\s+/g, ' ').slice(0, 60)
  }
}

const FlowNode = memo(function FlowNode({ type, data, selected }: NodeProps & { data: FlowNodeData; type: string }) {
  const meta = META[type as WorkflowNodeType]
  const Icon = meta.icon
  const status = data.__status
  return (
    <div
      className={clsx(
        'w-[230px] rounded-lg border bg-panel shadow-lg shadow-black/40 transition-colors',
        selected ? 'border-crimson' : status === 'error' ? 'border-crimson-line' : status === 'ok' ? 'border-ok/50' : status === 'running' ? 'border-crimson pulse-crimson' : 'border-line-strong',
        status === 'skipped' && 'opacity-45'
      )}
    >
      {type !== 'trigger' && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded" style={{ background: `${meta.color}22`, color: meta.color }}>
          <Icon size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{data.label || meta.label}</span>
        {status === 'running' && <Loader2 size={12} className="animate-spin text-crimson" />}
        {status && status !== 'running' && status !== 'pending' && (
          <span className={clsx('font-mono text-[10px]', status === 'ok' ? 'text-ok' : status === 'error' ? 'text-crimson-hi' : 'text-dim')}>
            {status === 'ok' && data.__ms !== undefined ? `${data.__iter ? `×${data.__iter} · ` : ''}${data.__ms}ms` : status}
          </span>
        )}
      </div>
      <div className="px-2.5 py-1.5">
        <div className="font-mono text-[10px] text-dim">{`{{${data.key}}}`}</div>
        <div className="mt-0.5 line-clamp-2 text-[11px] text-muted">{summary(type as WorkflowNodeType, data) || '—'}</div>
      </div>
      {type === 'condition' ? (
        <>
          <Handle type="source" id="true" position={Position.Right} style={{ top: '38%', background: '#3fb97a' }} />
          <Handle type="source" id="false" position={Position.Right} style={{ top: '78%', background: '#dc2645' }} />
          <span className="pointer-events-none absolute -right-8 top-[30%] text-[9px] text-ok">true</span>
          <span className="pointer-events-none absolute -right-8 top-[70%] text-[9px] text-crimson-hi">false</span>
        </>
      ) : type === 'loop' ? (
        <>
          <Handle type="source" id="body" position={Position.Right} style={{ top: '38%', background: '#fb923c' }} />
          <Handle type="source" id="done" position={Position.Right} style={{ top: '78%', background: '#ececef' }} />
          <Handle type="target" id="next" position={Position.Bottom} style={{ background: '#fb923c' }} />
          <span className="pointer-events-none absolute -right-8 top-[30%] text-[9px] text-[#fb923c]">body</span>
          <span className="pointer-events-none absolute -right-8 top-[70%] text-[9px] text-muted">done</span>
          <span className="pointer-events-none absolute -bottom-4 left-1/2 ml-2 text-[9px] text-[#fb923c]">next</span>
        </>
      ) : type !== 'output' ? (
        <Handle type="source" position={Position.Right} />
      ) : null}
    </div>
  )
})

export const nodeTypes = Object.fromEntries(NODE_TYPES.map((m) => [m.type, FlowNode]))
