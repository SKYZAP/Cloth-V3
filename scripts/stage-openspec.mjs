#!/usr/bin/env node
// Stage the OpenSpec CLI (@fission-ai/openspec) into sidecars/openspec so electron-builder ships it via
// extraResources. Cloth runs it on Electron's own Node (ELECTRON_RUN_AS_NODE), so OpenSpec mode needs no
// global install and no Node.js on the PC.
//
//   node scripts/stage-openspec.mjs [--force]
//
// The version is pinned; npm checks each package against the registry's integrity hash as it installs.
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { SIDECARS, ensureDir, exists, isMain, logger, readJson, rimraf, run } from './sidecar-utils.mjs'

export const OPENSPEC_VERSION = '2.0.0'
const PKG = '@fission-ai/openspec'
const log = logger('stage-openspec')

export async function stageOpenSpec({ force = false } = {}) {
  const stage = path.join(SIDECARS, 'openspec')
  const entry = path.join(stage, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js')
  const marker = await readJson(path.join(stage, 'VERSION'))
  if (!force && marker?.version === OPENSPEC_VERSION && (await exists(entry))) {
    log(`cache hit: openspec ${OPENSPEC_VERSION}`)
    return
  }
  const tmp = path.join(SIDECARS, '.openspec-install')
  await rimraf(tmp)
  await ensureDir(tmp)
  await fsp.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'cloth-openspec', private: true }, null, 2))
  // npm is npm.cmd on Windows, which Node starts only through a shell; the arguments are fixed, so that's safe.
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', `${PKG}@${OPENSPEC_VERSION}`], {
    cwd: tmp,
    shell: process.platform === 'win32'
  })
  if (!(await exists(path.join(tmp, 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js')))) throw new Error(`${PKG} installed without bin/openspec.js`)
  await rimraf(stage)
  await fsp.rename(tmp, stage)
  await fsp.writeFile(path.join(stage, 'VERSION'), JSON.stringify({ version: OPENSPEC_VERSION, package: PKG, stagedAt: new Date().toISOString() }, null, 2))
  log(`staged ${PKG} ${OPENSPEC_VERSION} → sidecars/openspec`)
}

if (isMain(import.meta.url)) {
  stageOpenSpec({ force: process.argv.includes('--force') }).catch((err) => {
    console.error('[stage-openspec] FAILED:', err.message ?? err)
    process.exit(1)
  })
}
