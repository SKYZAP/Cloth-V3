import { execFile } from 'node:child_process'

/** Kill a process and its children (SearXNG / Obscura spawn workers). */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    } else {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
      resolve()
    }
  })
}

export function run(file: string, args: string[], opts: { timeoutMs: number; cwd?: string; signal?: AbortSignal; maxBuffer?: number; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8', env: opts.env },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`Executable not found: ${file}`))
        if (err && (err as { killed?: boolean }).killed) return reject(new Error(`Timed out after ${opts.timeoutMs / 1000}s`))
        resolve({ stdout: String(stdout), stderr: String(stderr), code })
      }
    )
    opts.signal?.addEventListener('abort', () => child.pid && void killTree(child.pid), { once: true })
  })
}
