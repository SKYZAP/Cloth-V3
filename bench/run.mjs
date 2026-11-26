// The release benchmark: each Cloth mode and OMP do the same tasks with the same model, every run is scored with
// tests the agents never see, and the result is published to the dashboard (bench/site, served from BENCH_HOME/site).
// .github/workflows/bench.yml runs it for each release. (One benchmark is a "night" in the data files.)
//
//   node bench/run.mjs                (after `npm ci && npx electron-vite build` in the Cloth folder)
//
// Environment:
//   OPENAI_API_KEY        required
//   CLOTH_DIR             the built Cloth to measure (default: the repo this script is in)
//   BENCH_RELEASE         the release tag being measured, e.g. v1.5.0 (its id on the dashboard); unset: <date>-<commit>
//   BENCH_FORCE           set: measure a release again although it already has a result (saved as <tag>-2 …)
//   BENCH_HOME            data folder (default ~/cloth-bench): fixtures/berdbot.bundle, site/, results/, omp-cache/
//   OMP_VERSION           OMP release to compare against, e.g. 18.20.2 (downloaded to BENCH_HOME/bin)
//   OMP_BIN               use this installed OMP instead of downloading one (it must be OMP_VERSION)
//   OMP_RUNS_PER_VERSION  OMP runs to keep per task and arm (default 3); after that its results are reused until
//                         OMP_VERSION changes, since OMP itself didn't change
//   BENCH_ARMS            only these arms, e.g. cloth-chat,omp (default all)
//   BENCH_TASKS           only these tasks: berdbot, recon, todo, invoice (default all)
//   BENCH_MINUTES         time limit per run (default 60)
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { arch, homedir, hostname, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { BENCH, SEEDED, berdbotTemplate, row, runCloth, runOmp, scoreBerdbot, scoreRecon, scoreSeeded, sh, workspace } from './lib.mjs'

/** A link to one benchmark on the dashboard, when BENCH_URL says where it is served. */
const dash = (id) => (process.env.BENCH_URL ? ` · [dashboard](${process.env.BENCH_URL.replace(/\/$/, '')}/#${id})` : '')

const HOME = resolve(process.env.BENCH_HOME ?? join(homedir(), 'cloth-bench'))
const CLOTH = resolve(process.env.CLOTH_DIR ?? resolve(BENCH, '..'))
const RELEASE = process.env.BENCH_RELEASE || null
const MINUTES = Number(process.env.BENCH_MINUTES ?? 60)
const OMP_KEEP = Number(process.env.OMP_RUNS_PER_VERSION ?? 3)
const only = (v) => (v ? new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) : null)
const onlyArms = only(process.env.BENCH_ARMS)
const onlyTasks = only(process.env.BENCH_TASKS)

const TASKS = [
  { task: 'berdbot', name: 'Berdbot queue commands' },
  { task: 'recon', name: 'Order reconciler' },
  // Two tasks shaped for Spec → Ship: a feature across several parts of a small project, and a refactor that must not
  // change behaviour, quirks included.
  { task: 'todo', name: 'Todo: due dates and tags' },
  { task: 'invoice', name: 'Invoice refactor' }
]
const ARMS = [
  { arm: 'cloth-chat', harness: 'Cloth', mode: 'Chat', cloth: 'chat' },
  { arm: 'cloth-plan', harness: 'Cloth', mode: 'Plan', cloth: 'plan' },
  { arm: 'cloth-spec', harness: 'Cloth', mode: 'Spec → Ship', cloth: 'spec' },
  { arm: 'cloth-openspec', harness: 'Cloth', mode: 'OpenSpec', cloth: 'openspec' },
  { arm: 'omp', harness: 'OMP', mode: 'Default', plan: false },
  { arm: 'omp-plan', harness: 'OMP', mode: 'Plan (plan-yolo)', plan: true }
]

const log = (m) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}] ${m}`)
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback)

/** The OMP release binary for this machine, downloaded once and checked against the release's SHA256SUMS. */
async function ompBinary(version) {
  // OMP_BIN: an OMP already installed (its version is checked against OMP_VERSION).
  if (process.env.OMP_BIN) {
    const v = sh(process.env.OMP_BIN, ['--version']).stdout.trim()
    if (!v.includes(version)) throw new Error(`OMP_BIN is ${v || 'not runnable'}, not OMP ${version}`)
    return process.env.OMP_BIN
  }
  const os = platform() === 'darwin' ? 'darwin' : platform() === 'win32' ? 'windows' : 'linux'
  const asset = `omp-${os}-${arch() === 'arm64' ? 'arm64' : 'x64'}${os === 'windows' ? '.exe' : ''}`
  // The version before the extension: Windows runs only a name ending in .exe.
  const bin = join(HOME, 'bin', asset.replace(/(\.exe)?$/, `-${version}$1`))
  if (existsSync(bin)) return bin
  const base = `https://github.com/can1357/oh-my-pi/releases/download/v${version}`
  log(`downloading OMP ${version} (${asset})`)
  const get = async (url) => {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  const [data, sums] = await Promise.all([get(`${base}/${asset}`), get(`${base}/SHA256SUMS.txt`)])
  const want = sums
    .toString()
    .split('\n')
    .find((l) => l.trim().endsWith(asset))
    ?.split(/\s+/)[0]
  const got = createHash('sha256').update(data).digest('hex')
  if (!want || want !== got) throw new Error(`OMP ${asset} checksum mismatch (expected ${want}, got ${got})`)
  mkdirSync(join(HOME, 'bin'), { recursive: true })
  writeFileSync(bin, data)
  chmodSync(bin, 0o755)
  return bin
}

function publish(night) {
  const site = join(HOME, 'site')
  mkdirSync(join(site, 'data', 'nights'), { recursive: true })
  copyFileSync(join(BENCH, 'site', 'index.html'), join(site, 'index.html'))
  writeFileSync(join(site, 'data', 'nights', `${night.id}.json`), JSON.stringify(night))
  const index = readJson(join(site, 'data', 'index.json'), []).filter((n) => n.id !== night.id)
  const cost = night.rows.filter((r) => !r.cached).reduce((n, r) => n + (r.cost ?? 0), 0)
  index.unshift({ id: night.id, release: night.release, date: night.date, commit: night.commit, subject: night.subject, omp: night.omp, runs: night.rows.length, cost: +cost.toFixed(4), done: night.done })
  // Newest release first by version (an older release measured later still lands in its place), then by date.
  const ver = (n) => (n.release ?? '').replace(/^v/, '').split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  const byVersion = (a, b) => {
    const [x, y] = [ver(a), ver(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === y[i]) continue
      // A pre-release (1.5.0-beta) comes before its release (1.5.0).
      if (x[i] === undefined) return typeof y[i] === 'string' ? -1 : 1
      if (y[i] === undefined) return typeof x[i] === 'string' ? 1 : -1
      return x[i] < y[i] ? 1 : -1
    }
    return b.date.localeCompare(a.date)
  }
  index.sort((a, b) => (a.release && b.release ? byVersion(a, b) : b.date.localeCompare(a.date)))
  writeFileSync(join(site, 'data', 'index.json'), JSON.stringify(index, null, 1))
}

function summary(night) {
  const file = process.env.GITHUB_STEP_SUMMARY
  const lines = [`## Benchmark ${night.id}${night.done ? '' : ' (stopped early: partial results)'}`, '', `Cloth ${night.release ?? ''} \`${night.commit.slice(0, 7)}\` ${night.subject} · OMP ${night.omp ?? '—'} · GPT-6 Luna, medium${dash(night.id)}`, '']
  lines.push('| Task | Harness | Mode | Hidden tests | Minutes | Cost | Tokens | Tool calls | Note |', '|---|---|---|---|---|---|---|---|---|')
  for (const r of night.rows) {
    const note = [r.cached ? `reused from ${r.from}` : '', r.timed_out ? 'time limit' : '', r.error ?? ''].filter(Boolean).join('; ')
    lines.push(`| ${r.task} | ${r.harness} | ${r.mode} | ${r.hidden_passed}/${r.hidden_total} | ${r.minutes ?? '—'} | ${r.cost != null ? `$${r.cost.toFixed(3)}` : '—'} | ${r.tokens?.toLocaleString('en') ?? '—'} | ${r.tool_calls ?? '—'} | ${note} |`)
  }
  const text = lines.join('\n') + '\n'
  if (file) appendFileSync(file, text)
  else console.log(text)
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY')
  const commit = sh('git', ['rev-parse', 'HEAD'], { cwd: CLOTH }).stdout.trim()
  const subject = sh('git', ['log', '-1', '--format=%s'], { cwd: CLOTH }).stdout.trim()
  const date = new Date().toISOString()
  // A release is measured once, unless asked again (BENCH_FORCE).
  const base = RELEASE ?? `${date.slice(0, 10)}-${commit.slice(0, 7)}`
  const earlier = readJson(join(HOME, 'site', 'data', 'index.json'), []).find((n) => n.done && (n.id === base || n.id.startsWith(`${base}-`)))
  if (RELEASE && earlier && !process.env.BENCH_FORCE) {
    const note = `Skipped: ${RELEASE} was already benchmarked (${earlier.id}${dash(earlier.id)}). Run the workflow with "force" to measure it again.\n`
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, note)
    return log(note.trim())
  }
  let id = base
  for (let n = 2; existsSync(join(HOME, 'site', 'data', 'nights', `${id}.json`)); n++) id = `${base}-${n}`

  const arms = ARMS.filter((a) => !onlyArms || onlyArms.has(a.arm))
  const tasks = TASKS.filter((t) => !onlyTasks || onlyTasks.has(t.task))
  const ompVersion = arms.some((a) => a.harness === 'OMP') ? process.env.OMP_VERSION : null
  if (arms.some((a) => a.harness === 'OMP') && !ompVersion) throw new Error('Set OMP_VERSION')
  const omp = ompVersion ? await ompBinary(ompVersion) : null
  const night = { id, release: RELEASE, date, commit, subject, omp: ompVersion, host: hostname(), minutesLimit: MINUTES, done: false, rows: [] }
  const resultsDir = join(HOME, 'results', id)
  log(`${id}: ${arms.length} arms × ${tasks.length} tasks, results in ${resultsDir}`)
  // Stopped early (an error, or the job cancelled or timed out): still publish and summarise what finished.
  let finished = false
  const wrapUp = () => {
    if (finished) return
    finished = true
    try {
      publish(night)
    } catch (err) {
      log(`couldn't publish to the dashboard: ${err?.message ?? err}`)
    }
    summary(night)
  }
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.once(sig, () => {
      log(`${sig}: stopping`)
      wrapUp()
      process.exit(1)
    })
  try {
    await runAll(night, arms, tasks, omp, ompVersion, resultsDir)
    night.done = true
  } finally {
    wrapUp()
  }
  // Raw results (transcripts, logs, patches) for the last 14 benchmarks.
  const all = existsSync(join(HOME, 'results')) ? readdirSync(join(HOME, 'results')).sort() : []
  for (const old of all.slice(0, Math.max(0, all.length - 14))) rmSync(join(HOME, 'results', old), { recursive: true, force: true })
  const cloth = night.rows.filter((r) => r.harness === 'Cloth')
  if (cloth.length && cloth.every((r) => r.error)) throw new Error('Every Cloth run failed to start or report; see the results folder')
}

async function runAll(night, arms, tasks, omp, ompVersion, resultsDir) {
  const id = night.id

  for (const { task, name } of arms.length ? tasks : []) {
    const template = task === 'berdbot' ? berdbotTemplate(join(HOME, 'fixtures', 'berdbot.bundle'), join(HOME, 'work', 'berdbot-template')) : null
    const prompt = join(BENCH, 'tasks', task, 'prompt.txt')
    for (const a of arms) {
      const base = { task, task_name: name, arm: a.arm, harness: a.harness, mode: a.mode }
      // OMP didn't change since its last runs: reuse them once there are enough.
      const cacheDir = a.harness === 'OMP' ? join(HOME, 'omp-cache', ompVersion, `${task}-${a.arm}`) : null
      if (cacheDir) {
        const cached = existsSync(cacheDir) ? readdirSync(cacheDir).sort().map((f) => readJson(join(cacheDir, f))) : []
        if (cached.length >= OMP_KEEP) {
          for (const c of cached) night.rows.push({ ...c, ...base, cached: true, from: c.night })
          log(`${task} ${a.arm}: reusing ${cached.length} runs of OMP ${ompVersion}`)
          continue
        }
      }
      const out = join(resultsDir, `${task}-${a.arm}`)
      const ws = workspace(task, join(HOME, 'work', 'current', `${task}-${a.arm}`), template)
      log(`${task} ${a.arm}: running`)
      let r
      try {
        const result = a.harness === 'Cloth' ? await runCloth({ cloth: CLOTH, mode: a.cloth, ws, prompt, out, home: join(HOME, 'work', 'homes', `${task}-${a.arm}`), minutes: MINUTES }) : await runOmp({ omp, plan: a.plan, ws, prompt, out, minutes: MINUTES })
        const score = task === 'berdbot' ? scoreBerdbot(ws, out) : SEEDED.has(task) ? scoreSeeded(task, ws, out) : scoreRecon(ws, out)
        r = { ...row({ ...a, task, out, result, score }), ...base, night: id }
      } catch (err) {
        r = { ...base, night: id, error: String(err?.message ?? err).slice(0, 500), hidden_passed: 0, hidden_total: 0 }
      }
      night.rows.push(r)
      if (cacheDir && !r.error) {
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify(r))
      }
      rmSync(ws, { recursive: true, force: true })
      log(`${task} ${a.arm}: hidden ${r.hidden_passed}/${r.hidden_total}, ${r.minutes ?? '?'} min, $${r.cost ?? '?'}${r.error ? ` (${r.error})` : ''}`)
      publish(night)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
