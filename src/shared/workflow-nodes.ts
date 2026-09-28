import type { WorkflowNodeType } from './types'

export interface NodeField {
  key: string
  description: string
}

export interface NodeSpec {
  type: WorkflowNodeType
  label: string
  description: string
  output: string
  defaults: Record<string, unknown>
  fields: NodeField[]
}

/** Single source of truth for workflow node types — used by the editor, the engine docs and the builder agent. */
export const NODE_SPECS: NodeSpec[] = [
  {
    type: 'trigger',
    label: 'Trigger',
    description: 'Start of the flow — manual, cron or MCP input. Exactly one per workflow.',
    output: 'the run input object',
    defaults: { defaultInput: '{}' },
    fields: [{ key: 'defaultInput', description: 'JSON text used as input for cron runs and as the default for manual runs' }]
  },
  {
    type: 'llm',
    label: 'LLM',
    description: 'One model call with a templated prompt.',
    output: 'reply text (or parsed JSON when json=true)',
    defaults: { system: '', prompt: '{{prev}}', model: null, json: false },
    fields: [
      { key: 'system', description: 'system prompt (template)' },
      { key: 'prompt', description: 'user prompt (template)' },
      { key: 'json', description: 'boolean — parse the reply as JSON' },
      { key: 'temperature', description: 'optional number' }
    ]
  },
  {
    type: 'agent',
    label: 'Agent',
    description: 'Multi-step pi agent with knowledge search, skills, web and custom tools.',
    output: 'final answer text',
    defaults: { prompt: '{{prev}}', system: '', model: null, collectionIds: [], skillsEnabled: true, webEnabled: false, customTools: true, workspace: '', maxTurns: 12 },
    fields: [
      { key: 'prompt', description: 'task (template)' },
      { key: 'system', description: 'extra instructions (template)' },
      { key: 'collectionIds', description: 'array of collection ids the agent may search ([] = all)' },
      { key: 'skillsEnabled', description: 'boolean' },
      { key: 'webEnabled', description: 'boolean — allow web_search / web_fetch' },
      { key: 'customTools', description: 'boolean — allow user-defined tools' },
      { key: 'maxTurns', description: 'number' }
    ]
  },
  {
    type: 'rag',
    label: 'Knowledge search',
    description: 'Hybrid / keyword / vector / agentic retrieval over collections.',
    output: '{ text, hits: [{title, source, heading, text, score}], queries }',
    defaults: { query: '{{prev}}', k: 6, mode: 'hybrid', collectionIds: [] },
    fields: [
      { key: 'query', description: 'search query (template)' },
      { key: 'collectionIds', description: 'array of collection ids ([] = all)' },
      { key: 'k', description: 'number of hits' },
      { key: 'mode', description: 'hybrid | keyword | vector | agentic' }
    ]
  },
  {
    type: 'web',
    label: 'Web search',
    description: 'Search the public web with the configured engine (SearXNG or Obscura).',
    output: '{ text, results: [{title, url, snippet}] }',
    defaults: { query: '{{prev}}', k: 6, fetchTop: 0 },
    fields: [
      { key: 'query', description: 'search query (template)' },
      { key: 'k', description: 'number of results' },
      { key: 'fetchTop', description: 'number of top results whose pages are fetched as Markdown into text (0 = snippets only)' }
    ]
  },
  {
    type: 'skill',
    label: 'Skill',
    description: 'Load a skill’s instructions, or run a prompt with the skill loaded.',
    output: 'skill text, or the model reply in run mode',
    defaults: { skill: '', mode: 'content', prompt: '{{prev}}', model: null },
    fields: [
      { key: 'skill', description: 'skill name' },
      { key: 'mode', description: 'content | run' },
      { key: 'prompt', description: 'prompt for run mode (template)' }
    ]
  },
  {
    type: 'tool',
    label: 'Custom tool',
    description: 'Call a user-defined tool from the Tools page.',
    output: 'tool output text',
    defaults: { tool: '', args: '{}' },
    fields: [
      { key: 'tool', description: 'custom tool name' },
      { key: 'args', description: 'JSON object of arguments (template, e.g. {"q": "{{input.q}}"})' }
    ]
  },
  {
    type: 'http',
    label: 'HTTP request',
    description: 'Call an HTTP API.',
    output: '{ status, body }',
    defaults: { method: 'GET', url: 'http://localhost:3000/health', headers: '{}', body: '' },
    fields: [
      { key: 'method', description: 'GET | POST | PUT | PATCH | DELETE' },
      { key: 'url', description: 'URL (template)' },
      { key: 'headers', description: 'JSON object text (template)' },
      { key: 'body', description: 'request body (template)' }
    ]
  },
  {
    type: 'transform',
    label: 'Transform',
    description: 'JavaScript function body that returns a new value. Scope: input, prev, nodes (outputs by key).',
    output: 'the returned value',
    defaults: { code: 'return prev' },
    fields: [{ key: 'code', description: 'JavaScript function body, must `return` a value' }]
  },
  {
    type: 'condition',
    label: 'Condition',
    description: 'Branch on a JavaScript expression. Outgoing edges leave from the "true" or "false" handle.',
    output: 'passes prev through',
    defaults: { expression: 'Boolean(prev)' },
    fields: [{ key: 'expression', description: 'JavaScript expression over input, prev, nodes' }]
  },
  {
    type: 'loop',
    label: 'Loop',
    description:
      'Repeat part of the flow. Connect the steps to repeat from the "body" handle and the steps that follow from the "done" handle; optionally connect the last body step back into the loop’s "next" handle to pick the per-iteration result. mode "each" runs the body once per item of `items`; mode "until" re-runs it (feeding each result back in as prev) until `until` is true or maxIterations is reached. Inside the body, {{loop.item}}, {{loop.index}} and {{loop.last}} (previous result) are available.',
    output: 'each: array of per-iteration results · until: the last result',
    defaults: { mode: 'each', items: '{{prev}}', until: 'false', maxIterations: 5 },
    fields: [
      { key: 'mode', description: 'each | until' },
      { key: 'items', description: 'each mode: array to iterate — a {{path}} to an array, JSON text, or text (one item per line)' },
      { key: 'until', description: 'until mode: JavaScript expression checked after every iteration, e.g. String(prev).includes("LGTM"). Scope: prev (this iteration’s result), loop, input, nodes' },
      { key: 'maxIterations', description: 'until mode: hard stop (1–100)' }
    ]
  },
  {
    type: 'output',
    label: 'Output',
    description: 'Final result of the run.',
    output: 'rendered value',
    defaults: { value: '{{prev}}' },
    fields: [{ key: 'value', description: 'value template (empty = pass through prev)' }]
  }
]

export const NODE_SPEC: Record<WorkflowNodeType, NodeSpec> = Object.fromEntries(NODE_SPECS.map((s) => [s.type, s])) as Record<WorkflowNodeType, NodeSpec>
