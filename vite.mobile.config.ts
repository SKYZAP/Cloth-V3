import { resolve as res } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const here = fileURLToPath(new URL('.', import.meta.url))
const resolve = (p: string) => res(here, p)

/** The Android app's web bundle: the desktop renderer with the remote bridge in place of Electron IPC. */
export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  plugins: [
    react(),
    tailwindcss(),
    // Capacitor loads index.html; the phone entry is mobile.html so it can sit beside the desktop one.
    { name: 'cloth-mobile-index', enforce: 'post', generateBundle(_, bundle) {
      const html = bundle['mobile.html']
      if (html) html.fileName = 'index.html'
    } }
  ],
  server: { port: 5190, host: true },
  build: {
    outDir: resolve('out/mobile'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve('src/renderer/mobile.html') } }
  }
})
