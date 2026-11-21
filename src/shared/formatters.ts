// Formatters and linters agents can run on the code they change (Settings → Chat → Formatting and linting).
import type { LanguageId } from './onboarding'

export type FormatToolId = 'prettier' | 'eslint' | 'biome' | 'ruff' | 'black' | 'gofmt' | 'golangci-lint' | 'rustfmt' | 'clippy' | 'clang-format' | 'google-java-format'

export interface FormatToolInfo {
  id: FormatToolId
  name: string
  kind: 'Formatter' | 'Linter' | 'Formatter and linter'
  /** The Languages setting that shows it. */
  languages: LanguageId[]
  hint: string
}

export const FORMAT_TOOLS: FormatToolInfo[] = [
  { id: 'prettier', name: 'Prettier', kind: 'Formatter', languages: ['typescript', 'javascript'], hint: 'Also formats CSS, HTML, JSON, YAML and Markdown.' },
  { id: 'eslint', name: 'ESLint', kind: 'Linter', languages: ['typescript', 'javascript'], hint: 'Runs only where a folder has ESLint and its config, since rules differ in every project.' },
  { id: 'biome', name: 'Biome', kind: 'Formatter and linter', languages: ['typescript', 'javascript'], hint: 'Used instead of Prettier and ESLint in folders set up for it.' },
  { id: 'ruff', name: 'Ruff', kind: 'Formatter and linter', languages: ['python'], hint: 'Formats like Black and lints like flake8, in one program.' },
  { id: 'black', name: 'Black', kind: 'Formatter', languages: ['python'], hint: 'Used instead of Ruff’s formatter where a folder is set up for Black.' },
  { id: 'gofmt', name: 'gofmt', kind: 'Formatter', languages: ['go'], hint: 'Comes with Go.' },
  { id: 'golangci-lint', name: 'golangci-lint', kind: 'Linter', languages: ['go'], hint: 'Runs the linters a folder’s .golangci.yml turns on, or its standard set.' },
  { id: 'rustfmt', name: 'rustfmt', kind: 'Formatter', languages: ['rust'], hint: 'Comes with Rust through rustup.' },
  { id: 'clippy', name: 'Clippy', kind: 'Linter', languages: ['rust'], hint: 'Comes with Rust through rustup. Builds the crate, so it takes longer than the others.' },
  { id: 'clang-format', name: 'clang-format', kind: 'Formatter', languages: ['cpp'], hint: 'Follows a folder’s .clang-format file. Comes with LLVM and Visual Studio’s C++ tools.' },
  { id: 'google-java-format', name: 'google-java-format', kind: 'Formatter', languages: ['java'], hint: 'Formats to the Google Java style.' }
]

/**
 * bundled: ships with Cloth · installed: Cloth's own copy · found: on this PC's PATH · project: only a folder's own copy is used ·
 * missing: Cloth can install it (installable) or the url says how · toolchain: comes with a toolchain that isn't installed (needs).
 */
export interface FormatToolStatus {
  id: FormatToolId
  status: 'bundled' | 'installed' | 'found' | 'project' | 'missing' | 'toolchain'
  program?: string
  version?: string
  installable?: boolean
  url?: string
  needs?: { name: string; url: string } | null
}

export interface CodeChecks {
  /** agent: the agent is told to run them before it finishes · cloth: Cloth runs them after every write or edit · off. */
  when: 'agent' | 'cloth' | 'off'
  /** Formatters rewrite and linters apply safe fixes; off, they only report. */
  fix: boolean
  /** A folder with no config or copy of its own: leave it, or use Cloth's copies with their defaults. */
  noSetup: 'skip' | 'defaults'
  /** Tools switched off. */
  off: FormatToolId[]
}

export const DEFAULT_CODE_CHECKS: CodeChecks = { when: 'agent', fix: true, noSetup: 'skip', off: ['golangci-lint', 'clippy'] }
