// Formatters and linters for the files an agent changed: which ones a folder uses, where each program is, the command
// that runs it, and running them after a change (Settings → Chat → Formatting and linting, "Cloth runs them").
// A folder's own config and copy always come first; Cloth's copies (bundled Prettier, installed Ruff, …) stand in only
// where a folder has none, and only when the user asked for that.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, sep } from 'node:path'
import type { CodeChecks, FormatToolId } from '@shared/formatters'
import { installedFormatter } from './formatter-install'
import { findOnPath } from './lsp'

/** How to start a program: a command and the arguments that come before the tool's own. */
export interface Launch {
  cmd: string
  pre: string[]
  env?: NodeJS.ProcessEnv
  /** Shown to the agent: how to run it in a terminal. */
  display: string
  /** Where it came from: the folder's own copy, Cloth's, or this PC's. */
  from: 'folder' | 'cloth' | 'pc'
}

interface ToolDef {
  id: FormatToolId
  name: string
  exts: string[]
  /** The folder is set up for it (config file, or listed in its project file). */
  configured(root: string): boolean
  /** Works sensibly without a config of the folder's own (noSetup: defaults). */
  worksWithoutConfig: boolean
  /** The folder must have it set up, whatever noSetup says (ESLint's rules are the project's). */
  needsConfig?: boolean
  launch(root: string, toolsDir: string | null): Launch | null
  /** Arguments for the files (relative to root): fixing or only checking. Null when it runs once for the folder. */
  args(files: string[], fix: boolean, root: string): string[][]
  /** Seconds before it's stopped. */
  timeout?: number
}

const JS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const PRETTIER_EXTS = [...JS, '.css', '.scss', '.less', '.html', '.vue', '.json', '.jsonc', '.yaml', '.yml', '.md', '.mdx', '.graphql']
const has = (root: string, ...names: string[]) => names.some((n) => existsSync(join(root, n)))
const readText = (p: string) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
function packageJson(root: string): { prettier?: unknown; eslintConfig?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  try {
    return JSON.parse(readText(join(root, 'package.json')) || '{}')
  } catch {
    return {}
  }
}
const dependsOn = (root: string, pkg: string) => {
  const p = packageJson(root)
  return !!(p.dependencies?.[pkg] || p.devDependencies?.[pkg])
}
const pyproject = (root: string, table: string) => new RegExp(`^\\[tool\\.${table}(\\.|\\])`, 'm').test(readText(join(root, 'pyproject.toml')))
const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

/** Electron runs a Node script as Node with this set. */
const NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const node = (script: string, display: string, from: Launch['from']): Launch => ({ cmd: process.execPath, pre: [script], env: NODE_ENV, display, from })

/** A Node package's command from the folder's node_modules (its package.json `bin`), run with Cloth's own Node. */
function folderNodeBin(root: string, pkg: string, bin: string): Launch | null {
  const dir = join(root, 'node_modules', pkg)
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> }
    const rel = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[bin]
    if (!rel || !existsSync(join(dir, rel))) return null
    return node(join(dir, rel), `npx ${bin}`, 'folder')
  } catch {
    return null
  }
}

/** A program from the folder's Python virtual environment. */
function venvProgram(root: string, program: string): Launch | null {
  for (const env of ['.venv', 'venv', 'env']) {
    const p = process.platform === 'win32' ? join(root, env, 'Scripts', exe(program)) : join(root, env, 'bin', program)
    if (existsSync(p)) return { cmd: p, pre: [], display: relative(root, p).split(sep).join('/'), from: 'folder' }
  }
  return null
}

function onPath(program: string): Launch | null {
  const p = findOnPath(program)
  return p ? { cmd: p, pre: [], display: program, from: 'pc' } : null
}

function cloths(toolsDir: string | null, id: FormatToolId): Launch | null {
  if (!toolsDir) return null
  const p = installedFormatter(toolsDir, id)
  if (!p) return null
  if (p.endsWith('.jar')) {
    const java = findOnPath('java')
    return java ? { cmd: java, pre: ['-jar', p], display: `java -jar "${p}"`, from: 'cloth' } : null
  }
  return { cmd: p, pre: [], display: `"${p}"`, from: 'cloth' }
}

let bundledPrettier: string | null | undefined
function prettierScript(): string | null {
  if (bundledPrettier !== undefined) return bundledPrettier
  try {
    // Paths inside app.asar can't be run; electron-builder unpacks Prettier next to it (package.json asarUnpack).
    const req = createRequire(import.meta.url)
    bundledPrettier = join(dirname(req.resolve('prettier/package.json')), 'bin', 'prettier.cjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    if (!existsSync(bundledPrettier)) bundledPrettier = null
  } catch {
    bundledPrettier = null
  }
  return bundledPrettier
}

const RUST_EDITION = (root: string) => /^\s*edition\s*=\s*"(\d{4})"/m.exec(readText(join(root, 'Cargo.toml')))?.[1] ?? '2021'

export const TOOLS: ToolDef[] = [
  {
    id: 'biome',
    name: 'Biome',
    exts: [...JS, '.json', '.jsonc', '.css'],
    configured: (root) => has(root, 'biome.json', 'biome.jsonc'),
    worksWithoutConfig: false,
    launch: (root, dir) => folderNodeBin(root, '@biomejs/biome', 'biome') ?? cloths(dir, 'biome') ?? onPath('biome'),
    args: (files, fix) => [['check', ...(fix ? ['--write'] : []), '--no-errors-on-unmatched', ...files]]
  },
  {
    id: 'prettier',
    name: 'Prettier',
    exts: PRETTIER_EXTS,
    configured: (root) =>
      has(root, '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.json5', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts') ||
      !!packageJson(root).prettier ||
      dependsOn(root, 'prettier'),
    worksWithoutConfig: true,
    launch: (root) => {
      const own = folderNodeBin(root, 'prettier', 'prettier')
      if (own) return own
      const script = prettierScript()
      return script ? node(script, 'prettier', 'cloth') : null
    },
    args: (files, fix) => [[fix ? '--write' : '--check', '--ignore-unknown', ...files]]
  },
  {
    id: 'eslint',
    name: 'ESLint',
    exts: JS,
    configured: (root) => has(root, 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml') || !!packageJson(root).eslintConfig,
    worksWithoutConfig: false,
    needsConfig: true,
    launch: (root) => folderNodeBin(root, 'eslint', 'eslint'),
    args: (files, fix) => [[...(fix ? ['--fix'] : []), '--no-warn-ignored', ...files]]
  },
  {
    id: 'black',
    name: 'Black',
    exts: ['.py', '.pyi'],
    configured: (root) => pyproject(root, 'black'),
    worksWithoutConfig: false,
    launch: (root) => venvProgram(root, 'black') ?? onPath('black'),
    args: (files, fix) => [[...(fix ? [] : ['--check']), '--quiet', ...files]]
  },
  {
    id: 'ruff',
    name: 'Ruff',
    exts: ['.py', '.pyi'],
    configured: (root) => has(root, 'ruff.toml', '.ruff.toml') || pyproject(root, 'ruff'),
    worksWithoutConfig: true,
    launch: (root, dir) => venvProgram(root, 'ruff') ?? cloths(dir, 'ruff') ?? onPath('ruff'),
    // Formatting is left to Black where the folder uses Black (see plan()); the format step is dropped there.
    args: (files, fix) => [['format', ...(fix ? [] : ['--check']), ...files], ['check', ...(fix ? ['--fix'] : []), '--output-format', 'concise', ...files]]
  },
  {
    id: 'gofmt',
    name: 'gofmt',
    exts: ['.go'],
    configured: (root) => has(root, 'go.mod'),
    worksWithoutConfig: true,
    launch: () => onPath('gofmt'),
    args: (files, fix) => [[fix ? '-w' : '-l', ...files]]
  },
  {
    id: 'golangci-lint',
    name: 'golangci-lint',
    exts: ['.go'],
    configured: (root) => has(root, '.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'),
    worksWithoutConfig: true,
    launch: (root, dir) => cloths(dir, 'golangci-lint') ?? onPath('golangci-lint'),
    // It works on packages: the folders the changed files are in.
    args: (files, fix) => [['run', ...(fix ? ['--fix'] : []), ...[...new Set(files.map((f) => `./${dirname(f).split(sep).join('/')}/`.replace('/./', '/')))]]],
    timeout: 120
  },
  {
    id: 'rustfmt',
    name: 'rustfmt',
    exts: ['.rs'],
    configured: (root) => has(root, 'Cargo.toml', 'rustfmt.toml', '.rustfmt.toml'),
    worksWithoutConfig: true,
    launch: () => onPath('rustfmt'),
    args: (files, fix, root) => [['--edition', RUST_EDITION(root), ...(fix ? [] : ['--check']), ...files]]
  },
  {
    id: 'clippy',
    name: 'Clippy',
    exts: ['.rs'],
    configured: (root) => has(root, 'Cargo.toml'),
    worksWithoutConfig: false,
    needsConfig: true,
    launch: () => {
      const cargo = onPath('cargo')
      return cargo ? { ...cargo, pre: ['clippy'], display: 'cargo clippy' } : null
    },
    args: (_files, fix) => [[...(fix ? ['--fix', '--allow-dirty', '--allow-staged', '--allow-no-vcs'] : []), '--quiet', '--message-format', 'short']],
    timeout: 240
  },
  {
    id: 'clang-format',
    name: 'clang-format',
    exts: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
    configured: (root) => has(root, '.clang-format', '_clang-format'),
    worksWithoutConfig: true,
    launch: () => onPath('clang-format'),
    args: (files, fix) => [[...(fix ? ['-i'] : ['--dry-run', '--Werror']), ...files]]
  },
  {
    id: 'google-java-format',
    name: 'google-java-format',
    exts: ['.java'],
    configured: () => false,
    worksWithoutConfig: true,
    launch: (_root, dir) => cloths(dir, 'google-java-format') ?? onPath('google-java-format'),
    args: (files, fix) => [[fix ? '--replace' : '--dry-run', ...files]]
  }
]

export interface PlannedRun {
  tool: ToolDef
  files: string[]
  launch: Launch
  /** Argument lists, one run each. */
  runs: string[][]
}

/** A tool the folder is set up for that isn't there to run (e.g. Prettier in package.json before npm install). */
export interface MissingTool {
  name: string
  files: string[]
}

/**
 * Which tools to run on these files (relative to root) under these settings: the folder's own setup first, then,
 * when noSetup is "defaults", Cloth's copies for files nothing else covers. Biome stands in for Prettier and ESLint
 * where the folder uses it, and Black for Ruff's formatter.
 */
export function plan(root: string, files: string[], checks: CodeChecks, toolsDir: string | null): { runs: PlannedRun[]; missing: MissingTool[] } {
  const runs: PlannedRun[] = []
  const missing: MissingTool[] = []
  const on = (id: FormatToolId) => !checks.off.includes(id)
  const configured = new Map(TOOLS.map((t) => [t.id, t.configured(root)]))
  const biome = on('biome') && configured.get('biome')
  const black = on('black') && configured.get('black')
  for (const tool of TOOLS) {
    if (!on(tool.id)) continue
    if (biome && (tool.id === 'prettier' || tool.id === 'eslint')) continue
    const mine = files.filter((f) => tool.exts.includes(extname(f).toLowerCase()))
    if (!mine.length) continue
    const isSet = configured.get(tool.id)!
    if (!isSet && (tool.needsConfig || checks.noSetup === 'skip' || !tool.worksWithoutConfig)) continue
    const launch = tool.launch(root, toolsDir)
    if (!launch) {
      if (isSet) missing.push({ name: tool.name, files: mine })
      continue
    }
    // A folder without its own setup gets only Cloth's or this PC's copy when asked for defaults; its own copy counts as setup.
    let toolRuns = tool.args(mine, checks.fix, root)
    if (tool.id === 'ruff' && black) toolRuns = toolRuns.filter((a) => a[0] !== 'format')
    runs.push({ tool, files: mine, launch, runs: toolRuns })
  }
  return { runs, missing }
}

export interface RunResult {
  ok: boolean
  output: string
  timedOut?: boolean
}

export type Runner = (launch: Launch, args: string[], cwd: string, timeoutSec: number, signal?: AbortSignal) => Promise<RunResult>

export const runTool: Runner = (launch, args, cwd, timeoutSec, signal) =>
  new Promise((resolve) => {
    execFile(launch.cmd, [...launch.pre, ...args], { cwd, env: launch.env ?? process.env, timeout: timeoutSec * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
      const e = err as (Error & { killed?: boolean; code?: unknown }) | null
      resolve({ ok: !e, output, ...(e?.killed ? { timedOut: true } : {}) })
    })
  })

/** Output trimmed for a note: the first lines, with paths made relative to the folder. */
function brief(output: string, root: string, max = 12): string {
  const lines = output.split(/\r?\n/).map((l) => l.split(root + sep).join('').split(root.split(sep).join('/') + '/').join('')).filter((l) => l.trim())
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`].join('\n') : lines.join('\n')
}

/**
 * Run the folder's formatters and linters on files that just changed (absolute paths) and say what happened, for the
 * agent: what got reformatted (read it again before editing it), and what's left to fix. Never throws.
 */
export async function checkChanged(
  root: string,
  absFiles: string[],
  checks: CodeChecks,
  opts: { toolsDir: string | null; run?: Runner; signal?: AbortSignal } = { toolsDir: null }
): Promise<string[]> {
  const rel = absFiles.map((f) => relative(root, f).split(sep).join('/')).filter((f) => f && !f.startsWith('..'))
  if (!rel.length || checks.when !== 'cloth') return []
  const { runs, missing } = plan(root, rel, checks, opts.toolsDir)
  const run = opts.run ?? runTool
  const notes: string[] = missing.map((m) => `${m.name} is set up in this folder but isn't installed, so ${m.files.join(', ')} weren't checked with it. Install the folder's dependencies to use it.`)
  for (const r of runs) {
    const before = new Map<string, string>()
    if (checks.fix) for (const f of r.files) before.set(f, await readFile(join(root, f), 'utf8').catch(() => ''))
    const outputs: string[] = []
    let failed = false
    for (const args of r.runs) {
      const res = await run(r.launch, args, root, r.tool.timeout ?? 30, opts.signal)
      if (res.timedOut) {
        notes.push(`${r.tool.name} took too long and was stopped.`)
        failed = false
        outputs.length = 0
        break
      }
      // gofmt -l lists the files that need formatting and still exits 0.
      if (!res.ok || (r.tool.id === 'gofmt' && !checks.fix && res.output)) failed = true
      if (res.output) outputs.push(res.output)
    }
    if (checks.fix) {
      const changed: string[] = []
      for (const f of r.files) if ((await readFile(join(root, f), 'utf8').catch(() => '')) !== before.get(f)) changed.push(f)
      if (changed.length) notes.push(`${r.tool.name} fixed ${changed.join(', ')}. Read ${changed.length === 1 ? 'it' : 'them'} again before editing ${changed.length === 1 ? 'it' : 'them'} further.`)
    }
    if (failed) notes.push(`${r.tool.name} found problems${checks.fix ? ' it couldn’t fix' : ''}:\n${brief(outputs.join('\n'), root) || '(no details)'}`)
    else if (!checks.fix) notes.push(`✓ ${r.tool.name}: ${r.files.join(', ')} ${r.files.length === 1 ? 'is' : 'are'} clean`)
  }
  return notes
}

/**
 * The instruction for "the agent runs them": the commands this folder uses, so the agent doesn't have to look for them.
 * Null when nothing applies (a folder with no setup, and Cloth's defaults not wanted).
 */
export function agentInstruction(root: string, checks: CodeChecks, toolsDir: string | null): string | null {
  if (checks.when !== 'agent') return null
  const on = (id: FormatToolId) => !checks.off.includes(id)
  const lines: string[] = []
  const biome = on('biome') && TOOLS.find((t) => t.id === 'biome')!.configured(root)
  for (const tool of TOOLS) {
    if (!on(tool.id)) continue
    if (biome && (tool.id === 'prettier' || tool.id === 'eslint')) continue
    const isSet = tool.configured(root)
    if (!isSet && (tool.needsConfig || checks.noSetup === 'skip' || !tool.worksWithoutConfig)) continue
    const launch = tool.launch(root, toolsDir)
    if (!launch) continue
    const example = tool.args(['<files>'], checks.fix, root).map((a) => `${launch.display} ${a.join(' ')}`.replace(/ \.\/<files>\/?$/, ' <folders of the files>'))
    lines.push(`- ${tool.name} (${tool.exts.slice(0, 4).join(' ')}${tool.exts.length > 4 ? ' …' : ''}): ${example.map((e) => `\`${e}\``).join(', then ')}`)
  }
  const how = checks.fix ? 'with their fixes on, and fix by hand what they still report' : 'and fix what they report'
  if (!lines.length) return `Before you finish a code change, run the project’s own formatter and linter on the files you changed (its format or lint script, when it has one) ${how}.`
  return [`Before you finish a code change, run these on the files you changed (only those, never the whole folder) ${how}:`, ...lines].join('\n')
}
