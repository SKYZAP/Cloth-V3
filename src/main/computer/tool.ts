import { Type, type Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { parseCombo, sleep as realSleep, type Input, type Point } from './input'
import { checkRegion, fromOs, toOs, type ScreenDisplay } from './coords'
import type { Shot } from './screen'

export const ACTIONS = [
  'screenshot',
  'zoom',
  'mouse_move',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'left_mouse_down',
  'left_mouse_up',
  'scroll',
  'type',
  'key',
  'hold_key',
  'cursor_position',
  'wait'
] as const
export type ComputerAction = (typeof ACTIONS)[number]

const coordinate = (description: string) => Type.Array(Type.Integer(), { minItems: 2, maxItems: 2, description })

export const computerParameters = Type.Object({
  action: Type.Union(
    ACTIONS.map((a) => Type.Literal(a)),
    { description: 'What to do' }
  ),
  coordinate: Type.Optional(coordinate('[x, y] in screenshot pixels: where to click, move, scroll or end a drag')),
  start_coordinate: Type.Optional(coordinate('[x, y] where a left_click_drag starts')),
  text: Type.Optional(Type.String({ description: 'For type: the text. For key and hold_key: a key or combo like "Return", "ctrl+s", "cmd+shift+t", "Page_Down", "F5"' })),
  scroll_direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')])),
  scroll_amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Wheel notches to scroll (default 3)' })),
  repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'How many times to press the key (default 1)' })),
  duration: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: 'Seconds, for wait and hold_key' })),
  region: Type.Optional(Type.Array(Type.Integer(), { minItems: 4, maxItems: 4, description: 'For zoom: [x0, y0, x1, y1] in screenshot pixels' })),
  display: Type.Optional(Type.Integer({ minimum: 0, description: 'Switch to this display (by its number) before acting' }))
})
export type ComputerParams = Omit<Static<typeof computerParameters>, 'action'> & { action: ComputerAction }

/** Limits on what one run may do. */
export const LIMITS = {
  minGapMs: 150,
  perMinute: 60,
  perRun: 300,
  typeChars: 2000,
  typeChunk: 50,
  waitSeconds: 10,
  settleMs: 500,
  failsafePx: 8
}

export const DECLINED = 'The user declined computer use.'
export const MOVED = 'The user moved the mouse; computer use paused.'
export const STOPPED = 'The user stopped computer use.'

/** Everything outside this module computer use needs: the screen, Cloth's windows and the OS. */
export interface ComputerHost {
  /** Missing OS permissions as a message for the model (null when all is well). */
  permissions(): Promise<string | null>
  /** Step aside: minimise Cloth, show the banner on the display, listen for the stop shortcut. */
  begin(display: ScreenDisplay, onStop: () => void): Promise<void>
  /** Bring Cloth back, hide the banner and stop listening for the shortcut. */
  end(): void
  /** A visible Cloth window (not the banner) covers this input-space point. */
  clothWindowAt(p: Point): boolean
  /** A Cloth window has the keyboard focus. */
  clothFocused(): boolean
  /** The stop shortcut as the user sees it ("Ctrl+Alt+Esc"). */
  stopKeys(): string
}

export interface ComputerDeps {
  platform: NodeJS.Platform
  input(): Promise<Input>
  displays(): ScreenDisplay[]
  capture(display: ScreenDisplay): Promise<Shot>
  zoom(display: ScreenDisplay, region: readonly number[]): Promise<Shot>
  host: ComputerHost
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Who is using the computer and how they agreed to it. */
export interface ComputerUser {
  /** The chat (or run) — one at a time controls the computer. */
  owner: string
  /** Null when there's nobody to ask (an unattended run). */
  consent: { granted(): boolean; ask(toolCallId: string, text: string, signal?: AbortSignal): Promise<boolean> } | null
  /** Stop the whole run (the stop shortcut). */
  onStop?: () => void
}

export interface ComputerDetails {
  action: ComputerAction
  coordinate?: number[]
  display: number
  thumbnail?: string
  width?: number
  height?: number
}

/** Actions that change the screen: a fresh screenshot follows them. */
const CHANGES = new Set<ComputerAction>(['mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'wait'])
const POINTER = new Set<ComputerAction>(['mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll'])
const KEYBOARD = new Set<ComputerAction>(['type', 'key', 'hold_key'])
const CLICKS: Partial<Record<ComputerAction, { button: 'left' | 'right' | 'middle'; count: number; verb: string }>> = {
  left_click: { button: 'left', count: 1, verb: 'Clicked' },
  right_click: { button: 'right', count: 1, verb: 'Right-clicked' },
  middle_click: { button: 'middle', count: 1, verb: 'Middle-clicked' },
  double_click: { button: 'left', count: 2, verb: 'Double-clicked' },
  triple_click: { button: 'left', count: 3, verb: 'Triple-clicked' }
}

class Refusal extends Error {}

/**
 * Runs computer use for every chat: one owner at a time, its display, and the stop shortcut.
 * Each run gets its own `tool()` (its own action budget and failsafe).
 */
export class ComputerController {
  private active: { owner: string; stop: () => void } | null = null
  private displayOf = new Map<string, number>()
  private input: Input | null = null
  private now: () => number
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  constructor(private deps: ComputerDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? realSleep
  }

  /** The OS name and the displays, for the tool's description. */
  describe(owner?: string): string {
    const mac = this.deps.platform === 'darwin'
    const list = this.deps.displays()
    const current = this.displayIndex(owner, list)
    const lines = [
      `Control this ${mac ? 'Mac' : 'Windows PC'} with the mouse and keyboard, and see it with screenshots. Coordinates are pixels in the latest screenshot of the active display.`,
      `The OS is ${mac ? 'macOS: use cmd for shortcuts (cmd+c, cmd+tab)' : 'Windows: use ctrl for shortcuts (ctrl+c, alt+tab)'}. Keys use xdotool-style names: Return, Escape, Tab, BackSpace, Delete, Page_Down, Home, Up, F5, and combos like ${mac ? 'cmd+shift+t' : 'ctrl+shift+t'}.`,
      'Start with a screenshot. After actions that change the screen you get a fresh screenshot. Use zoom to read small text. Prefer keyboard shortcuts when they are reliable.',
      'If a result says the user stopped or paused computer use, stop and tell the user what you were doing.',
      `Displays (pass display to switch; the active one is ${current}):`,
      ...list.map((d, i) => `- ${i}: ${d.shot.width}×${d.shot.height} screenshots${d.primary ? ' (primary)' : ''}`)
    ]
    return lines.join('\n')
  }

  private displayIndex(owner: string | undefined, list = this.deps.displays()): number {
    const saved = owner ? this.displayOf.get(owner) : undefined
    if (saved !== undefined && saved < list.length) return saved
    return Math.max(0, list.findIndex((d) => d.primary))
  }

  /** Someone is using the computer now (its owner). */
  get current(): string | null {
    return this.active?.owner ?? null
  }

  /** The stop shortcut: end the action under way and the run. */
  stop(): void {
    this.active?.stop()
  }

  /** The run is over (or waits for the user): give the computer back. */
  async release(owner?: string): Promise<void> {
    if (!this.active || (owner && this.active.owner !== owner)) return
    this.active = null
    await this.input?.releaseAll().catch(() => undefined)
    this.deps.host.end()
  }

  tool(user: ComputerUser): AgentTool<typeof computerParameters, ComputerDetails> {
    const deps = this.deps
    const run = {
      actions: 0,
      last: 0,
      recent: [] as number[],
      cursor: null as Point | null,
      stopped: false,
      paused: false,
      action: null as AbortController | null
    }
    const stop = () => {
      run.stopped = true
      run.action?.abort()
      void this.release(user.owner)
      user.onStop?.()
    }

    const pace = async (signal?: AbortSignal) => {
      const wait = run.last + LIMITS.minGapMs - this.now()
      if (wait > 0) await this.sleep(wait, signal)
      run.recent = run.recent.filter((t) => this.now() - t < 60_000)
      if (run.recent.length >= LIMITS.perMinute) await this.sleep(run.recent[0] + 60_000 - this.now(), signal)
      run.recent = run.recent.filter((t) => this.now() - t < 60_000)
    }
    /** The user took the mouse back: the cursor isn't where the agent left it. */
    const checkFailsafe = async (input: Input) => {
      if (!run.cursor) return
      const now = await input.cursor()
      if (Math.hypot(now.x - run.cursor.x, now.y - run.cursor.y) > LIMITS.failsafePx) {
        run.paused = true
        await this.release(user.owner)
        throw new Refusal(MOVED)
      }
    }
    const refuseCloth = (p: Point) => {
      if (deps.host.clothWindowAt(p)) throw new Refusal("That point is on Cloth's own window. Cloth can't be controlled with computer use.")
    }

    return {
      name: 'computer',
      label: 'Computer',
      description: this.describe(user.owner),
      parameters: computerParameters,
      executionMode: 'sequential',
      execute: async (toolCallId, params, signal) => {
        const p = params as ComputerParams
        if (run.stopped) throw new Refusal(`${STOPPED} Do not try again; tell the user where you got to.`)
        if (run.paused) throw new Refusal('Computer use is paused because the user moved the mouse. Ask the user before carrying on.')
        if (this.active && this.active.owner !== user.owner) throw new Refusal('Another chat is using the computer right now. Try again when it has finished.')
        if (run.actions >= LIMITS.perRun) throw new Refusal(`This run has used all ${LIMITS.perRun} computer actions. Tell the user where you got to.`)

        // One consent per chat, on its first action.
        if (!user.consent) throw new Refusal('Computer use needs someone to allow it in a chat; it can’t start in an unattended run.')
        if (!user.consent.granted()) {
          const keys = deps.host.stopKeys()
          const ok = await user.consent.ask(toolCallId, `Let Cloth use this computer for this chat? It minimises itself while it works and stops when you press ${keys}.`, signal)
          if (!ok) return { content: [{ type: 'text', text: DECLINED }], details: { action: p.action, display: this.displayIndex(user.owner) } }
        }
        const missing = await deps.host.permissions()
        if (missing) throw new Refusal(missing)

        const list = deps.displays()
        if (p.display !== undefined) {
          if (p.display >= list.length) throw new Refusal(`There is no display ${p.display}. Displays: ${list.map((_, i) => i).join(', ')}.`)
          this.displayOf.set(user.owner, p.display)
        }
        const index = this.displayIndex(user.owner, list)
        const display = list[index]
        if (!display) throw new Refusal('No display found.')
        const details = (extra: Partial<ComputerDetails> = {}): ComputerDetails => ({ action: p.action, ...(p.coordinate ? { coordinate: p.coordinate } : {}), display: index, ...extra })

        const point = (at: number[] | undefined, name: string): Point => {
          if (!at) throw new Refusal(`${p.action} needs ${name}.`)
          const os = toOs(display, at)
          if (typeof os === 'string') throw new Refusal(os)
          return os
        }
        // Check the arguments before touching anything.
        if (p.action === 'type') {
          if (!p.text) throw new Refusal('type needs text.')
          if (p.text.length > LIMITS.typeChars) throw new Refusal(`type takes at most ${LIMITS.typeChars} characters at a time; split the text.`)
        }
        if (p.action === 'key' || p.action === 'hold_key') {
          if (!p.text) throw new Refusal(`${p.action} needs text: the key or combo, like "Return" or "ctrl+s".`)
          try {
            parseCombo(p.text)
          } catch (err) {
            throw new Refusal(err instanceof Error ? err.message : String(err))
          }
          if (p.action === 'hold_key' && p.duration === undefined) throw new Refusal('hold_key needs duration (seconds).')
        }
        if (p.action === 'scroll' && !p.scroll_direction) throw new Refusal('scroll needs scroll_direction.')
        if (p.action === 'zoom') {
          if (!p.region) throw new Refusal('zoom needs region [x0, y0, x1, y1].')
          const bad = checkRegion(display, p.region)
          if (bad) throw new Refusal(bad)
        }
        const target = p.action === 'left_click_drag' ? point(p.coordinate, 'coordinate') : p.coordinate ? point(p.coordinate, 'coordinate') : null
        const from = p.action === 'left_click_drag' && p.start_coordinate ? point(p.start_coordinate, 'start_coordinate') : null
        if (p.action === 'mouse_move' && !target) throw new Refusal('mouse_move needs coordinate.')

        const input = (this.input ??= await deps.input())
        await pace(signal)
        run.actions++
        run.last = this.now()
        run.recent.push(run.last)

        if (p.action === 'cursor_position') {
          const at = fromOs(display, await input.cursor())
          return { content: [{ type: 'text', text: at ? `The cursor is at [${at[0]}, ${at[1]}].` : 'The cursor is on another display.' }], details: details() }
        }

        // Step aside (once per stretch of work), then act.
        if (!this.active) {
          this.active = { owner: user.owner, stop }
          run.cursor = null
          await deps.host.begin(display, () => this.stop())
        }
        const action = new AbortController()
        run.action = action
        const onAbort = () => action.abort()
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          await checkFailsafe(input)
          if (POINTER.has(p.action)) {
            if (target) refuseCloth(target)
            if (from) refuseCloth(from)
            if (!target && !from) refuseCloth(await input.cursor())
          }
          if (KEYBOARD.has(p.action) && deps.host.clothFocused()) throw new Refusal("Cloth's window has the keyboard focus. Click the app you want to type in first.")

          let text = ''
          const click = CLICKS[p.action]
          if (click) {
            if (target) await input.move(target.x, target.y)
            await input.click(click.button, click.count)
            text = `${click.verb}${p.coordinate ? ` at [${p.coordinate.join(', ')}]` : ''}.`
          } else
            switch (p.action) {
              case 'screenshot':
                break
              case 'zoom': {
                const shot = await deps.zoom(display, p.region!)
                return result(`Zoomed into [${p.region!.join(', ')}]. This image is ${shot.width}×${shot.height}; click using the full screenshot's coordinates, not this image's.`, shot, details({ thumbnail: shot.thumbnail, width: shot.width, height: shot.height }))
              }
              case 'mouse_move':
                await input.move(target!.x, target!.y)
                text = `Moved the mouse to [${p.coordinate!.join(', ')}].`
                break
              case 'left_click_drag': {
                const start = from ?? (await input.cursor())
                await input.drag(start, target!)
                text = `Dragged to [${p.coordinate!.join(', ')}].`
                break
              }
              case 'left_mouse_down':
              case 'left_mouse_up':
                if (target) await input.move(target.x, target.y)
                if (p.action === 'left_mouse_down') await input.down('left')
                else await input.up('left')
                text = p.action === 'left_mouse_down' ? 'Pressed the left button.' : 'Released the left button.'
                break
              case 'scroll': {
                const n = p.scroll_amount ?? 3
                const dir = p.scroll_direction!
                await input.scroll(dir === 'left' ? -n : dir === 'right' ? n : 0, dir === 'up' ? -n : dir === 'down' ? n : 0, target ?? undefined)
                text = `Scrolled ${dir} ${n}.`
                break
              }
              case 'type':
                for (let i = 0; i < p.text!.length; i += LIMITS.typeChunk) {
                  if (action.signal.aborted) throw new Refusal(STOPPED)
                  if (i) await checkFailsafe(input)
                  await input.typeText(p.text!.slice(i, i + LIMITS.typeChunk))
                  run.cursor = await input.cursor()
                }
                text = `Typed ${p.text!.length} character${p.text!.length === 1 ? '' : 's'}.`
                break
              case 'key':
                await input.key(p.text!, p.repeat ?? 1)
                text = `Pressed ${p.text}${(p.repeat ?? 1) > 1 ? ` ${p.repeat} times` : ''}.`
                break
              case 'hold_key':
                await input.holdKey(p.text!, Math.min(p.duration ?? 0, LIMITS.waitSeconds), action.signal)
                text = `Held ${p.text} for ${p.duration}s.`
                break
              case 'wait':
                await this.sleep(Math.min(p.duration ?? 1, LIMITS.waitSeconds) * 1000, action.signal)
                text = `Waited ${Math.min(p.duration ?? 1, LIMITS.waitSeconds)}s.`
                break
            }
          if (action.signal.aborted) throw new Refusal(STOPPED)
          run.cursor = await input.cursor()
          if (CHANGES.has(p.action)) await this.sleep(LIMITS.settleMs, action.signal)
          const shot = await deps.capture(display)
          return result(text || `Screenshot of display ${index} (${shot.width}×${shot.height}).`, shot, details({ thumbnail: shot.thumbnail, width: shot.width, height: shot.height }))
        } catch (err) {
          if (run.stopped || action.signal.aborted) throw new Refusal(`${STOPPED} Do not try again; tell the user where you got to.`)
          throw err
        } finally {
          signal?.removeEventListener('abort', onAbort)
          run.action = null
        }
      }
    }
  }
}

function result(text: string, shot: Shot, details: ComputerDetails): AgentToolResult<ComputerDetails> {
  const content: (TextContent | ImageContent)[] = [
    { type: 'text', text },
    { type: 'image', data: shot.data, mimeType: shot.mimeType }
  ]
  return { content, details }
}

/** Offer `computer` only to a top-level agent whose chat switched it on, on a model that can see images. */
export function computerOffered(scope: { computerUse?: boolean; depth?: number }, modelInput: readonly string[] | undefined, supported: boolean): boolean {
  return supported && !!scope.computerUse && !scope.depth && !!modelInput?.includes('image')
}
