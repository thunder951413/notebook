import { afterEach, describe, expect, test, vi } from 'vitest'
import { AUTO_SYNC_MAX_WAIT_MS, createAutomaticSyncPolicy, createBackgroundSyncGate, createQuietSyncScheduler, createSyncStateFinalizer, schedulePendingSyncBatch } from './syncLifecycle'

afterEach(() => vi.useRealTimers())

describe('sync lifecycle scheduling', () => {
  test('bounds continuous editing by five minutes and resets the bound after cancel', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const scheduler = createQuietSyncScheduler(run)
    scheduler.request()
    for (let elapsed = 0; elapsed < AUTO_SYNC_MAX_WAIT_MS - 30_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000)
      scheduler.request()
    }
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_000)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.request()
    scheduler.cancel()
    vi.advanceTimersByTime(AUTO_SYNC_MAX_WAIT_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('avoids empty background/exit sync and throttles foreground checks, without delaying edits', () => {
    const policy = createAutomaticSyncPolicy()
    expect(policy.shouldRun('startup', false, 0)).toBe(true)
    policy.succeeded(0)
    for (const reason of ['foreground', 'background', 'shutdown', 'changes'] as const) {
      expect(policy.shouldRun(reason, false, 60_000)).toBe(false)
      expect(policy.shouldRun(reason, true, 60_000)).toBe(true)
    }
    expect(policy.shouldRun('foreground', false, 120_000)).toBe(true)
    expect(policy.shouldRun('background', false, 120_000)).toBe(false)
    expect(policy.shouldRun('online', false, 1)).toBe(true)
  })

  test('backs off failures up to fifteen minutes, allowing network recovery and resetting after success', () => {
    const policy = createAutomaticSyncPolicy()
    expect(policy.failed(0)).toBe(60_000)
    expect(policy.shouldRun('foreground', true, 59_999)).toBe(false)
    expect(policy.shouldRun('retry', true, 60_000)).toBe(true)
    expect(policy.shouldRun('online', true, 1)).toBe(true)
    expect([policy.failed(60_000), policy.failed(60_000), policy.failed(60_000), policy.failed(60_000), policy.failed(60_000)])
      .toEqual([120_000, 240_000, 480_000, 900_000, 900_000])
    policy.succeeded(70_000)
    expect(policy.shouldRun('changes', true, 70_001)).toBe(true)
    expect(policy.failed(70_002)).toBe(60_000)
  })
  test('always commits a non-transient state when a sync run finishes', () => {
    const commit = vi.fn()
    const successful = createSyncStateFinalizer('offline', commit)
    successful.complete('synced')
    expect(successful.finish()).toBe('synced')
    expect(commit).toHaveBeenLastCalledWith('synced')

    const cancelled = createSyncStateFinalizer('synced', commit)
    expect(cancelled.finish()).toBe('synced')
    expect(commit).toHaveBeenLastCalledWith('synced')
  })

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
