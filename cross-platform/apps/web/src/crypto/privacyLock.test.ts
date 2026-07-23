import { beforeEach, expect, test } from 'vitest'
import { configurePrivacyLock, hasPrivacyLock, removePrivacyLock, verifyPrivacyLock } from './privacyLock'

beforeEach(() => removePrivacyLock())

test('stores only a salted verifier and validates the local privacy password', async () => {
  await configurePrivacyLock('correct horse')
  expect(hasPrivacyLock()).toBe(true)
  expect(localStorage.getItem('notebook-private-lock-v1')).not.toContain('correct horse')
  expect(await verifyPrivacyLock('correct horse')).toBe(true)
  expect(await verifyPrivacyLock('wrong password')).toBe(false)
})

test('rejects a short privacy password', async () => {
  await expect(configurePrivacyLock('short')).rejects.toThrow(/至少/)
})
