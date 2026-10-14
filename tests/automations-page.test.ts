import { describe, expect, it } from 'vitest'
import { cronOf, daySlots, formatDuration, nextRuns, nextUp, readSchedule, relativeIn, runChat, runOutcome, runSummary, runWhen, runsInLast30Days, scheduleSentence, shortWhen } from '../src/renderer/src/pages/automation/schedule'

// Tue 14 Oct 2026, 20:42 local time.
const NOW = new Date(2026, 9, 14, 20, 42).getTime()
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()

describe('schedule sentence', () => {
  it('reads the cadences in words', () => {
    expect(scheduleSentence('30 8 * * 1-5', null)).toBe('Every weekday at 8:30')
    expect(scheduleSentence('0 9 * * 1', null)).toBe('Every Monday at 9:00')
    expect(scheduleSentence('0 17 * * *', null)).toBe('Every day at 17:00')
    expect(scheduleSentence('0 * * * *', null)).toBe('Every hour')
    expect(scheduleSentence(null, null)).toBe('Only when you run it')
  })
  it('mentions changes it watches', () => {
    expect(scheduleSentence('0 * * * *', { kind: 'url', url: 'https://x.test', everyMinutes: 15 })).toBe('Every hour · and on changes')
    expect(scheduleSentence(null, { kind: 'files' })).toBe('When files in its folder change')
    expect(scheduleSentence(null, { kind: 'mcp', serverId: 's', tool: 't', args: {}, everyMinutes: 5 })).toBe('When an MCP check changes')
  })
  it('describes a custom cron and keeps a broken one as written', () => {
    expect(scheduleSentence('*/15 9-17 * * 1-5', null)).toMatch(/15 minutes/)
    expect(scheduleSentence('not a cron', null)).toBe('not a cron')
  })
  it('round-trips the schedule model', () => {
    for (const c of ['30 8 * * 1-5', '0 9 * * 1', '5 17 * * *', '0 * * * *', '*/5 * * * *']) expect(cronOf(readSchedule(c))).toBe(c)
    expect(readSchedule('*/5 * * * *').cadence).toBe('custom')
    expect(cronOf(readSchedule(null))).toBeNull()
  })
  it('flags an invalid cron and lists the next runs', () => {
    expect(nextRuns('nope').ok).toBe(false)
    const r = nextRuns('0 9 * * *', 3, new Date(NOW))
    expect(r.ok).toBe(true)
    expect(r.runs.map((d) => d.getTime())).toEqual([at(15, 9), at(16, 9), at(17, 9)])
  })
})

describe('next up', () => {
  it('picks the soonest future run across automations', () => {
    const entries = [
      { id: 'a', name: 'Weekly', times: [at(20, 9)] },
      { id: 'b', name: 'Hourly', times: [at(14, 20), at(14, 21), at(14, 22)] },
      { id: 'c', name: 'Never', times: [] }
    ]
    expect(nextUp(entries, NOW)).toEqual({ id: 'b', name: 'Hourly', at: at(14, 21) })
    expect(nextUp([{ id: 'c', name: 'Never', times: [] }], NOW)).toBeNull()
  })
  it('says how far away it is', () => {
    expect(relativeIn(NOW + 18 * 60_000, NOW)).toBe('in 18 min')
    expect(relativeIn(NOW + 14 * 3_600_000, NOW)).toBe('in 14 h')
    expect(relativeIn(NOW + 4 * 86_400_000, NOW)).toBe('in 4 days')
    expect(relativeIn(NOW + 20_000, NOW)).toBe('in under a minute')
  })
  it('names the day briefly', () => {
    expect(shortWhen(at(14, 21), NOW)).toBe('21:00')
    expect(shortWhen(at(15, 8, 30), NOW)).toBe('Tomorrow 8:30')
    expect(shortWhen(at(19, 9), NOW)).toBe('Mon 9:00')
    expect(shortWhen(at(27, 9), NOW)).toBe('Tue 27 Oct 9:00')
  })
})

describe('today strip', () => {
  it('marks the hours with a run today and the current hour', () => {
    const { slots, nowHour } = daySlots([at(14, 8, 30), at(14, 9), at(14, 21), at(14, 23, 59), at(15, 1), at(13, 22)], NOW)
    expect(slots).toHaveLength(24)
    expect(slots.flatMap((on, h) => (on ? [h] : []))).toEqual([8, 9, 21, 23])
    expect(nowHour).toBe(20)
  })
})

describe('run lines', () => {
  it('summarises a run by its first report, its error, or nothing', () => {
    expect(runSummary({ status: 'ok', error: null, reports: [{ kind: 'chat', chatId: 'c1', title: 'Added 3 pages' }, { kind: 'notify' }] })).toBe('Added 3 pages')
    expect(runSummary({ status: 'ok', error: null, reports: [{ kind: 'notify' }] })).toBe('Sent a notification')
    expect(runSummary({ status: 'ok', error: null, reports: [{ kind: 'knowledge', collection: 'Docs', title: 'Notes' }] })).toBe('Saved to Docs: Notes')
    expect(runSummary({ status: 'error', error: 'The model provider was unreachable.\nstack…', reports: [] })).toBe('The model provider was unreachable.')
    expect(runSummary({ status: 'ok', error: null, reports: [] })).toBe('Nothing to report')
    expect(runSummary({ status: 'ok', error: null })).toBe('Nothing to report')
    expect(runSummary({ status: 'running', error: null })).toBe('Running…')
  })
  it('tells done, partly done and failed apart', () => {
    expect(runOutcome({ status: 'ok', reports: [] })).toBe('ok')
    expect(runOutcome({ status: 'error', reports: [{ kind: 'notify' }] })).toBe('partial')
    expect(runOutcome({ status: 'error' })).toBe('failed')
    expect(runOutcome({ status: 'running' })).toBe('running')
  })
  it('finds the chat it reported in', () => {
    expect(runChat({ reports: [{ kind: 'notify' }, { kind: 'chat', chatId: 'c9', title: 't' }] })).toBe('c9')
    expect(runChat({})).toBeNull()
  })
  it('formats when and how long', () => {
    expect(runWhen(at(14, 20, 7), NOW, 'en-GB')).toBe('today, 20:07')
    expect(runWhen(at(13, 8, 30), NOW, 'en-GB')).toBe('yesterday, 08:30')
    expect(runWhen(at(12, 20, 7), NOW, 'en-GB')).toBe('Mon 12 Oct, 20:07')
    expect(runWhen(at(5, 9), NOW, 'en-GB')).toBe('Mon 5 Oct, 09:00')
    // Yesterday across a month boundary still reads as yesterday.
    expect(runWhen(new Date(2026, 8, 30, 23, 59).getTime(), new Date(2026, 9, 1, 0, 5).getTime(), 'en-GB')).toBe('yesterday, 23:59')
    expect(formatDuration(9_400)).toBe('9s')
    expect(formatDuration(130_000)).toBe('2m 10s')
    expect(formatDuration(182_000)).toBe('3m 02s')
    expect(formatDuration(null)).toBe('')
    expect(runsInLast30Days([{ startedAt: at(14, 1) }, { startedAt: NOW - 31 * 86_400_000 }], NOW)).toBe(1)
  })
})
