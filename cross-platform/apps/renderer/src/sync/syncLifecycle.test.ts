import { afterEach, describe, expect, test, vi } from 'vitest'
import { createBackgroundSyncGate, createQuietSyncScheduler, schedulePendingSyncBatch } from './syncLifecycle'

afterEach(() => vi.useRealTimers())

describe('sync lifecycle scheduling', () => {
  test('waits for a full quiet period before running normal outbox sync', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const scheduler = createQuietSyncScheduler(run, 30_000)
    scheduler.request()
    vi.advanceTimersByTime(29_999)
    scheduler.request()
    vi.advanceTimersByTime(29_999)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('coalesces blur and visibilitychange into one background flush/sync', async () => {
    const run = vi.fn(async () => undefined)
    const gate = createBackgroundSyncGate(run)
    gate.background() // window blur
    gate.background() // document visibilitychange(hidden)
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(1)
    gate.foreground()
    gate.background()
    await Promise.resolve()
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('re-arms a quiet batch when the bounded outbox still has a tail', async () => {
    const request = vi.fn()
    await schedulePendingSyncBatch(async () => true, request)
    expect(request).toHaveBeenCalledTimes(1)
    await schedulePendingSyncBatch(async () => false, request)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
