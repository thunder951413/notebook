import { afterEach, expect, test, vi } from 'vitest'
import { nextReminderAt } from './useReminders'

afterEach(() => vi.useRealTimers())

test('advances recurring reminders beyond the current time', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-23T12:00:00.000Z'))
  expect(nextReminderAt('2026-07-20T09:00:00.000Z', 'daily')).toBe('2026-07-24T09:00:00.000Z')
  expect(nextReminderAt('2026-07-01T09:00:00.000Z', 'weekly')).toBe('2026-07-29T09:00:00.000Z')
  expect(nextReminderAt('2026-06-23T09:00:00.000Z', 'monthly')).toBe('2026-08-23T09:00:00.000Z')
  expect(nextReminderAt('2026-07-23T09:00:00.000Z', 'none')).toBeUndefined()
})
