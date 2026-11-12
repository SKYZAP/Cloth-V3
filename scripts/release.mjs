// Builds the installer and uploads it, its blockmap and latest.yml to a draft GitHub release of the private repo.
// GH_TOKEN (Contents: read and write on SKYZAP/Cloth-V3) comes from the environment or ~/.homelab/env; it is never printed.
import './system-ca.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function tokenFromEnvFile() {
  const file = join(homedir(), '.homelab', 'env')
  if (!existsSync(file)) return null
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(GH_TOKEN|GITHUB_TOKEN)\s*=\s*(.*)\s*$/.exec(line)
    if (m) return m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return null
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || tokenFromEnvFile()
if (!token) {
  console.error('No GH_TOKEN: set it in the environment or add GH_TOKEN=… to ~/.homelab/env.')
  process.exit(1)
}

const env = { ...process.env, GH_TOKEN: token }
const run = (cmd) => {
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run('npm run sidecars')
run('npm run build:runner')
run('npx electron-vite build')
run('npx electron-builder --publish always')
console.log('Uploaded to a draft release. Publish it on GitHub to make it available to Cloth.')
