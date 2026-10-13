import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Value } from 'typebox/value'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

// The screen module captures through Electron: stand-ins for desktopCapturer and the screen.
const electron = vi.hoisted(() => ({ sources: [] as unknown[], getSources: vi.fn() }))
vi.mock('electron', () => ({
  desktopCapturer: { getSources: electron.getSources },
  screen: { getPrimaryDisplay: () => ({ id: 1 }), getAllDisplays: () => [], dipToScreenRect: (_w: unknown, r: unknown) => r }
}))

import { describeDisplay, fromOs, shotSize, toOs, capture, checkRegion, zoom, type ScreenDisplay } from '../src/main/computer/screen'
import { canonicalKey, parseCombo, type Input, type Point } from '../src/main/computer/input'
import { ComputerController, computerOffered, computerParameters, DECLINED, LIMITS, MOVED, STOPPED, type ComputerHost } from '../src/main/computer/tool'
import { pruneScreenshots, SCREENSHOT_REMOVED } from '../src/main/computer/prune'
import { ApprovalService } from '../src/main/agent/workspace'
import { makeServices } from './helpers'

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A 1440×900-point Retina MacBook screen (2880×1800 pixels). */
const retina = describeDisplay({ id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 }, true, 'darwin')
/** A 2560×1440 monitor at 150% on Windows (1707×960 DIP). */
const win150 = describeDisplay({ id: 2, bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }, true, 'win32', () => ({ x: 0, y: 0, width: 2560, height: 1440 }))
/** A 1920×1080 monitor at 100% to the right of it. */
const winRight = describeDisplay({ id: 3, bounds: { x: 1707, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }, false, 'win32', () => ({ x: 2560, y: 0, width: 1920, height: 1080 }))
/** A second Mac display above-left of the main one (negative origin). */
const macLeft = describeDisplay({ id: 4, bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, scaleFactor: 1 }, false, 'darwin')

describe('computer use: screens and coordinates', () => {
  it('sizes screenshots to at most 1280 wide and 1.15 megapixels', () => {
    expect(shotSize(1920, 1080)).toEqual({ width: 1280, height: 720 })
    expect(shotSize(1280, 800)).toEqual({ width: 1280, height: 800 })
    expect(shotSize(1024, 768)).toEqual({ width: 1024, height: 768 })
    // A tall portrait screen is limited by its pixel count, not its width.
    const tall = shotSize(1080, 1920)
    expect(tall.width * tall.height).toBeLessThanOrEqual(1.15e6 + 2000)
    expect(tall.width).toBeLessThan(1080)
  })

  it('maps Retina screenshots to points', () => {
    expect(retina.pixels).toEqual({ width: 2880, height: 1800 })
    expect(retina.shot).toEqual({ width: 1280, height: 800 })
    expect(toOs(retina, [640, 400])).toEqual({ x: 720, y: 450 })
    expect(toOs(retina, [0, 0])).toEqual({ x: 0, y: 0 })
    expect(toOs(retina, [1279, 799])).toEqual({ x: 1439, y: 899 })
  })

  it('maps 150% DPI Windows screenshots to physical pixels', () => {
    expect(win150.os).toEqual({ x: 0, y: 0, width: 2560, height: 1440 })
    expect(win150.shot).toEqual({ width: 1280, height: 720 })
    expect(toOs(win150, [640, 360])).toEqual({ x: 1280, y: 720 })
    expect(toOs(win150, [1279, 719])).toEqual({ x: 2558, y: 1438 })
  })

  it('offsets to the right display on multi-monitor setups', () => {
    expect(toOs(winRight, [0, 0])).toEqual({ x: 2560, y: 0 })
    expect(toOs(winRight, [640, 360])).toEqual({ x: 2560 + 960, y: 540 })
    expect(toOs(macLeft, [640, 360])).toEqual({ x: -1920 + 960, y: -200 + 540 })
  })

  it('refuses points outside the screenshot with a message', () => {
    expect(toOs(retina, [1280, 10])).toMatch(/outside the screen.*1280×800/)
    expect(toOs(retina, [-1, 10])).toMatch(/outside/)
    expect(toOs(retina, [Number.NaN, 1])).toMatch(/two numbers/)
  })

  it('maps the cursor back into screenshot coordinates', () => {
    expect(fromOs(win150, { x: 1280, y: 720 })).toEqual([640, 360])
    expect(fromOs(win150, { x: 3000, y: 10 })).toBeNull()
    expect(fromOs(winRight, { x: 3000, y: 15 })).toEqual([293, 10])
    expect(fromOs(retina, { x: 720, y: 450 })).toEqual([640, 400])
  })

  it('checks zoom regions', () => {
    expect(checkRegion(retina, [0, 0, 100, 100])).toBeNull()
    expect(checkRegion(retina, [0, 0, 2000, 100])).toMatch(/inside/)
    expect(checkRegion(retina, [50, 50, 50, 60])).toMatch(/at least/)
  })
})

// ─── Screenshots (desktopCapturer stand-in) ──────────────────────────────────

function fakeImage(width: number, height: number, pngBytes = 1000): any {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(pngBytes, 1),
    toJPEG: () => Buffer.from('jpeg'),
    resize: vi.fn((o: { width: number; height?: number }) => fakeImage(o.width, o.height ?? Math.round((height * o.width) / width))),
    crop: vi.fn((r: { width: number; height: number }) => fakeImage(r.width, r.height))
  }
}

describe('computer use: screenshots', () => {
  beforeEach(() => electron.getSources.mockReset())

  it('captures the matching display at the model size', async () => {
    electron.getSources.mockResolvedValue([
      { display_id: '9', thumbnail: fakeImage(10, 10) },
      { display_id: '1', thumbnail: fakeImage(1280, 800) }
    ])
    const shot = await capture(retina)
    expect(electron.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 1280, height: 800 } })
    expect(shot).toMatchObject({ width: 1280, height: 800, mimeType: 'image/png' })
    expect(shot.thumbnail).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('makes the size exact and switches to JPEG above 1 MB', async () => {
    electron.getSources.mockResolvedValue([{ display_id: '1', thumbnail: fakeImage(1279, 800, 2 * 1024 * 1024) }])
    const shot = await capture(retina)
    expect(shot.width).toBe(1280)
    expect(shot.mimeType).toBe('image/png')
    electron.getSources.mockResolvedValue([{ display_id: '1', thumbnail: { ...fakeImage(1280, 800, 2 * 1024 * 1024), resize: () => fakeImage(320, 200) } }])
    expect((await capture(retina)).mimeType).toBe('image/jpeg')
  })

  it('zooms by cropping a full-resolution capture', async () => {
    const full = fakeImage(2880, 1800)
    electron.getSources.mockResolvedValue([{ display_id: '1', thumbnail: full }])
    const shot = await zoom(retina, [0, 0, 640, 400])
    expect(electron.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 2880, height: 1800 } })
    expect(full.crop).toHaveBeenCalledWith({ x: 0, y: 0, width: 1440, height: 900 })
    expect(shot.width).toBeLessThanOrEqual(1280)
  })
})

// ─── Keys ────────────────────────────────────────────────────────────────────

describe('computer use: key names', () => {
  it('reads xdotool-style combos', () => {
    expect(parseCombo('ctrl+s')).toEqual({ mods: ['ctrl'], key: 's' })
    expect(parseCombo('cmd+shift+t')).toEqual({ mods: ['cmd', 'shift'], key: 't' })
    expect(parseCombo('Return')).toEqual({ mods: [], key: 'return' })
    expect(parseCombo('Page_Down')).toEqual({ mods: [], key: 'pagedown' })
    expect(parseCombo('ctrl++')).toEqual({ mods: ['ctrl'], key: '+' })
    expect(canonicalKey('F5')).toBe('f5')
    expect(canonicalKey('Left')).toBe('left')
    expect(canonicalKey('Escape')).toBe('escape')
    expect(() => parseCombo('ctrl+bogus')).toThrow(/Unknown key/)
    expect(() => parseCombo('a+b')).toThrow(/more than one key/)
  })
})

// ─── Schema ──────────────────────────────────────────────────────────────────

describe('computer use: schema', () => {
  const ok = (v: unknown) => Value.Check(computerParameters, v)
  it('accepts well-formed calls', () => {
    expect(ok({ action: 'screenshot' })).toBe(true)
    expect(ok({ action: 'left_click', coordinate: [10, 20] })).toBe(true)
    expect(ok({ action: 'scroll', coordinate: [1, 2], scroll_direction: 'down', scroll_amount: 5 })).toBe(true)
    expect(ok({ action: 'zoom', region: [0, 0, 100, 100] })).toBe(true)
    expect(ok({ action: 'key', text: 'ctrl+s', repeat: 3 })).toBe(true)
  })
  it('rejects malformed calls', () => {
    expect(ok({ action: 'explode' })).toBe(false)
    expect(ok({ action: 'left_click', coordinate: [1, 2, 3] })).toBe(false)
    expect(ok({ action: 'left_click', coordinate: [1.5, 2] })).toBe(false)
    expect(ok({ action: 'scroll', scroll_amount: 21 })).toBe(false)
    expect(ok({ action: 'key', repeat: 0 })).toBe(false)
    expect(ok({ action: 'wait', duration: 11 })).toBe(false)
    expect(ok({ action: 'zoom', region: [0, 0, 1] })).toBe(false)
  })
})

// ─── The tool, with a fake input and host ────────────────────────────────────

type Call = [string, ...unknown[]]

function fakeInput(calls: Call[]) {
  let cursor: Point = { x: 0, y: 0 }
  const input: Input & { nudge(p: Point): void } = {
    nudge: (p) => (cursor = p),
    move: async (x, y) => {
      calls.push(['move', x, y])
      cursor = { x, y }
    },
    down: async (b) => void calls.push(['down', b]),
    up: async (b) => void calls.push(['up', b]),
    click: async (b, n) => void calls.push(['click', b, n]),
    drag: async (from, to) => {
      calls.push(['drag', from, to])
      cursor = to
    },
    scroll: async (dx, dy, at) => {
      calls.push(['scroll', dx, dy, at])
      if (at) cursor = at
    },
    typeText: async (t) => void calls.push(['type', t]),
    key: async (c, r) => void calls.push(['key', c, r]),
    holdKey: async (c, s) => void calls.push(['hold', c, s]),
    cursor: async () => cursor,
    releaseAll: async () => void calls.push(['releaseAll'])
  }
  return input
}

function setup(opts: { consent?: 'granted' | 'approve' | 'decline' | null; host?: Partial<ComputerHost>; displays?: ScreenDisplay[] } = {}) {
  const calls: Call[] = []
  const input = fakeInput(calls)
  let clock = 1_000_000
  const sleeps: number[] = []
  const hostCalls: string[] = []
  const host: ComputerHost = {
    permissions: async () => null,
    begin: async () => void hostCalls.push('begin'),
    end: () => void hostCalls.push('end'),
    clothWindowAt: () => false,
    clothFocused: () => false,
    stopKeys: () => 'Ctrl+Alt+Esc',
    ...opts.host
  }
  const controller = new ComputerController({
    platform: 'win32',
    input: async () => input,
    displays: () => opts.displays ?? [win150, winRight],
    capture: async (d) => ({ data: 'AAAA', mimeType: 'image/png', width: d.shot.width, height: d.shot.height, thumbnail: 'data:image/jpeg;base64,AA' }),
    zoom: async () => ({ data: 'BBBB', mimeType: 'image/png', width: 640, height: 400, thumbnail: 'data:image/jpeg;base64,BB' }),
    host,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    }
  })
  let granted = opts.consent === 'granted'
  const asked: string[] = []
  const stopped: string[] = []
  const tool = controller.tool({
    owner: 'chat_1',
    consent:
      opts.consent === null
        ? null
        : {
            granted: () => granted,
            ask: async (_id, text) => {
              asked.push(text)
              if (opts.consent === 'decline') return false
              granted = true
              return true
            }
          },
    onStop: () => void stopped.push('stop')
  })
  const run = (params: Record<string, unknown>) => tool.execute('call_1', params as never)
  return { controller, tool, run, calls, input, sleeps, hostCalls, asked, stopped, advance: (ms: number) => (clock += ms) }
}

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const hasImage = (r: { content: { type: string }[] }) => r.content.some((c) => c.type === 'image')

describe('computer use: actions', () => {
  it('turns actions into input calls in OS coordinates', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'left_click', coordinate: [640, 360] })
    await t.run({ action: 'double_click', coordinate: [10, 10] })
    await t.run({ action: 'triple_click' })
    await t.run({ action: 'right_click', coordinate: [0, 0] })
    await t.run({ action: 'middle_click', coordinate: [0, 0] })
    expect(t.calls).toEqual([
      ['move', 1280, 720],
      ['click', 'left', 1],
      ['move', 20, 20],
      ['click', 'left', 2],
      ['click', 'left', 3],
      ['move', 0, 0],
      ['click', 'right', 1],
      ['move', 0, 0],
      ['click', 'middle', 1]
    ])
  })

  it('drags, scrolls, types and presses keys', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'left_click_drag', start_coordinate: [0, 0], coordinate: [100, 50] })
    await t.run({ action: 'scroll', coordinate: [100, 50], scroll_direction: 'down', scroll_amount: 5 })
    await t.run({ action: 'scroll', scroll_direction: 'left' })
    await t.run({ action: 'key', text: 'ctrl+s', repeat: 2 })
    await t.run({ action: 'hold_key', text: 'shift', duration: 1 })
    await t.run({ action: 'left_mouse_down', coordinate: [1, 1] })
    await t.run({ action: 'left_mouse_up' })
    expect(t.calls).toEqual([
      ['drag', { x: 0, y: 0 }, { x: 200, y: 100 }],
      ['scroll', 0, 5, { x: 200, y: 100 }],
      ['scroll', -3, 0, undefined],
      ['key', 'ctrl+s', 2],
      ['hold', 'shift', 1],
      ['move', 2, 2],
      ['down', 'left'],
      ['up', 'left']
    ])
  })

  it('types long text in chunks', async () => {
    const t = setup({ consent: 'granted' })
    const text = 'x'.repeat(120)
    const r = await t.run({ action: 'type', text })
    expect(t.calls.filter((c) => c[0] === 'type').map((c) => (c[1] as string).length)).toEqual([50, 50, 20])
    expect(textOf(r)).toMatch(/Typed 120 characters/)
    await expect(t.run({ action: 'type', text: 'y'.repeat(LIMITS.typeChars + 1) })).rejects.toThrow(/at most 2000/)
  })

  it('returns a fresh screenshot after screen-changing actions, text for cursor_position', async () => {
    const t = setup({ consent: 'granted' })
    const click = await t.run({ action: 'left_click', coordinate: [5, 5] })
    expect(hasImage(click)).toBe(true)
    expect(click.details).toMatchObject({ action: 'left_click', coordinate: [5, 5], display: 0, thumbnail: expect.stringMatching(/^data:image/) })
    expect(t.sleeps).toContain(LIMITS.settleMs)
    const shot = await t.run({ action: 'screenshot' })
    expect(hasImage(shot)).toBe(true)
    const zoomed = await t.run({ action: 'zoom', region: [0, 0, 100, 100] })
    expect(textOf(zoomed)).toMatch(/Zoomed into/)
    const pos = await t.run({ action: 'cursor_position' })
    expect(hasImage(pos)).toBe(false)
    expect(textOf(pos)).toBe('The cursor is at [5, 5].')
  })

  it('reports bad arguments to the model without acting', async () => {
    const t = setup({ consent: 'granted' })
    await expect(t.run({ action: 'left_click', coordinate: [5000, 5] })).rejects.toThrow(/outside the screen/)
    await expect(t.run({ action: 'mouse_move' })).rejects.toThrow(/needs coordinate/)
    await expect(t.run({ action: 'key' })).rejects.toThrow(/needs text/)
    await expect(t.run({ action: 'key', text: 'ctrl+nope' })).rejects.toThrow(/Unknown key/)
    await expect(t.run({ action: 'scroll' })).rejects.toThrow(/scroll_direction/)
    await expect(t.run({ action: 'zoom', region: [0, 0, 9999, 10] })).rejects.toThrow(/inside/)
    await expect(t.run({ action: 'screenshot', display: 5 })).rejects.toThrow(/no display 5/)
    expect(t.calls).toEqual([])
  })

  it('switches the active display and keeps it for the chat', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'left_click', coordinate: [0, 0], display: 1 })
    expect(t.calls[0]).toEqual(['move', 2560, 0])
    await t.run({ action: 'left_click', coordinate: [0, 0] })
    expect(t.calls[2]).toEqual(['move', 2560, 0])
    expect(t.tool.description).toMatch(/0: 1280×720 screenshots \(primary\)/)
    expect(t.controller.describe('chat_1')).toMatch(/the active one is 1/)
  })

  it('names the OS and its shortcut key in the description', () => {
    const t = setup()
    expect(t.tool.description).toMatch(/Windows: use ctrl/)
    const mac = new ComputerController({ platform: 'darwin', input: async () => fakeInput([]), displays: () => [retina], capture: async () => { throw new Error() }, zoom: async () => { throw new Error() }, host: {} as ComputerHost })
    expect(mac.describe()).toMatch(/macOS: use cmd/)
  })
})

describe('computer use: limits', () => {
  it('keeps at least 150 ms between actions', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'cursor_position' })
    t.sleeps.length = 0
    await t.run({ action: 'cursor_position' })
    expect(t.sleeps[0]).toBe(LIMITS.minGapMs)
  })

  it('allows 60 actions a minute and then waits', async () => {
    const t = setup({ consent: 'granted' })
    for (let i = 0; i < 60; i++) await t.run({ action: 'cursor_position' })
    expect(t.sleeps.some((ms) => ms > 1000)).toBe(false)
    await t.run({ action: 'cursor_position' })
    expect(Math.max(...t.sleeps)).toBeGreaterThan(50_000)
  })

  it('stops after 300 actions in a run', async () => {
    const t = setup({ consent: 'granted' })
    for (let i = 0; i < LIMITS.perRun; i++) await t.run({ action: 'cursor_position' })
    await expect(t.run({ action: 'cursor_position' })).rejects.toThrow(/all 300 computer actions/)
  })

  it('caps waits at 10 seconds', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'wait', duration: 10 })
    expect(t.sleeps).toContain(10_000)
  })
})

describe('computer use: safety', () => {
  it('pauses when the user moves the mouse', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'left_click', coordinate: [100, 100] })
    t.input.nudge({ x: 200 + 30, y: 200 })
    await expect(t.run({ action: 'left_click', coordinate: [100, 100] })).rejects.toThrow(MOVED)
    expect(t.hostCalls).toEqual(['begin', 'end'])
    expect(t.calls.at(-1)).toEqual(['releaseAll'])
    // Paused for the rest of the run.
    await expect(t.run({ action: 'screenshot' })).rejects.toThrow(/paused/)
  })

  it('ignores small jitter within 8 px', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'left_click', coordinate: [100, 100] })
    t.input.nudge({ x: 205, y: 203 })
    await expect(t.run({ action: 'left_click', coordinate: [100, 100] })).resolves.toBeTruthy()
  })

  it("refuses pointer actions on Cloth's windows and typing while Cloth has focus", async () => {
    const t = setup({ consent: 'granted', host: { clothWindowAt: (p) => p.x < 100, clothFocused: () => true } })
    await expect(t.run({ action: 'left_click', coordinate: [10, 10] })).rejects.toThrow(/Cloth's own window/)
    await expect(t.run({ action: 'type', text: 'hi' })).rejects.toThrow(/keyboard focus/)
    await expect(t.run({ action: 'key', text: 'Return' })).rejects.toThrow(/keyboard focus/)
    await t.run({ action: 'left_click', coordinate: [500, 10] })
    expect(t.calls.filter((c) => c[0] === 'click')).toHaveLength(1)
  })

  it('steps aside once and gives the computer back on release', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'screenshot' })
    await t.run({ action: 'screenshot' })
    expect(t.hostCalls).toEqual(['begin'])
    expect(t.controller.current).toBe('chat_1')
    await t.controller.release('chat_1')
    expect(t.hostCalls).toEqual(['begin', 'end'])
    expect(t.controller.current).toBeNull()
  })

  it('the stop shortcut ends the run and refuses further actions', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'screenshot' })
    t.controller.stop()
    expect(t.stopped).toEqual(['stop'])
    await expect(t.run({ action: 'screenshot' })).rejects.toThrow(STOPPED)
  })

  it('lets one chat use the computer at a time', async () => {
    const t = setup({ consent: 'granted' })
    await t.run({ action: 'screenshot' })
    const other = t.controller.tool({ owner: 'chat_2', consent: { granted: () => true, ask: async () => true } })
    await expect(other.execute('c', { action: 'screenshot' } as never)).rejects.toThrow(/Another chat/)
  })

  it('reports missing OS permissions', async () => {
    const t = setup({ consent: 'granted', host: { permissions: async () => 'Cloth does not have Screen Recording permission' } })
    await expect(t.run({ action: 'screenshot' })).rejects.toThrow(/Screen Recording/)
    expect(t.hostCalls).toEqual([])
  })
})

describe('computer use: consent', () => {
  it('asks once, and acts after the user allows it', async () => {
    const t = setup({ consent: 'approve' })
    await t.run({ action: 'screenshot' })
    await t.run({ action: 'screenshot' })
    expect(t.asked).toHaveLength(1)
    expect(t.asked[0]).toBe('Let Cloth use this computer for this chat? It minimises itself while it works and stops when you press Ctrl+Alt+Esc.')
  })

  it('declined: the tool says so and touches nothing', async () => {
    const t = setup({ consent: 'decline' })
    const r = await t.run({ action: 'left_click', coordinate: [1, 1] })
    expect(textOf(r)).toBe(DECLINED)
    expect(t.calls).toEqual([])
    expect(t.hostCalls).toEqual([])
  })

  it('refuses to start where nobody can allow it', async () => {
    const t = setup({ consent: null })
    await expect(t.run({ action: 'screenshot' })).rejects.toThrow(/needs someone to allow it/)
  })

  it('goes through the approval card, and the chat remembers the answer', async () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.providers.setModels(provider.id, [{ id: 'vis', name: 'vis', contextWindow: 32000, maxTokens: 4096, reasoning: false, vision: true, embedding: false }])
    const session = services.chat.create({ model: { providerId: provider.id, modelId: 'vis' }, computerUse: true })
    const t = setup()
    services.runtime.attachComputer(t.controller)
    const agent = services.runtime.createAgent({ model: session.model!, scope: (services.chat as any).scope(session.id), systemPrompt: '' })
    const tool = agent.state.tools.find((x) => x.name === 'computer')!
    expect(tool).toBeTruthy()
    const first = tool.execute('call_a', { action: 'screenshot' } as never)
    await new Promise((r) => setTimeout(r, 0))
    const [pending] = services.chat.pendingApprovals(session.id)
    expect(pending).toMatchObject({ kind: 'computer', toolCallId: 'call_a' })
    expect(pending.command).toMatch(/^Let Cloth use this computer for this chat\?/)
    services.chat.resolveApproval(pending.id, 'allow')
    expect(hasImage(await first)).toBe(true)
    expect(services.chat.get(session.id).computerConsent).toBe(true)
    // Switching it off takes the consent back.
    services.chat.update(session.id, { computerUse: false })
    expect(services.chat.get(session.id).computerConsent).toBe(false)
  })

  it('a declined card returns the decline to the model', async () => {
    const approvals = new ApprovalService(() => undefined)
    const t = setup()
    const tool = t.controller.tool({
      owner: 's1',
      consent: { granted: () => false, ask: async (id, text, signal) => (await approvals.request({ sessionId: 's1', toolCallId: id, kind: 'computer', command: text }, signal)) !== 'deny' }
    })
    const pending = tool.execute('c1', { action: 'screenshot' } as never)
    await new Promise((r) => setTimeout(r, 0))
    approvals.resolve(approvals.list('s1')[0].id, 'deny')
    expect(textOf(await pending)).toBe(DECLINED)
  })
})

// ─── Offering the tool ───────────────────────────────────────────────────────

describe('computer use: when the tool is offered', () => {
  it('only with the switch on, on a model that sees images, at the top level', () => {
    expect(computerOffered({ computerUse: true, depth: 0 }, ['text', 'image'], true)).toBe(true)
    expect(computerOffered({ computerUse: true }, ['text'], true)).toBe(false)
    expect(computerOffered({ computerUse: false }, ['text', 'image'], true)).toBe(false)
    expect(computerOffered({ computerUse: true, depth: 1 }, ['text', 'image'], true)).toBe(false)
    expect(computerOffered({ computerUse: true }, ['text', 'image'], false)).toBe(false)
  })

  it('chats get it only with the switch on and a vision model', () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    const model = (vision: boolean) => ({ id: vision ? 'vis' : 'txt', name: 'm', contextWindow: 32000, maxTokens: 4096, reasoning: false, vision, embedding: false })
    services.providers.setModels(provider.id, [model(true), model(false)])
    services.runtime.attachComputer(setup().controller)
    const names = (modelId: string, computerUse: boolean, depth = 0) => {
      const session = services.chat.create({ model: { providerId: provider.id, modelId }, computerUse })
      const scope = { ...(services.chat as any).scope(session.id), depth }
      return services.runtime.createAgent({ model: session.model!, scope, systemPrompt: '' }).state.tools.map((x) => x.name)
    }
    expect(names('vis', true)).toContain('computer')
    expect(names('vis', false)).not.toContain('computer')
    expect(names('txt', true)).not.toContain('computer')
    expect(names('vis', true, 1)).not.toContain('computer')
    // New chats start with it off.
    expect(services.chat.create({}).computerUse).toBe(false)
  })

  it('Plan mode offers no computer', () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.providers.setModels(provider.id, [{ id: 'vis', name: 'vis', contextWindow: 32000, maxTokens: 4096, reasoning: false, vision: true, embedding: false }])
    services.runtime.attachComputer(setup().controller)
    const names = (permissions: 'auto' | 'manual' | 'plan') => {
      const session = services.chat.create({ model: { providerId: provider.id, modelId: 'vis' }, computerUse: true, permissions })
      return services.runtime.createAgent({ model: session.model!, scope: (services.chat as any).scope(session.id), systemPrompt: '' }).state.tools.map((x) => x.name)
    }
    expect(names('auto')).toContain('computer')
    expect(names('manual')).toContain('computer')
    expect(names('plan')).not.toContain('computer')
  })

  it('without a computer (other platforms, tests) it is never offered', () => {
    const { services } = makeServices()
    const provider = services.providers.create({ name: 'faux', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' })
    services.providers.setModels(provider.id, [{ id: 'vis', name: 'vis', contextWindow: 32000, maxTokens: 4096, reasoning: false, vision: true, embedding: false }])
    const session = services.chat.create({ model: { providerId: provider.id, modelId: 'vis' }, computerUse: true })
    const tools = services.runtime.createAgent({ model: session.model!, scope: (services.chat as any).scope(session.id), systemPrompt: '' }).state.tools
    expect(tools.map((x) => x.name)).not.toContain('computer')
  })
})

// ─── Screenshot pruning ──────────────────────────────────────────────────────

describe('computer use: screenshot pruning', () => {
  const shot = (n: number): AgentMessage =>
    ({ role: 'toolResult', toolCallId: `c${n}`, toolName: 'computer', content: [{ type: 'text', text: `step ${n}` }, { type: 'image', data: `img${n}`, mimeType: 'image/png' }], isError: false, timestamp: n }) as AgentMessage
  const other: AgentMessage = { role: 'toolResult', toolCallId: 'x', toolName: 'read', content: [{ type: 'image', data: 'keep', mimeType: 'image/png' }], isError: false, timestamp: 0 } as AgentMessage

  it('keeps the last three computer screenshots', () => {
    const history = [other, shot(1), shot(2), shot(3), shot(4), shot(5)]
    const pruned = pruneScreenshots(history)
    const images = pruned.map((m) => (m.role === 'toolResult' ? m.content.find((c) => c.type === 'image') : undefined))
    expect(images.map((i) => (i && 'data' in i ? i.data : null))).toEqual(['keep', null, null, 'img3', 'img4', 'img5'])
    const second = pruned[2]
    expect(second.role === 'toolResult' && second.content).toEqual([{ type: 'text', text: 'step 2' }, { type: 'text', text: SCREENSHOT_REMOVED }])
    // The original history is untouched.
    expect(history[1].role === 'toolResult' && history[1].content[1].type).toBe('image')
  })

  it('leaves short histories alone', () => {
    const history = [shot(1), shot(2)]
    expect(pruneScreenshots(history)).toBe(history)
  })
})
