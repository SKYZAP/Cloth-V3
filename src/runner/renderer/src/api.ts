import type { RunnerApi, RunnerEvent } from '../../api'

type Bridge = {
  invoke(method: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }>
  onEvent(listener: (payload: unknown) => void): () => void
}
const bridge = (window as unknown as { runner: Bridge }).runner

/** Typed calls into the runner's main process; failures reject with the main process's message. */
export const runner = new Proxy({} as RunnerApi, {
  get: (_t, method: string) => async (...args: unknown[]) => {
    const res = await bridge.invoke(method, args)
    if (!res.ok) throw new Error(res.error ?? 'Something went wrong')
    return res.value
  }
})

export const onRunnerEvent = (fn: (e: RunnerEvent) => void) => bridge.onEvent((p) => fn(p as RunnerEvent))
