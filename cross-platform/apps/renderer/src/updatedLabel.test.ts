import { expect, test } from 'vitest'
import { formatUpdatedLabel } from './updatedLabel'

const now = new Date('2026-08-22T15:00:00')

test('same-day updates show a clock time', () => {
  expect(formatUpdatedLabel('2026-08-22T09:05:00', now)).toMatch(/^\d{2}:\d{2}$/)
})

test('yesterday and the past week stay relative', () => {
  expect(formatUpdatedLabel('2026-08-21T23:59:00', now)).toBe('昨天')
  expect(formatUpdatedLabel('2026-08-17T12:00:00', now)).toBe('4 天前')
})

test('older and invalid timestamps fall back', () => {
  expect(formatUpdatedLabel('2026-07-21T12:00:00', now)).toBe('2026/7/21')
  expect(formatUpdatedLabel('not-a-date', now)).toBe('')
})
