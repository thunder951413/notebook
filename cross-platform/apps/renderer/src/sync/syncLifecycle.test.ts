import { afterEach, describe, expect, test, vi } from 'vitest'
import { AUTO_REQUEST_BUDGET, AUTO_SYNC_MAX_WAIT_MS, EDIT_SYNC_MAX_WAIT_MS, MIN_AUTO_SYNC_INTERVAL_MS, createAutomaticSyncPolicy, createBackgroundSyncGate, createDeferredRun, createQuietSyncScheduler, createSyncStateFinalizer, schedulePendingSyncBatch } from './syncLifecycle'

afterEach(() => vi.useRealTimers())

describe('sync lifecycle scheduling', () => {
  test('bounds continuous editing by the maximum wait and resets the bound after cancel', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const scheduler = createQuietSyncScheduler(run)
    scheduler.request()
    for (let elapsed = 0; elapsed < AUTO_SYNC_MAX_WAIT_MS - 20_000; elapsed += 20_000) {
      vi.advanceTimersByTime(20_000)
      scheduler.request()
    }
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20_000)
    expect(run).toHaveBeenCalledTimes(1)
    scheduler.request()
    scheduler.cancel()
    vi.advanceTimersByTime(AUTO_SYNC_MAX_WAIT_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  test('uploads only at boundaries with pending edits, a minute apart; focus only pulls when stale', () => {
    const policy = createAutomaticSyncPolicy()
    expect(policy.decide('startup', false, 0).run).toBe(true)
    policy.started(0)
    policy.succeeded(0)
    // Nothing to upload: boundaries and edits do not touch the network.
    for (const reason of ['boundary', 'background', 'changes', 'shutdown'] as const) expect(policy.decide(reason, false, 90_000).run).toBe(false)
    // Switching apps right after a sync does not sync again, even with edits.
    expect(policy.decide('foreground', true, 60_000).run).toBe(false)
    expect(policy.decide('foreground', false, 120_000).run).toBe(true)
    // Edits upload at a boundary, but not twice within a minute.
    expect(policy.decide('boundary', true, 30_000)).toEqual({ run: false, retryInMs: MIN_AUTO_SYNC_INTERVAL_MS - 30_000, heldBy: 'interval' })
    expect(policy.decide('boundary', true, MIN_AUTO_SYNC_INTERVAL_MS).run).toBe(true)
    // Quitting always flushes pending edits.
    policy.started(100_000)
    expect(policy.decide('shutdown', true, 100_001).run).toBe(true)
    expect(policy.decide('online', false, 100_001).run).toBe(true)
  })

  test('keeps this device inside its share of the 坚果云 request budget', () => {
    const policy = createAutomaticSyncPolicy()
    expect(policy.decide('boundary', true, 0, AUTO_REQUEST_BUDGET - 1).run).toBe(true)
    expect(policy.decide('boundary', true, 0, AUTO_REQUEST_BUDGET)).toMatchObject({ run: false, heldBy: 'budget' })
    expect(policy.decide('foreground', false, 0, AUTO_REQUEST_BUDGET).run).toBe(false)
    expect(policy.decide('shutdown', true, 0, AUTO_REQUEST_BUDGET).run).toBe(true)
  })

  test('deferred runs keep the earliest requested time', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const deferred = createDeferredRun(run)
    deferred.schedule(10_000, 0)
    deferred.schedule(30_000, 0)
    vi.advanceTimersByTime(10_000)
    expect(run).toHaveBeenCalledTimes(1)
    deferred.schedule(30_000, 10_000)
    deferred.schedule(5_000, 10_000)
    vi.advanceTimersByTime(5_000)
    expect(run).toHaveBeenCalledTimes(2)
    deferred.schedule(1_000)
    deferred.cancel()
    vi.advanceTimersByTime(60_000)
    expect(run).toHaveBeenCalledTimes(2)
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
    expect(EDIT_SYNC_MAX_WAIT_MS).toBe(AUTO_SYNC_MAX_WAIT_MS)
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
