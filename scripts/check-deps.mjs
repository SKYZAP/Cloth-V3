// Fails packaging when node_modules has drifted from package-lock.json. electron-builder copies whatever is
// installed, so a dependency added to package.json but never installed ships as a missing module and the app
// crashes at startup (1.4.1: "Cannot find package 'marked'"). Fix a failure with `npm ci`.
import { spawnSync } from 'node:child_process'

const r = spawnSync('npm ls --omit=dev --all --json', { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
let problems = []
try {
  problems = JSON.parse(r.stdout).problems ?? []
} catch {
  problems = [r.stderr.trim() || 'npm ls produced no readable output']
}
if (r.status !== 0 && problems.length === 0) problems = [r.stderr.trim() || `npm ls exited with ${r.status}`]

if (problems.length) {
  console.error('Installed dependencies do not match package-lock.json, so the app would ship broken:')
  for (const p of problems.slice(0, 20)) console.error(`  - ${p}`)
  if (problems.length > 20) console.error(`  … and ${problems.length - 20} more`)
  console.error('Run `npm ci`, then package again.')
  process.exit(1)
}
console.log('Dependencies match package-lock.json.')
