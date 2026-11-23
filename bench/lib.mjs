// Runs one benchmark arm and scores it. Used by run.mjs; Linux (the Pi runs it under xvfb), macOS and Windows.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCH = fileURLToPath(new URL('.', import.meta.url))
export const BERDBOT_BASE = '0e0008c'
/** Tasks that start from a small project in tasks/<task>/seed, scored with tasks/<task>/hidden.test.mjs. */
export const SEEDED = new Set(['todo', 'invoice'])

const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const WIN = process.platform === 'win32'
/** Windows runs npm and npx through cmd.exe, which needs arguments with spaces quoted. */
const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
export const sh = (cmd, args, opts = {}) => {
  const viaShell = WIN && (cmd === 'npm' || cmd === 'npx')
  const r = spawnSync(cmd, viaShell ? args.map(quote) : args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000, shell: viaShell, ...opts })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' }
}
const must = (r, what) => {
  if (r.code !== 0) throw new Error(`${what} failed:\n${r.out.slice(-2000)}`)
  return r
}

/** Starts a program and waits for it, stopping it (and what it started) after `minutes`. */
function run(cmd, args, { cwd, env, minutes, log, hide = true }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // Its own process group (Linux, macOS), so a time limit stops everything it started.
    const p = spawn(cmd, args, { cwd, env, detached: !WIN, windowsHide: hide, stdio: ['ignore', 'pipe', 'pipe'] })
    const sink = createWriteStream(log)
    p.stdout.pipe(sink)
    p.stderr.pipe(sink)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (WIN) return void spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'])
      try {
        process.kill(-p.pid, 'SIGTERM')
        setTimeout(() => {
          try {
            process.kill(-p.pid, 'SIGKILL')
          } catch {}
        }, 10_000)
      } catch {}
    }, minutes * 60_000)
    const done = (code) => {
      clearTimeout(timer)
      sink.end(() => resolve({ code, seconds: Math.round((Date.now() - t0) / 1000), timedOut }))
    }
    p.on('error', () => done(-1))
    p.on('close', done)
  })
}

// ─── Workspaces ──────────────────────────────────────────────────────────────

/** Berdbot at the base commit with its dependencies installed and its Prisma client generated, made fresh each night. */
export function berdbotTemplate(bundle, dir) {
  rmSync(dir, { recursive: true, force: true })
  must(sh('git', ['clone', '-q', bundle, dir]), 'cloning berdbot')
  must(sh('git', ['checkout', '-q', '-B', 'main', BERDBOT_BASE], { cwd: dir }), 'checking out the base commit')
  sh('git', ['remote', 'remove', 'origin'], { cwd: dir })
  must(sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, timeout: 1_200_000 }), 'installing berdbot')
  must(sh('npx', ['prisma', 'generate'], { cwd: dir }), 'generating the Prisma client')
  return dir
}

export function workspace(task, dir, template) {
  rmSync(dir, { recursive: true, force: true })
  if (task === 'berdbot') {
    // A clone of the source, with the template's dependencies hard-linked in (a full copy takes minutes on the Pi).
    must(sh('git', ['clone', '-q', template, dir]), 'cloning the berdbot template')
    sh('git', ['remote', 'remove', 'origin'], { cwd: dir })
    if (WIN) {
      // No hard-link copy of a folder here: robocopy copies it (exit codes under 8 mean success).
      const r = sh('robocopy', [join(template, 'node_modules'), join(dir, 'node_modules'), '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 1_200_000 })
      if (r.code >= 8) throw new Error(`copying node_modules failed:
${r.out.slice(-2000)}`)
    } else must(sh('cp', ['-al', join(template, 'node_modules'), join(dir, 'node_modules')]), 'linking node_modules')
    return dir
  }
  // The reconciler starts from an empty folder, a seeded task from its seed project (a git repo either way, so every
  // harness sees the same thing).
  mkdirSync(dir, { recursive: true })
  if (SEEDED.has(task)) cpSync(join(BENCH, 'tasks', task, 'seed'), dir, { recursive: true })
  sh('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  git(['add', '-A'], dir)
  git(['commit', '-q', '--allow-empty', '-m', SEEDED.has(task) ? 'seed' : 'empty'], dir)
  return dir
}

// ─── Harnesses ───────────────────────────────────────────────────────────────

const noGitHub = (out) => ({ GH_CONFIG_DIR: join(out, 'no-gh'), GH_TOKEN: '', GITHUB_TOKEN: '' })

/** One Cloth mode through its modes probe (CLOTH_PROBE=modes): a real model, every question answered with its recommendation. */
export async function runCloth({ cloth, mode, ws, prompt, out, home, minutes }) {
  mkdirSync(out, { recursive: true })
  const electron = createRequire(join(cloth, 'package.json'))('electron')
  const linux = process.platform === 'linux'
  const [cmd, args] = linux ? ['xvfb-run', ['-a', electron, '--no-sandbox', '.']] : [electron, ['.']]
  const r = await run(cmd, args, {
    cwd: cloth,
    minutes: minutes + 10,
    // Started hidden on Windows, Cloth's window never shows, and the probe waits for it to.
    hide: false,
    log: join(out, 'app.log'),
    env: {
      ...process.env,
      ...noGitHub(out),
      // Not the machine's own homelab MCP servers (~/.homelab/env): a run sees only what the benchmark gives it.
      HOMELAB_ENV: join(out, 'no-homelab-env'),
      CLOTH_HOME: home,
      CLOTH_SMOKE: out,
      CLOTH_PROBE: 'modes',
      CLOTH_STARTUP_TRACE: '1',
      CLOTH_PROBE_MODE: mode,
      CLOTH_PROBE_WORKSPACE: ws,
      CLOTH_PROBE_PROMPT: prompt,
      CLOTH_PROBE_MODEL: 'gpt-6-luna',
      CLOTH_PROBE_THINKING: 'medium',
      CLOTH_PROBE_MINUTES: String(minutes)
    }
  })
  rmSync(home, { recursive: true, force: true })
  return r
}

/** OMP in print mode: GPT-6 Luna, medium, no skills/rules/extensions (plan: plan-yolo). */
export async function runOmp({ omp, plan, ws, prompt, out, minutes }) {
  mkdirSync(out, { recursive: true })
  const args = ['-p', '--model', 'openai/gpt-6-luna', '--thinking', 'medium', '--mode', 'json', '--no-skills', '--no-rules', '--no-extensions', '--no-title', '--no-session', '--auto-approve']
  if (plan) args.push('--plan-yolo', '--plan-yolo-into', 'openai/gpt-6-luna')
  args.push(readFileSync(prompt, 'utf8').trim())
  const r = await run(omp, args, { cwd: ws, minutes, log: join(out, 'events.jsonl'), env: { ...process.env, ...noGitHub(out) } })
  const u = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, toolCalls: 0, agents: 0 }
  for (const line of readFileSync(join(out, 'events.jsonl'), 'utf8').split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type !== 'message_end' || e.message?.role !== 'assistant') continue
    const m = e.message
    u.calls++
    u.input += m.usage?.input ?? 0
    u.output += m.usage?.output ?? 0
    u.cacheRead += m.usage?.cacheRead ?? 0
    u.cacheWrite += m.usage?.cacheWrite ?? 0
    u.cost += m.usage?.cost?.total ?? 0
    for (const c of m.content ?? []) {
      if (c.type !== 'toolCall') continue
      u.toolCalls++
      if (/^(task|Task|Agent)$/.test(c.name)) u.agents++
    }
  }
  writeFileSync(join(out, 'usage.json'), JSON.stringify(u, null, 2))
  return r
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/** Berdbot: its own tests and build as the agent left them, lint on changed files, then the hidden acceptance suite. */
export function scoreBerdbot(repo, out) {
  const npx = (args, opts) => sh('npx', args, { cwd: repo, ...opts })
  const jest = (args, file) => {
    npx(['jest', ...args, '--json', `--outputFile=${file}`])
    const j = read(file)
    return { tests: j?.numTotalTests ?? 0, passed: j?.numPassedTests ?? 0, failed: j?.numFailedTests ?? 0, failures: (j?.testResults ?? []).flatMap((s) => s.assertionResults.filter((a) => a.status !== 'passed').map((a) => `${a.ancestorTitles.join(' › ')} › ${a.title}`)) }
  }
  const own = jest([], join(out, 'own-tests.json'))
  const build = sh('npm', ['run', 'build'], { cwd: repo })
  sh('git', ['add', '-A'], { cwd: repo })
  const numstat = sh('git', ['diff', '--cached', '--numstat', BERDBOT_BASE], { cwd: repo })
    .stdout.trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [a, d, path] = l.split('\t')
      return { path, added: Number(a) || 0, removed: Number(d) || 0 }
    })
  writeFileSync(join(out, 'changes.patch'), sh('git', ['diff', '--cached', BERDBOT_BASE, '--', '.', ':!package-lock.json'], { cwd: repo }).stdout)
  const changedTs = numstat.map((f) => f.path).filter((p) => /^src\/.*\.ts$/.test(p) && existsSync(join(repo, p)))
  let lintErrors = null
  if (changedTs.length) {
    const lint = npx(['eslint', '--no-fix', '--format', 'json', ...changedTs])
    try {
      lintErrors = JSON.parse(lint.stdout.slice(lint.stdout.indexOf('['))).reduce((n, f) => n + f.errorCount, 0)
    } catch {}
  } else lintErrors = 0
  const target = join(repo, 'src/modules/discord/commands/music/zz-hidden-acceptance.spec.ts')
  copyFileSync(join(BENCH, 'tasks/berdbot/hidden.spec.ts'), target)
  const hidden = jest(['zz-hidden'], join(out, 'hidden-tests.json'))
  rmSync(target)
  sh('git', ['reset', '-q'], { cwd: repo })
  const score = {
    hidden: { passed: hidden.passed, total: hidden.tests, failures: hidden.failures },
    own: { tests: own.tests, pass: own.failed === 0 && own.tests > 0, failures: own.failures },
    build: { ok: build.code === 0 },
    lintErrors,
    linesAdded: numstat.reduce((n, f) => n + (f.path === 'package-lock.json' ? 0 : f.added), 0),
    files: numstat.length
  }
  writeFileSync(join(out, 'score.json'), JSON.stringify(score, null, 2))
  return score
}

/** Order reconciler: the hidden node:test suite, then the agent's own `npm test`. */
export function scoreRecon(dir, out) {
  const r = sh(process.execPath, ['--test', '--test-reporter=spec', 'acceptance.test.mjs'], { cwd: join(BENCH, 'tasks/recon'), env: { ...process.env, BENCH_DIR: dir }, timeout: 300_000 })
  const num = (k) => Number(r.out.match(new RegExp(`ℹ ${k} (\\d+)`))?.[1] ?? 0)
  const failures = [...new Set([...r.out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]).filter((t) => !/^(failing tests|tests)/.test(t)))]
  const own = existsSync(join(dir, 'package.json')) ? sh('npm', ['test'], { cwd: dir, timeout: 300_000 }) : { code: 1, out: '' }
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').length : 0)
  let testLines = 0
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.git') continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/test/i.test(p) && /\.m?js$/.test(e)) testLines += lines(p)
    }
  }
  walk(dir)
  const score = {
    hidden: { passed: num('pass'), total: num('tests'), failures },
    own: { tests: Number(own.out.match(/ℹ tests (\d+)/)?.[1] ?? own.out.match(/# tests (\d+)/)?.[1] ?? 0), pass: own.code === 0, failures: [] },
    build: { ok: null },
    lintErrors: null,
    linesAdded: lines(join(dir, 'reconcile.mjs')) + testLines + lines(join(dir, 'README.md'))
  }
  writeFileSync(join(out, 'score.json'), JSON.stringify(score, null, 2))
  return score
}

const git = (args, cwd) => sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...args], { cwd })

/** A seeded task: its hidden node:test suite, the agent's own `npm test`, and what changed since the seed. */
export function scoreSeeded(task, dir, out) {
  const r = sh(process.execPath, ['--test', '--test-reporter=spec', 'hidden.test.mjs'], { cwd: join(BENCH, 'tasks', task), env: { ...process.env, BENCH_DIR: dir }, timeout: 300_000 })
  writeFileSync(join(out, 'hidden-tests.txt'), r.out)
  const num = (k) => Number(r.out.match(new RegExp(`ℹ ${k} (\\d+)`))?.[1] ?? 0)
  const failures = [...new Set([...r.out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]).filter((t) => !/^(failing tests|tests)/.test(t)))]
  const own = sh('npm', ['test'], { cwd: dir, timeout: 300_000 })
  git(['add', '-A'], dir)
  writeFileSync(join(out, 'changes.patch'), git(['diff', '--cached', 'HEAD'], dir).stdout)
  const numstat = git(['diff', '--cached', '--numstat', 'HEAD'], dir).stdout.trim().split('\n').filter(Boolean)
  git(['reset', '-q'], dir)
  const score = {
    hidden: { passed: num('pass'), total: num('tests'), failures },
    own: { tests: Number(own.out.match(/ℹ tests (\d+)/)?.[1] ?? own.out.match(/# tests (\d+)/)?.[1] ?? 0), pass: own.code === 0, failures: [] },
    build: { ok: null },
    lintErrors: null,
    linesAdded: numstat.reduce((n, l) => n + (Number(l.split('\t')[0]) || 0), 0),
    files: numstat.length
  }
  writeFileSync(join(out, 'score.json'), JSON.stringify(score, null, 2))
  return score
}

// ─── One row of the dashboard ────────────────────────────────────────────────

export function row({ task, arm, harness, mode, out, result, score }) {
  const r = { task, arm, harness, mode, model: 'GPT-6 Luna', effort: 'Medium', exit: result.code, timed_out: result.timedOut }
  if (harness === 'Cloth') {
    const rep = read(join(out, 'report.json'))
    if (rep) {
      const t = rep.totals
      Object.assign(r, {
        minutes: rep.minutes,
        tokens: t.input + t.cached + t.output + t.agentInput + t.agentCached + t.agentOutput,
        output_tokens: t.output + t.agentOutput,
        cost: +(t.cost + t.agentCost).toFixed(4),
        tool_calls: t.toolCalls,
        agents: t.agentRuns,
        questions: rep.questions
      })
    } else r.error = 'Cloth wrote no report (see app.log)'
  } else {
    const u = read(join(out, 'usage.json'))
    Object.assign(r, {
      minutes: +(result.seconds / 60).toFixed(2),
      tokens: u.input + u.output + u.cacheRead + u.cacheWrite,
      output_tokens: u.output,
      cost: +u.cost.toFixed(4),
      tool_calls: u.toolCalls,
      agents: u.agents,
      questions: 0
    })
    if (!u.calls) r.error = 'OMP made no model calls (see events.jsonl)'
  }
  Object.assign(r, {
    hidden_passed: score.hidden.passed,
    hidden_total: score.hidden.total,
    hidden_failures: score.hidden.failures.slice(0, 20),
    own_tests: score.own.tests,
    own_pass: score.own.pass,
    build_ok: score.build.ok,
    lint_errors: score.lintErrors,
    lines_added: score.linesAdded
  })
  return r
}
