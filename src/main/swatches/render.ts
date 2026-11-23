/** Renders a page in a hidden, sandboxed window and returns a PNG of it: a mockup board for the agent to look at, for its card's thumbnail, or for export. */
export type RenderPage = (url: string, width: number, height: number) => Promise<Buffer>

const LOAD_TIMEOUT = 15_000
/** After load: web fonts, a first animation frame, and a board's own start-up script. */
const SETTLE_MS = 700

export const renderPage: RenderPage = async (url, width, height) => {
  const { BrowserWindow } = await import('electron')
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, backgroundThrottling: false }
  })
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setAudioMuted(true)
    await Promise.race([win.loadURL(url), new Promise((_, reject) => setTimeout(() => reject(new Error('The board took over 15 s to load')), LOAD_TIMEOUT))])
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width, height })
    return img.toPNG()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** A PNG scaled down so its longer side is at most `max` px (models read big screenshots poorly and slowly). */
export async function shrinkPng(png: Buffer, max: number): Promise<Buffer> {
  const { nativeImage } = await import('electron')
  const img = nativeImage.createFromBuffer(png)
  const { width, height } = img.getSize()
  const s = Math.min(1, max / Math.max(width, height, 1))
  return s >= 1 ? png : img.resize({ width: Math.round(width * s), height: Math.round(height * s), quality: 'good' }).toPNG()
}
