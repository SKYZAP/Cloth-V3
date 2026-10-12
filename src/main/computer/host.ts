import { BrowserWindow, globalShortcut, screen, shell, systemPreferences } from 'electron'
import { inputSupported, loadInput, type Point } from './input'
import { capture, listDisplays, zoom, type ScreenDisplay } from './screen'
import { ComputerController, type ComputerHost } from './tool'

const SCREEN_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

/** The stop shortcut, and the one used when the first can't be registered. */
const SHORTCUTS = [
  { accelerator: 'Control+Alt+Escape', win: 'Ctrl+Alt+Esc', mac: 'Ctrl+Option+Esc' },
  { accelerator: 'Control+Alt+Shift+X', win: 'Ctrl+Alt+Shift+X', mac: 'Ctrl+Option+Shift+X' }
]

export type PermissionNotice = { kind: 'screen' | 'accessibility'; text: string }

const bannerHtml = (keys: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:500 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}
body{display:flex;align-items:center;justify-content:center}
.pill{display:flex;align-items:center;gap:8px;padding:9px 16px;border-radius:999px;background:rgba(18,18,20,.92);color:#f4f4f5;border:1px solid rgba(255,255,255,.12);box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.25)}
</style></head><body><div class="pill"><span class="dot"></span>Cloth is using your computer · ${keys} to stop</div></body></html>`

/** Electron's side of computer use: Cloth's windows, the banner, the stop shortcut and macOS permissions. */
export class ElectronComputerHost implements ComputerHost {
  private banner: BrowserWindow | null = null
  private minimised: BrowserWindow[] = []
  private shortcut: (typeof SHORTCUTS)[number] | null = null
  private mac = process.platform === 'darwin'

  constructor(private notify: (n: PermissionNotice) => void) {}

  stopKeys(): string {
    const s = this.shortcut ?? SHORTCUTS[0]
    return this.mac ? s.mac : s.win
  }

  async permissions(): Promise<string | null> {
    if (!this.mac) return null
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      this.notify({ kind: 'screen', text: 'Cloth needs Screen Recording permission to see your screen. Turn it on in System Settings, then restart Cloth.' })
      return 'Cloth does not have Screen Recording permission on this Mac, so it cannot see the screen. The user has been shown how to turn it on (it needs a restart of Cloth). Stop and ask the user to do that.'
    }
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      void shell.openExternal(ACCESSIBILITY_PANE)
      this.notify({ kind: 'accessibility', text: 'Cloth needs Accessibility permission to use the mouse and keyboard. Turn it on in System Settings.' })
      return 'Cloth does not have Accessibility permission on this Mac, so it cannot use the mouse or keyboard. System Settings has been opened for the user. Wait for the user to turn it on, or ask them to.'
    }
    return null
  }

  private ownWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== this.banner)
  }

  async begin(display: ScreenDisplay, onStop: () => void): Promise<void> {
    // The stop shortcut, with a fallback when another app holds it.
    if (!this.shortcut) {
      for (const s of SHORTCUTS) {
        try {
          if (globalShortcut.register(s.accelerator, onStop)) {
            this.shortcut = s
            break
          }
        } catch {
          /* try the next one */
        }
      }
    }
    this.showBanner(display)
    const visible = this.ownWindows().filter((w) => w.isVisible() && !w.isMinimized())
    for (const w of visible) w.minimize()
    this.minimised.push(...visible)
    // Let the minimise animation finish before anything looks at the screen.
    if (visible.length) await new Promise((r) => setTimeout(r, 500))
  }

  end(): void {
    if (this.shortcut) globalShortcut.unregister(this.shortcut.accelerator)
    this.shortcut = null
    if (this.banner && !this.banner.isDestroyed()) this.banner.destroy()
    this.banner = null
    for (const w of this.minimised) if (!w.isDestroyed() && w.isMinimized()) w.restore()
    this.minimised = []
  }

  private showBanner(display: ScreenDisplay): void {
    const width = 460
    const height = 52
    const bounds = { x: Math.round(display.bounds.x + (display.bounds.width - width) / 2), y: display.bounds.y + 10, width, height }
    if (this.banner && !this.banner.isDestroyed()) {
      this.banner.setBounds(bounds)
      return
    }
    const win = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
    })
    win.setIgnoreMouseEvents(true)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Keep the banner out of the screenshots the model sees.
    win.setContentProtection(true)
    win.once('ready-to-show', () => !win.isDestroyed() && win.showInactive())
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(bannerHtml(this.stopKeys()))}`)
    this.banner = win
  }

  clothWindowAt(p: Point): boolean {
    // Windows bounds are DIP; the point is physical pixels on Windows.
    const dip = process.platform === 'win32' ? screen.screenToDipPoint(p) : p
    return this.ownWindows().some((w) => {
      if (!w.isVisible() || w.isMinimized()) return false
      const b = w.getBounds()
      return dip.x >= b.x && dip.y >= b.y && dip.x < b.x + b.width && dip.y < b.y + b.height
    })
  }

  clothFocused(): boolean {
    const w = BrowserWindow.getFocusedWindow()
    return !!w && w !== this.banner
  }
}

/** Computer use on this machine, or null where it isn't supported. */
export function createComputer(notify: (n: PermissionNotice) => void): ComputerController | null {
  if (!inputSupported()) return null
  return new ComputerController({
    platform: process.platform,
    input: async () => {
      const input = await loadInput()
      if (!input) throw new Error('Computer use is not supported on this system')
      return input
    },
    displays: listDisplays,
    capture,
    zoom,
    host: new ElectronComputerHost(notify)
  })
}

/** Open the macOS privacy pane a permission notice points at. */
export function openPermissionPane(kind: 'screen' | 'accessibility'): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve()
  return shell.openExternal(kind === 'screen' ? SCREEN_PANE : ACCESSIBILITY_PANE)
}
