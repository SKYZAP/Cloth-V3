import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import type { GitRepo, GitStatus, WorkspaceRoot } from '@shared/types'
import type { ChatService } from '../agent/chat'
import type { ContainerService } from '../agent/containers'
import type { ProviderService } from '../providers/providers'
import { inside, listDir, readWorkspaceFile } from './files'
import { diffForMessage, gitCommit, gitDiff, gitDiscard, gitInit, gitLog, gitPull, gitPush, gitStage, gitStatus, gitUnstage, repoRoot } from './git'
import type { TerminalService } from './terminals'

const COMMIT_SYSTEM = `You write git commit messages. Given a diff, answer with ONLY the message:
- a subject line in the imperative mood, at most 72 characters, no trailing period
- if the change needs it, a blank line and a short body (what and why, wrapped at 72)
No code fences, no quotes, no preamble.`

/** Folders the Git panel doesn't look in for repositories: dependencies and build output. */
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'bin', 'obj', '__pycache__', 'venv'])

/** The chat side panel: the chat's files, its terminals and its folder's git state. */
export class PanelService {
  constructor(
    private chat: ChatService,
    private providers: ProviderService,
    readonly terminals: TerminalService,
    private containers?: ContainerService
  ) {}

  root(sessionId: string): WorkspaceRoot {
    const s = this.chat.get(sessionId)
    const folder = s.workspace && existsSync(s.workspace) ? s.workspace : null
    if (s.container && this.containers) {
      const copy = this.containers.copyDir(sessionId)
      // Before the agent first runs, the copy doesn't exist yet: show the folder it will copy.
      return { path: existsSync(copy) ? copy : folder, container: existsSync(copy), folder }
    }
    return { path: folder, container: false, folder }
  }

  private files(sessionId: string): string {
    const r = this.root(sessionId)
    if (!r.path) throw new Error('This chat has no folder')
    return r.path
  }

  /** Where git runs: the chat's real folder (a container's copy is reviewed with its own changes view), or one of
   *  the repositories inside it (`repo`, a path relative to the folder, from `gitRepos`). */
  private gitDir(sessionId: string, repo?: string): string | null {
    const folder = this.root(sessionId).folder
    if (!folder) return null
    return repo ? inside(folder, repo) : folder
  }

  private async repo(sessionId: string, repo?: string): Promise<string> {
    const dir = this.gitDir(sessionId, repo)
    if (!dir) throw new Error('This chat has no folder')
    const status = await gitStatus(dir)
    if (!status.root) throw new Error('This folder is not a git repository')
    return status.root
  }

  async list(sessionId: string, dir: string) {
    return listDir(this.files(sessionId), dir)
  }

  async read(sessionId: string, path: string) {
    return readWorkspaceFile(this.files(sessionId), path)
  }

  /** Absolute path of a workspace file (to open or reveal it on the desktop). */
  absolute(sessionId: string, path: string): string {
    return inside(this.files(sessionId), path)
  }

  // ─── Terminals ──────────────────────────────────────────────────────────────
  openTerminal(sessionId: string, size: { cols: number; rows: number }) {
    const s = this.chat.get(sessionId)
    return this.terminals.create({ sessionId, folder: this.root(sessionId).folder, container: s.container }, size)
  }

  // ─── Git ────────────────────────────────────────────────────────────────────
  async gitStatus(sessionId: string, repo?: string): Promise<GitStatus> {
    const dir = this.gitDir(sessionId, repo)
    if (!dir) return { repo: false, root: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
    return gitStatus(dir)
  }

  /** Every repository in the chat's folder: its own (the folder may sit inside one), and repos and submodules one or
   *  two folders down (dependency, build and hidden folders are skipped). Each with its branch and change count. */
  async gitRepos(sessionId: string): Promise<GitRepo[]> {
    const folder = this.root(sessionId).folder
    if (!folder) return []
    const found: string[] = []
    const walk = async (dir: string, depth: number) => {
      if (depth > 2) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
        const sub = join(dir, e.name)
        // A repository, or a submodule (whose .git is a file).
        if (existsSync(join(sub, '.git'))) found.push(sub)
        await walk(sub, depth + 1)
      }
    }
    await walk(folder, 1)
    const own = await repoRoot(folder)
    const dirs = [...(own ? [folder] : []), ...found].slice(0, 24)
    const repos = await Promise.all(
      dirs.map(async (dir): Promise<GitRepo | null> => {
        const st = await gitStatus(dir).catch(() => null)
        if (!st?.root) return null
        const path = dir === folder ? '' : relative(folder, dir).split('\\').join('/')
        return { path, name: path ? basename(dir) : basename(st.root), root: st.root, branch: st.branch, changes: st.files.length, ahead: st.ahead, behind: st.behind }
      })
    )
    // A repository reached twice (the same top folder) is listed once.
    const seen = new Set<string>()
    return repos.filter((r): r is GitRepo => {
      if (!r || seen.has(r.root)) return false
      seen.add(r.root)
      return true
    })
  }

  /** `git init` in the chat's real folder (the same folder git status reads; never a container's copy). */
  async gitInit(sessionId: string): Promise<GitStatus> {
    const folder = this.root(sessionId).folder
    if (!folder) throw new Error('This chat has no folder')
    await gitInit(folder)
    return this.gitStatus(sessionId)
  }

  private async file(sessionId: string, path: string, repo?: string) {
    const status = await this.gitStatus(sessionId, repo)
    const f = status.files.find((x) => x.path === path)
    if (!f || !status.root) throw new Error(`${path} has no changes`)
    return { root: status.root, file: f, status }
  }

  async gitDiff(sessionId: string, path: string, staged: boolean, repo?: string): Promise<string> {
    const { root, file } = await this.file(sessionId, path, repo)
    return gitDiff(root, file, staged)
  }

  async gitStage(sessionId: string, paths: string[], repo?: string): Promise<GitStatus> {
    await gitStage(await this.repo(sessionId, repo), paths)
    return this.gitStatus(sessionId, repo)
  }

  async gitUnstage(sessionId: string, paths: string[], repo?: string): Promise<GitStatus> {
    await gitUnstage(await this.repo(sessionId, repo), paths)
    return this.gitStatus(sessionId, repo)
  }

  async gitDiscard(sessionId: string, paths: string[], repo?: string): Promise<GitStatus> {
    const status = await this.gitStatus(sessionId, repo)
    if (!status.root) throw new Error('This folder is not a git repository')
    await gitDiscard(
      status.root,
      status.files.filter((f) => paths.includes(f.path))
    )
    return this.gitStatus(sessionId, repo)
  }

  async gitCommit(sessionId: string, message: string, all: boolean, repo?: string): Promise<{ hash: string; status: GitStatus }> {
    const hash = await gitCommit(await this.repo(sessionId, repo), message, all)
    return { hash, status: await this.gitStatus(sessionId, repo) }
  }

  async gitLog(sessionId: string, repo?: string) {
    const status = await this.gitStatus(sessionId, repo)
    return status.root ? gitLog(status.root) : []
  }

  async gitPush(sessionId: string, repo?: string): Promise<string> {
    return gitPush(await this.repo(sessionId, repo))
  }

  async gitPull(sessionId: string, repo?: string): Promise<string> {
    return gitPull(await this.repo(sessionId, repo))
  }

  /** A commit message for the staged changes (or all of them), written by the chat's model. */
  async commitMessage(sessionId: string, all: boolean, repo?: string): Promise<string> {
    const model = this.chat.get(sessionId).model
    if (!model) throw new Error('Pick a model for this chat first')
    const diff = await diffForMessage(await this.repo(sessionId, repo), all)
    if (!diff.trim()) throw new Error('There are no changes to describe')
    const { text } = await this.providers.complete(model, { system: COMMIT_SYSTEM, prompt: `Diff:\n\n${diff}\n\nCommit message:`, maxTokens: 600, temperature: 0.2, thinking: 'off' })
    return text
      .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, '')
      .replace(/^["']|["']$/g, '')
      .trim()
  }
}
