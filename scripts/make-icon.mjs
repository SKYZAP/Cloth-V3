// Renders resources/icon.svg to resources/icon.png (1024px) using Electron's Chromium.
//   npx electron scripts/make-icon.mjs
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const svg = readFileSync(`${root}resources/icon.svg`, 'utf8')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const html = `<html style="background:transparent"><body style="margin:0;background:transparent">${svg.replace('<svg', '<svg width="1024" height="1024"')}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 300))
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  await dbg.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  const { data } = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1024, height: 1024, scale: 1 } })
  writeFileSync(`${root}resources/icon.png`, Buffer.from(data, 'base64'))
  console.log('wrote resources/icon.png')
  app.quit()
})
