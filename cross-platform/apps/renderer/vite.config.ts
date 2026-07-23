import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The renderer is built by electron-vite. This file only supplies the shared
// React transform and DOM test environment; it does not define a standalone
// web/PWA build.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
})
