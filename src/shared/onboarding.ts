/** First-run setup: the steps, the languages it offers and what the main process reports back. */

export type OnboardingStep = 'welcome' | 'model' | 'folder' | 'langs' | 'deps' | 'import' | 'modes'

export const ONBOARDING_STEPS: OnboardingStep[] = ['welcome', 'model', 'folder', 'langs', 'deps', 'import', 'modes']

/** What setup saved: where it got to, which steps were skipped, and what the best-practice library made. */
export interface OnboardingState {
  /** When the last step was finished (null = not finished yet). */
  completedAt: number | null
  /** Steps passed over with Skip (or left by "Set up later"), shown on the Dashboard until done. */
  skipped: OnboardingStep[]
  /** The step to reopen on. */
  step: OnboardingStep
  /** The Dashboard's "Finish setup" card was dismissed. */
  cardDismissed?: boolean
  /** The best-practice library, so running setup again updates it instead of making another. */
  bestPractices?: { collectionId: string; workflowId: string } | null
}

export type LanguageId = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'cpp' | 'java' | 'csharp' | 'php' | 'ruby'

export interface LanguageInfo {
  id: LanguageId
  name: string
  /** Frameworks and libraries offered once the language is picked. */
  frameworks: string[]
}

export const LANGUAGES: LanguageInfo[] = [
  { id: 'typescript', name: 'TypeScript', frameworks: ['React', 'Next.js', 'Node.js', 'Electron', 'Vue', 'Svelte', 'Angular'] },
  { id: 'javascript', name: 'JavaScript', frameworks: ['React', 'Node.js', 'Express', 'Vue'] },
  { id: 'python', name: 'Python', frameworks: ['FastAPI', 'Django', 'Flask', 'pandas', 'PyTorch'] },
  { id: 'go', name: 'Go', frameworks: ['Gin', 'Echo'] },
  { id: 'rust', name: 'Rust', frameworks: ['Tokio', 'Axum', 'Tauri'] },
  { id: 'cpp', name: 'C / C++', frameworks: ['CMake', 'Qt'] },
  { id: 'java', name: 'Java', frameworks: ['Spring Boot'] },
  { id: 'csharp', name: 'C#', frameworks: ['.NET', 'ASP.NET Core', 'Unity'] },
  { id: 'php', name: 'PHP', frameworks: ['Laravel', 'Symfony'] },
  { id: 'ruby', name: 'Ruby', frameworks: ['Rails'] }
]

/** What Cloth saw in a folder. */
export interface FolderScan {
  path: string
  git: { branch: string | null } | null
  /** AGENTS.md or CLAUDE.md at the top. */
  instructions: string | null
  /** Share of code files per language, largest first. */
  languages: { id: LanguageId; files: number; share: number }[]
  frameworks: string[]
  /** Folders one level down with their own project file (package.json, pyproject.toml, go.mod, Cargo.toml…). */
  subprojects: string[]
  /** The scan stopped early on a very large folder. */
  partial: boolean
}

/** Code intelligence for a language: shipped with Cloth, found on this PC, missing, or not offered. */
export interface LanguageServerInfo {
  id: LanguageId
  status: 'bundled' | 'found' | 'missing' | 'none'
  /** The program Cloth runs (found) or would look for (missing). */
  program: string | null
  /** Where to get it when missing. */
  url?: string
}

export type ImportSourceId = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex' | 'agents' | 'omp'

export interface ImportSource {
  id: ImportSourceId
  name: string
  /** Where it was found (shown to the user). */
  path: string
  skills: { name: string; description: string; dir: string; imported: boolean }[]
  agents: { name: string; description: string; file: string; imported: boolean }[]
  /** Only names and what they run: environment values and headers stay in the main process. */
  mcp: { name: string; summary: string; imported: boolean }[]
}

export interface ImportSelection {
  skills: string[]
  agents: string[]
  mcp: { source: ImportSourceId; name: string }[]
}

export interface ImportResult {
  skills: string[]
  agents: string[]
  mcp: string[]
  errors: string[]
}

export type BestPracticeCadence = 'weekly' | 'monthly' | 'once'
