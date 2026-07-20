import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@muyajs/core': resolve(here, 'node_modules/@muyajs/core/src/index.ts'),
    },
  },
  build: {
    outDir: resolve(here, '../../Notebook/MarkdownEditor.bundle/Contents/Resources'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'safari17',
  },
})
