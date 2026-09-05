import { beforeEach, expect, test, vi } from 'vitest'
import { recordDiagnosticEvent } from './diagnostics'

const record = vi.fn(async () => undefined)

beforeEach(() => {
  record.mockClear()
  Object.defineProperty(window, 'notebookDesktop', {
    configurable: true,
    value: { diagnostics: { record } },
  })
})

test('drops unreviewed renderer messages and resource references', () => {
  recordDiagnosticEvent({
    level: 'info', category: 'automation', action: 'proposal-create', status: 'success',
    message: 'private note title and server body', resource: { type: 'page', id: 'private-title' },
  })

  expect(record).toHaveBeenCalledWith(expect.objectContaining({ message: undefined, resource: undefined }))
})

test('retains audited count summaries and structured error details', () => {
  recordDiagnosticEvent({ level: 'info', category: 'sync', action: 'outbox', status: 'success', message: '本批上传 2 条；剩余待上传 1 条' })
  recordDiagnosticEvent({ level: 'error', category: 'sync', action: 'run', status: 'failed', message: 'raw server body', errorType: 'NetworkError', errorCode: 'ECONNRESET' })

  expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: '本批上传 2 条；剩余待上传 1 条' }))
  expect(record).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: undefined, errorType: 'NetworkError', errorCode: 'ECONNRESET' }))
})
