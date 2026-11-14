import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Dependency, DependencyReport } from '@shared/deps'
import type { Ctx } from './core/context'
import { bundledOpenSpec } from './agent/openspec'
import { run } from './web/process'

/*
 * Settings → Dependencies: what Cloth ships (from the VERSION files the staging scripts write) and which
 * programs it uses from this PC (each asked for its version). Checking runs a few short commands, so the
 * result is kept until the person checks again.
 */

const TIMEOUT = 8000

/** Run a program and return its output, or null when it isn't there or fails. */
async function probe(file: string, args: string[]): Promise<string | null> {
  try {
    const r = await run(file, args, { timeoutMs: TIMEOUT })
    return r.code === 0 ? `${r.stdout}\n${r.stderr}`.trim() : null
  } catch {
    return null
  }
}

/** The first x.y or x.y.z in a program's output. */
export function versionIn(out: string | null): string | null {
  return out ? (/(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1] ?? null) : null
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export class DependencyService {
  private last: DependencyReport | null = null
  private checking: Promise<DependencyReport> | null = null

  constructor(private ctx: Ctx) {}

  /** The last check, or a first one. */
  async list(): Promise<DependencyReport> {
    return this.last ?? this.refresh()
  }

  async refresh(): Promise<DependencyReport> {
    this.checking ??= this.check().finally(() => (this.checking = null))
    this.last = await this.checking
    return this.last
  }

  private bundled(): Dependency[] {
    const dir = this.ctx.sidecarsDir
    const obscura = readJson(join(dir, 'obscura', 'VERSION'))
    const obscuraBin = join(dir, 'obscura', process.platform === 'win32' ? 'obscura.exe' : 'obscura')
    const searx = readJson(join(dir, 'searxng', 'VERSION'))
    const searxOk = existsSync(join(dir, 'searxng', 'src', 'searxng', 'searx'))
    const openspec = bundledOpenSpec()
    const missing = 'Not in this build. In development, run `npm run sidecars`.'
    return [
      {
        id: 'obscura',
        name: 'Obscura',
        source: 'bundled',
        status: existsSync(obscuraBin) ? 'ok' : 'missing',
        version: typeof obscura?.version === 'string' ? obscura.version : null,
        usedFor: 'Web search and reading web pages',
        ...(existsSync(obscuraBin) ? {} : { detail: missing })
      },
      {
        id: 'searxng',
        name: 'SearXNG',
        source: 'bundled',
        status: searxOk ? 'ok' : 'missing',
        version: typeof searx?.searxng === 'string' ? `${searx.searxng.slice(0, 7)}${typeof searx.python === 'string' ? ` · Python ${searx.python}` : ''}` : null,
        usedFor: 'The local search engine web search uses, unless you set your own in Web search',
        ...(searxOk ? {} : { detail: missing })
      },
      {
        id: 'openspec',
        name: 'OpenSpec CLI',
        source: 'bundled',
        status: openspec ? 'ok' : 'missing',
        version: openspec?.version ?? null,
        usedFor: 'OpenSpec mode: proposals, specs, validation and archiving',
        ...(openspec ? {} : { detail: `${missing} Without it, OpenSpec mode uses an openspec on the PATH.` })
      }
    ]
  }

  private async check(): Promise<DependencyReport> {
    const win = process.platform === 'win32'
    const [git, gh, ghAuth, docker, dockerServer, node, python, bash, pwsh] = await Promise.all([
      probe('git', ['--version']),
      probe('gh', ['--version']),
      probe('gh', ['auth', 'status']),
      probe('docker', ['--version']),
      probe('docker', ['version', '--format', '{{.Server.Version}}']),
      probe('node', ['--version']),
      (async () => (await probe('python3', ['--version'])) ?? (await probe('python', ['--version'])) ?? (win ? await probe('py', ['-3', '--version']) : null))(),
      probe('bash', ['--version']),
      win ? probe('pwsh', ['--version']) : Promise.resolve(null)
    ])
    // On Windows, `bash` can be WSL's launcher rather than a real bash (Git Bash prints "GNU bash").
    const realBash = bash && /GNU bash/i.test(bash) ? bash : null
    const system: Dependency[] = [
      {
        id: 'git',
        name: 'Git',
        source: 'system',
        status: git ? 'ok' : 'missing',
        version: versionIn(git),
        usedFor: 'The Changes panel, Spec → Ship, and Boards (separate copies of your code, commits, applying changes)',
        ...(git ? {} : { detail: 'Those features stop with an error until Git is installed.' }),
        url: 'https://git-scm.com/downloads'
      },
      {
        id: 'gh',
        name: 'GitHub CLI',
        source: 'system',
        status: !gh ? 'missing' : ghAuth ? 'ok' : 'warn',
        version: versionIn(gh),
        usedFor: 'Pull requests: Boards set to “Commit and open a PR”, and OpenSpec’s Ship step',
        ...(!gh ? { detail: 'Boards can still build without commits or commit locally.' } : ghAuth ? {} : { detail: 'Installed but not signed in. Run `gh auth login` in a terminal.' }),
        url: 'https://cli.github.com'
      },
      {
        id: 'docker',
        name: 'Docker',
        source: 'system',
        status: !docker ? 'missing' : dockerServer ? 'ok' : 'warn',
        version: versionIn(dockerServer) ?? versionIn(docker),
        usedFor: 'Container chats, where the agent works inside a Linux container, with their terminals and ports',
        ...(!docker ? { detail: 'Chats run on this PC instead.' } : dockerServer ? {} : { detail: 'Installed but not running. Start Docker Desktop.' }),
        optional: true,
        url: 'https://www.docker.com/products/docker-desktop/'
      },
      {
        id: 'node',
        name: 'Node.js',
        source: 'system',
        status: node ? 'ok' : 'missing',
        version: versionIn(node),
        usedFor: 'MCP servers started with npx, such as Playwright and Context7',
        ...(node ? {} : { detail: 'Those MCP servers won’t start. Cloth itself doesn’t need it.' }),
        optional: true,
        url: 'https://nodejs.org'
      },
      {
        id: 'python',
        name: 'Python',
        source: 'system',
        status: python ? 'ok' : 'missing',
        version: versionIn(python),
        usedFor: 'Skills whose scripts are written in Python',
        ...(python ? {} : { detail: 'Skills with Python scripts can’t run them. SearXNG brings its own Python.' }),
        optional: true,
        url: 'https://www.python.org/downloads/'
      },
      {
        id: 'bash',
        name: win ? 'Bash (Git Bash)' : 'Bash',
        source: 'system',
        status: realBash ? 'ok' : 'missing',
        version: versionIn(realBash),
        usedFor: 'Skills whose scripts are shell scripts',
        ...(realBash ? {} : { detail: win ? 'Comes with Git for Windows.' : 'Skills with shell scripts can’t run them.' }),
        optional: true,
        ...(win ? { url: 'https://git-scm.com/downloads/win' } : {})
      }
    ]
    if (win)
      system.push({
        id: 'pwsh',
        name: 'PowerShell 7',
        source: 'system',
        status: pwsh ? 'ok' : 'missing',
        version: versionIn(pwsh),
        usedFor: 'The terminal panel, when it’s installed',
        ...(pwsh ? {} : { detail: 'The terminal and the agent’s commands use Windows PowerShell, which every PC has.' }),
        optional: true,
        url: 'https://aka.ms/powershell'
      })
    return { items: [...this.bundled(), ...system], checkedAt: Date.now() }
  }
}
