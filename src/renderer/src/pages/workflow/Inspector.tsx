import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { CustomTool, ModelRef, Skill, WorkflowNodeType } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { Button, Field, Input, Select, Switch, Textarea } from '@/components/ui'
import { ModelPicker } from '@/components/ModelPicker'
import { META, type FlowNodeData } from './nodes'

export function Inspector({
  type,
  data,
  onChange,
  onDelete,
  keys
}: {
  type: WorkflowNodeType
  data: FlowNodeData
  onChange(patch: Partial<FlowNodeData>): void
  onDelete(): void
  keys: string[]
}) {
  const meta = META[type]
  const collections = useApp((s) => s.collections)
  const [skills, setSkills] = useState<Skill[]>([])
  const [tools, setTools] = useState<CustomTool[]>([])
  useEffect(() => {
    if (type === 'skill') void api.skills.list().then(setSkills)
    if (type === 'tool') void api.tools.list().then(setTools)
  }, [type])

  const str = (k: string) => String(data[k] ?? '')
  const set = (k: string) => (e: { target: { value: string } }) => onChange({ [k]: e.target.value })
  const template = (k: string, label: string, rows = 4, hint?: string) => (
    <Field label={label} hint={hint}>
      <Textarea rows={rows} className="font-mono text-[11.5px]" value={str(k)} onChange={set(k)} />
    </Field>
  )
  const collectionPicker = (
    <Field label="Collections" hint="None selected = all">
      <div className="flex flex-wrap gap-1">
        {collections.map((c) => {
          const ids = (data.collectionIds as string[]) ?? []
          const on = ids.includes(c.id)
          return (
            <button
              key={c.id}
              onClick={() => onChange({ collectionIds: on ? ids.filter((x) => x !== c.id) : [...ids, c.id] })}
              className={`rounded border px-1.5 py-0.5 text-[11px] ${on ? 'border-crimson-line bg-crimson-soft text-crimson-hi' : 'border-line text-muted'}`}
            >
              {c.name}
            </button>
          )
        })}
        {!collections.length && <span className="text-[11px] text-dim">No collections</span>}
      </div>
    </Field>
  )
  const model = (label = 'Model') => (
    <Field label={label}>
      <ModelPicker value={(data.model as ModelRef) ?? null} onChange={(m) => onChange({ model: m })} allowNone noneLabel="Default model" />
    </Field>
  )

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded" style={{ background: `${meta.color}22`, color: meta.color }}>
          <meta.icon size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{meta.label}</div>
          <div className="text-[11px] text-dim">{meta.description}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Label">
          <Input value={str('label')} onChange={set('label')} placeholder={meta.label} />
        </Field>
        <Field label="Key">
          <Input
            className="font-mono"
            value={str('key')}
            onChange={(e) => {
              const v = e.target.value.replace(/[^\w]/g, '_')
              if (!keys.includes(v) || v === data.key) onChange({ key: v })
            }}
          />
        </Field>
      </div>

      {type === 'trigger' && template('defaultInput', 'Default input (JSON)', 6, 'Used for cron runs and as the default for manual runs. Reference as {{input.field}}.')}
      {type === 'llm' && (
        <>
          {model()}
          {template('system', 'System prompt', 3)}
          {template('prompt', 'Prompt', 6, 'Templates: {{input.x}}, {{prev}}, {{node_key}}, {{node_key.field}}')}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Temperature">
              <Input type="number" step="0.1" value={str('temperature')} onChange={set('temperature')} placeholder="default" />
            </Field>
            <Field label="Max tokens">
              <Input type="number" value={str('maxTokens')} onChange={set('maxTokens')} placeholder="default" />
            </Field>
          </div>
          <Switch checked={!!data.json} onChange={(v) => onChange({ json: v })} label="Parse reply as JSON" />
        </>
      )}
      {type === 'agent' && (
        <>
          {model()}
          {template('prompt', 'Task', 6)}
          {template('system', 'Extra instructions', 3)}
          {collectionPicker}
          <Switch checked={data.skillsEnabled !== false} onChange={(v) => onChange({ skillsEnabled: v })} label="Skills available" />
          <Switch checked={!!data.webEnabled} onChange={(v) => onChange({ webEnabled: v })} label="Web search & fetch" />
          <Switch checked={data.customTools !== false} onChange={(v) => onChange({ customTools: v })} label="Custom tools" />
          <Field label="Workspace folder (read-only tools)">
            <div className="flex gap-1.5">
              <Input value={str('workspace')} onChange={set('workspace')} placeholder="none" />
              <Button
                size="sm"
                onClick={async () => {
                  const [d] = await api.app.pickPaths({ directory: true })
                  if (d) onChange({ workspace: d })
                }}
              >
                …
              </Button>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Max turns">
              <Input type="number" value={str('maxTurns')} onChange={set('maxTurns')} />
            </Field>
            <div className="pt-6">
              <Switch checked={!!data.includeTrace} onChange={(v) => onChange({ includeTrace: v })} label="Output tool list" />
            </div>
          </div>
        </>
      )}
      {type === 'rag' && (
        <>
          {template('query', 'Query', 3)}
          {collectionPicker}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Mode">
              <Select value={str('mode') || 'hybrid'} onChange={set('mode')}>
                <option value="hybrid">hybrid</option>
                <option value="keyword">keyword</option>
                <option value="vector">vector</option>
                <option value="agentic">agentic</option>
              </Select>
            </Field>
            <Field label="k">
              <Input type="number" value={str('k')} onChange={set('k')} />
            </Field>
          </div>
          {data.mode === 'agentic' && model('Planner model')}
        </>
      )}
      {type === 'web' && (
        <>
          {template('query', 'Query', 3)}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Results">
              <Input type="number" value={str('k')} onChange={set('k')} />
            </Field>
            <Field label="Fetch top pages" hint="0 = snippets only">
              <Input type="number" min={0} max={5} value={str('fetchTop')} onChange={set('fetchTop')} />
            </Field>
          </div>
          <div className="text-[11px] text-dim">Uses the engine selected in Settings → Web search. Output: {'{text, results}'}.</div>
        </>
      )}
      {type === 'tool' && (
        <>
          <Field label="Custom tool">
            <Select value={str('tool')} onChange={set('tool')}>
              <option value="">Select…</option>
              {tools.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                  {t.enabled ? '' : ' (disabled)'}
                </option>
              ))}
            </Select>
          </Field>
          {(() => {
            const t = tools.find((x) => x.name === data.tool)
            return t?.params.length ? (
              <div className="text-[11px] text-dim">
                Parameters: {t.params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`).join(', ')}
              </div>
            ) : null
          })()}
          {template('args', 'Arguments (JSON template)', 5, 'e.g. {"query": "{{input.q}}"}')}
        </>
      )}
      {type === 'skill' && (
        <>
          <Field label="Skill">
            <Select value={str('skill')} onChange={set('skill')}>
              <option value="">Select…</option>
              {skills.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mode">
            <Select value={str('mode') || 'content'} onChange={set('mode')}>
              <option value="content">Output the skill instructions</option>
              <option value="run">Run a prompt with the skill loaded</option>
            </Select>
          </Field>
          {data.mode === 'run' && (
            <>
              {model()}
              {template('prompt', 'Prompt', 4)}
            </>
          )}
        </>
      )}
      {type === 'http' && (
        <>
          <div className="grid grid-cols-[90px_1fr] gap-2">
            <Field label="Method">
              <Select value={str('method') || 'GET'} onChange={set('method')}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </Select>
            </Field>
            <Field label="URL">
              <Input className="font-mono text-[11.5px]" value={str('url')} onChange={set('url')} />
            </Field>
          </div>
          {template('headers', 'Headers (JSON)', 3)}
          {data.method !== 'GET' && template('body', 'Body', 5)}
          <Switch checked={!!data.allowErrors} onChange={(v) => onChange({ allowErrors: v })} label="Don't fail on non-2xx" />
        </>
      )}
      {type === 'transform' && template('code', 'JavaScript (function body)', 10, 'In scope: input, prev, nodes (all outputs by key), JSON, Math, Date. Must return a value. 1s timeout.')}
      {type === 'condition' && template('expression', 'Expression', 3, 'Truthy → "true" handle, otherwise "false". Scope: input, prev, nodes.')}
      {type === 'loop' && (
        <>
          <Field label="Mode">
            <Select value={str('mode') || 'each'} onChange={set('mode')}>
              <option value="each">For each item</option>
              <option value="until">Repeat until</option>
            </Select>
          </Field>
          {str('mode') === 'until' ? (
            <>
              {template('until', 'Stop when', 2, 'JavaScript, checked after each pass. prev = this pass’s result, e.g. String(prev).includes("LGTM").')}
              <Field label="Max iterations" hint="Hard stop, 1–100">
                <Input type="number" min={1} max={100} value={str('maxIterations')} onChange={set('maxIterations')} />
              </Field>
            </>
          ) : (
            template('items', 'Items', 2, 'A {{path}} to an array (e.g. {{search.hits}}), JSON text, or text with one item per line.')
          )}
          <div className="rounded-md border border-line bg-bg p-2.5 text-[11px] leading-relaxed text-dim">
            Wire the steps to repeat from the <span className="text-[#fb923c]">body</span> handle and what comes after from <span className="text-muted">done</span>. Inside the body use{' '}
            <span className="font-mono text-muted">{'{{loop.item}}'}</span>, <span className="font-mono text-muted">{'{{loop.index}}'}</span> and <span className="font-mono text-muted">{'{{loop.last}}'}</span>. Connect the last body step back into{' '}
            <span className="text-[#fb923c]">next</span> to choose each pass’s result.
            <div className="mt-1.5">
              Output: {str('mode') === 'until' ? 'the last pass’s result' : 'an array with one result per item'}.
            </div>
          </div>
        </>
      )}
      {type === 'output' && template('value', 'Value', 4, 'Empty = pass through the previous output.')}

      {type !== 'trigger' && type !== 'output' && (
        <Switch checked={!!data.continueOnError} onChange={(v) => onChange({ continueOnError: v })} label="Continue on error" />
      )}
      <div className="border-t border-line pt-3">
        <Button variant="danger" size="sm" icon={<Trash2 size={12} />} onClick={onDelete}>
          Delete node
        </Button>
      </div>
    </div>
  )
}
