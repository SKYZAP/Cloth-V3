import { existsSync } from 'node:fs'
import type { GitStatus, WorkspaceRoot } from '@shared/types'
import type { ChatService } from '../agent/chat'
import type { ContainerService } from '../agent/containers'
import type { ProviderService } from '../providers/providers'
import { inside, listDir, readWorkspaceFile } from './files'
import { diffForMessage, gitCommit, gitDiff, gitDiscard, gitInit, gitLog, gitPull, gitPush, gitStage, gitStatus, gitUnstage } from './git'
import type { TerminalService } from './terminals'

const COMMIT_SYSTEM = `You write git commit messages. Given a diff, answer with ONLY the message:
- a subject line in the imperative mood, at most 72 characters, no trailing period
- if the change needs it, a blank line and a short body (what and why, wrapped at 72)
No code fences, no quotes, no preamble.`

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

  /** Git works on the chat's real folder (a container's copy is reviewed with its own changes view). */
  private async repo(sessionId: string): Promise<string> {
    const folder = this.root(sessionId).folder
    if (!folder) throw new Error('This chat has no folder')
    const status = await gitStatus(folder)
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
  async gitStatus(sessionId: string): Promise<GitStatus> {
    const folder = this.root(sessionId).folder
    if (!folder) return { repo: false, root: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
    return gitStatus(folder)
  }

  /** `git init` in the chat's real folder (the same folder git status reads; never a container's copy). */
  async gitInit(sessionId: string): Promise<GitStatus> {
    const folder = this.root(sessionId).folder
    if (!folder) throw new Error('This chat has no folder')
    await gitInit(folder)
    return this.gitStatus(sessionId)
  }

  private async file(sessionId: string, path: string) {
    const status = await this.gitStatus(sessionId)
    const f = status.files.find((x) => x.path === path)
    if (!f || !status.root) throw new Error(`${path} has no changes`)
    return { root: status.root, file: f, status }
  }

  async gitDiff(sessionId: string, path: string, staged: boolean): Promise<string> {
    const { root, file } = await this.file(sessionId, path)
    return gitDiff(root, file, staged)
  }

  async gitStage(sessionId: string, paths: string[]): Promise<GitStatus> {
    await gitStage(await this.repo(sessionId), paths)
    return this.gitStatus(sessionId)
  }

  async gitUnstage(sessionId: string, paths: string[]): Promise<GitStatus> {
    await gitUnstage(await this.repo(sessionId), paths)
    return this.gitStatus(sessionId)
  }

  async gitDiscard(sessionId: string, paths: string[]): Promise<GitStatus> {
    const status = await this.gitStatus(sessionId)
    if (!status.root) throw new Error('This folder is not a git repository')
    await gitDiscard(
      status.root,
      status.files.filter((f) => paths.includes(f.path))
    )
    return this.gitStatus(sessionId)
  }

  async gitCommit(sessionId: string, message: string, all: boolean): Promise<{ hash: string; status: GitStatus }> {
    const hash = await gitCommit(await this.repo(sessionId), message, all)
    return { hash, status: await this.gitStatus(sessionId) }
  }

  async gitLog(sessionId: string) {
    const status = await this.gitStatus(sessionId)
    return status.root ? gitLog(status.root) : []
  }

  async gitPush(sessionId: string): Promise<string> {
    return gitPush(await this.repo(sessionId))
  }

  async gitPull(sessionId: string): Promise<string> {
    return gitPull(await this.repo(sessionId))
  }

  /** A commit message for the staged changes (or all of them), written by the chat's model. */
  async commitMessage(sessionId: string, all: boolean): Promise<string> {
    const model = this.chat.get(sessionId).model
    if (!model) throw new Error('Pick a model for this chat first')
    const diff = await diffForMessage(await this.repo(sessionId), all)
    if (!diff.trim()) throw new Error('There are no changes to describe')
    const { text } = await this.providers.complete(model, { system: COMMIT_SYSTEM, prompt: `Diff:\n\n${diff}\n\nCommit message:`, maxTokens: 600, temperature: 0.2, thinking: 'off' })
    return text
      .replace(/^\s*```[a-z]*\n?|\n?```\s*$/g, '')
      .replace(/^["']|["']$/g, '')
      .trim()
  }
}
