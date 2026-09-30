import { createRequire } from 'node:module'

// The runner's main process is one ESM bundle. A few bundled dependencies still call `require` for
// Node built-ins at runtime; give them one. Imported first, so it runs before they load.
const g = globalThis as { require?: NodeJS.Require }
g.require ??= createRequire(import.meta.url)
