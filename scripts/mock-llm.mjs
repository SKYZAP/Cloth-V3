// Minimal OpenAI-compatible mock server for offline development and smoke tests.
//   node scripts/mock-llm.mjs [port]      (default 5055)
// Models: mock-chat (streams, calls rag_search once per question), mock-embed (hashed bag-of-words vectors).
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? process.env.MOCK_LLM_PORT ?? 5055)
const DIM = 128

function embed(text) {
  const v = new Array(DIM).fill(0)
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
    v[Math.abs(h) % DIM] += 1
  }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}

function textOf(content) {
  if (typeof content === 'string') return content
  return (content ?? []).map((c) => c.text ?? '').join('')
}

function plan(body) {
  const msgs = body.messages ?? []
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const question = textOf(lastUser?.content)
  const afterUser = msgs.slice(msgs.lastIndexOf(lastUser) + 1)
  const toolMsg = [...afterUser].reverse().find((m) => m.role === 'tool')
  const tools = (body.tools ?? []).map((t) => t.function?.name)
  // Workflow builder agent: assemble a small graph, then finish.
  if (tools.includes('add_node')) {
    if (!toolMsg) {
      return {
        tools: [
          { name: 'add_node', args: { type: 'trigger', key: 'start', data: { defaultInput: '{"topic": "sqlite full-text search"}' } } },
          { name: 'add_node', args: { type: 'rag', key: 'docs', label: 'Search docs', data: { query: '{{input.topic}}', k: 4 } } },
          { name: 'add_node', args: { type: 'condition', key: 'found', label: 'Found anything?', data: { expression: 'prev.hits.length > 0' } } },
          { name: 'add_node', args: { type: 'llm', key: 'summary', label: 'Summarize', data: { prompt: 'Summarize for {{input.topic}}:\n\n{{docs.text}}' } } },
          { name: 'add_node', args: { type: 'web', key: 'web', label: 'Web fallback', data: { query: '{{input.topic}}', k: 3 } } },
          { name: 'add_node', args: { type: 'output', key: 'result', label: 'Output', data: { value: '{{prev}}' } } },
          { name: 'connect', args: { from: 'start', to: 'docs' } },
          { name: 'connect', args: { from: 'docs', to: 'found' } },
          { name: 'connect', args: { from: 'found', to: 'summary', branch: 'true' } },
          { name: 'connect', args: { from: 'found', to: 'web', branch: 'false' } },
          { name: 'connect', args: { from: 'summary', to: 'result' } },
          { name: 'connect', args: { from: 'web', to: 'result' } }
        ]
      }
    }
    if (/valid and complete/.test(textOf(toolMsg.content))) return { text: 'The workflow is assembled.' }
    return { tools: [{ name: 'finish', args: { name: 'Docs digest with web fallback', description: 'Searches local docs, falls back to the web, summarizes' } }] }
  }
  if (!toolMsg && tools.includes('web_search') && /\bweb\b|latest|online/i.test(question)) {
    return { tool: { name: 'web_search', args: { query: question.replace(/search the web (for)?/i, '').slice(0, 100) } } }
  }
  if (!toolMsg && tools.includes('rag_search') && !/^reply with/i.test(question)) {
    return { tool: { name: 'rag_search', args: { query: question.slice(0, 120) } } }
  }
  if (toolMsg && textOf(toolMsg.content).includes('(engine: ')) {
    return { text: `Top web result [1]: ${textOf(toolMsg.content).split('\n')[0].replace(/^\[1\]\s*/, '')}. See also [2]. _(mock-chat response)_` }
  }
  if (toolMsg) {
    const first = textOf(toolMsg.content).split('\n---\n')[0].split('\n').slice(2).join(' ').slice(0, 220)
    return { text: `Here is what the knowledge base says [1]:\n\n> ${first}\n\n**Summary:** the indexed docs cover this topic directly [1]. _(mock-chat response)_` }
  }
  if (/pong/i.test(question)) return { text: 'pong' }
  if (/json/i.test(textOf(body.messages?.[0]?.content)) || /JSON/.test(question)) return {
      text: JSON.stringify({
        queries: [question.split(String.fromCharCode(10)).pop().slice(0, 40)],
        sufficient: true,
        ratings: [{ i: 1, r: 3 }],
        results: [1, 2, 3, 4].map((i) => ({ i, pass: i % 2 === 1, reason: 'mock judgement' })),
        issues: [{ severity: 'medium', excerpt: 'APP_GUARD', problem: 'mock audit finding', suggestion: 'mock suggestion' }],
        cases: [{ prompt: 'example', expectations: ['mentions example'] }]
      })
    }
  return { text: `You said: “${question.slice(0, 200)}”. This is **mock-chat**, a local test model.` }
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
  const url = req.url.replace(/^\/v1/, '')

  if (req.method === 'GET' && url === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-chat', object: 'model' }, { id: 'mock-embed', object: 'model' }] }))
  }
  if (req.method === 'POST' && url === '/embeddings') {
    const input = Array.isArray(body.input) ? body.input : [body.input]
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ object: 'list', data: input.map((t, index) => ({ object: 'embedding', index, embedding: embed(t) })), model: body.model }))
  }
  if (req.method === 'POST' && url === '/chat/completions') {
    const p = plan(body)
    const calls = p.tools ?? (p.tool ? [p.tool] : [])
    const id = `chatcmpl-${Date.now()}`
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      const message = calls.length
        ? { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: 'assistant', content: p.text }
      return res.end(JSON.stringify({ id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 } }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    if (calls.length) {
      calls.forEach((c, index) => {
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${Date.now()}_${index}`, type: 'function', function: { name: c.name, arguments: '' } }] }, finish_reason: null }] })
        sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(c.args) } }] }, finish_reason: null }] })
      })
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    } else {
      for (const piece of p.text.match(/.{1,12}/gs)) {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
        await new Promise((r) => setTimeout(r, 15))
      }
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 420, completion_tokens: 64, total_tokens: 484 } })
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  res.writeHead(404).end('not found')
}).listen(port, '127.0.0.1', () => console.log(`mock-llm listening on http://127.0.0.1:${port}/v1`))
