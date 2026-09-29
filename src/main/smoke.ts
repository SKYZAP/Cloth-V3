// Dev-only smoke run (CLOTH_SMOKE=<dir>): seeds data against scripts/mock-llm.mjs,
// sends a chat message, runs a workflow and screenshots every page, then quits.
import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Services } from './services'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runSmoke(win: BrowserWindow, s: Services, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  const log: string[] = []
  const note = (m: string) => {
    log.push(m)
    console.log(`[smoke] ${m}`)
  }
  try {
    if (process.env.CLOTH_PROBE === 'kb-search') return await probeKnowledgeSearch(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'skills') return await probeSkills(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'flows') return await probeFlowOutput(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'dashboard') return await probeDashboard(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'coding') return await probeCoding(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'planning') return await probePlanning(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'subagents') return await probeSubagents(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'lsp') {
      // Bundled language servers must start from the packaged app (asar unpacked).
      const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs')
      const dir = join(outDir, 'lsp')
      mk(dir, { recursive: true })
      wf(join(dir, 'a.ts'), 'const n: number = "x"\n')
      wf(join(dir, 'b.py'), 'x: int = "y"\n')
      for (const f of ['a.ts', 'b.py']) {
        const t0 = Date.now()
        try {
          const server = await s.lsp.server(dir, join(dir, f))
          const d = await server.diagnostics(join(dir, f))
          note(`${f}: ${d.map((x) => x.message.split('\n')[0]).join(' | ') || 'no diagnostics'} (${Date.now() - t0}ms)`)
        } catch (err) {
          note(`${f}: FAILED ${err instanceof Error ? err.message : err}`)
        }
      }
      s.lsp.disposeAll()
      return
    }
    if (process.env.CLOTH_PROBE === 'composer') {
      const js = (code: string) => win.webContents.executeJavaScript(code)
      const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
      await s.providers.refreshModels(lm.id)
      const chat = s.chat.create({ model: { providerId: lm.id, modelId: 'qwen/qwen3.5-9b' }, workspace: outDir, webEnabled: true })
      // Seed some history so the context meter shows a real percentage.
      const t = Date.now()
      s.ctx.db
        .prepare('UPDATE sessions SET messages = ? WHERE id = ?')
        .run(JSON.stringify([
          { role: 'user', content: 'Explain the difference between a process and a thread.', timestamp: t - 2000 },
          { role: 'assistant', content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'notes.md' } }], stopReason: 'toolUse', api: 'openai-completions', provider: lm.id, model: 'qwen/qwen3.5-9b', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: t - 1800 },
          { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(24000) }], isError: false, timestamp: t - 1600 },
          { role: 'assistant', content: [{ type: 'text', text: 'A **process** has its own address space; **threads** share one within a process.' }], usage: { input: 21000, output: 900, cacheRead: 0, cacheWrite: 0, totalTokens: 21900, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', api: 'openai-completions', provider: lm.id, model: 'qwen/qwen3.5-9b', timestamp: t - 1000 }
        ]), chat.id)
      win.webContents.reload()
      await wait(2500)
      await clickNav(win, 'Chat')
      await wait(1500)
      writeFileSync(join(outDir, 'composer.png'), await screenshot(win))
      await js(`document.querySelector('button[aria-label="Context usage"]')?.click()`)
      await wait(700)
      writeFileSync(join(outDir, 'context-open.png'), await screenshot(win))
      await js(`document.querySelector('button[aria-label="Context usage"]')?.click()`)
      await wait(400)
      // Real mouse input: hover (tooltip shows), then click — the tooltip must not linger over the sheet.
      const r = (await js(`(() => { const b = document.querySelector('button[aria-label="Thinking"]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`)) as { x: number; y: number }
      win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y })
      await wait(500)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await wait(1400)
      writeFileSync(join(outDir, 'sheet-open.png'), await screenshot(win))
      return
    }
    if (process.env.CLOTH_PROBE === 'images') return await probeImages(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'settings') {
      const js = (code: string) => win.webContents.executeJavaScript(code)
      await clickNav(win, 'Settings')
      await wait(900)
      for (const title of ['Models', 'Chat', 'Subagents', 'Web search', 'Knowledge', 'Phone', 'MCP server', 'Data & about']) {
        await js(`[...document.querySelectorAll('button')].find((b) => b.querySelector('span span')?.textContent === ${JSON.stringify(title)})?.click()`)
        await wait(500)
        writeFileSync(join(outDir, `settings-${title.split(' ')[0].toLowerCase()}.png`), await screenshot(win))
      }
      await js(`(() => { const i = document.querySelector('input[placeholder="Search settings"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'parallel'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await wait(500)
      writeFileSync(join(outDir, 'settings-search.png'), await screenshot(win))
      note(`search "parallel" shows: ${await js(`document.querySelector('h1')?.textContent`)}`)
      return
    }
    if (process.env.CLOTH_PROBE === 'assemble') {
      // Flows → AI: assemble a workflow with a scripted model and check the editor survives it.
      const js = (code: string) => win.webContents.executeJavaScript(code)
      const errors: string[] = []
      win.webContents.on('console-message', (e) => e.level === 'error' && errors.push(e.message.slice(0, 2500)))
      const { registerFauxProvider } = await import('@earendil-works/pi-ai/compat')
      const { fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai')
      const faux = registerFauxProvider({ api: 'openai-completions', provider: 'faux-builder' })
      const provider = s.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
      s.providers.setModels(provider.id, [{ id: 'faux-1', name: 'faux-1', embedding: false, reasoning: false, vision: false, contextWindow: 32000, maxTokens: 4096 } as never])
      s.settings.update({ defaultModel: { providerId: provider.id, modelId: 'faux-1' } })
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('add_node', { type: 'trigger', key: 'start', data: { defaultInput: '{"topic":"typescript"}' } }),
            fauxToolCall('add_node', { type: 'web', key: 'news', data: { query: '{{input.topic}} release news' } }),
            fauxToolCall('add_node', { type: 'llm', key: 'digest', data: { prompt: 'Summarize: {{news}}' } }),
            fauxToolCall('add_node', { type: 'output', key: 'result', data: { value: '{{digest}}' } }),
            fauxToolCall('connect', { from: 'start', to: 'news' }),
            fauxToolCall('connect', { from: 'news', to: 'digest' }),
            fauxToolCall('connect', { from: 'digest', to: 'result' })
          ],
          { stopReason: 'toolUse' }
        ),
        fauxAssistantMessage([fauxToolCall('finish', { name: 'News digest', description: 'Digest of release news' })], { stopReason: 'toolUse' })
      ])
      win.webContents.reload()
      await wait(2500)
      await clickNav(win, 'Flows')
      await wait(900)
      await js(`window.__errs = []; const ce = console.error; console.error = (...a) => { window.__errs.push(a.map((x) => typeof x === 'string' ? x : x && x.stack ? x.stack : String(x)).join(' | ').slice(0, 3000)); ce(...a) }; 1`)
      await clickText(win, 'AI')
      await wait(700)
      await js(`(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Search the web for TypeScript news and summarize it'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await wait(600)
      note(`assemble button: ${await js(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => x.textContent.trim() === 'Assemble').at(-1); if (!b) return 'missing'; b.click(); return b.disabled ? 'disabled' : 'clicked' })()`)}`)
      await wait(5000)
      writeFileSync(join(outDir, 'assemble.png'), await screenshot(win))
      const text = (await js(`document.getElementById('root')?.innerText.slice(0, 300)`)) as string
      note(`root text: ${JSON.stringify(text)}`)
      note(`workflows: ${JSON.stringify(s.workflows.list().map((w) => [w.name, w.nodes.length]))}`)
      note(`console errors: ${errors.length ? errors.join(' || ') : 'none'}`)
      note(`detailed: ${JSON.stringify(await js('window.__errs'))}`)
      faux.unregister()
      return
    }
    if (process.env.CLOTH_PROBE === 'phone') {
      // Settings → Phone: QR pairing dialog, a phone connecting (simulated with the real client), device list.
      const js = (code: string) => win.webContents.executeJavaScript(code)
      const { RemoteClient } = await import('@shared/remote-client')
      const { decodePairing, encodePairing } = await import('@shared/remote')
      s.settings.update({ remotePort: 7899 })
      await clickNav(win, 'Settings')
      await wait(900)
      await js(`[...document.querySelectorAll('div')].find((d) => d.textContent === 'Phone')?.scrollIntoView({ block: 'start' })`)
      await wait(400)
      writeFileSync(join(outDir, 'phone-settings.png'), await screenshot(win))
      await clickText(win, 'Pair a phone')
      await wait(1500)
      writeFileSync(join(outDir, 'phone-pair.png'), await screenshot(win))
      const link = (await js(`new Promise((resolve) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Copy code'); navigator.clipboard.readText = async () => ''; resolve(b ? 'found' : 'missing') })`)) as string
      const pending = s.remote.status().devices.find((d) => d.pending)
      note(`copy button ${link}; pending device ${pending ? 'yes' : 'no'}; running=${s.remote.status().running} hosts=${s.remote.status().hosts.map((h) => h.address).join(',')}`)
      // The phone's side of the pairing the dialog is showing: its device and key, as the QR carries them.
      const stored = s.ctx.kv.get<{ id: string; key: string; pending: boolean }[]>('remoteDevices', []).find((d) => d.pending)!
      const p = decodePairing(encodePairing({ v: 1, id: stored.id, k: s.ctx.secrets.decrypt(Buffer.from(stored.key, 'base64')), port: 7899, h: [], n: 'test' }))
      const client = new RemoteClient({ ...p, h: ['127.0.0.1'] }, { name: 'Pixel 9', platform: 'android', onEvent: () => undefined, onState: (st) => note(`phone state: ${st}`) })
      client.connect()
      await wait(2500)
      writeFileSync(join(outDir, 'phone-paired.png'), await screenshot(win))
      await clickText(win, 'Done')
      await wait(700)
      writeFileSync(join(outDir, 'phone-devices.png'), await screenshot(win))
      const chats = (await client.call('chat.list', [])) as unknown[]
      note(`phone listed ${chats.length} chats; devices: ${JSON.stringify(s.remote.status().devices.map((d) => [d.name, d.connected, d.pending]))}`)
      client.close()
      return
    }
    if (process.env.CLOTH_PROBE === 'dialogs') {
      const js = (code: string) => win.webContents.executeJavaScript(code)
      await s.skills.create({ name: 'int-skill', description: 'Integration-test skill', body: '# Int skill' })
      win.webContents.reload()
      await wait(2500)
      await clickNav(win, 'Skills')
      await wait(900)
      await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('int-skill'))?.click()`)
      await wait(700)
      await js(`document.querySelector('button[title^="Delete"]')?.click()`)
      await wait(700)
      writeFileSync(join(outDir, 'confirm-dialog.png'), await screenshot(win))
      const focused = await js(`document.activeElement?.textContent`)
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      await wait(600)
      const afterEsc = (await s.skills.list()).some((k) => k.name === 'int-skill')
      await js(`document.querySelector('button[title^="Delete"]')?.click()`)
      await wait(600)
      await clickText(win, 'Move to trash')
      await wait(1000)
      const afterConfirm = (await s.skills.list()).some((k) => k.name === 'int-skill')
      note(`default focus: "${focused}"; exists after Escape: ${afterEsc}; exists after "Move to trash": ${afterConfirm}`)
      return
    }
    if (process.env.CLOTH_PROBE === 'cites') {
      const js = (code: string) => win.webContents.executeJavaScript(code)
      const chat = s.chat.create({})
      const t = Date.now()
      const hit = (n: number) => ({ chunkId: `c${n}`, docId: 'd', collectionId: 'web', title: `Source number ${n}`, source: `https://example.com/${n}`, sourceType: 'url', headingPath: '', text: `Snippet for source ${n}.`, score: 1, bm25Rank: null, vectorRank: null })
      s.ctx.db.prepare('UPDATE sessions SET messages = ? WHERE id = ?').run(
        JSON.stringify([
          { role: 'user', content: 'design a page', timestamp: t - 3000 },
          { role: 'assistant', content: [{ type: 'toolCall', id: 'w1', name: 'web_search', arguments: { query: 'minimal sites' } }], stopReason: 'toolUse', api: 'openai-completions', provider: 'x', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: t - 2000 },
          { role: 'toolResult', toolCallId: 'w1', toolName: 'web_search', content: [{ type: 'text', text: 'results' }], details: { references: [hit(1), hit(2), hit(3)] }, isError: false, timestamp: t - 1500 },
          { role: 'assistant', content: [{ type: 'text', text: '1. **Minimalist aesthetic** [1] [2] — a long sentence with plenty of plain text to hover over without touching any citation.\n2. **Typography** [3] — more text here.' }], stopReason: 'stop', api: 'openai-completions', provider: 'x', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: t - 1000 }
        ]),
        chat.id
      )
      win.webContents.reload()
      await wait(2500)
      await clickNav(win, 'Chat')
      await wait(1500)
      const pos = (await js(`(() => {
        const chips = [...document.querySelectorAll('.group\\\\/cite > span:first-child')].map((c) => c.getBoundingClientRect())
        const li = [...document.querySelectorAll('.prose-cloth li')][0].getBoundingClientRect()
        return { chip: { x: Math.round(chips[1].x + chips[1].width / 2), y: Math.round(chips[1].y + chips[1].height / 2) }, text: { x: Math.round(li.x + li.width - 60), y: Math.round(li.y + 10) } }
      })()`)) as { chip: { x: number; y: number }; text: { x: number; y: number } }
      win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.text.x, y: pos.text.y })
      await wait(400)
      const onText = await js(`[...document.querySelectorAll('.group\\\\/cite > span:nth-child(2)')].filter((p) => getComputedStyle(p).display !== 'none').length`)
      writeFileSync(join(outDir, 'cite-text-hover.png'), await screenshot(win))
      win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.chip.x, y: pos.chip.y })
      await wait(400)
      const onChip = await js(`[...document.querySelectorAll('.group\\\\/cite > span:nth-child(2)')].filter((p) => getComputedStyle(p).display !== 'none').map((p) => p.textContent.slice(0, 16))`)
      writeFileSync(join(outDir, 'cite-chip-hover.png'), await screenshot(win))
      note(`popups visible — hovering text: ${onText}; hovering chip [2]: ${JSON.stringify(onChip)}`)
      return
    }
    if (process.env.CLOTH_PROBE === 'codeintel') return await probeCodeIntel(win, s, outDir, note)
    if (process.env.CLOTH_PROBE === 'ast') {
      // Native ast-grep + bundled grammars must load in the packaged app (asar unpacked).
      const { astSearch, resolveLanguage, supportedLanguages } = await import('./agent/ast')
      const { writeFileSync: wf, mkdirSync: mk } = await import('node:fs')
      const dir = join(outDir, 'ast')
      mk(dir, { recursive: true })
      wf(join(dir, 'a.ts'), 'console.log(1, 2)\n')
      wf(join(dir, 'b.py'), 'print("x")\n')
      wf(join(dir, 'c.go'), 'package main\nfunc main() { println("go") }\n')
      note(`languages: ${supportedLanguages().join(', ')}`)
      for (const [lang, pattern] of [['ts', 'console.log($$$A)'], ['python', 'print($X)'], ['go', 'println($X)']]) {
        const r = await astSearch(dir, dir, { pattern, lang: resolveLanguage(lang), max: 5 })
        note(`${lang}: ${r.matches.map((m) => `${m.file}:${m.line} ${m.text}`).join('; ') || 'no match'}`)
      }
      return
    }
    const base = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:5055/v1'
    const provider = s.providers.create({ name: 'Mock (local)', kind: 'openai-compatible', baseUrl: base })
    const p = await s.providers.refreshModels(provider.id)
    note(`provider models: ${p.models.map((m) => `${m.id}${m.embedding ? '[embed]' : ''}`).join(', ')}`)
    const chat = { providerId: provider.id, modelId: 'mock-chat' }
    const emb = { providerId: provider.id, modelId: 'mock-embed' }
    s.settings.update({ defaultModel: chat, embeddingModel: emb })

    const col = s.rag.createCollection({ name: 'nestjs-docs', description: 'NestJS framework notes', embedding: emb })
    await s.rag.ingestText(col.id, 'Guards', '# Guards\n\nA guard is a class annotated with @Injectable() which implements CanActivate. Guards determine whether a request will be handled by the route handler, typically for authorization.\n\n## Role-based auth\n\nUse a Roles decorator with Reflector to read metadata and compare against the user roles.')
    await s.rag.ingestText(col.id, 'Pipes', '# Pipes\n\nPipes transform or validate input data before it reaches the handler. ValidationPipe works with class-validator.')
    await s.rag.ingestText(col.id, 'Interceptors', '# Interceptors\n\nInterceptors bind extra logic before and after method execution, e.g. logging, caching, response mapping.')
    const search = await s.rag.search({ query: 'how do guards authorize requests', collectionIds: [col.id], mode: 'hybrid' })
    note(`hybrid top hit: ${search.hits[0]?.title} (bm25 ${search.hits[0]?.bm25Rank}, vec ${search.hits[0]?.vectorRank})`)

    await s.skills.create({ name: 'nestjs-guards', description: 'Write NestJS guards and role-based authorization. Use when protecting routes.', body: '# NestJS guards\n\n## Instructions\n\n1. Implement `CanActivate`.\n2. Register with `@UseGuards()` or `APP_GUARD`.\n3. Read role metadata with `Reflector`.' })
    await s.skills.saveEvals('nestjs-guards', [{ id: 'c1', prompt: 'Protect an admin route in NestJS', expectations: ['uses CanActivate', 'uses Reflector for roles'] }])
    const run = await s.skills.test({ name: 'nestjs-guards', model: chat, baseline: true, audit: true })
    note(`skill test: ${run.status} verdict=${run.verdict} ${run.error ?? run.summary}`)

    const wf = s.workflows.create({ name: 'Docs digest', template: 'rag-digest' })
    s.workflows.save(wf.id, { cron: '0 9 * * 1-5', cronEnabled: true })
    const wr = await s.workflows.run(wf.id, { question: 'guards' })
    note(`workflow: ${wr.status} ${wr.error ?? JSON.stringify(wr.output).slice(0, 120)}`)

    // Bundled example knowledge.
    const examples = await s.examples.load()
    for (let i = 0; i < 100 && (s.rag.getCollection(examples!.id).docCount < s.examples.files().length || s.rag.listDocuments(examples!.id).some((d) => d.status !== 'ready')); i++) await wait(100)
    const exHit = await s.rag.search({ query: 'undo the last commit', collectionIds: [examples!.id] })
    note(`examples: ${s.rag.getCollection(examples!.id).docCount} docs; "undo the last commit" → ${exHit.hits[0]?.title} › ${exHit.hits[0]?.headingPath}`)

    // Custom tool.
    const tool = s.custom.create({
      name: 'date_math',
      description: 'Add or subtract days from a date.',
      kind: 'javascript',
      params: [{ name: 'days', type: 'number', description: 'Days to add', required: true }],
      config: { code: "const d = new Date('2026-09-27'); d.setDate(d.getDate() + args.days); return d.toISOString().slice(0, 10)" }
    })
    note(`custom tool: ${JSON.stringify(await s.custom.test(tool, { days: 10 }))}`)

    // Web search through the bundled engines.
    for (const engine of ['obscura', 'searxng'] as const) {
      s.settings.update({ webEngine: engine })
      const res = await s.web.search('sqlite fts5 bm25', { k: 3 }).catch((err: Error) => ({ results: [], tookMs: 0, error: err.message }))
      note(`web ${engine}: ${res.results.length} results in ${res.tookMs}ms ${'error' in res ? res.error : res.results[0]?.url ?? ''}`)
    }
    s.settings.update({ webEngine: 'obscura' })

    // Agent-assembled workflow.
    const graph = await s.workflows.build({ description: 'Search my docs for a topic, fall back to the web, summarize', buildId: 'smoke' })
    const built = s.workflows.createFromGraph(graph)
    const builtRun = await s.workflows.run(built.id, { topic: 'full-text search' })
    note(`builder: "${graph.name}" ${graph.nodes.length} nodes/${graph.edges.length} edges → run ${builtRun.status} ${builtRun.error ?? ''}`)

    const session = s.chat.create({ model: chat })
    const webSession = s.chat.create({ model: chat, webEnabled: true, collectionIds: [col.id] })
    win.webContents.reload()
    await wait(2500)
    await clickNav(win, 'Chat')
    await wait(500)
    await s.chat.send(session.id, 'How do guards authorize requests in NestJS?')
    for (let i = 0; i < 50 && s.chat.isRunning(session.id); i++) await wait(200)
    const turn = s.chat.messages(session.id).at(-1)
    note(`chat: ${turn?.blocks.map((b) => b.type).join(',')} error=${turn?.error ?? 'none'}`)
    await s.chat.send(webSession.id, 'Search the web for the latest SQLite release notes')
    for (let i = 0; i < 150 && s.chat.isRunning(webSession.id); i++) await wait(200)
    const webTurn = s.chat.messages(webSession.id).at(-1)
    note(`web chat: ${webTurn?.blocks.map((b) => (b.type === 'tool' ? `tool:${b.trace.name}(${b.trace.status},${b.trace.references.length} refs)` : b.type)).join(',')} error=${webTurn?.error ?? 'none'}`)
    await wait(800)
    writeFileSync(join(outDir, 'chat-answer.png'), await screenshot(win))
    // Composer focus ring, context sheet, expanded trace.
    await win.webContents.executeJavaScript(`document.querySelector('textarea').focus()`)
    await wait(500)
    writeFileSync(join(outDir, 'chat-focus.png'), await screenshot(win))
    await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="Knowledge"]').click()`)
    await wait(900)
    writeFileSync(join(outDir, 'chat-sheet.png'), await screenshot(win))
    note('sheet: ' + (await win.webContents.executeJavaScript(`document.querySelector('[role=dialog]')?.getBoundingClientRect().top`)))
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
    await wait(800)
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('web_search'))?.click()`)
    await wait(700)
    writeFileSync(join(outDir, 'chat-trace.png'), await screenshot(win))

    // Slash command: type "/nes" in the real composer, pick with Enter, send.
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('textarea')
      ta.focus()
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, '/nes')
      ta.setSelectionRange(4, 4)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await wait(600)
    writeFileSync(join(outDir, 'chat-slash.png'), await screenshot(win))
    await win.webContents.executeJavaScript(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await wait(400)
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.querySelector('textarea')
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, 'Protect the admin routes')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await wait(300)
    writeFileSync(join(outDir, 'chat-slash-chip.png'), await screenshot(win))
    await win.webContents.executeJavaScript(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    for (let i = 0; i < 60 && s.chat.isRunning(webSession.id); i++) await wait(200)
    await wait(600)
    const slashUser = s.chat.messages(webSession.id).filter((m) => m.role === 'user').at(-1)
    note(`slash: skills=${JSON.stringify(slashUser?.skills)} text="${slashUser?.blocks[0]?.type === 'text' ? slashUser.blocks[0].text : ''}"`)
    writeFileSync(join(outDir, 'chat-slash-sent.png'), await screenshot(win))

    // JS-rendered docs site (real network, rendered by the bundled Obscura).
    const nest = s.rag.createCollection({ name: 'nestjs-live', embedding: null })
    const t0 = Date.now()
    await s.rag.ingestUrl({ collectionId: nest.id, url: 'https://docs.nestjs.com', crawl: true, maxPages: 12 })
    for (let i = 0; i < 300 && s.rag.listDocuments(nest.id).filter((d) => d.status !== 'indexing').length < 12; i++) await wait(250)
    const nestDocs = s.rag.listDocuments(nest.id)
    note(`nestjs crawl: ${nestDocs.filter((d) => d.status === 'ready').length}/${nestDocs.length} ready, ${nestDocs.reduce((a, d) => a + d.chunkCount, 0)} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

    for (const page of ['Chat', 'Knowledge', 'Skills', 'Tools', 'Flows', 'Models', 'MCP', 'Settings']) {
      await clickNav(win, page)
      await wait(page === 'Flows' ? 1500 : 900)
      if (page === 'Flows')
        note(
          'flow geometry: ' +
            (await win.webContents.executeJavaScript(`JSON.stringify({ rf: document.querySelector('.react-flow')?.getBoundingClientRect(), vp: document.querySelector('.react-flow__viewport')?.style.transform, nodes: [...document.querySelectorAll('.react-flow__node')].map(n => { const r = n.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width)] }) })`))
        )
      if (page === 'Skills') await clickText(win, 'Tests (1)')
      if (page === 'Knowledge') await clickText(win, 'Search playground').then(() => typeSearch(win))
      await wait(700)
      writeFileSync(join(outDir, `${page.toLowerCase()}.png`), await screenshot(win))
      note(`captured ${page}`)
    }
  } catch (err) {
    note(`FAILED: ${err instanceof Error ? err.stack : String(err)}`)
  } finally {
    writeFileSync(join(outDir, 'smoke.log'), log.join('\n'))
    app.quit()
  }
}

// capturePage can fail with UnknownVizError on some GPUs; CDP screenshots are reliable.
async function screenshot(win: BrowserWindow): Promise<Buffer> {
  const dbg = win.webContents.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  const { data } = (await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })) as { data: string }
  return Buffer.from(data, 'base64')
}

function clickNav(win: BrowserWindow, label: string) {
  return win.webContents.executeJavaScript(`[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})?.click()`)
}

function clickText(win: BrowserWindow, text: string) {
  return win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`)
}

async function typeSearch(win: BrowserWindow) {
  await wait(300)
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('input[placeholder="Ask the collection…"]')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'guards role based authorization')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    setTimeout(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Search')?.click(), 100)
  })()`)
  await wait(800)
}

/** Real mouse/keyboard input on the Knowledge search playground, plus layout diagnostics. */
async function probeKnowledgeSearch(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const provider = s.providers.create({ name: 'Mock (local)', kind: 'openai-compatible', baseUrl: process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:5055/v1' })
  await s.providers.refreshModels(provider.id).catch(() => undefined)
  s.settings.update({ defaultModel: { providerId: provider.id, modelId: 'mock-chat' } })
  const col = await s.examples.load()
  for (let i = 0; i < 80 && s.rag.listDocuments(col!.id).some((d) => d.status !== 'ready'); i++) await wait(100)
  win.webContents.reload()
  await wait(2500)
  const js = (code: string) => win.webContents.executeJavaScript(code)
  await clickNav(win, 'Knowledge')
  await wait(800)
  await clickText(win, 'Search playground')
  await wait(600)
  const state = await js(`JSON.stringify({ tabs: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /Search|Documents|Add/.test(t)), inputs: [...document.querySelectorAll('input')].map(i => i.placeholder) })`)
  note('state ' + state)
  const box = await js(`JSON.stringify(document.querySelector('input[placeholder^="Ask the collection"], input[placeholder^="Search the collection"]')?.getBoundingClientRect() ?? null)`)
  const r = JSON.parse(box) as { x: number; y: number; width: number; height: number }
  const x = Math.round(r.x + r.width / 2)
  const y = Math.round(r.y + r.height / 2)
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await wait(300)
  for (const ch of 'undo last commit') {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await wait(15)
  }
  await wait(300)
  const typed = await js(`document.querySelector('input[placeholder^="Ask the collection"]')?.value`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await wait(2500)
  const diag = await js(`JSON.stringify({
    active: document.activeElement?.getAttribute('placeholder'),
    hits: document.querySelectorAll('[class*="rounded-[10px]"][class*="bg-bg"]').length,
    summary: [...document.querySelectorAll('span')].map(e => e.textContent).find(t => /passages in/.test(t || '')),
    answer: [...document.querySelectorAll('.prose-cloth')].map(e => e.textContent).join(' | ').slice(0, 160),
    scrolled: [...document.querySelectorAll('*')].filter(e => e.scrollLeft > 0 || e.scrollTop > 0).map(e => (e.tagName + '.' + String(e.className).slice(0, 60) + ' L' + e.scrollLeft + ' T' + e.scrollTop)).slice(0, 8),
    docScroll: [document.documentElement.scrollLeft, document.body.scrollLeft],
    wide: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 2).map(e => e.tagName + '.' + String(e.className).slice(0, 70)).slice(0, 8)
  })`)
  note(`typed="${typed}" diag=${diag}`)
  writeFileSync(join(outDir, 'kb-search.png'), await screenshot(win))
}

/** skills.sh search + install through the dialog, then Draft with AI against a local LM Studio model. */
async function probeSkills(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const setInput = (selector: string, value: string) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
  await s.providers.refreshModels(lm.id)
  s.settings.update({ defaultModel: { providerId: lm.id, modelId: process.env.CLOTH_PROBE_MODEL ?? 'qwen/qwen3.5-9b' } })
  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Skills')
  await wait(700)
  await js(`document.querySelector('button[title="Browse skills.sh"]').click()`)
  await wait(500)
  await setInput('input[placeholder^="Search skills.sh"]', 'nestjs')
  for (let i = 0; i < 40 && !(await js(`!!document.querySelector('[role] .font-mono, .font-mono.text-\[14px\]')`).catch(() => false)); i++) await wait(250)
  await wait(2500)
  writeFileSync(join(outDir, 'registry-search.png'), await screenshot(win))
  await clickText(win, 'Install')
  for (let i = 0; i < 60 && !(await s.skills.list()).some((k) => k.source); i++) await wait(250)
  const installed = (await s.skills.list()).find((k) => k.source)
  note(`registry install: ${installed?.name} from ${installed?.source?.id} files=${installed?.files.join(',')}`)
  await wait(800)
  writeFileSync(join(outDir, 'registry-installed.png'), await screenshot(win))
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`)
  await wait(600)
  await clickText(win, 'Tests (')
  await wait(600)
  const t0 = Date.now()
  await clickText(win, 'Draft with AI')
  for (let i = 0; i < 240 && (await js(`document.querySelectorAll('textarea').length`)) < 2; i++) await wait(500)
  const drafted = await js(`document.querySelectorAll('textarea').length / 2`)
  note(`draft with AI: ${drafted} case(s) in the editor after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  writeFileSync(join(outDir, 'draft-evals.png'), await screenshot(win))
}

/** A real chat against LM Studio that edits files in a workspace, approved through the UI. */
async function probeCoding(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf, existsSync: ex } = await import('node:fs')
  const ws = join(outDir, 'workspace')
  mk(ws, { recursive: true })
  wf(join(ws, 'math.js'), "export function add(a, b) {\n  return a + b\n}\n")
  const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
  await s.providers.refreshModels(lm.id)
  const model = { providerId: lm.id, modelId: process.env.CLOTH_PROBE_MODEL ?? 'qwen/qwen3.5-9b' }
  s.settings.update({ defaultModel: model })
  const chat = s.chat.create({ model, workspace: ws, fileAccess: 'write', knowledgeEnabled: false, skillsEnabled: false, customTools: false, webEnabled: false })
  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Chat')
  await wait(1200)
  const t0 = Date.now()
  await s.chat.send(chat.id, 'In math.js, add an exported `multiply(a, b)` function below `add`. Then create a short README.md describing the two functions. Use the edit and write tools.')
  let shots = 0
  for (let i = 0; i < 600 && s.chat.isRunning(chat.id); i++) {
    const pending = s.chat.pendingApprovals(chat.id)
    if (pending.length) {
      await wait(900)
      shots++
      note(`approval ${shots}: ${pending[0].kind} ${pending[0].path} +${pending[0].added} -${pending[0].removed} after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      if (shots <= 2) writeFileSync(join(outDir, `coding-approval-${shots}.png`), await screenshot(win))
      await clickText(win, 'Apply')
      await wait(700)
      continue
    }
    await wait(500)
  }
  await wait(1500)
  note(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s; running=${s.chat.isRunning(chat.id)}`)
  note(`math.js:\n${rf(join(ws, 'math.js'), 'utf8')}`)
  note(`README.md exists: ${ex(join(ws, 'README.md'))}`)
  const traces = s.chat.messages(chat.id).flatMap((m) => m.blocks).filter((b) => b.type === 'tool')
  note(`tools: ${traces.map((b) => (b.type === 'tool' ? `${b.trace.name}:${b.trace.status}${b.trace.changes ? `(${b.trace.changes.length} change)` : ''}` : '')).join(', ')}`)
  await js(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 999999)`)
  await wait(600)
  writeFileSync(join(outDir, 'coding-done.png'), await screenshot(win))
  // Open the workspace sheet to show the new settings.
  await js(`document.querySelector('button[aria-label="Workspace"]')?.click()`)
  await wait(1200)
  writeFileSync(join(outDir, 'coding-sheet.png'), await screenshot(win))
}

/** A fake Images API (slow on purpose) + LM Studio chat calling generate_image, then the Models playground. */
async function probeImages(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const { createServer } = await import('node:http')
  const { nativeImage } = await import('electron')
  // A 768×512 "sunset over hills" drawn pixel by pixel, so the reveal has something to show.
  const W = 768
  const H = 512
  const bmp = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = y / H
      let r = 40 + 200 * (1 - t) + 15
      let g = 30 + 90 * (1 - t) * (1 - t)
      let b = 90 + 60 * t
      const sun = Math.hypot(x - W * 0.62, y - H * 0.52)
      if (sun < 70) [r, g, b] = [255, 200 + (70 - sun) * 0.6, 120]
      const hill = H * 0.68 + Math.sin(x / 90) * 28 + Math.sin(x / 37) * 9
      if (y > hill) [r, g, b] = [22 + (y - hill) * 0.05, 18, 32]
      const i = (y * W + x) * 4
      bmp[i] = Math.min(255, b)
      bmp[i + 1] = Math.min(255, g)
      bmp[i + 2] = Math.min(255, r)
      bmp[i + 3] = 255
    }
  }
  const png = nativeImage.createFromBitmap(bmp, { width: W, height: H }).toPNG().toString('base64')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-image-1' }] }))
    if (req.url !== '/v1/images/generations') {
      res.statusCode = 404
      return res.end('{}')
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => setTimeout(() => res.end(JSON.stringify({ data: [{ b64_json: png, revised_prompt: `${JSON.parse(body).prompt}, golden hour, painterly` }] })), 5000))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const images = s.providers.create({ name: 'Local images (fake)', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1` })
  await s.providers.refreshModels(images.id)
  const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
  await s.providers.refreshModels(lm.id)
  const model = { providerId: lm.id, modelId: process.env.CLOTH_PROBE_MODEL ?? 'qwen/qwen3.5-9b' }
  s.settings.update({ defaultModel: model, imageModel: { providerId: images.id, modelId: 'gpt-image-1' } })
  const chat = s.chat.create({ model, knowledgeEnabled: false, skillsEnabled: false, customTools: false, webEnabled: false, subagents: false })
  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Chat')
  await wait(1200)
  await s.chat.send(chat.id, 'Generate an image of a sunset over rolling hills, landscape format.')
  let shot = false
  for (let i = 0; i < 600 && s.chat.isRunning(chat.id); i++) {
    const t = s.chat.messages(chat.id).flatMap((m) => m.blocks).find((b) => b.type === 'tool' && b.trace.name === 'generate_image')
    if (!shot && t && t.type === 'tool' && t.trace.status === 'running') {
      await wait(2800)
      writeFileSync(join(outDir, 'image-generating.png'), await screenshot(win))
      shot = true
    }
    await wait(250)
  }
  await wait(1800)
  await js(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 999999)`)
  await wait(500)
  writeFileSync(join(outDir, 'image-done.png'), await screenshot(win))
  const trace = s.chat.messages(chat.id).flatMap((m) => m.blocks).find((b) => b.type === 'tool' && b.trace.name === 'generate_image')
  note(`chat: ${trace && trace.type === 'tool' ? `${trace.trace.status} ${JSON.stringify(trace.trace.args)} → ${trace.trace.image?.status} ${trace.trace.image?.width}×${trace.trace.image?.height}` : 'no generate_image call'}`)
  const loaded = await js(`[...document.querySelectorAll('img')].filter((i) => i.src.startsWith('cloth-image://')).map((i) => i.naturalWidth + 'x' + i.naturalHeight)`)
  note(`images rendered from cloth-image://: ${JSON.stringify(loaded)}`)

  // Models page playground.
  await clickNav(win, 'Models')
  await wait(900)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Local images'))?.click()`)
  await wait(900)
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Generate')?.click()`)
  await wait(700)
  await js(`[...document.querySelectorAll('.fixed button')].find((b) => b.textContent.trim() === 'Generate')?.click()`)
  await wait(3000)
  writeFileSync(join(outDir, 'playground-generating.png'), await screenshot(win))
  await wait(4000)
  writeFileSync(join(outDir, 'playground-done.png'), await screenshot(win))
  server.close()
}

/** A small TS project with a type error: the model should find it with lsp and fix it. */
async function probeCodeIntel(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const { mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = await import('node:fs')
  const ws = join(outDir, 'project')
  mk(join(ws, 'src'), { recursive: true })
  wf(join(ws, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }, null, 2))
  wf(join(ws, 'src', 'cart.ts'), 'export interface Item {\n  name: string\n  price: number\n  qty: number\n}\n\nexport function total(items: Item[]): number {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0)\n}\n')
  wf(join(ws, 'src', 'checkout.ts'), "import { total, type Item } from './cart'\n\nconst items: Item[] = [\n  { name: 'pen', price: '1.50', qty: 2 },\n  { name: 'book', price: 12, quantity: 1 }\n]\n\nexport const amount: string = total(items)\n")
  const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
  await s.providers.refreshModels(lm.id)
  const model = { providerId: lm.id, modelId: process.env.CLOTH_PROBE_MODEL ?? 'qwen/qwen3.5-9b' }
  const chat = s.chat.create({ model, workspace: ws, fileAccess: 'write', autoApprove: 'edits', subagents: false, knowledgeEnabled: false, skillsEnabled: false, customTools: false, webEnabled: false })
  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Chat')
  await wait(1200)
  const t0 = Date.now()
  await s.chat.send(chat.id, 'checkout.ts does not type-check. Use the lsp tool to see the diagnostics, fix every error in checkout.ts (do not change cart.ts), and confirm there are no type errors left.')
  for (let i = 0; i < 900 && s.chat.isRunning(chat.id); i++) await wait(400)
  await wait(1200)
  const traces = s.chat.messages(chat.id).flatMap((m) => m.blocks).filter((b) => b.type === 'tool')
  note(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s; tools: ${traces.map((b) => (b.type === 'tool' ? `${b.trace.name}${b.trace.name === 'lsp' ? `(${(b.trace.args as { action?: string }).action})` : ''}:${b.trace.status}` : '')).join(', ')}`)
  const server = await s.lsp.server(ws, join(ws, 'src', 'checkout.ts'))
  const left = (await server.diagnostics(join(ws, 'src', 'checkout.ts'))).filter((d) => d.severity === 1)
  note(`errors left in checkout.ts: ${left.length}${left.length ? ' — ' + left.map((d) => d.message).join(' | ') : ''}`)
  note(`checkout.ts now:\n${rf(join(ws, 'src', 'checkout.ts'), 'utf8')}`)
  await js(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 999999)`)
  await wait(600)
  writeFileSync(join(outDir, 'codeintel.png'), await screenshot(win))
  s.lsp.disposeAll()
}

/** Two scouts in parallel over Cloth's own source (read-only). */
async function probeSubagents(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
  await s.providers.refreshModels(lm.id)
  const model = { providerId: lm.id, modelId: process.env.CLOTH_PROBE_MODEL ?? 'qwen/qwen3.5-9b' }
  s.settings.update({ defaultModel: model })
  const ws = join(app.getAppPath(), 'src', 'main')
  const chat = s.chat.create({ model, workspace: ws, fileAccess: 'read', knowledgeEnabled: false, skillsEnabled: false, customTools: false, webEnabled: false })
  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Chat')
  await wait(1200)
  const t0 = Date.now()
  await s.chat.send(
    chat.id,
    'Run two scout subagents in parallel (call the task tool twice in the same turn): one to find how the MCP server registers its tools (look in mcp/), and one to find how workflows are scheduled with cron (look in workflows/). Then give me a short combined summary.'
  )
  let shot = false
  for (let i = 0; i < 900 && s.chat.isRunning(chat.id); i++) {
    const tasks = s.chat.messages(chat.id).flatMap((m) => m.blocks).filter((b) => b.type === 'tool' && b.trace.name === 'task')
    if (!shot && tasks.length && Date.now() - t0 > 25_000) {
      await js(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 999999)`)
      await wait(500)
      writeFileSync(join(outDir, 'subagents-running.png'), await screenshot(win))
      shot = true
    }
    await wait(400)
  }
  await wait(1500)
  const traces = s.chat.messages(chat.id).flatMap((m) => m.blocks).filter((b) => b.type === 'tool')
  for (const b of traces) {
    if (b.type !== 'tool') continue
    const sub = b.trace.subagent
    note(`${b.trace.name}:${b.trace.status}${sub ? ` [${sub.role}] "${sub.description}" steps=${sub.blocks.filter((x) => x.type === 'tool').length} report=${b.trace.result.slice(0, 140).replace(/\n/g, ' ')}` : ''}`)
  }
  note(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await js(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 999999)`)
  await wait(600)
  writeFileSync(join(outDir, 'subagents-done.png'), await screenshot(win))
}

/** Multi-step task with a live plan, then a manual summarise from the context meter. */
async function probePlanning(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const { mkdirSync: mk } = await import('node:fs')
  const ws = join(outDir, 'workspace')
  mk(ws, { recursive: true })
  const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
  await s.providers.refreshModels(lm.id)
  const model = { providerId: lm.id, modelId: process.env.CLOTH_PROBE_MODEL ?? 'qwen/qwen3.5-9b' }
  s.settings.update({ defaultModel: model })
  const chat = s.chat.create({ model, workspace: ws, fileAccess: 'write', autoApprove: 'edits', knowledgeEnabled: false, skillsEnabled: false, customTools: false, webEnabled: false })
  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Chat')
  await wait(1200)
  const t0 = Date.now()
  await s.chat.send(
    chat.id,
    'Set up a tiny JS utility package in the workspace. Plan it with todo_write first, then: 1) create src/add.js exporting add(a,b), 2) create src/sub.js exporting sub(a,b), 3) create src/index.js re-exporting both, 4) create package.json with name "tiny-math", 5) write a README.md. Update the todo list as you complete each step.'
  )
  let shot = false
  for (let i = 0; i < 900 && s.chat.isRunning(chat.id); i++) {
    const todos = s.chat
      .messages(chat.id)
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'tool' && b.trace.name === 'todo_write')
    if (!shot && todos.length >= 2) {
      await wait(600)
      writeFileSync(join(outDir, 'plan-running.png'), await screenshot(win))
      shot = true
    }
    await wait(400)
  }
  await wait(1500)
  const traces = s.chat.messages(chat.id).flatMap((m) => m.blocks).filter((b) => b.type === 'tool')
  note(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s; tools: ${traces.map((b) => (b.type === 'tool' ? `${b.trace.name}:${b.trace.status}` : '')).join(', ')}`)
  note(`files: ${(await import('node:fs')).readdirSync(ws, { recursive: true }).join(', ')}`)
  await js(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 999999)`)
  await wait(500)
  writeFileSync(join(outDir, 'plan-done.png'), await screenshot(win))
  await s.chat.send(chat.id, 'Thanks. In one sentence: what does src/index.js export?')
  for (let i = 0; i < 400 && s.chat.isRunning(chat.id); i++) await wait(400)
  await wait(800)
  const before = await s.chat.contextUsage(chat.id)
  note(`context before: ${before.tokens} / ${before.window} (threshold ${before.threshold})`)
  // Manual summarise through the context meter.
  await js(`document.querySelector('button[aria-label="Summarise conversation"]')?.click()`)
  for (let i = 0; i < 300 && !s.chat.messages(chat.id).some((m) => m.summary); i++) await wait(400)
  await wait(1200)
  const after = await s.chat.contextUsage(chat.id)
  const carrier = s.chat.messages(chat.id).find((m) => m.summary)
  note(`summarised: ${!!carrier}; context after: ${after.tokens}; summary: ${carrier?.summary?.slice(0, 300).replace(/\n/g, ' ⏎ ')}`)
  await js(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Earlier conversation summarised'))?.click()`)
  await wait(900)
  await js(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 0)`)
  await wait(500)
  writeFileSync(join(outDir, 'summary.png'), await screenshot(win))
  // Workspace settings in the context sheet.
  await js(`document.querySelector('button[aria-label="Workspace"]')?.click()`)
  await wait(1200)
  await js(`document.getElementById('sheet-workspace')?.scrollIntoView({ block: 'start' })`)
  await wait(700)
  writeFileSync(join(outDir, 'workspace-sheet.png'), await screenshot(win))
}

/** Seed a week of synthetic usage + a messy loop flow; screenshot the dashboard and Arrange. */
async function probeDashboard(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const openai = s.providers.create({ name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' })
  s.providers.setModels(openai.id, [{ id: 'gpt-6-luna', name: 'gpt-6-luna', contextWindow: 400000, maxTokens: 128000, reasoning: true, vision: true, embedding: false, pricing: { input: 1.25, output: 10 } }])
  const lm = s.providers.create({ name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
  s.providers.setModels(lm.id, [
    { id: 'qwen/qwen3.5-9b', name: 'qwen3.5-9b', contextWindow: 32768, maxTokens: 8192, reasoning: true, vision: false, embedding: false },
    { id: 'text-embedding-nomic-embed-text-v1.5', name: 'nomic', contextWindow: 8192, maxTokens: 0, reasoning: false, vision: false, embedding: true }
  ])
  const ins = s.ctx.db.prepare(
    'INSERT INTO usage_events (at, kind, source, ref, provider_id, model_id, name, detail, input_tokens, output_tokens, cache_read, cache_write, cost, duration_ms, ok) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)'
  )
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const now = Date.now()
  const sources = ['chat', 'chat', 'chat', 'workflow', 'workflow', 'skills', 'knowledge', 'mcp', 'builder']
  const tools = ['rag_search', 'rag_search', 'rag_search', 'skill_use', 'web_search', 'web_search', 'read_file', 'grep', 'date_math', 'web_fetch']
  const skillNames = ['nestjs-best-practices', 'nestjs-guards', 'commit-messages', 'react-testing']
  const vias = ['slash', 'tool', 'tool', 'mcp', 'workflow']
  for (let i = 0; i < 520; i++) {
    const day = Math.floor(rnd() * 7)
    const hour = 9 + Math.floor(rnd() * 11 + (rnd() > 0.85 ? -8 : 0))
    const at = now - day * 86_400_000 - ((new Date(now).getHours() - hour + 24) % 24) * 3_600_000 - Math.floor(rnd() * 3_600_000)
    if (at > now) continue
    const src = sources[Math.floor(rnd() * sources.length)]
    const local = rnd() > 0.35
    const r = rnd()
    if (r < 0.45) {
      const inTok = Math.floor(800 + rnd() * 9000)
      ins.run(at, 'llm', src, local ? lm.id : openai.id, local ? 'qwen/qwen3.5-9b' : 'gpt-6-luna', null, null, inTok, Math.floor(150 + rnd() * 1800), Math.floor((local ? 1800 : 900) + rnd() * 9000), rnd() > 0.03 ? 1 : 0)
    } else if (r < 0.55) {
      ins.run(at, 'embed', 'knowledge', lm.id, 'text-embedding-nomic-embed-text-v1.5', null, null, Math.floor(2000 + rnd() * 20000), 0, 300, 1)
    } else if (r < 0.9) {
      ins.run(at, 'tool', src, null, null, tools[Math.floor(Math.pow(rnd(), 1.6) * tools.length)], rnd() > 0.85 ? 'mcp' : 'builtin', 0, 0, Math.floor(20 + rnd() * 900), rnd() > 0.05 ? 1 : 0)
    } else {
      ins.run(at, 'skill', src, null, null, skillNames[Math.floor(Math.pow(rnd(), 1.4) * skillNames.length)], vias[Math.floor(rnd() * vias.length)], 0, 0, null, 1)
    }
  }
  await s.skills.create({ name: 'nestjs-guards', description: 'Write NestJS guards.', body: '# Guards' })
  await s.skills.create({ name: 'commit-messages', description: 'Write conventional commits.', body: '# Commits' })

  // A loop flow with deliberately scattered nodes.
  const wf = s.workflows.create({ name: 'summarize-each-url' })
  s.workflows.save(wf.id, {
    nodes: [
      { id: 't', type: 'trigger', position: { x: 420, y: 380 }, data: { key: 'start', label: 'Start', defaultInput: '{"urls":["a","b","c"]}' } },
      { id: 'l', type: 'loop', position: { x: -80, y: 40 }, data: { key: 'each_url', label: 'For each URL', mode: 'each', items: '{{input.urls}}' } },
      { id: 'f', type: 'transform', position: { x: 700, y: -60 }, data: { key: 'fetch', label: 'Fetch page', code: 'return "page " + nodes.loop.item' } },
      { id: 'c', type: 'condition', position: { x: 160, y: 520 }, data: { key: 'long', label: 'Long enough?', expression: 'String(prev).length > 5' } },
      { id: 's', type: 'transform', position: { x: 980, y: 300 }, data: { key: 'summarize', label: 'Summarize', code: 'return "summary of " + prev' } },
      { id: 'k', type: 'transform', position: { x: 600, y: 640 }, data: { key: 'skip', label: 'Mark empty', code: 'return "(empty)"' } },
      { id: 'o', type: 'output', position: { x: 60, y: 260 }, data: { key: 'result', label: 'Digest', value: '' } }
    ],
    edges: [
      { id: 'e1', source: 't', target: 'l' },
      { id: 'e2', source: 'l', target: 'f', sourceHandle: 'body' },
      { id: 'e3', source: 'f', target: 'c' },
      { id: 'e4', source: 'c', target: 's', sourceHandle: 'true' },
      { id: 'e5', source: 'c', target: 'k', sourceHandle: 'false' },
      { id: 'e6', source: 's', target: 'l', targetHandle: 'next' },
      { id: 'e7', source: 'k', target: 'l', targetHandle: 'next' },
      { id: 'e8', source: 'l', target: 'o', sourceHandle: 'done' }
    ]
  })
  const run = await s.workflows.run(wf.id, { urls: ['alpha', 'b', 'gamma'] })
  note(`loop run: ${run.status} ${JSON.stringify(run.output)} iterations=${run.nodes.find((n) => n.nodeId === 'l')?.iterations}`)

  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Flows')
  await wait(1500)
  writeFileSync(join(outDir, 'flow-before-arrange.png'), await screenshot(win))
  await clickText(win, 'Arrange')
  await wait(1400)
  writeFileSync(join(outDir, 'flow-after-arrange.png'), await screenshot(win))
  for (let i = 0; i < 3; i++) await js(`document.querySelector('.react-flow__controls-zoomin')?.click()`)
  await wait(700)
  writeFileSync(join(outDir, 'flow-zoomed.png'), await screenshot(win))

  await clickNav(win, 'Dashboard')
  await wait(2200)
  writeFileSync(join(outDir, 'dashboard-top.png'), await screenshot(win))
  await js(`document.querySelector('main .overflow-y-auto').scrollTo(0, 99999)`)
  await wait(900)
  writeFileSync(join(outDir, 'dashboard-bottom.png'), await screenshot(win))
  const stats = await s.dashboard.stats('7d')
  note(`dashboard: calls=${stats.totals.calls} tokens=${stats.totals.tokens} cost=${stats.totals.cost.toFixed(2)} tools=${stats.tools.length} skills=${stats.skills.length}`)
}

/** Run a flow whose output is markdown, then open it in the output modal. */
async function probeFlowOutput(win: BrowserWindow, s: Services, outDir: string, note: (m: string) => void) {
  const md = [
    '# Top Search Results Summary: TypeScript Releases',
    '',
    'Based on the search results, here are the key findings about **TypeScript** releases:',
    '',
    '## Latest Versions & Availability',
    '',
    '| Source | Status |',
    '| --- | --- |',
    '| GitHub releases | 5.9 stable |',
    '| npm | `typescript@next` nightly |',
    '',
    '## Highlights',
    '',
    '- `import defer` support',
    '- Faster `--build` mode',
    '',
    '```ts',
    'const x: number = 42',
    '```'
  ].join('\n')
  const wf = s.workflows.create({ name: 'typescript-release-digest' })
  s.workflows.save(wf.id, {
    nodes: [
      { id: 'n_trigger', type: 'trigger', position: { x: 0, y: 120 }, data: { key: 'trigger', label: 'Start', defaultInput: '{}' } },
      { id: 'n_md', type: 'transform', position: { x: 320, y: 120 }, data: { key: 'digest', label: 'Digest', code: 'return ' + JSON.stringify(md) } },
      { id: 'n_out', type: 'output', position: { x: 640, y: 120 }, data: { key: 'result', label: 'Digest Output', value: '' } }
    ],
    edges: [
      { id: 'e1', source: 'n_trigger', target: 'n_md' },
      { id: 'e2', source: 'n_md', target: 'n_out' }
    ]
  })
  const run = await s.workflows.run(wf.id, {})
  note(`run: ${run.status} ${run.error ?? typeof run.output}`)
  win.webContents.reload()
  await wait(2500)
  await clickNav(win, 'Flows')
  await wait(1200)
  await clickText(win, 'typescript-release-digest')
  await wait(1500)
  writeFileSync(join(outDir, 'flow-panel.png'), await screenshot(win))
  await clickText(win, 'View output')
  await wait(800)
  writeFileSync(join(outDir, 'flow-output-modal.png'), await screenshot(win))
  const found = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.fixed h1, .fixed h2, .fixed table, .fixed pre')].map(e => e.tagName).join(',')`)
  note(`modal elements: ${found}`)
}
