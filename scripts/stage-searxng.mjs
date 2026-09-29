#!/usr/bin/env node
// Stage a self-contained SearXNG (standalone CPython + pinned SearXNG source + its pip deps)
// into sidecars/searxng so the packaged app can run `python -m searx.webapp` on loopback.
// Ported from cloth v1's install-searxng.mjs.
//
//   node scripts/stage-searxng.mjs [--force]
//
// Layout:
//   sidecars/searxng/python/           python-build-standalone CPython
//   sidecars/searxng/src/searxng/      SearXNG source (on PYTHONPATH at runtime)
//   sidecars/searxng/settings.yml      template; secret/port filled in at runtime
//   sidecars/searxng/VERSION
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as tar from 'tar'
import { ROOT, SIDECARS, dirSize, ensureDir, exists, fetchVerified, isMain, logger, readJson, rimraf, run } from './sidecar-utils.mjs'

export const PYTHON_VERSION = '3.12.13'
export const PBS_TAG = '20260303'
// From the release's SHA256SUMS (install_only_stripped assets).
const PBS_SHA256 = {
  'win32-x64': '10b7a95b928e551fc78cac665999e1ae1f08fb738b255adb0a8d3b9c2824a9c0',
  'darwin-arm64': '377234f346fce41b6d3112b5ead89cb6af2d5596244f9edc1a739065770dde1f',
  'darwin-x64': 'b7ad42eef6a5729af319ba8a89eedd155e4d7c2a9884beff174a4c13e1286e68',
  'linux-x64': 'c710dd6b63e4df92f4c5b7b29ccad4276226a024a9017d5018f15321c7854af4',
  'linux-arm64': '9e0349ac08f40e33151bb9693de762101541f07633dea61dbaca17d03290cb58'
}
const TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu'
}
// SearXNG is rolling on master with no release tags — pin a commit and its archive checksum.
const SEARXNG_DEFAULT_REF = 'cd75013c928306299ee70a2123482c40b47cc431'
const SEARXNG_REF = process.env.SEARXNG_REF || SEARXNG_DEFAULT_REF
const SEARXNG_TARBALL_SHA256 = SEARXNG_REF === SEARXNG_DEFAULT_REF ? '732959590d384128aeebbe35fed86803fa28a69544b3a6cf5116341fb435480c' : null

const log = logger('stage-searxng')
const STAGE = path.join(SIDECARS, 'searxng')
const pythonExe = (dir) => (process.platform === 'win32' ? path.join(dir, 'python', 'python.exe') : path.join(dir, 'python', 'bin', 'python3.12'))

async function extract(file, dest, strip = 0) {
  await ensureDir(dest)
  // Skip symlinks: SearXNG ships a few template symlinks Windows can't create without privileges.
  await tar.x({ file, cwd: dest, strip, filter: (_p, entry) => entry.type !== 'SymbolicLink' })
}

async function installSearxng(stage) {
  const py = pythonExe(stage)
  const src = path.join(stage, 'src', 'searxng')
  await rimraf(path.join(stage, 'src'))
  const archive = await fetchVerified(`https://github.com/searxng/searxng/archive/${SEARXNG_REF}.tar.gz`, `searxng-${SEARXNG_REF}.tar.gz`, SEARXNG_TARBALL_SHA256, log)
  await extract(archive, src, 1)
  const reqs = path.join(src, 'requirements.txt')
  if (!(await exists(reqs))) throw new Error('SearXNG requirements.txt missing — did the archive layout change?')
  // SearXNG's setup.py imports runtime deps, so install requirements only and run from source.
  log(`pip install -r requirements.txt (SearXNG @ ${SEARXNG_REF.slice(0, 12)})`)
  await run(py, ['-m', 'pip', 'install', '--no-cache-dir', '--no-warn-script-location', '--disable-pip-version-check', '-r', reqs])
  if (process.platform === 'win32') {
    // POSIX-only import in a module we never use; it breaks import on Windows.
    const file = path.join(src, 'searx', 'valkeydb.py')
    if (await exists(file)) await fsp.writeFile(file, (await fsp.readFile(file, 'utf8')).replace(/^import pwd\r?\n/m, ''))
  }
  await fsp.copyFile(path.join(ROOT, 'resources', 'searxng', 'settings.yml'), path.join(stage, 'settings.yml'))
  log('verifying searx.webapp imports')
  const verifySettings = path.join(stage, '.verify-settings.yml')
  const template = await fsp.readFile(path.join(stage, 'settings.yml'), 'utf8')
  await fsp.writeFile(verifySettings, template.replaceAll('__PORT__', '8888').replace('__SECRET__', 'stage-verify-only-secret-0000000000'))
  await run(py, ['-c', 'import searx.webapp'], { cwd: src, env: { ...process.env, PYTHONPATH: src, SEARXNG_SETTINGS_PATH: verifySettings } })
  await rimraf(verifySettings)
}

async function slim(stage) {
  let removed = 0
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (['__pycache__', 'test', 'tests', 'pip'].includes(e.name) || /^pip-.*\.dist-info$/.test(e.name)) {
          removed += await dirSize(full)
          await rimraf(full)
        } else await walk(full)
      }
    }
  }
  await walk(path.join(stage, 'python'))
  log(`slimmed ${(removed / 1048576).toFixed(1)} MB (bytecode caches, tests, pip)`)
}

export async function stageSearxng({ force = false } = {}) {
  const tag = `${process.platform}-${process.arch}`
  if (!PBS_SHA256[tag]) {
    log(`no pinned CPython for ${tag}; skipping`)
    return
  }
  const marker = await readJson(path.join(STAGE, 'VERSION'))
  if (!force && marker?.python === PYTHON_VERSION && marker?.searxng === SEARXNG_REF && marker?.pbs === PBS_TAG && (await exists(pythonExe(STAGE)))) {
    // Always refresh the settings template so edits land without --force.
    await fsp.copyFile(path.join(ROOT, 'resources', 'searxng', 'settings.yml'), path.join(STAGE, 'settings.yml'))
    log(`cache hit: python ${PYTHON_VERSION} + searxng ${SEARXNG_REF.slice(0, 12)}`)
    return
  }
  await rimraf(STAGE)
  await ensureDir(STAGE)
  const asset = `cpython-${PYTHON_VERSION}+${PBS_TAG}-${TRIPLES[tag]}-install_only_stripped.tar.gz`
  const pbs = await fetchVerified(`https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${asset}`, asset, PBS_SHA256[tag], log)
  log('extracting CPython')
  await extract(pbs, STAGE)
  await installSearxng(STAGE)
  await slim(STAGE)
  await fsp.writeFile(path.join(STAGE, 'VERSION'), JSON.stringify({ python: PYTHON_VERSION, pbs: PBS_TAG, searxng: SEARXNG_REF, tag, stagedAt: new Date().toISOString() }, null, 2))
  log(`staged ${tag} → sidecars/searxng (${((await dirSize(STAGE)) / 1048576).toFixed(0)} MB)`)
}

if (isMain(import.meta.url)) {
  stageSearxng({ force: process.argv.includes('--force') }).catch((err) => {
    console.error('[stage-searxng] FAILED:', err.message ?? err)
    process.exit(1)
  })
}
