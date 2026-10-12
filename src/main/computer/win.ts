import koffi from 'koffi'
import { EVENT_GAP_MS, parseCombo, sleep, type Button, type Input, type Modifier, type Point } from './input'

// SendInput constants (winuser.h).
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x1000
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const MOUSEEVENTF_ABSOLUTE = 0x8000
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004
const WHEEL_DELTA = 120
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

const BUTTON_FLAGS: Record<Button, [down: number, up: number]> = {
  left: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP],
  right: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP],
  middle: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP]
}

const MOD_VK: Record<Modifier, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12, cmd: 0x5b }
/** Virtual-key codes for named keys, and whether each is an extended key. */
const NAMED_VK: Record<string, [vk: number, extended: boolean]> = {
  return: [0x0d, false],
  escape: [0x1b, false],
  tab: [0x09, false],
  backspace: [0x08, false],
  space: [0x20, false],
  capslock: [0x14, false],
  delete: [0x2e, true],
  insert: [0x2d, true],
  home: [0x24, true],
  end: [0x23, true],
  pageup: [0x21, true],
  pagedown: [0x22, true],
  left: [0x25, true],
  up: [0x26, true],
  right: [0x27, true],
  down: [0x28, true]
}
const EXTENDED_VK = new Set([0x5b, ...Object.values(NAMED_VK).filter(([, e]) => e).map(([vk]) => vk)])

type Raw = { type: number; u: { mi?: Record<string, number>; ki?: Record<string, number> } }

/** Win32 calls through koffi (user32, __stdcall). */
function bind() {
  const MOUSEINPUT = koffi.struct('CLOTH_MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' })
  const KEYBDINPUT = koffi.struct('CLOTH_KEYBDINPUT', { wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t' })
  const HARDWAREINPUT = koffi.struct('CLOTH_HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' })
  const INPUT = koffi.struct('CLOTH_INPUT', { type: 'uint32_t', u: koffi.union('CLOTH_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }) })
  const POINT = koffi.struct('CLOTH_POINT', { x: 'long', y: 'long' })
  const size = koffi.sizeof(INPUT)
  if (size !== (process.arch === 'ia32' ? 28 : 40)) throw new Error(`Unexpected INPUT size ${size}`)
  const user32 = koffi.load('user32.dll')
  return {
    size,
    SendInput: user32.func('__stdcall', 'SendInput', 'uint32_t', ['uint32_t', koffi.pointer(INPUT), 'int']),
    SetCursorPos: user32.func('__stdcall', 'SetCursorPos', 'bool', ['int', 'int']),
    GetCursorPos: user32.func('__stdcall', 'GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))]),
    GetSystemMetrics: user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']),
    VkKeyScanW: user32.func('__stdcall', 'VkKeyScanW', 'int16_t', ['uint16_t'])
  }
}

const mouse = (dwFlags: number, dx = 0, dy = 0, mouseData = 0): Raw => ({ type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData: mouseData >>> 0, dwFlags, time: 0, dwExtraInfo: 0 } } })
const keyEvent = (vk: number, up: boolean, extra = 0): Raw => ({
  type: INPUT_KEYBOARD,
  u: { ki: { wVk: vk, wScan: 0, dwFlags: (up ? KEYEVENTF_KEYUP : 0) | (EXTENDED_VK.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0) | extra, time: 0, dwExtraInfo: 0 } }
})
const unicode = (unit: number, up: boolean): Raw => ({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } } })

export function createWindowsInput(): Input {
  const w = bind()
  const heldButtons = new Set<Button>()
  const heldKeys = new Set<number>()

  const send = async (inputs: Raw[]) => {
    if (!inputs.length) return
    const sent = w.SendInput(inputs.length, inputs, w.size)
    for (const i of inputs) {
      const ki = i.u.ki
      if (i.type === INPUT_KEYBOARD && ki && ki.wVk) {
        if (ki.dwFlags & KEYEVENTF_KEYUP) heldKeys.delete(ki.wVk)
        else heldKeys.add(ki.wVk)
      }
    }
    await sleep(EVENT_GAP_MS)
    // Windows refuses input aimed at a window running as administrator (UIPI).
    if (sent !== inputs.length) throw new Error('Windows blocked the input. The window in front may be running as administrator.')
  }

  const vkFor = (key: string): { vk: number; shift: boolean } => {
    if (NAMED_VK[key]) return { vk: NAMED_VK[key][0], shift: false }
    const f = key.match(/^f(\d+)$/)
    if (f) return { vk: 0x70 + Number(f[1]) - 1, shift: false }
    if (/^[a-z]$/.test(key)) return { vk: key.toUpperCase().charCodeAt(0), shift: false }
    if (/^[0-9]$/.test(key)) return { vk: key.charCodeAt(0), shift: false }
    const scan = w.VkKeyScanW(key.charCodeAt(0))
    if (scan === -1) throw new Error(`There is no key for "${key}" on this keyboard layout`)
    return { vk: scan & 0xff, shift: ((scan >> 8) & 1) === 1 }
  }

  /** The key-down events of a combo (modifiers first) and its key-up events (in reverse). */
  const comboEvents = (combo: string): { downs: Raw[]; ups: Raw[] } => {
    const { mods, key } = parseCombo(combo)
    const vks = mods.map((m) => MOD_VK[m])
    if (key) {
      const { vk, shift } = vkFor(key)
      if (shift && !vks.includes(MOD_VK.shift)) vks.push(MOD_VK.shift)
      vks.push(vk)
    }
    return { downs: vks.map((vk) => keyEvent(vk, false)), ups: [...vks].reverse().map((vk) => keyEvent(vk, true)) }
  }

  const absolute = (x: number, y: number) => {
    const vx = w.GetSystemMetrics(SM_XVIRTUALSCREEN)
    const vy = w.GetSystemMetrics(SM_YVIRTUALSCREEN)
    const vw = Math.max(2, w.GetSystemMetrics(SM_CXVIRTUALSCREEN))
    const vh = Math.max(2, w.GetSystemMetrics(SM_CYVIRTUALSCREEN))
    return [Math.round(((x - vx) * 65535) / (vw - 1)), Math.round(((y - vy) * 65535) / (vh - 1))] as const
  }

  const move = async (x: number, y: number) => {
    const [nx, ny] = absolute(x, y)
    await send([mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny)])
    // The normalised move can round a pixel off: land exactly.
    w.SetCursorPos(Math.round(x), Math.round(y))
  }

  const self: Input = {
    move,
    down: async (button) => {
      await send([mouse(BUTTON_FLAGS[button][0])])
      heldButtons.add(button)
    },
    up: async (button) => {
      await send([mouse(BUTTON_FLAGS[button][1])])
      heldButtons.delete(button)
    },
    click: async (button, count) => {
      const [down, up] = BUTTON_FLAGS[button]
      const events: Raw[] = []
      for (let i = 0; i < count; i++) events.push(mouse(down), mouse(up))
      await send(events)
    },
    drag: async (from, to) => {
      await move(from.x, from.y)
      await self.down('left')
      try {
        const steps = 15
        for (let i = 1; i <= steps; i++) await move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
      } finally {
        await self.up('left')
      }
    },
    scroll: async (dx, dy, at) => {
      if (at) await move(at.x, at.y)
      // Wheel: positive is away from the user (up); horizontal: positive is right.
      if (dy) await send([mouse(MOUSEEVENTF_WHEEL, 0, 0, -dy * WHEEL_DELTA)])
      if (dx) await send([mouse(MOUSEEVENTF_HWHEEL, 0, 0, dx * WHEEL_DELTA)])
    },
    typeText: async (text) => {
      const units: Raw[] = []
      for (const ch of text.replace(/\r\n?/g, '\n')) {
        if (ch === '\n') {
          units.push(keyEvent(NAMED_VK.return[0], false), keyEvent(NAMED_VK.return[0], true))
          continue
        }
        // One down/up per UTF-16 unit (a surrogate pair is two units).
        for (let i = 0; i < ch.length; i++) units.push(unicode(ch.charCodeAt(i), false), unicode(ch.charCodeAt(i), true))
      }
      // A few characters per call keeps each SendInput short.
      for (let i = 0; i < units.length; i += 16) await send(units.slice(i, i + 16))
    },
    key: async (combo, repeat) => {
      const { downs, ups } = comboEvents(combo)
      for (let i = 0; i < repeat; i++) await send([...downs, ...ups])
    },
    holdKey: async (combo, seconds, signal) => {
      const { downs, ups } = comboEvents(combo)
      await send(downs)
      try {
        await sleep(seconds * 1000, signal).catch(() => undefined)
      } finally {
        await send(ups)
      }
    },
    cursor: async () => {
      const p = { x: 0, y: 0 }
      w.GetCursorPos(p)
      return { x: p.x, y: p.y } satisfies Point
    },
    releaseAll: async () => {
      const ups: Raw[] = [...heldKeys].map((vk) => keyEvent(vk, true))
      for (const b of heldButtons) ups.push(mouse(BUTTON_FLAGS[b][1]))
      heldButtons.clear()
      if (ups.length) await send(ups).catch(() => undefined)
      heldKeys.clear()
    }
  }
  return self
}
