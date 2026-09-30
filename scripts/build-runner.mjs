#!/usr/bin/env node
// Build the Flow Runner — the app template every exported flow is packaged with — and stage the
// installer builder (NSIS). Cloth ships both (extraResources), so exporting a flow needs no network.
//
//   node scripts/build-runner.mjs
//
// Output:
//   build/runner-dist/win-unpacked   the packaged runner (FlowRunner.exe + resources/app.asar)
//   build/nsis                       makensis and its includes
import { spawnSync } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
const stage = path.join(root, 'build', 'runner-app')
const dist = path.join(root, 'build', 'runner-dist')
const log = (m) => console.log(`[build-runner] ${m}`)

if (process.platform !== 'win32') {
  log('Flow app export is Windows-only for now — skipping')
  process.exit(0)
}

// 1 — compile main / preload / renderer
log('compiling')
const vite = spawnSync(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--config', 'electron.runner.config.ts'], { cwd: root, stdio: 'inherit' })
if (vite.status !== 0) process.exit(vite.status ?? 1)

// 2 — stage an app folder: compiled output + the native modules the bundle leaves external
log('staging')
await fsp.rm(stage, { recursive: true, force: true })
await fsp.mkdir(stage, { recursive: true })
await fsp.cp(path.join(root, 'out', 'runner'), path.join(stage, 'out', 'runner'), { recursive: true })
const natives = ['@ast-grep/napi', `@ast-grep/napi-${process.platform}-${process.arch}-msvc`]
const deps = {}
for (const name of natives) {
  const dir = path.join(root, 'node_modules', ...name.split('/'))
  await fsp.cp(dir, path.join(stage, 'node_modules', ...name.split('/')), { recursive: true })
  deps[name] = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')).version
}
await fsp.writeFile(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'cloth-flow-runner', productName: 'FlowRunner', version: pkg.version, description: 'Runs a flow exported from Cloth', author: 'Cloth', type: 'module', main: 'out/runner/main/index.js', dependencies: deps }, null, 2)
)

// 3 — package once (no installer: Cloth wraps each export in its own)
log('packaging')
const { build, Platform } = require('electron-builder')
await fsp.rm(dist, { recursive: true, force: true })
await build({
  projectDir: stage,
  targets: Platform.WINDOWS.createTarget('dir'),
  config: {
    appId: 'dev.cloth.flowrunner',
    productName: 'FlowRunner',
    electronVersion: require('electron/package.json').version,
    directories: { output: dist, buildResources: path.join(root, 'resources') },
    files: ['out/**', 'package.json', 'node_modules/**', '!**/*.map'],
    asar: true,
    asarUnpack: ['node_modules/@ast-grep/**'],
    npmRebuild: false,
    electronLanguages: ['en-US'],
    icon: path.join(root, 'resources', 'icon.png'),
    win: { target: 'dir', signAndEditExecutable: true }
  }
})
log(`runner ready: ${path.join(dist, 'win-unpacked')}`)

// 4 — NSIS for building each export's installer (electron-builder's pinned, checksummed copy)
log('staging NSIS')
const { getBinFromUrl } = require('app-builder-lib/out/binDownload')
const nsisSrc = await getBinFromUrl('nsis-3.0.4.1', 'nsis-3.0.4.1.7z', '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa')
const nsisOut = path.join(root, 'build', 'nsis')
await fsp.rm(nsisOut, { recursive: true, force: true })
await fsp.cp(nsisSrc, nsisOut, { recursive: true, filter: (src) => !/[\\/](linux|mac)([\\/]|$)/.test(path.relative(nsisSrc, src) ? `/${path.relative(nsisSrc, src)}` : '') })
log(`NSIS ready: ${nsisOut}`)
