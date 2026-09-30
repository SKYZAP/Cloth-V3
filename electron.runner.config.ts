import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Flow Runner: the app template exported flows are packaged with (npm run build:runner).
 * The main process reuses Cloth's services, bundled in; only native modules stay external and ship
 * in the runner's node_modules.
 */
const alias = { '@shared': resolve('src/shared') }
const NATIVE = [/^@ast-grep\//, 'pyright', 'typescript', /^@typescript\//, 'electron']

/**
 * The Anthropic SDK re-exports Node built-in namespaces (`import * as fs` … `export { fs }`), which
 * Rollup turns into invalid code once bundled. Same module, loading them with require.
 */
const nodeNamespaces = {
  name: 'cloth-node-namespaces',
  load(id: string) {
    if (!/@anthropic-ai[\\/]sdk[\\/]internal[\\/]node\.mjs$/.test(id)) return null
    const mods = ['child_process', 'crypto', 'fs', 'os', 'path', 'stream', 'util']
    return [`import { createRequire } from 'node:module'`, `const req = createRequire(import.meta.url)`, ...mods.map((m) => `export const ${m} = req('node:${m}')`)].join('\n')
  }
}

export default defineConfig({
  main: {
    // turndown's ES build calls require('@mixmark-io/domino') at load; its CommonJS build gets bundled properly.
    resolve: { alias: { ...alias, turndown: resolve('node_modules/turndown/lib/turndown.cjs.js') } },
    plugins: [nodeNamespaces],
    build: {
      outDir: 'out/runner/main',
      externalizeDeps: false,
      rollupOptions: { input: { index: resolve('src/runner/main/index.ts') }, external: NATIVE }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/runner/preload',
      rollupOptions: {
        input: { index: resolve('src/runner/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/runner/renderer'),
    resolve: { alias: { ...alias, '@': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: { outDir: 'out/runner/renderer', rollupOptions: { input: { index: resolve('src/runner/renderer/index.html') } } }
  }
})
