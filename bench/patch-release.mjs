// Prepares an older release's source for the benchmark, before it is built: node bench/patch-release.mjs <cloth dir>
// Releases before the modes probe could set up OpenAI by itself need a provider in CLOTH_HOME, and each run starts
// with an empty one. This adds master's few lines (a provider from OPENAI_API_KEY) to the release's probe. It only
// touches the dev-only probe, never what the agent does, so the release is measured as it shipped.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const file = join(process.argv[2] ?? '.', 'src/main/probe-modes.ts')
let src = readFileSync(file, 'utf8')
const MARK = 'A fresh CLOTH_HOME has no providers'
const anchor = '  const provider = s.providers.list().find((p) => p.enabled && p.models.some((m) => m.id === want))'
if (src.includes(MARK)) console.log('probe-modes.ts sets up its provider already')
else if (!src.includes(anchor)) {
  console.log(`::error::Couldn't patch ${file}: it has no "${anchor.trim()}" line`)
  process.exitCode = 1
} else {
  src = src.replace(
    anchor,
    `  // ${MARK}: set up OpenAI from the environment's key (added by bench/patch-release.mjs).
  if (!s.providers.list().some((p) => p.enabled && p.models.some((m) => m.id === want)) && process.env.OPENAI_API_KEY) {
    const p = s.providers.create({ name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY })
    await s.providers.refreshModels(p.id)
  }
${anchor}`
  )
  writeFileSync(file, src)
  console.log('probe-modes.ts: added the provider setup from OPENAI_API_KEY')
}
