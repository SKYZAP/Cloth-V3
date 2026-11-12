// Builds the Android APK: phone web bundle → Capacitor sync → Gradle.
// Usage: node scripts/mobile-apk.mjs [debug|release] [version]
import './system-ca.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const [mode = 'debug', version] = process.argv.slice(2)
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

const android = join(process.cwd(), 'mobile', 'android')
// Gradle needs the SDK location; fall back to the default Android Studio install.
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk'))
if (!existsSync(join(android, 'local.properties')) && existsSync(sdk)) writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdk.replaceAll('\\', '/')}\n`)

run('npx', ['vite', 'build', '--config', 'vite.mobile.config.ts'])
run('npx', ['cap', 'sync', 'android'])
const task = mode === 'release' ? 'assembleRelease' : 'assembleDebug'
run(process.platform === 'win32' ? `"${join(android, 'gradlew.bat')}"` : './gradlew', [task, '--console=plain', ...(version ? [`-PclothVersion=${version}`] : [])], android)
console.log(`\nAPK: mobile/android/app/build/outputs/apk/${mode}/`)
