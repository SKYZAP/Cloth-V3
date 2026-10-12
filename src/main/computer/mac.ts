import koffi from 'koffi'
import { screen } from 'electron'
import { EVENT_GAP_MS, parseCombo, sleep, type Button, type Input, type Modifier, type Point } from './input'

// CGEventType
const kMouseMoved = 5
const kLeftDown = 1
const kLeftUp = 2
const kRightDown = 3
const kRightUp = 4
const kLeftDragged = 6
const kRightDragged = 7
const kOtherDown = 25
const kOtherUp = 26
const kOtherDragged = 27
const kMouseEventClickState = 1
const kHIDEventTap = 0
const kScrollUnitLine = 1
/** Lines scrolled per notch (the Windows default wheel step is 3 lines). */
const LINES_PER_NOTCH = 3

const BUTTON: Record<Button, { id: number; down: number; up: number; dragged: number }> = {
  left: { id: 0, down: kLeftDown, up: kLeftUp, dragged: kLeftDragged },
  right: { id: 1, down: kRightDown, up: kRightUp, dragged: kRightDragged },
  middle: { id: 2, down: kOtherDown, up: kOtherUp, dragged: kOtherDragged }
}

const FLAG: Record<Modifier, number> = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 }
const MOD_CODE: Record<Modifier, number> = { cmd: 55, shift: 56, alt: 58, ctrl: 59 }

/** US-layout virtual key codes (Events.h). */
const KEYCODE: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, return: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42,
  ',': 43, '/': 44, n: 45, m: 46, '.': 47, tab: 48, space: 49, ' ': 49, '`': 50, backspace: 51, escape: 53,
  capslock: 57, f17: 64, f18: 79, f19: 80, f20: 90, f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101, f11: 103,
  f13: 105, f16: 106, f14: 107, f10: 109, f12: 111, f15: 113, insert: 114, home: 115, pageup: 116, delete: 117,
  f4: 118, end: 119, f2: 120, pagedown: 121, f1: 122, left: 123, right: 124, down: 125, up: 126
}
/** Characters typed with shift on a US keyboard, by the key they share. */
const SHIFTED: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`'
}

const CG = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'
const CF = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'

function bind() {
  const CGPoint = koffi.struct('CLOTH_CGPoint', { x: 'double', y: 'double' })
  const cg = koffi.load(CG)
  const cf = koffi.load(CF)
  return {
    CGEventCreateMouseEvent: cg.func('void *CGEventCreateMouseEvent(void *source, uint32_t type, CLOTH_CGPoint pos, uint32_t button)'),
    CGEventCreateKeyboardEvent: cg.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t keycode, bool down)'),
    CGEventCreateScrollWheelEvent2: cg.func('void *CGEventCreateScrollWheelEvent2(void *source, uint32_t units, uint32_t count, int32_t w1, int32_t w2, int32_t w3)'),
    CGEventSetIntegerValueField: cg.func('void CGEventSetIntegerValueField(void *ev, uint32_t field, int64_t value)'),
    CGEventSetFlags: cg.func('void CGEventSetFlags(void *ev, uint64_t flags)'),
    CGEventKeyboardSetUnicodeString: cg.func('void CGEventKeyboardSetUnicodeString(void *ev, unsigned long len, const uint16_t *str)'),
    CGEventPost: cg.func('void CGEventPost(uint32_t tap, void *ev)'),
    CFRelease: cf.func('void CFRelease(void *cf)'),
    point: CGPoint
  }
}

export function createMacInput(): Input {
  const cg = bind()
  const heldButtons = new Set<Button>()
  const heldKeys = new Map<number, number>()

  const post = async (ev: unknown) => {
    if (!ev) throw new Error('macOS refused to create the input event')
    try {
      cg.CGEventPost(kHIDEventTap, ev)
    } finally {
      cg.CFRelease(ev)
    }
    await sleep(EVENT_GAP_MS)
  }
  const cursor = async (): Promise<Point> => {
    const p = screen.getCursorScreenPoint()
    return { x: p.x, y: p.y }
  }
  const mouseEvent = (type: number, at: Point, button: number) => cg.CGEventCreateMouseEvent(null, type, { x: at.x, y: at.y }, button)

  const move = async (x: number, y: number) => {
    // With a button held the system expects "dragged" events, not plain moves.
    const held = [...heldButtons][0]
    await post(mouseEvent(held ? BUTTON[held].dragged : kMouseMoved, { x, y }, held ? BUTTON[held].id : 0))
  }
  const button = async (b: Button, down: boolean, clicks = 1) => {
    const ev = mouseEvent(down ? BUTTON[b].down : BUTTON[b].up, await cursor(), BUTTON[b].id)
    if (ev) cg.CGEventSetIntegerValueField(ev, kMouseEventClickState, clicks)
    await post(ev)
    if (down) heldButtons.add(b)
    else heldButtons.delete(b)
  }

  const codeFor = (key: string): { code: number; shift: boolean } => {
    if (KEYCODE[key] !== undefined) return { code: KEYCODE[key], shift: false }
    const base = SHIFTED[key]
    if (base) return { code: KEYCODE[base], shift: true }
    throw new Error(`There is no key for "${key}" on a US keyboard`)
  }
  const keyEvent = async (code: number, down: boolean, flags: number) => {
    const ev = cg.CGEventCreateKeyboardEvent(null, code, down)
    if (ev) cg.CGEventSetFlags(ev, flags)
    await post(ev)
    if (down) heldKeys.set(code, flags)
    else heldKeys.delete(code)
  }
  /** Press a combo's modifiers (building up the flags), then its key; returns how to let go. */
  const pressCombo = async (combo: string): Promise<() => Promise<void>> => {
    const { mods, key } = parseCombo(combo)
    const k = key ? codeFor(key) : null
    const all = k?.shift && !mods.includes('shift') ? [...mods, 'shift' as Modifier] : mods
    let flags = 0
    for (const m of all) {
      flags |= FLAG[m]
      await keyEvent(MOD_CODE[m], true, flags)
    }
    if (k) await keyEvent(k.code, true, flags)
    return async () => {
      if (k) await keyEvent(k.code, false, flags)
      for (const m of [...all].reverse()) {
        flags &= ~FLAG[m]
        await keyEvent(MOD_CODE[m], false, flags)
      }
    }
  }

  const self: Input = {
    move,
    down: (b) => button(b, true),
    up: (b) => button(b, false),
    click: async (b, count) => {
      for (let i = 1; i <= count; i++) {
        await button(b, true, i)
        await button(b, false, i)
      }
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
      // Wheel 1 is vertical (positive scrolls up), wheel 2 horizontal (positive scrolls left).
      for (let i = 0; i < Math.max(Math.abs(dx), Math.abs(dy)); i++) {
        const v = i < Math.abs(dy) ? -Math.sign(dy) * LINES_PER_NOTCH : 0
        const h = i < Math.abs(dx) ? -Math.sign(dx) * LINES_PER_NOTCH : 0
        await post(cg.CGEventCreateScrollWheelEvent2(null, kScrollUnitLine, 2, v, h, 0))
      }
    },
    typeText: async (text) => {
      for (const ch of text.replace(/\r\n?/g, '\n')) {
        if (ch === '\n') {
          await keyEvent(KEYCODE.return, true, 0)
          await keyEvent(KEYCODE.return, false, 0)
          continue
        }
        const units = Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i))
        for (const down of [true, false]) {
          const ev = cg.CGEventCreateKeyboardEvent(null, 0, down)
          if (ev) cg.CGEventKeyboardSetUnicodeString(ev, units.length, units)
          await post(ev)
        }
      }
    },
    key: async (combo, repeat) => {
      for (let i = 0; i < repeat; i++) await (await pressCombo(combo))()
    },
    holdKey: async (combo, seconds, signal) => {
      const release = await pressCombo(combo)
      try {
        await sleep(seconds * 1000, signal).catch(() => undefined)
      } finally {
        await release()
      }
    },
    cursor,
    releaseAll: async () => {
      for (const code of [...heldKeys.keys()]) await keyEvent(code, false, 0).catch(() => undefined)
      for (const b of [...heldButtons]) await button(b, false).catch(() => undefined)
    }
  }
  return self
}
