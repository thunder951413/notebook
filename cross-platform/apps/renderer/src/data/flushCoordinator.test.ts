import { afterEach, describe, expect, test, vi } from 'vitest'
import { flushPendingEdits, registerAfterFlushHandler, registerFlushHandler } from './flushCoordinator'

describe('flush coordinator', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup())
  })

  test('runs post-flush sync only after durable draft and reading-position handlers', async () => {
    const order: string[] = []
    cleanups.push(registerFlushHandler(async () => { order.push('draft') }))
    cleanups.push(registerFlushHandler(async () => { order.push('reading-position') }))
    cleanups.push(registerAfterFlushHandler(async () => { order.push('sync') }))
    await flushPendingEdits()
    expect(order).toEqual(expect.arrayContaining(['draft', 'reading-position']))
    expect(order.at(-1)).toBe('sync')
  })

  test('does not invoke a post-flush sync if a durable flush fails', async () => {
    const sync = vi.fn()
    cleanups.push(registerFlushHandler(async () => { throw new Error('disk failed') }))
    cleanups.push(registerAfterFlushHandler(sync))
    await expect(flushPendingEdits()).rejects.toThrow('disk failed')
    expect(sync).not.toHaveBeenCalled()
  })
})
