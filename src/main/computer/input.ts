/**
 * Mouse and keyboard input in OS coordinates (physical pixels on Windows, points on macOS).
 * The platform modules (win.ts, mac.ts) load native libraries with koffi; they are imported only
 * when computer use actually runs, so nothing native loads on other platforms or in tests.
 */

export type Button = 'left' | 'right' | 'middle'
export interface Point {
  x: number
  y: number
}
export type Modifier = 'ctrl' | 'shift' | 'alt' | 'cmd'

export interface Input {
  move(x: number, y: number): Promise<void>
  down(button: Button): Promise<void>
  up(button: Button): Promise<void>
  /** Click `count` times where the pointer is. */
  click(button: Button, count: number): Promise<void>
  /** Press the left button at `from`, move to `to` in steps, release. */
  drag(from: Point, to: Point): Promise<void>
  /** Scroll by notches (positive dy = down, positive dx = right), at a point when given. */
  scroll(dx: number, dy: number, at?: Point): Promise<void>
  typeText(text: string): Promise<void>
  /** Press an xdotool-style combo ("ctrl+s", "Return") `repeat` times. */
  key(combo: string, repeat: number): Promise<void>
  /** Hold a combo down for a while, then let go (early when the signal aborts). */
  holdKey(combo: string, seconds: number, signal?: AbortSignal): Promise<void>
  cursor(): Promise<Point>
  /** Let go of every key and button this input still holds down. */
  releaseAll(): Promise<void>
}

/** Every input event waits at least this long after the one before. */
export const EVENT_GAP_MS = 12

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = () => {
      clearTimeout(t)
      reject(new Error('Cancelled'))
    }
    signal?.addEventListener('abort', stop, { once: true })
  })

const MOD_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  cmd: 'cmd',
  command: 'cmd',
  super: 'cmd',
  meta: 'cmd',
  win: 'cmd',
  windows: 'cmd'
}

/** Named keys the models use, by their xdotool-ish names (lower case, without _ or -). */
const NAMED: Record<string, string> = {
  return: 'return',
  enter: 'return',
  kpenter: 'return',
  escape: 'escape',
  esc: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  space: 'space',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  prior: 'pageup',
  pagedown: 'pagedown',
  next: 'pagedown',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  insert: 'insert',
  capslock: 'capslock',
  minus: '-',
  plus: '+',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  apostrophe: "'",
  grave: '`',
  bracketleft: '[',
  bracketright: ']'
}

/**
 * A key name made canonical: a named key ("return", "pagedown", "f5", "left") or one character.
 * Throws for names it doesn't know.
 */
export function canonicalKey(name: string): string {
  if (name.length === 1) return name.toLowerCase()
  const n = name.toLowerCase().replace(/[_\-\s]/g, '')
  const arrow = n.match(/^(?:arrow)?(up|down|left|right)$/)
  if (arrow) return arrow[1]
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(n)) return n
  if (NAMED[n]) return NAMED[n]
  throw new Error(`Unknown key "${name}"`)
}

/** "ctrl+shift+t" → modifiers and the main key (null when the combo is only modifiers). */
export function parseCombo(combo: string): { mods: Modifier[]; key: string | null } {
  const raw = combo.trim()
  if (!raw) throw new Error('Name a key to press, like "Return" or "ctrl+s"')
  // A trailing "+" is the plus key itself ("ctrl++").
  const parts = raw === '+' ? ['+'] : raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+')
  const mods: Modifier[] = []
  let key: string | null = null
  for (const p of parts.map((x) => x.trim())) {
    if (!p) throw new Error(`Can't read the key combo "${combo}"`)
    const mod = MOD_ALIASES[p.toLowerCase()]
    if (mod) {
      if (!mods.includes(mod)) mods.push(mod)
      continue
    }
    if (key !== null) throw new Error(`"${combo}" names more than one key; press them one after another`)
    key = canonicalKey(p)
  }
  return { mods, key }
}

/** Load the input for this platform (null where computer use isn't supported). */
export async function loadInput(platform: NodeJS.Platform = process.platform): Promise<Input | null> {
  if (platform === 'win32') return (await import('./win')).createWindowsInput()
  if (platform === 'darwin') return (await import('./mac')).createMacInput()
  return null
}

export const inputSupported = (platform: NodeJS.Platform = process.platform): boolean => platform === 'win32' || platform === 'darwin'
