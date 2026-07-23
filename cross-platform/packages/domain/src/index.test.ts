import { isoNow } from './index'
import { expect, test } from 'vitest'

test('creates portable ISO timestamps', () => {
  const value = isoNow()
  expect(new Date(value).toISOString()).toBe(value)
})
