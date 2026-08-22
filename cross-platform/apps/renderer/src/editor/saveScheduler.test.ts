import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createTrailingDebounce } from './saveScheduler'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('runs once after the input stays quiet for the delay', () => {
  const run = vi.fn()
  const debounce = createTrailingDebounce(250, run)
  debounce.call()
  debounce.call()
  vi.advanceTimersByTime(200)
  debounce.call()
  vi.advanceTimersByTime(249)
  expect(run).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(run).toHaveBeenCalledTimes(1)
})

test('flush runs a pending call immediately and only once', () => {
  const run = vi.fn()
  const debounce = createTrailingDebounce(250, run)
  debounce.call()
  debounce.flush()
  expect(run).toHaveBeenCalledTimes(1)
  debounce.flush()
  vi.advanceTimersByTime(500)
  expect(run).toHaveBeenCalledTimes(1)
})

test('cancel drops the pending call', () => {
  const run = vi.fn()
  const debounce = createTrailingDebounce(250, run)
  debounce.call()
  debounce.cancel()
  vi.advanceTimersByTime(500)
  expect(run).not.toHaveBeenCalled()
})
