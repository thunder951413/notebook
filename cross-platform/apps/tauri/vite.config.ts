import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const assetsDir = resolve(__dirname, 'dist/assets')
const mapsDir = resolve(__dirname, 'dist-maps')

/**
 * Source maps are generated (hidden) but moved out of dist so they are not
 * shipped inside the app. CI publishes them next to the release, which lets
 * crash stacks from the diagnostics log be mapped back to source.
 */
function externalSourceMaps(): Plugin {
  return {
    name: 'notebook-external-source-maps',
    apply: 'build',
    closeBundle() {
      rmSync(mapsDir, { recursive: true, force: true })
      mkdirSync(mapsDir, { recursive: true })
      for (const name of readdirSync(assetsDir)) if (name.endsWith('.map')) renameSync(resolve(assetsDir, name), resolve(mapsDir, name))
    },
  }
}

// Builds the shared renderer (apps/renderer) with the Tauri bridge in front.
export default defineConfig({
  root: __dirname,
  publicDir: resolve(__dirname, '../renderer/public'),
  plugins: [react(), externalSourceMaps()],
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
    sourcemap: 'hidden',
  },
})
