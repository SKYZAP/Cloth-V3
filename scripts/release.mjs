// Builds the installer and uploads it, its blockmap and latest.yml to a draft GitHub release.
// GH_TOKEN (Contents: read and write on the repository) comes from the environment; it is never printed.
import './system-ca.mjs'
import { spawnSync } from 'node:child_process'

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) {
  console.error('No GH_TOKEN: set it in the environment (a token with Contents: read and write on the repository).')
  process.exit(1)
}

const env = { ...process.env, GH_TOKEN: token }
const run = (cmd) => {
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true, env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
run('npm run check-deps')
run('npm run sidecars')
run('npm run build:runner')
run('npx electron-vite build')
run('npx electron-builder --publish always')
console.log('Uploaded to a draft release. Publish it on GitHub to make it available to Cloth.')
