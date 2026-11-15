/**
 * File paths mentioned in a chat (inline code, links, the files a tool changed) that open in the side panel's file viewer.
 * Pure, so the renderer and tests share it.
 */

/** Extensions that mark a bare name (no folder) as a file. `log`, `map` and the like are left out: `console.log` isn't one. */
const FILE_EXTS = new Set(
  'ts tsx js jsx mjs cjs json jsonc md mdx txt py rb go rs java kt kts swift c h cc cpp hpp cs php html htm css scss sass less vue svelte astro yml yaml toml ini cfg conf env sh bash zsh ps1 bat cmd sql graphql gql proto xml svg png jpg jpeg gif webp ico csv tsv lock gradle dart lua r ex exs erl hs ml scala tf prisma dockerfile gitignore editorconfig'.split(' ')
)

const SEGMENT = /^[\w.@()+\-[\]~#%=, ]+$/

/**
 * The path in `raw` when it reads as a file path, without any `:line[:col]` suffix; else null.
 * A path with a folder in it (`src/app.ts`, `./notes`, `C:\x\y.md`) counts, and so does a bare
 * name with a known file extension (`package.json`). URLs, commands and code don't. Spaces count only
 * with `spaces` (a link's address) or in a file:// URL: in inline code, `cat a.ts` is a command.
 */
export function filePathIn(raw: string, spaces = false): string | null {
  let s = raw.trim()
  if (!s || s.length > 260 || /[\n\t]/.test(s) || (!spaces && !/^file:\/\//i.test(s) && /\s/.test(s)) ||(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^file:\/\//i.test(s))) return null
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    } catch {
      return null
    }
  }
  s = s.replace(/(?::\d+){1,2}$/, '').replace(/#L\d+(?:-L?\d+)?$/, '')
  const drive = /^[A-Za-z]:[\\/]/.test(s)
  const body = drive ? s.slice(3) : s.replace(/^~?[\\/]/, '').replace(/^(?:\.{1,2}[\\/])+/, '')
  const parts = body.split(/[\\/]/).filter(Boolean)
  if (!parts.length || !parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..')) return null
  const last = parts[parts.length - 1]
  const ext = last.includes('.') ? last.slice(last.lastIndexOf('.') + 1).toLowerCase() : last.toLowerCase()
  const hasFolder = parts.length > 1 || drive || /^(?:\.{1,2}|~)?[\\/]/.test(s)
  // A bare `name.ext` needs a file extension; `a.b` (a property, a version) doesn't count.
  if (!hasFolder && !FILE_EXTS.has(ext) && !/^\.[\w-]+$/.test(last)) return null
  // Something like `1.2.3` or `/` alone isn't a file.
  if (/^[\d.]+$/.test(last)) return null
  return s
}

/**
 * `path` as a '/'-separated path relative to the chat's folder `root`, or null when it's outside it.
 * Relative paths are taken as relative to the folder. Case-insensitive on Windows-style paths.
 */
export function relativeTo(root: string | null, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(path)
  const absolute = /^[A-Za-z]:\//.test(p) || p.startsWith('/') || p.startsWith('~/')
  if (!absolute) {
    const rel = p.replace(/^(?:\.\/)+/, '')
    return rel.startsWith('../') ? null : rel || null
  }
  if (!root) return null
  const r = norm(root)
  const windows = /^[A-Za-z]:\//.test(r)
  const [a, b] = windows ? [p.toLowerCase(), r.toLowerCase()] : [p, r]
  if (a === b) return null
  return a.startsWith(`${b}/`) ? p.slice(r.length + 1) : null
}
