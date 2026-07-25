import { expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/notebook-diagnostics-test' } }))

import { sanitizeDiagnosticMessage } from './diagnostics'

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
