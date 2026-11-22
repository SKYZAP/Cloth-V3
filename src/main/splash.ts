// The small window that shows while Cloth starts, when starting takes long enough to notice (a cold start after a
// reboot or an update can take over ten seconds). It is a self-contained page with no preload and no files to load,
// so it can draw straight away; the main process tells it which step is running. It closes once Cloth's window shows.
import { BrowserWindow } from 'electron'

export interface Splash {
  /** Say what is starting now. */
  step(text: string): void
  /** Close it (the main window has shown). Safe to call more than once. */
  close(): void
}

const ICON = `<svg viewBox="64 64 896 896" aria-hidden="true"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1b1f"/><stop offset="1" stop-color="#09090a"/></linearGradient><linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ef3d5c"/><stop offset="1" stop-color="#9f1830"/></linearGradient></defs><rect x="64" y="64" width="896" height="896" rx="208" fill="url(#bg)"/><rect x="64.5" y="64.5" width="895" height="895" rx="207.5" fill="none" stroke="#303036" stroke-width="3"/><path d="M700 350a230 230 0 1 0 0 324" fill="none" stroke="url(#c)" stroke-width="92" stroke-linecap="round"/><path class="dash" d="M410 512h200" fill="none" stroke="#ececef" stroke-opacity=".55" stroke-width="40" stroke-linecap="round" stroke-dasharray="40 64"/></svg>`

/** The startup window's page (exported for tests). */
export function splashPage(version: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Starting Cloth</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; background: #141518; color: #f1f1f4; font: 13px/1.4 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif; user-select: none; cursor: default; overflow: hidden; }
  body { display: flex; flex-direction: column; align-items: center; padding: 44px 28px 18px; border: 1px solid #36363c; -webkit-app-region: drag; animation: in 160ms ease-out both; }
  svg { width: 72px; height: 72px; }
  .dash { animation: slide 1.1s linear infinite; }
  h1 { margin-top: 18px; font-size: 16px; font-weight: 600; letter-spacing: .01em; }
  #step { margin-top: 6px; color: #bdbdc5; min-height: 18px; text-align: center; }
  .bar { position: relative; width: 168px; height: 3px; margin-top: 18px; border-radius: 2px; background: #26262b; overflow: hidden; }
  .bar::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 40%; border-radius: 2px; background: #cf2845; animation: run 1.3s ease-in-out infinite; }
  #hint { margin-top: 14px; max-width: 250px; color: #94949e; font-size: 12px; text-align: center; opacity: 0; transition: opacity 300ms; }
  #hint.on { opacity: 1; }
  footer { margin-top: auto; color: #94949e; font-size: 11px; }
  @keyframes in { from { opacity: 0; } }
  @keyframes slide { to { stroke-dashoffset: -104; } }
  @keyframes run { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
  @media (prefers-reduced-motion: reduce) { body, .dash, .bar::after { animation: none; } .bar::after { width: 100%; opacity: .5; } }
</style></head><body>
${ICON}
<h1>Starting Cloth</h1>
<p id="step" role="status" aria-live="polite">Opening…</p>
<div class="bar" aria-hidden="true"></div>
<p id="hint">The first start after a restart or an update takes longer while the system reads Cloth's files.</p>
<footer>Cloth ${version.replace(/[^\w.+-]/g, '')}</footer>
<script>
  window.setStep = (t) => { document.getElementById('step').textContent = t }
  setTimeout(() => document.getElementById('hint').classList.add('on'), 6000)
</script>
</body></html>`
}

/**
 * Shows the startup window `delayMs` after this is called unless closed first, so a quick start never flashes it.
 * Its page loads hidden from the start (starting its renderer takes about a second), so it can show on time.
 * The main window should call `close()` as soon as it shows.
 */
export function openSplash(opts: { delayMs: number; version: string; icon?: string; onShown?: () => void }): Splash {
  let win: BrowserWindow | null = null
  let closed = false
  let due = false
  let loaded = false
  let current = 'Opening…'
  const send = () => {
    if (win && !win.isDestroyed()) void win.webContents.executeJavaScript(`window.setStep && setStep(${JSON.stringify(current)})`).catch(() => undefined)
  }
  const show = () => {
    if (closed || !due || !loaded || !win || win.isDestroyed() || win.isVisible()) return
    win.show()
    opts.onShown?.()
    send()
  }
  // Load it a moment after the main window, so the main window's renderer starts first.
  const create = setTimeout(() => {
    if (closed) return
    win = new BrowserWindow({
      width: 320,
      height: 340,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      center: true,
      show: false,
      backgroundColor: '#141518',
      title: 'Starting Cloth',
      icon: opts.icon,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.once('ready-to-show', () => {
      loaded = true
      show()
    })
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashPage(opts.version))}`).catch(() => undefined)
  }, Math.min(opts.delayMs, 300))
  const timer = setTimeout(() => {
    due = true
    show()
  }, opts.delayMs)
  return {
    step(text) {
      current = text
      send()
    },
    close() {
      if (closed) return
      closed = true
      clearTimeout(create)
      clearTimeout(timer)
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }
  }
}
