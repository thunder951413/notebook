// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: Record<string, string> } } }
const csp = config.app.security.csp

test('the webview may only talk to the local bridge; WebDAV and AI go through Rust', () => {
  const sources = csp['connect-src']!.split(/\s+/)
  expect(sources).not.toContain('https:')
  expect(sources).not.toContain('wss:')
  expect(sources).not.toContain('*')
  expect(sources.filter((source) => /^(https?|wss?):\/\//.test(source)).every((source) => /^(https?|wss?):\/\/(127\.0\.0\.1|ipc\.localhost)/.test(source))).toBe(true)
})

test('scripts stay same-origin with no eval', () => {
  const scripts = csp['script-src']!.split(/\s+/)
  expect(scripts).not.toContain("'unsafe-eval'")
  expect(scripts).not.toContain("'unsafe-inline'")
})
