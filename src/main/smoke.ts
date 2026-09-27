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
