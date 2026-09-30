import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Services } from '../../main/services'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Dev check (CLOTH_RUNNER_SMOKE=<out dir>): screenshots of the setup screen, then — with a scripted
 * model standing in for OpenAI — a full run, and the results screen.
 */
export async function runnerSmoke(win: BrowserWindow, s: Services, flowId: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  const shot = async (name: string) => writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG())
  const js = (code: string) => win.webContents.executeJavaScript(code)
  const log: string[] = []
  try {
    await new Promise<void>((r) => (win.isVisible() ? r() : win.once('show', () => r())))
    await wait(1500)
    await shot('runner-setup.png')
    const { registerFauxProvider } = await import('@earendil-works/pi-ai/compat')
    const { fauxAssistantMessage } = await import('@earendil-works/pi-ai')
    const faux = registerFauxProvider({ api: 'openai-responses', provider: 'faux-runner' })
    faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('## Outline\n\n1. Market\n2. Results\n3. Next steps')))
    const p = s.providers.create({ name: 'OpenAI', kind: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test' })
    s.providers.setModels(p.id, [{ id: 'faux-1', name: 'faux-1', embedding: false, reasoning: false, vision: false, contextWindow: 32000, maxTokens: 4096 } as never])
    s.settings.update({ defaultModel: { providerId: p.id, modelId: 'faux-1' } })
    win.webContents.reload()
    await wait(2500)
    await shot('runner-ready.png')
    log.push(`clicked run: ${await js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Run')); b?.click(); return !!b })()`)}`)
    for (let i = 0; i < 60; i++) {
      await wait(500)
      const runs = s.workflows.runs(flowId, 1)
      if (runs[0] && runs[0].status !== 'running') {
        log.push(`run ${runs[0].status}: ${runs[0].error ?? ''} files=${JSON.stringify(runs[0].files)}`)
        break
      }
    }
    await wait(1200)
    await shot('runner-done.png')
    faux.unregister()
  } catch (err) {
    log.push(`error: ${err instanceof Error ? err.stack : String(err)}`)
  }
  writeFileSync(join(outDir, 'runner-smoke.log'), log.join('\n'))
  app.quit()
}
