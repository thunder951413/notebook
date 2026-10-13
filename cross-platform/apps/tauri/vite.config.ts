import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Builds the shared renderer (apps/renderer) with the Tauri bridge in front.
export default defineConfig({
  root: __dirname,
  publicDir: resolve(__dirname, '../renderer/public'),
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [resolve(__dirname, '..'), resolve(__dirname, '../../packages'), resolve(__dirname, '../../node_modules')] },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // WKWebView on macOS 13+ (Safari 16).
    target: 'safari16',
    chunkSizeWarningLimit: 4000,
  },
})
