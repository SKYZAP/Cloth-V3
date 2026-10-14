import { Cron } from 'croner'
import cronstrue from 'cronstrue'
import type { AutomationWatch, WorkflowRun, WorkflowRunReport } from '@shared/types'

// Pure helpers for the Automations page: the schedule model, its sentence, the "Next up" card and run lines.
// No React or app imports, so they can be unit tested.

export type Cadence = 'once' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom'

export const CADENCES: { value: Cadence; label: string }[] = [
  { value: 'once', label: 'Only when you run it' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday' },
  { value: 'weekly', label: 'Every week' },
  { value: 'custom', label: 'Custom schedule' }
]
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface Schedule {
  cadence: Cadence
  /** HH:MM, 24-hour. */
  time: string
  day: number
  custom: string
}

/** The schedule a saved cron describes. */
export function readSchedule(cron: string | null): Schedule {
  const base: Schedule = { cadence: 'once', time: '09:00', day: 1, custom: cron ?? '' }
  if (!cron) return base
  const m = cron.trim().match(/^(\d{1,2}) (\d{1,2}|\*) \* \* (\*|1-5|[0-6])$/)
  if (m) {
    const time = m[2] === '*' ? '09:00' : `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`
    if (m[2] === '*' && m[3] === '*' && m[1] === '0') return { ...base, cadence: 'hourly' }
    if (m[2] !== '*' && m[3] === '*') return { ...base, cadence: 'daily', time }
    if (m[2] !== '*' && m[3] === '1-5') return { ...base, cadence: 'weekdays', time }
    if (m[2] !== '*' && /^[0-6]$/.test(m[3])) return { ...base, cadence: 'weekly', time, day: Number(m[3]) }
  }
  return { ...base, cadence: 'custom', custom: cron }
}

export function cronOf(s: Schedule): string | null {
  const [h, m] = s.time.split(':').map((x) => Number(x) || 0)
  switch (s.cadence) {
    case 'once':
      return null
    case 'hourly':
      return '0 * * * *'
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekdays':
      return `${m} ${h} * * 1-5`
    case 'weekly':
      return `${m} ${h} * * ${s.day}`
    case 'custom':
      return s.custom.trim() || null
  }
}

/** The next `count` run times of a cron expression; ok is false when it isn't a valid expression. */
export function nextRuns(cron: string | null, count = 3, from?: Date): { ok: boolean; runs: Date[] } {
  if (!cron) return { ok: true, runs: [] }
  try {
    const c = new Cron(cron, { paused: true })
    const runs = c.nextRuns(count, from)
    c.stop()
    return { ok: true, runs }
  } catch {
    return { ok: false, runs: [] }
  }
}

/** "08:30" → "8:30". */
export const clock = (hhmm: string) => hhmm.replace(/^0(\d)/, '$1')

const WATCH_WHEN: Record<AutomationWatch['kind'], string> = {
  files: 'files in its folder change',
  url: 'a web page changes',
  mcp: 'an MCP check changes'
}
export const watchWhen = (kind: AutomationWatch['kind']) => WATCH_WHEN[kind]

/** How often it runs, in words: "Every weekday at 8:30", "Every hour · and on changes", "When a web page changes". */
export function scheduleSentence(cron: string | null, watch: AutomationWatch | null): string {
  const s = readSchedule(cron)
  let base: string | null
  switch (s.cadence) {
    case 'once':
      base = null
      break
    case 'hourly':
      base = 'Every hour'
      break
    case 'daily':
      base = `Every day at ${clock(s.time)}`
      break
    case 'weekdays':
      base = `Every weekday at ${clock(s.time)}`
      break
    case 'weekly':
      base = `Every ${DAYS[s.day]} at ${clock(s.time)}`
      break
    case 'custom':
      try {
        base = cronstrue.toString(s.custom, { use24HourTimeFormat: true, verbose: false })
      } catch {
        base = s.custom
      }
      break
  }
  if (!base) return watch ? `When ${WATCH_WHEN[watch.kind]}` : 'Only when you run it'
  return watch ? `${base} · and on changes` : base
}

const DAY = 86_400_000
const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const hm = (t: number) => {
  const d = new Date(t)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "in 18 min", "in 14 h", "in 4 days" (or "18 min ago" for the past). */
export function relativeIn(t: number, now: number): string {
  const past = t < now
  const m = Math.round(Math.abs(t - now) / 60_000)
  const say = (s: string) => (past ? `${s} ago` : `in ${s}`)
  if (m < 1) return past ? 'just now' : 'in under a minute'
  if (m < 60) return say(`${m} min`)
  const h = Math.round(m / 60)
  if (h < 24) return say(`${h} h`)
  const d = Math.round(h / 24)
  return say(`${d} day${d === 1 ? '' : 's'}`)
}

/** A future time, short: "21:00" today, "Tomorrow 8:30", "Mon 9:00" this week, "Mon 20 Oct 9:00" later. */
export function shortWhen(t: number, now: number): string {
  const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY)
  const d = new Date(t)
  if (days === 0) return hm(t)
  if (days === 1) return `Tomorrow ${hm(t)}`
  if (days === -1) return `Yesterday ${hm(t)}`
  if (days > 1 && days < 7) return `${SHORT_DAYS[d.getDay()]} ${hm(t)}`
  return `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hm(t)}`
}

/**
 * When a run started, to read mid-sentence: "today, 20:07", "yesterday, 20:07", or "Mon 12 Oct, 20:07"
 * for older days (weekday, day, month and time in the user's locale; `locale` is for tests).
 */
export function runWhen(t: number, now: number, locale?: string | string[]): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY)
  const d = new Date(t)
  if (days === 0 || days === 1) {
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
    return `${days === 0 ? 'today' : 'yesterday'}, ${time}`
  }
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d)
}

/** The soonest scheduled run across automations, after `now`. */
export function nextUp<T extends { id: string; name: string; times: number[] }>(entries: T[], now: number): { id: string; name: string; at: number } | null {
  let best: { id: string; name: string; at: number } | null = null
  for (const e of entries) for (const at of e.times) if (at > now && (!best || at < best.at)) best = { id: e.id, name: e.name, at }
  return best
}

/** Today's 24 hours: which have a scheduled run, and the current hour (for the marker). */
export function daySlots(times: number[], now: number): { slots: boolean[]; nowHour: number } {
  const start = startOfDay(now)
  const slots = Array.from({ length: 24 }, () => false)
  for (const t of times) {
    if (t < start || t >= start + DAY) continue
    slots[new Date(t).getHours()] = true
  }
  return { slots, nowHour: new Date(now).getHours() }
}

export type RunOutcome = 'running' | 'ok' | 'partial' | 'failed'

/** How a run went: it failed after reporting something counts as partly done. */
export function runOutcome(run: Pick<WorkflowRun, 'status' | 'reports'>): RunOutcome {
  if (run.status === 'running') return 'running'
  if (run.status === 'ok') return 'ok'
  return run.reports?.length ? 'partial' : 'failed'
}

export const OUTCOME_WORD: Record<RunOutcome, string> = { running: 'Running', ok: 'Done', partial: 'Partly done', failed: 'Failed' }

const reportLine = (r: WorkflowRunReport) => (r.kind === 'chat' ? r.title : r.kind === 'notify' ? r.title || 'Sent a notification' : `Saved to ${r.collection}: ${r.title}`)

/** One line for a run: its first report's title, else its error, else "Nothing to report". */
export function runSummary(run: Pick<WorkflowRun, 'status' | 'reports' | 'error'>): string {
  if (run.status === 'running') return 'Running…'
  const first = run.reports?.[0]
  if (first) return reportLine(first)
  if (run.status === 'error') return run.error?.split('\n')[0].trim() || 'It failed without saying why'
  return 'Nothing to report'
}

/** The chat a run reported in, if any. */
export const runChat = (run: Pick<WorkflowRun, 'reports'>) => run.reports?.find((r): r is Extract<WorkflowRunReport, { kind: 'chat' }> => r.kind === 'chat')?.chatId ?? null

/** "9s", "2m 10s", "1h 03m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Runs started in the last 30 days. */
export const runsInLast30Days = (runs: { startedAt: number }[], now: number) => runs.filter((r) => r.startedAt >= now - 30 * DAY).length
