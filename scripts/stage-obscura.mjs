#!/usr/bin/env node
// Stage the Obscura headless browser (https://github.com/h4ckf0r0day/obscura) into sidecars/obscura
// so electron-builder can ship it via extraResources. Cloth runs `obscura fetch <url> --dump html`
// per web search (DuckDuckGo HTML SERP), so no long-running CDP server is needed.
//
//   node scripts/stage-obscura.mjs [--force]
//
// Pinned release + per-asset sha256 (from the GitHub release's asset digests). The
// `no-render-stealth` build is used: we only need DOM/HTML, and stealth helps with bot walls.
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { SIDECARS, ensureDir, exists, fetchVerified, isMain, logger, readJson, rimraf, run, sha256 } from './sidecar-utils.mjs'

export const OBSCURA_VERSION = '0.2.3'
const VARIANT = 'no-render-stealth'
const ASSETS = {
  'win32-x64': { name: `obscura-x86_64-windows-${VARIANT}.zip`, sha256: 'f3890f8f89c9e7fcdc56941d0a5920e78c5d7b744d5e081bc5a9f3697467e65b' },
  'linux-x64': { name: `obscura-x86_64-linux-${VARIANT}.tar.gz`, sha256: '56239859ef7bc34439013834fd0491ff21b0d0debe372d5a6e373dd025ea3198' },
  'linux-arm64': { name: `obscura-aarch64-linux-${VARIANT}.tar.gz`, sha256: 'd0d443c4ebfcf41b29582f4637fe0d3e266a1dbff5eaa877af5c788e8fb1fb8c' },
  'darwin-x64': { name: `obscura-x86_64-macos-${VARIANT}.tar.gz`, sha256: '1eb06ec1008523a06523c13fd6c431d26ca8d85136eef41952219c70e947038b' },
  'darwin-arm64': { name: `obscura-aarch64-macos-${VARIANT}.tar.gz`, sha256: '93cc696f52c60ed113f366eaf9506fbf27b9e6543e82d3d739783dabf63750f8' }
}

const log = logger('stage-obscura')
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n)

async function findBinary(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      const nested = await findBinary(full)
      if (nested) return nested
    } else if (e.name === exe('obscura')) return full
  }
  return null
}

export async function stageObscura({ force = false } = {}) {
  const tag = `${process.platform}-${process.arch}`
  const asset = ASSETS[tag]
  const stage = path.join(SIDECARS, 'obscura')
  if (!asset) {
    log(`no pinned Obscura build for ${tag}; skipping (web search can still use SearXNG)`)
    return
  }
  const marker = await readJson(path.join(stage, 'VERSION'))
  if (!force && marker?.version === OBSCURA_VERSION && marker?.asset === asset.name && (await exists(path.join(stage, exe('obscura'))))) {
    log(`cache hit: obscura ${OBSCURA_VERSION} (${tag})`)
    return
  }
  const archive = await fetchVerified(`https://github.com/h4ckf0r0day/obscura/releases/download/v${OBSCURA_VERSION}/${asset.name}`, `obscura-v${OBSCURA_VERSION}-${asset.name}`, asset.sha256, log)
  const tmp = path.join(SIDECARS, '.obscura-extract')
  await rimraf(tmp)
  await ensureDir(tmp)
  // bsdtar (Windows 10+, macOS) and GNU tar both read .tar.gz; bsdtar also reads .zip.
  await run('tar', ['-xf', archive, '-C', tmp])
  const bin = await findBinary(tmp)
  if (!bin) throw new Error(`${asset.name} did not contain ${exe('obscura')}`)
  await rimraf(stage)
  await fsp.rename(path.dirname(bin), stage).catch(async () => {
    await ensureDir(stage)
    for (const f of await fsp.readdir(path.dirname(bin))) await fsp.cp(path.join(path.dirname(bin), f), path.join(stage, f), { recursive: true })
  })
  await rimraf(tmp)
  if (process.platform !== 'win32') await fsp.chmod(path.join(stage, 'obscura'), 0o755)
  await fsp.writeFile(
    path.join(stage, 'VERSION'),
    JSON.stringify({ version: OBSCURA_VERSION, variant: VARIANT, asset: asset.name, sha256: await sha256(path.join(stage, exe('obscura'))), stagedAt: new Date().toISOString() }, null, 2)
  )
  log(`staged obscura ${OBSCURA_VERSION} ${VARIANT} → sidecars/obscura (${(await fsp.readdir(stage)).join(', ')})`)
}

if (isMain(import.meta.url)) {
  stageObscura({ force: process.argv.includes('--force') }).catch((err) => {
    console.error('[stage-obscura] FAILED:', err.message ?? err)
    process.exit(1)
  })
}
