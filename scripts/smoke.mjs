// End-to-end smoke run: starts the mock LLM, launches the built app in CLOTH_SMOKE mode
// (isolated data dir), and writes screenshots + smoke.log to .cloth-dev/smoke.
//   npm run smoke
import { spawn } from 'node:child_process'
import { rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = fileURLToPath(new URL('..', import.meta.url))
const base = join(root, '.cloth-dev')
rmSync(join(base, 'smoke'), { recursive: true, force: true })
rmSync(join(base, 'smoke-home'), { recursive: true, force: true })

const mock = spawn(process.execPath, [join(root, 'scripts/mock-llm.mjs')], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))
const app = spawn(electron, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CLOTH_HOME: join(base, 'smoke-home'), CLOTH_SMOKE: join(base, 'smoke') }
})
app.on('exit', (code) => {
  mock.kill()
  console.log('\n' + readFileSync(join(base, 'smoke', 'smoke.log'), 'utf8'))
  process.exit(code ?? 0)
})
