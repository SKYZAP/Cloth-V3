import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // Tests start with no built-in skills, so skill lists hold only what each test made.
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 20_000, env: { CLOTH_BUILTIN_SKILLS: 'off' } }
})
