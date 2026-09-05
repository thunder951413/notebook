import { afterEach, expect, test, vi } from 'vitest'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ logsPath: `/tmp/notebook-diagnostics-test-${process.pid}` }))
vi.mock('electron', () => ({ app: { getPath: () => state.logsPath, getVersion: () => '2.3.0-test' } }))

import { appendDiagnosticEvent, diagnosticErrorDetails, diagnosticLogPath, exportDiagnosticEvents, MAX_LOG_BYTES, sanitizeDiagnosticMessage } from './diagnostics'

afterEach(async () => {
  await rm(state.logsPath, { recursive: true, force: true })
})

test('redacts credentials and flattens diagnostic messages', () => {
  const value = sanitizeDiagnosticMessage('sync failed\npassword=hunter2 token: abc123 https://user:pass@example.com/?key=private sk-1234567890abcdef github_pat_privatevalue')
  expect(value).toContain('sync failed')
  expect(value).toContain('password=[redacted]')
  expect(value).toContain('token=[redacted]')
  expect(value).not.toContain('hunter2')
  expect(value).not.toContain('abc123')
  expect(value).not.toContain('sk-1234567890abcdef')
  expect(value).not.toContain('github_pat_privatevalue')
  expect(value).not.toContain('user:pass')
  expect(value).not.toContain('key=private')
  expect(value).not.toContain('\n')
})

test('records bounded metadata and sanitized structured errors', async () => {
  const error = Object.assign(new Error('private response body'), { code: 'E_DISK' })
  await appendDiagnosticEvent({
    level: 'error', category: 'storage unsafe', action: 'write', status: 'failed',
    operationId: 'operation/unsafe', resource: { type: 'page', id: 'page/1' },
    ...diagnosticErrorDetails(error),
  })

  const entry = (await exportDiagnosticEvents())[0]!
  expect(entry).toMatchObject({
    appVersion: '2.3.0-test', platform: process.platform, arch: process.arch,
    category: 'storage-unsafe', operationId: 'operation-unsafe', resource: { type: 'page', id: 'page-1' },
    errorType: 'Error', errorCode: 'E_DISK',
  })
  expect(entry.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  expect(entry.stack?.length).toBeLessThanOrEqual(5)
  expect(diagnosticErrorDetails({ name: 'TypeError', stack: 'TypeError: private\n    at save (http://localhost:5173/src/data/private.ts:12:4)' }).stack)
    .toEqual(['at save (private.ts:12:4)'])
  expect(JSON.stringify(entry)).not.toContain('private response body')
})

test('bounds queued writes and reports dropped noise on the next retained write', async () => {
  const writes = Array.from({ length: 300 }, (_, index) => appendDiagnosticEvent({
    level: 'info', category: 'noise', action: `event-${index}`, status: 'info',
  }))
  await Promise.all(writes)
  await appendDiagnosticEvent({ level: 'info', category: 'test', action: 'after-overflow', status: 'success' })

  const entries = await exportDiagnosticEvents()
  const overflow = entries.find((entry) => entry.action === 'queue-overflow')
  expect(overflow?.message).toMatch(/\d+ events dropped/)
  expect(entries.at(-1)?.action).toBe('after-overflow')
})

test('serializes an export snapshot between earlier and later writes', async () => {
  const first = appendDiagnosticEvent({ level: 'info', category: 'test', action: 'before-export', status: 'success' })
  const snapshot = exportDiagnosticEvents()
  const later = appendDiagnosticEvent({ level: 'info', category: 'test', action: 'after-export', status: 'success' })
  await first
  const exported = await snapshot
  await later

  expect(exported.map((entry) => entry.action)).toContain('before-export')
  expect(exported.map((entry) => entry.action)).not.toContain('after-export')
})

test('rotates before an incoming entry would exceed the cap and exports both files', async () => {
  await mkdir(state.logsPath, { recursive: true })
  const legacy = `${JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', category: 'old', action: 'retained', status: 'success' })}\n`
  const filler = `${legacy}${' '.repeat(MAX_LOG_BYTES - Buffer.byteLength(legacy) - 100)}`
  await writeFile(diagnosticLogPath(), filler)

  await appendDiagnosticEvent({ level: 'info', category: 'new', action: 'incoming', status: 'success', message: 'x'.repeat(500) })

  expect((await stat(`${diagnosticLogPath()}.1`)).size).toBeLessThanOrEqual(MAX_LOG_BYTES)
  expect((await stat(diagnosticLogPath())).size).toBeLessThanOrEqual(MAX_LOG_BYTES)
  const active = await readFile(diagnosticLogPath(), 'utf8')
  expect(active).toContain('"action":"incoming"')
  const exported = await exportDiagnosticEvents()
  expect(exported.map((entry) => entry.action)).toEqual(['retained', 'incoming'])
})

test('logging failures resolve without surfacing into application workflows', async () => {
  const blockingFile = join(state.logsPath, 'not-a-directory')
  await mkdir(state.logsPath, { recursive: true })
  await writeFile(blockingFile, 'occupied')
  state.logsPath = blockingFile
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await expect(appendDiagnosticEvent({ level: 'error', category: 'test', action: 'failure', status: 'failed' })).resolves.toBeUndefined()
  warning.mockRestore()
  state.logsPath = `/tmp/notebook-diagnostics-test-${process.pid}`
})
