// Startup timing: milliseconds since the process started at each step of launch, written to the console and the
// log once the app has started up. CLOTH_STARTUP_TRACE=1 prints each step as it happens too.

const t0 = performance.timeOrigin
const marks: [string, number][] = [['main starts', Math.round(Date.now() - t0)]]

/** Record a launch step. */
export function mark(step: string): void {
  const ms = Math.round(Date.now() - t0)
  marks.push([step, ms])
  if (process.env.CLOTH_STARTUP_TRACE) console.log(`[startup] ${step} ${ms}ms`)
}

/** One line: "ready 180ms · services 410ms · …". */
export function summary(): string {
  return marks.map(([s, ms]) => `${s} ${ms}ms`).join(' · ')
}
