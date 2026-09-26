import { memo } from 'react'
import clsx from 'clsx'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot, BrainCircuit, Code2, Flag, GitBranch, Globe, Play, Search, Sparkles, type LucideIcon } from 'lucide-react'
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

export const NODE_TYPES: NodeMeta[] = [
  { type: 'trigger', label: 'Trigger', icon: Play, color: '#dc2645', description: 'Start of the flow — manual, cron or MCP input', defaults: { defaultInput: '{}' } },
  { type: 'llm', label: 'LLM', icon: BrainCircuit, color: '#e07a5f', description: 'One model call with a templated prompt', defaults: { system: '', prompt: '{{prev}}', model: null, json: false } },
  { type: 'agent', label: 'Agent', icon: Bot, color: '#c084fc', description: 'pi agent loop with RAG, skills & workspace tools', defaults: { prompt: '{{prev}}', system: '', model: null, collectionIds: [], skillsEnabled: true, workspace: '', maxTurns: 12 } },
  { type: 'rag', label: 'Knowledge search', icon: Search, color: '#6b9cf0', description: 'Hybrid or agentic retrieval → {text, hits}', defaults: { query: '{{prev}}', k: 6, mode: 'hybrid', collectionIds: [] } },
  { type: 'skill', label: 'Skill', icon: Sparkles, color: '#e0a43a', description: 'Load a skill, or run a prompt with it', defaults: { skill: '', mode: 'content', prompt: '{{prev}}', model: null } },
  { type: 'http', label: 'HTTP request', icon: Globe, color: '#3fb97a', description: 'Call an API → {status, body}', defaults: { method: 'GET', url: 'http://localhost:3000/health', headers: '{}', body: '' } },
  { type: 'transform', label: 'Transform', icon: Code2, color: '#8b8b95', description: 'JavaScript: return a new value from input / prev / nodes', defaults: { code: 'return prev' } },
  { type: 'condition', label: 'Condition', icon: GitBranch, color: '#f472b6', description: 'Branch on a JS expression → true / false', defaults: { expression: 'Boolean(prev)' } },
  { type: 'output', label: 'Output', icon: Flag, color: '#ececef', description: 'Final result of the run', defaults: { value: '{{prev}}' } }
]

export const META: Record<WorkflowNodeType, NodeMeta> = Object.fromEntries(NODE_TYPES.map((m) => [m.type, m])) as Record<WorkflowNodeType, NodeMeta>

export type FlowNodeData = Record<string, unknown> & { key: string; label?: string; __status?: NodeRunStatus; __ms?: number; __summary?: string }

function summary(type: WorkflowNodeType, d: FlowNodeData): string {
  switch (type) {
    case 'llm':
    case 'agent':
      return String(d.prompt ?? '').slice(0, 80)
    case 'rag':
      return `${d.mode ?? 'hybrid'} · k=${d.k ?? 6} · ${String(d.query ?? '')}`
    case 'skill':
      return d.skill ? `${d.skill} (${d.mode})` : 'no skill selected'
    case 'http':
      return `${d.method} ${d.url}`
    case 'transform':
      return String(d.code ?? '').split('\n')[0]
    case 'condition':
      return String(d.expression ?? '')
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
            {status === 'ok' && data.__ms !== undefined ? `${data.__ms}ms` : status}
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
      ) : type !== 'output' ? (
        <Handle type="source" position={Position.Right} />
      ) : null}
    </div>
  )
})

export const nodeTypes = Object.fromEntries(NODE_TYPES.map((m) => [m.type, FlowNode]))
