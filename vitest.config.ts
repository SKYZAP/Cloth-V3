import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // Tests never read this PC's homelab tokens (~/.homelab/env): point them at a file that isn't there. They start with
  // no built-in skills either, so skill lists hold only what each test made.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 20_000, env: { HOMELAB_ENV: resolve('tests/.no-homelab-env'), CLOTH_BUILTIN_SKILLS: 'off' } }
})
